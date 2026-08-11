import {
  McpServer,
  type CallToolResult,
  type McpRequestContext,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";

import {
  CosenseResponseError,
  CosenseUpstreamError,
  createCosenseClient,
  type CosenseClient,
} from "./cosense";
import { READ_SCOPE, hasReadAuthorizationProps } from "./env";

const annotations = {
  readOnlyHint: true,
  openWorldHint: true,
} as const;

const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine((title) => title !== "." && title !== "..", {
    message: "Dot-segment titles are not supported",
  });
const querySchema = z.string().trim().min(1).max(2_000);
const limitSchema = z.number().int().min(1).max(20).default(10);
const matchSchema = z.enum(["and", "or"]).default("and");

function requireReadAccess(
  context: ServerContext,
  requestContext: McpRequestContext,
): void {
  const standardAuth = context.http?.authInfo ?? requestContext.authInfo;
  if (standardAuth && !standardAuth.scopes.includes(READ_SCOPE)) {
    throw new Error("insufficient_scope");
  }

  if (!hasReadAuthorizationProps(getMcpAuthContext()?.props)) {
    throw new Error("missing_authorization_context");
  }
}

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
  } else if (
    error instanceof Error &&
    (error.message === "insufficient_scope" ||
      error.message === "missing_authorization_context")
  ) {
    message = `Authorization with ${READ_SCOPE} is required.`;
  }

  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export function createCosenseMcpServer(
  requestContext: McpRequestContext,
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
      description:
        "Read one page from the fixed public Cosense project. Returns the page body without author data or line IDs.",
      inputSchema: z.object({ title: titleSchema }),
      annotations,
    },
    async ({ title }, context) => {
      try {
        requireReadAccess(context, requestContext);
        const value = await client.getPage({ title });
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
      description:
        "Search page bodies in the fixed public Cosense project. Use this when the requested words may appear in ordinary body text.",
      inputSchema: z.object({
        query: querySchema,
        match: matchSchema,
        sort: z.enum(["pageRank", "updated"]).default("pageRank"),
        limit: limitSchema,
      }),
      annotations,
    },
    async (input, context) => {
      try {
        requireReadAccess(context, requestContext);
        const value = await client.searchFullText(input);
        return success(value, `Found ${value.returned} full-text candidates.`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "search_vector",
    {
      description:
        "Semantic search over Cosense page titles and inline link notation. Ordinary body text is not searched; score values are only relative ranking signals.",
      inputSchema: z.object({
        query: querySchema,
        limit: limitSchema,
      }),
      annotations,
    },
    async (input, context) => {
      try {
        requireReadAccess(context, requestContext);
        const value = await client.searchVector(input);
        return success(value, `Found ${value.returned} vector candidates.`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_related_pages",
    {
      description:
        "List 1-hop or 2-hop related pages from the fixed public Cosense project. Returns metadata and pagination, not page bodies.",
      inputSchema: z.object({
        title: titleSchema,
        hop: z.union([z.literal(1), z.literal(2)]).default(1),
        query: querySchema.optional(),
        match: matchSchema,
        limit: limitSchema,
        cursor: z.string().min(1).max(2_000).optional(),
      }),
      annotations,
    },
    async (input, context) => {
      try {
        requireReadAccess(context, requestContext);
        const value = await client.getRelatedPages({
          title: input.title,
          hop: input.hop,
          match: input.match,
          limit: input.limit,
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        });
        return success(value, `Found ${value.returned} related pages.`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
