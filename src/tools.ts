import {
  McpServer,
  type CallToolResult,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  CosenseAuthenticationError,
  CosenseReplaceLinksRetryableError,
  CosenseResponseError,
  CosenseUpstreamError,
  CosenseWriteConflictError,
  CosenseWriteOutcomeUnknownError,
  type CosenseClient,
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
const MAX_INPUT_LENGTH = 500;
const MAX_WRITE_TEXT_LENGTH = 10_000;
const MAX_WRITE_LINES = 100;

const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_INPUT_LENGTH)
  .refine((title) => title !== "." && title !== "..", {
    message: "Dot-segment titles are not supported",
  });
const writeTitleSchema = titleSchema.refine(
  (title) => !/[\r\n\u0000]/.test(title),
  { message: "Write titles must not contain CR, LF, or NUL" },
);
const querySchema = z.string().trim().min(1).max(MAX_INPUT_LENGTH);
const limitSchema = z.number().int().min(1).max(20).default(10);
const matchSchema = z.enum(["and", "or"]).default("and");
const pageIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_INPUT_LENGTH)
  .refine((pageId) => pageId !== "." && pageId !== "..", {
    message: "Dot-segment page IDs are not supported",
  });
const commitIdSchema = z.string().trim().min(1).max(MAX_INPUT_LENGTH);
const writeTextSchema = z
  .string()
  .max(MAX_WRITE_TEXT_LENGTH)
  .refine((text) => text.trim().length > 0, {
    message: "Text must not be blank",
  })
  .refine((text) => !text.includes("\u0000"), {
    message: "Text must not contain NUL",
  })
  .refine((text) => text.split(/\r?\n/).length <= MAX_WRITE_LINES, {
    message: `Text must contain at most ${MAX_WRITE_LINES} lines`,
  });
const updateBodySchema = z
  .string()
  .max(MAX_WRITE_TEXT_LENGTH)
  .refine((body) => !body.includes("\u0000"), {
    message: "Body must not contain NUL",
  })
  .refine((body) => body.split(/\r?\n/).length <= MAX_WRITE_LINES, {
    message: `Body must contain at most ${MAX_WRITE_LINES} lines`,
  });
const updatePageInputSchema = z
  .object({
    title: writeTitleSchema,
    expectedCommitId: commitIdSchema,
    body: updateBodySchema.optional(),
    newTitle: writeTitleSchema.optional(),
  })
  .strict()
  .refine(
    ({ body, newTitle }) => body !== undefined || newTitle !== undefined,
    { message: "Provide body, newTitle, or both" },
  );
const normalizedTitle = (title: string): string =>
  title.toLowerCase().replaceAll(" ", "_");
const replaceLinksInputSchema = z
  .object({
    fromTitle: writeTitleSchema,
    toTitle: writeTitleSchema,
  })
  .strict()
  .refine(
    ({ fromTitle, toTitle }) =>
      normalizedTitle(fromTitle) !== normalizedTitle(toTitle),
    { message: "Source and destination titles must be different" },
  );

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
          "The target Cosense page is no longer the page that was approved. Read it again before writing.";
        break;
      case "duplicate-title":
        message =
          "A Cosense page with this title was created concurrently. Read it and ask whether to append or use another title.";
        break;
      case "stale-commit":
      case "not-fast-forward":
        message =
          "The Cosense page state changed after it was read. Read the current page and confirm the write again.";
        break;
    }
  } else if (error instanceof CosenseWriteOutcomeUnknownError) {
    message =
      "Cosense may have committed the write, but the result could not be confirmed. Do not retry; call get_page first.";
  } else if (error instanceof CosenseReplaceLinksRetryableError) {
    message =
      "The Cosense link replacement result could not be confirmed. Do not retry automatically; after user confirmation, the exact same replace_links arguments are safe to retry.";
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
    { name: "shiyui-cosense-mcp", version: "0.2.0" },
    {
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
      inputSchema: z.object({ title: titleSchema }),
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
      inputSchema: z.object({
        query: querySchema,
        match: matchSchema,
        sort: z.enum(["pageRank", "updated"]).default("pageRank"),
        limit: limitSchema,
      }),
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
      inputSchema: z.object({
        query: querySchema,
        limit: limitSchema,
      }),
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
      inputSchema: z.object({
        title: titleSchema,
        hop: z.union([z.literal(1), z.literal(2)]).default(1),
        query: querySchema.optional(),
        match: matchSchema,
        limit: limitSchema,
        cursor: z.string().min(1).max(MAX_INPUT_LENGTH).optional(),
      }),
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
      inputSchema: z.object({
        sort: z
          .enum(["updated", "created", "accessed", "linked", "views", "title"])
          .default("updated"),
        limit: limitSchema,
        skip: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .default(0),
      }),
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
        "Use only when the user asks about edit history, how a page changed, or differences since an earlier commitId; do not call for routine page reads. Return at most the latest 50 explainable changes for one page in the fixed Cosense project. Pass pageId and optionally commitId from get_page to return only later changes. Actor names are resolved with one project-users request; no other pages or histories are fetched.",
      inputSchema: z.object({
        pageId: pageIdSchema,
        commitId: commitIdSchema.optional(),
      }),
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
        "Create one page in the fixed Cosense project. Call only after the user has approved the exact title and text. Fails if the page already exists and never falls back to append or overwrite. The client checks absence, previews the exact page, and submits once without retrying. If the outcome is uncertain, call get_page before any further write.",
      inputSchema: z
        .object({
          title: writeTitleSchema,
          text: writeTextSchema,
        })
        .strict(),
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
        "Append exact text to the end of one existing page in the fixed Cosense project. First call get_page, then pass its current commitId as expectedCommitId, and call only after the user has approved the exact title and text. Fails if the page is missing, renamed, or changed; it never creates, replaces, or deletes content. The client previews and submits once without retrying. If the outcome is uncertain, call get_page before any further write.",
      inputSchema: z
        .object({
          title: writeTitleSchema,
          text: writeTextSchema,
          expectedCommitId: commitIdSchema,
        })
        .strict(),
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
        "Update one existing page in the fixed Cosense project, including replacing its body, changing its title, or both. First call get_page and pass its current commitId as expectedCommitId. body is the complete final page body excluding the title: omit it to keep the body, or pass an empty string to delete the body. When body is provided, every existing body line omitted from it is deleted. Call only after the user has approved the exact supplied final body and/or new title. The client previews and submits once without retrying. After a title change, ask separately before calling replace_links; update_page does not rewrite links.",
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
        "Replace links project-wide in the fixed Cosense project from one exact title to another. This directly replaces [title], #title, and [title.icon] references without preview and does not rename any page. Use get_page to inspect relevant pages when needed, and call only after the user has approved the exact fromTitle and toTitle. Do not call automatically after update_page; ask separately after a rename.",
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
