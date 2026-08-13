import { createMcpHandler, type StatelessMcpHandler } from "agents/mcp/server";
import { describe, expect, it, vi } from "vitest";

import { CosenseAuthenticationError, type CosenseClient } from "../src/cosense";
import { createCosenseMcpServer } from "../src/tools";

const MODERN_PROTOCOL_VERSION = "2026-07-28";

interface JsonRpcResponse {
  error?: { code: number; message: string };
  id: number;
  jsonrpc: "2.0";
  result?: Record<string, unknown>;
}

function createStubClient(): CosenseClient {
  return {
    getPage: vi.fn(async ({ title }) => ({
      exists: true,
      title,
      canonicalUrl: `https://scrapbox.io/shiyui/${encodeURIComponent(title)}`,
      pageId: "page-id",
      commitId: "commit-id",
      text: "short body",
    })),
    searchFullText: vi.fn(async () => ({
      returned: 0,
      truncated: false,
      results: [],
    })),
    searchVector: vi.fn(async () => ({
      returned: 0,
      localTruncated: false,
      results: [],
    })),
    getRelatedPages: vi.fn(async () => ({
      hasNext: false,
      returned: 0,
      results: [],
    })),
  };
}

function createHandler(client: CosenseClient): StatelessMcpHandler {
  return createMcpHandler(
    (requestContext) => createCosenseMcpServer(requestContext, client),
    {
      route: "/mcp",
      legacy: "reject",
      corsOptions: false,
    },
  );
}

async function modernRequest(
  handler: StatelessMcpHandler,
  method: string,
  params: Record<string, unknown> = {},
): Promise<JsonRpcResponse> {
  const headers = new Headers({
    "Content-Type": "application/json",
    Host: "localhost",
    "Mcp-Method": method,
    "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
  });
  if (method === "tools/call" && typeof params.name === "string") {
    headers.set("Mcp-Name", params.name);
  }

  const response = await handler.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  );

  if (response.status !== 200) {
    throw new Error(
      `Unexpected HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return response.json<JsonRpcResponse>();
}

describe("createCosenseMcpServer", () => {
  it("publishes only the four fixed-project read tools with private no-cache metadata", async () => {
    const response = await modernRequest(
      createHandler(createStubClient()),
      "tools/list",
    );
    expect(response.error).toBeUndefined();

    const result = response.result as {
      cacheScope: string;
      resultType: string;
      tools: Array<{
        annotations?: Record<string, unknown>;
        description?: string;
        inputSchema: { properties?: Record<string, unknown> };
        name: string;
        outputSchema?: {
          properties?: Record<string, unknown>;
          type?: string;
        };
        title?: string;
      }>;
      ttlMs: number;
    };

    expect(result).toMatchObject({
      resultType: "complete",
      ttlMs: 0,
      cacheScope: "private",
    });
    expect(result.tools.map(({ name }) => name)).toEqual([
      "get_page",
      "search_full_text",
      "search_vector",
      "get_related_pages",
    ]);

    const expectedProperties = {
      get_page: ["title"],
      search_full_text: ["limit", "match", "query", "sort"],
      search_vector: ["limit", "query"],
      get_related_pages: ["cursor", "hop", "limit", "match", "query", "title"],
    };
    const expectedOutputProperties = {
      get_page: [
        "canonicalUrl",
        "commitId",
        "createdAt",
        "exists",
        "linked",
        "links",
        "pageId",
        "pageRank",
        "text",
        "title",
        "updatedAt",
      ],
      search_full_text: [
        "exactTitleMatch",
        "reportedCount",
        "results",
        "returned",
        "truncated",
      ],
      search_vector: ["localTruncated", "results", "returned"],
      get_related_pages: [
        "hasNext",
        "nextCursor",
        "results",
        "returned",
        "total",
      ],
    };
    const expectedTitles = {
      get_page: "Get Cosense page",
      search_full_text: "Search Cosense text",
      search_vector: "Search Cosense semantically",
      get_related_pages: "Get related Cosense pages",
    };

    for (const tool of result.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: true,
      });
      expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(
        expectedProperties[tool.name as keyof typeof expectedProperties],
      );
      expect(tool.title).toBe(
        expectedTitles[tool.name as keyof typeof expectedTitles],
      );
      expect(tool.outputSchema?.type).toBe("object");
      expect(Object.keys(tool.outputSchema?.properties ?? {}).sort()).toEqual(
        expectedOutputProperties[
          tool.name as keyof typeof expectedOutputProperties
        ],
      );
      if (tool.name !== "get_page") {
        expect(tool.description).toContain("get_page");
      }
    }
  });

  it("returns compact text plus structured content for a tool call", async () => {
    const client = createStubClient();
    const response = await modernRequest(createHandler(client), "tools/call", {
      name: "get_page",
      arguments: { title: "test page" },
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      resultType: "complete",
      content: [
        {
          type: "text",
          text: "Loaded “test page” (10 characters).",
        },
      ],
      structuredContent: {
        exists: true,
        title: "test page",
        text: "short body",
      },
    });
    expect(client.getPage).toHaveBeenCalledOnce();
    expect(client.getPage).toHaveBeenCalledWith(
      { title: "test page" },
      expect.any(AbortSignal),
    );
  });

  it("rejects oversized input before calling Cosense", async () => {
    const client = createStubClient();
    const response = await modernRequest(createHandler(client), "tools/call", {
      name: "get_page",
      arguments: { title: "日".repeat(501) },
    });

    expect(response.result).toMatchObject({ isError: true });
    expect(client.getPage).not.toHaveBeenCalled();
  });

  it("returns a safe authentication failure without an HTTP status", async () => {
    const client = createStubClient();
    vi.mocked(client.getPage).mockRejectedValue(
      new CosenseAuthenticationError(401, "page"),
    );

    const response = await modernRequest(createHandler(client), "tools/call", {
      name: "get_page",
      arguments: { title: "private page" },
    });

    expect(response.result).toMatchObject({
      resultType: "complete",
      isError: true,
      content: [{ type: "text", text: "Cosense authentication failed." }],
    });
    expect(JSON.stringify(response)).not.toContain("401");
  });
});
