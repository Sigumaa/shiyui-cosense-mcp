import {
  McpServer,
  type CallToolResult,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  appendToPageInputSchema,
  createPageInputSchema,
  CosenseAuthenticationError,
  CosenseReplaceLinksRetryableError,
  CosenseResponseError,
  CosenseUpstreamError,
  CosenseWriteConflictError,
  CosenseWriteOutcomeUnknownError,
  getPageChangesInputSchema,
  getPageInputSchema,
  getRelatedPagesInputSchema,
  listPagesInputSchema,
  replaceLinksInputSchema,
  searchFullTextInputSchema,
  searchVectorInputSchema,
  type CosenseClient,
  updatePageInputSchema,
} from "./cosense";

const readAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
} as const;
const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;
const destructiveWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;
const serverDescription = [
  'Cosense project "shiyui" を読み書きするMCP。',
  "文章を新しく作る、または文章表現を大きく変える場合は、必要に応じて get_page で「cosenseの書き方」を読み、",
  "そこに記載されたプロジェクト固有の書き方・記法・編集方針に従う。機械的な変更や通常の読み取りだけの場合は読む必要はない。",
].join("\n");
const serverInstructions =
  "Use write tools when the user has clearly requested a write and identified its target. You may compose or polish the final wording within that request; ask only when the intent is ambiguous or the change would exceed the request. Read current page state only when an operation needs it. A clearly requested rename and link replacement may be executed in sequence. Follow each tool description for conflict and retry rules.";

const getPageOutputSchema = z.object({
  exists: z.boolean(),
  title: z.string(),
  canonicalUrl: z.string(),
  pageId: z.string().optional(),
  commitId: z.string().optional(),
  text: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  pageRank: z.number().optional(),
  linked: z.number().optional(),
  links: z.array(z.string()).optional(),
});

const fullTextSearchOutputSchema = z.object({
  reportedCount: z.number().optional(),
  exactTitleMatch: z.boolean().optional(),
  returned: z.number(),
  truncated: z.boolean(),
  results: z.array(
    z.object({
      title: z.string(),
      snippet: z.string(),
      matchedWords: z.array(z.string()),
      updatedAt: z.string().optional(),
      pageRank: z.number().optional(),
      canonicalUrl: z.string(),
    }),
  ),
});

const vectorSearchOutputSchema = z.object({
  returned: z.number(),
  localTruncated: z.boolean(),
  results: z.array(
    z.object({
      title: z.string(),
      score: z.number(),
      exists: z.boolean(),
      canonicalUrl: z.string(),
      updatedAt: z.string().optional(),
      pageRank: z.number().optional(),
    }),
  ),
});

const relatedPagesOutputSchema = z.object({
  total: z.number().optional(),
  hasNext: z.boolean(),
  nextCursor: z.string().optional(),
  returned: z.number(),
  results: z.array(
    z.object({
      title: z.string(),
      descriptions: z.array(z.string()),
      relation: z.enum(["outgoing", "incoming", "bidirectional"]).optional(),
      pageRank: z.number().optional(),
      linked: z.number().optional(),
      updatedAt: z.string().optional(),
      canonicalUrl: z.string(),
    }),
  ),
});

const listPagesOutputSchema = z.object({
  reportedCount: z.number(),
  skip: z.number(),
  returned: z.number(),
  hasNext: z.boolean(),
  nextSkip: z.number().optional(),
  results: z.array(
    z.object({
      pageId: z.string(),
      title: z.string(),
      canonicalUrl: z.string(),
      descriptions: z.array(z.string()),
      pin: z.number().optional(),
      views: z.number().optional(),
      linked: z.number().optional(),
      linesCount: z.number().optional(),
      charsCount: z.number().optional(),
      createdAt: z.string().optional(),
      updatedAt: z.string().optional(),
      accessedAt: z.string().optional(),
    }),
  ),
});

const pageChangesOutputSchema = z.object({
  pageId: z.string(),
  afterCommitId: z.string().optional(),
  commitCount: z.number(),
  totalChanges: z.number(),
  returned: z.number(),
  truncated: z.boolean(),
  latestCommitId: z.string().optional(),
  latestTitleChange: z
    .object({
      title: z.string(),
      canonicalUrl: z.string(),
    })
    .optional(),
  changes: z.array(
    z.object({
      kind: z.enum(["title", "insert", "update", "delete"]),
      authors: z.array(z.string()),
      createdAt: z.string().optional(),
      before: z.string().optional(),
      after: z.string().optional(),
    }),
  ),
});

const writePageOutputSchema = z.object({
  action: z.enum(["create", "append"]),
  title: z.string(),
  canonicalUrl: z.string(),
  commitId: z.string(),
  previousCommitId: z.string().optional(),
  addedLines: z.number().int().positive(),
});

const updatePageOutputSchema = z.object({
  action: z.literal("update"),
  previousTitle: z.string(),
  title: z.string(),
  canonicalUrl: z.string(),
  previousCommitId: z.string(),
  commitId: z.string(),
  changed: z.boolean(),
  titleChanged: z.boolean(),
  bodyChanged: z.boolean(),
});

