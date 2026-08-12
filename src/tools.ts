import {
  McpServer,
  type CallToolResult,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  CosenseResponseError,
  CosenseUpstreamError,
  createCosenseClient,
  type CosenseClient,
} from "./cosense";

const annotations = {
  readOnlyHint: true,
  openWorldHint: true,
} as const;
const MAX_INPUT_LENGTH = 500;

const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_INPUT_LENGTH)
  .refine((title) => title !== "." && title !== "..", {
    message: "Dot-segment titles are not supported",
  });
const querySchema = z.string().trim().min(1).max(MAX_INPUT_LENGTH);
const limitSchema = z.number().int().min(1).max(20).default(10);
const matchSchema = z.enum(["and", "or"]).default("and");

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

function success(value: object, summary: string): CallToolResult {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: value as Record<string, unknown>,
  };
}

function failure(error: unknown): CallToolResult {
  let message = "Cosense request failed.";
  if (error instanceof CosenseResponseError) {
    message = "Cosense returned an unexpected response.";
  } else if (error instanceof CosenseUpstreamError) {
    if (error.status === 429) {
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
  client: CosenseClient = createCosenseClient(),
): McpServer {
  const server = new McpServer(
    { name: "shiyui-cosense-mcp", version: "0.1.0" },
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
        "Read one page from the fixed public Cosense project. Returns the page body without author data or line IDs.",
      inputSchema: z.object({ title: titleSchema }),
      outputSchema: getPageOutputSchema,
      annotations,
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
      annotations,
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
      annotations,
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
        "List 1-hop or 2-hop candidate pages from the fixed public Cosense project. Returns metadata and pagination, not current page bodies; call get_page for selected titles.",
      inputSchema: z.object({
        title: titleSchema,
        hop: z.union([z.literal(1), z.literal(2)]).default(1),
        query: querySchema.optional(),
        match: matchSchema,
        limit: limitSchema,
        cursor: z.string().min(1).max(MAX_INPUT_LENGTH).optional(),
      }),
      outputSchema: relatedPagesOutputSchema,
      annotations,
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

  return server;
}