const replaceLinksOutputSchema = z.object({
  action: z.literal("replace-links"),
  fromTitle: z.string(),
  toTitle: z.string(),
  message: z.string(),
});

function success(value: object, summary: string): CallToolResult {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: value as Record<string, unknown>,
  };
}

function failure(error: unknown): CallToolResult {
  let message = "Cosense request failed.";
  if (error instanceof CosenseAuthenticationError) {
    message = "Cosense authentication failed.";
  } else if (error instanceof CosenseWriteConflictError) {
    switch (error.reason) {
      case "page-already-exists":
        message =
          "A Cosense page with this title already exists. Read it before deciding whether to append.";
        break;
      case "page-missing":
      case "page-renamed":
      case "page-replaced":
        message =
          "The target Cosense page is no longer the page intended by this write. Read it again before writing.";
        break;
      case "duplicate-title":
        message =
          "A Cosense page with this title was created concurrently. Read it before deciding whether to append or use another title.";
        break;
      case "stale-commit":
      case "not-fast-forward":
        message =
          "The Cosense page state changed after it was read. Read the current page and reassess the write.";
        break;
    }
  } else if (error instanceof CosenseWriteOutcomeUnknownError) {
    message =
      "Cosense may have committed the write, but the result could not be confirmed. Do not retry; call get_page first.";
  } else if (error instanceof CosenseReplaceLinksRetryableError) {
    message =
      "The Cosense link replacement result could not be confirmed. Do not retry automatically; after assessing partial completion, the exact same replace_links arguments are safe to retry.";
  } else if (error instanceof CosenseResponseError) {
    message = "Cosense returned an unexpected response.";
  } else if (error instanceof CosenseUpstreamError) {
    if (error.operation === "page edit submit" && error.status === 404) {
      message =
        "The Cosense write preview is unavailable or already consumed. Do not retry; call get_page first.";
    } else if (
      error.operation === "page edit preview" &&
      error.status === 422
    ) {
      message =
        "Cosense rejected the proposed page content. Review the title and text before trying again.";
    } else if (error.status === 429) {
      message = "Cosense is temporarily rate-limited. Try again later.";
    } else if (error.status >= 500) {
      message = "Cosense is temporarily unavailable.";
    } else {
      message = `Cosense request failed (HTTP ${error.status}).`;
    }
  }

  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export function createCosenseMcpServer(
  _requestContext: McpRequestContext,
  client: CosenseClient,
): McpServer {
  const server = new McpServer(
    {
      name: "shiyui-cosense-mcp",
      version: "0.2.0",
      description: serverDescription,
    },
    {
      instructions: serverInstructions,
      cacheHints: {
        "server/discover": { ttlMs: 0, cacheScope: "private" },
        "tools/list": { ttlMs: 0, cacheScope: "private" },
      },
    },
  );

  server.registerTool(
    "get_page",
    {
      title: "Get Cosense page",
      description:
        "Read one page from the fixed Cosense project. Returns the page body without author data or line IDs.",
      inputSchema: getPageInputSchema,
      outputSchema: getPageOutputSchema,
      annotations: readAnnotations,
    },
    async ({ title }, context) => {
      try {
        const value = await client.getPage({ title }, context.mcpReq.signal);
        return success(
          value,
          value.exists
            ? `Loaded “${value.title}” (${value.text.length} characters).`
            : `“${value.title}” does not exist.`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "search_full_text",
    {
      title: "Search Cosense text",
      description:
        "Find indexed candidate snippets by words in ordinary page text. Results may lag edits and are not complete page bodies; call get_page for the selected title to read the current body.",
      inputSchema: searchFullTextInputSchema,
      outputSchema: fullTextSearchOutputSchema,
      annotations: readAnnotations,
    },
    async (input, context) => {
      try {
        const value = await client.searchFullText(input, context.mcpReq.signal);
        return success(value, `Found ${value.returned} full-text candidates.`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "search_vector",
    {
      title: "Search Cosense semantically",
      description:
        "Find indexed semantic candidates from Cosense page titles and inline link notation. Ordinary body text is not searched, results may lag edits, and scores are relative; call get_page for a selected existing title.",
      inputSchema: searchVectorInputSchema,
      outputSchema: vectorSearchOutputSchema,
      annotations: readAnnotations,
    },
    async (input, context) => {
      try {
        const value = await client.searchVector(input, context.mcpReq.signal);
        return success(value, `Found ${value.returned} vector candidates.`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_related_pages",
    {
      title: "Get related Cosense pages",
      description:
        "List 1-hop or 2-hop candidate pages from the fixed Cosense project. Returns metadata and pagination, not current page bodies; call get_page for selected titles.",
      inputSchema: getRelatedPagesInputSchema,
      outputSchema: relatedPagesOutputSchema,
      annotations: readAnnotations,
    },
    async (input, context) => {
      try {
        const value = await client.getRelatedPages(
          {
            title: input.title,
            hop: input.hop,
            match: input.match,
            limit: input.limit,
            ...(input.query === undefined ? {} : { query: input.query }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          },
          context.mcpReq.signal,
        );
        return success(value, `Found ${value.returned} related pages.`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_pages",
    {
      title: "List Cosense pages",
      description:
        "List one bounded page of metadata from the fixed Cosense project, without fetching page bodies. Cosense always places pinned pages first, so sort does not define a pure global order. reportedCount is Cosense's reported total page count, not a per-call limit. Use get_page to read a selected page. Additional pages are fetched only when called again with nextSkip as skip.",
      inputSchema: listPagesInputSchema,
      outputSchema: listPagesOutputSchema,
      annotations: readAnnotations,
    },
    async (input, context) => {
      try {
        const value = await client.listPages(input, context.mcpReq.signal);
        return success(value, `Listed ${value.returned} Cosense pages.`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_page_changes",
    {
      title: "Get Cosense page changes",
      description:
        "Use only when the user asks about edit history, how a page changed, or differences since an earlier commitId; do not call for routine page reads. Return at most the latest 100 explainable changes for one page in the fixed Cosense project, with before and after text limited to 2,000 characters each. Pass pageId and optionally commitId from get_page to return only later changes. Actor names are resolved with one project-users request; no other pages or histories are fetched.",
      inputSchema: getPageChangesInputSchema,
      outputSchema: pageChangesOutputSchema,
      annotations: readAnnotations,
    },
    async (input, context) => {
      try {
        const value = await client.getPageChanges(
          {
            pageId: input.pageId,
            ...(input.commitId === undefined
              ? {}
              : { commitId: input.commitId }),
          },
          context.mcpReq.signal,
        );
        return success(
          value,
          `Found ${value.returned} changes across ${value.commitCount} commits.`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "create_page",
    {
      title: "Create Cosense page",
      description:
        "Create one page in the fixed Cosense project when the user's request clearly identifies the page and intent. The final wording may be composed within that request. Fails if the page already exists and never falls back to append or overwrite. The client checks absence, previews the exact page, and submits once without retrying. If the outcome is uncertain, call get_page before any further write.",
      inputSchema: createPageInputSchema,
      outputSchema: writePageOutputSchema,
      annotations: writeAnnotations,
    },
    async (input, context) => {
      try {
        const value = await client.createPage(input, context.mcpReq.signal);
        return success(
          value,
          `Created “${value.title}” with ${value.addedLines} total lines.`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "append_to_page",
    {
      title: "Append to Cosense page",
      description:
        "Append non-blank text to the end of one existing page in the fixed Cosense project when the user's write intent and target are clear. Pass the current commitId from get_page as expectedCommitId; reuse an already current result instead of reading only for confirmation. Fails if the page is missing, renamed, or changed; it never creates, replaces, or deletes content. The client previews and submits once without retrying. If the outcome is uncertain, call get_page before any further write.",
      inputSchema: appendToPageInputSchema,
      outputSchema: writePageOutputSchema,
      annotations: writeAnnotations,
    },
    async (input, context) => {
      try {
        const value = await client.appendToPage(input, context.mcpReq.signal);
        return success(
          value,
          `Appended ${value.addedLines} lines to “${value.title}”.`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "update_page",
    {
      title: "Update Cosense page",
      description:
        "Update one existing page in the fixed Cosense project, including replacing its body, changing its title, or both, when the user's write intent and target are clear. Pass the current commitId from get_page as expectedCommitId. body is the complete final page body excluding the title: omit it to keep the body, or pass an empty string to delete the body. When body is provided, every existing body line omitted from it is deleted. The client previews and submits once without retrying. update_page does not rewrite links; when the same user request clearly includes both rename and link replacement, call replace_links afterward with the actual submitted title.",
      inputSchema: updatePageInputSchema,
      outputSchema: updatePageOutputSchema,
      annotations: destructiveWriteAnnotations,
    },
    async (input, context) => {
      try {
        const value = await client.updatePage(input, context.mcpReq.signal);
        const summary = !value.changed
          ? `No changes were needed for “${value.title}”.`
          : value.titleChanged
            ? `Updated “${value.previousTitle}” and renamed it to “${value.title}”.`
            : `Updated “${value.title}”.`;
        return success(value, summary);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "replace_links",
    {
      title: "Replace Cosense links",
      description:
        "Replace links project-wide in the fixed Cosense project from one exact title to another. This directly replaces [title], #title, and [title.icon] references without preview and does not rename any page. Use get_page only when inspection is needed. Call when the user's request clearly includes this project-wide replacement, including as the next step of a requested rename; do not infer link replacement from a rename that did not request it.",
      inputSchema: replaceLinksInputSchema,
      outputSchema: replaceLinksOutputSchema,
      annotations: destructiveWriteAnnotations,
    },
    async (input, context) => {
      try {
        const value = await client.replaceLinks(input, context.mcpReq.signal);
        return success(
          value,
          `Replaced project links from “${value.fromTitle}” to “${value.toTitle}”.`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
