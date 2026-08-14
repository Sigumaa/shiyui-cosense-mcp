import { createMcpHandler, type StatelessMcpHandler } from "agents/mcp/server";
import { describe, expect, it, vi } from "vitest";

import {
  CosenseAuthenticationError,
  CosenseReplaceLinksRetryableError,
  CosenseUpstreamError,
  CosenseWriteConflictError,
  CosenseWriteOutcomeUnknownError,
  type CosenseClient,
} from "../src/cosense";
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
    listPages: vi.fn(async ({ skip }) => ({
      reportedCount: 0,
      skip: skip ?? 0,
      returned: 0,
      hasNext: false,
      results: [],
    })),
    getPageChanges: vi.fn(async ({ pageId, commitId }) => ({
      pageId,
      ...(commitId === undefined ? {} : { afterCommitId: commitId }),
      commitCount: 0,
      totalChanges: 0,
      returned: 0,
      truncated: false,
      changes: [],
    })),
    createPage: vi.fn(async ({ title, text }) => ({
      action: "create" as const,
      title,
      canonicalUrl: `https://scrapbox.io/shiyui/${encodeURIComponent(title)}`,
      commitId: "created-commit-id",
      addedLines: text.split(/\r?\n/).length + 1,
    })),
    appendToPage: vi.fn(async ({ title, text, expectedCommitId }) => ({
      action: "append" as const,
      title,
      canonicalUrl: `https://scrapbox.io/shiyui/${encodeURIComponent(title)}`,
      commitId: "appended-commit-id",
      previousCommitId: expectedCommitId,
      addedLines: text.split(/\r?\n/).length,
    })),
    updatePage: vi.fn(async ({ title, body, newTitle, expectedCommitId }) => ({
      action: "update" as const,
      previousTitle: title,
      title: newTitle ?? title,
      canonicalUrl: `https://scrapbox.io/shiyui/${encodeURIComponent(newTitle ?? title)}`,
      previousCommitId: expectedCommitId,
      commitId: "updated-commit-id",
      changed: true,
      titleChanged: newTitle !== undefined && newTitle !== title,
      bodyChanged: body !== undefined,
    })),
    replaceLinks: vi.fn(async ({ fromTitle, toTitle }) => ({
      action: "replace-links" as const,
      fromTitle,
      toTitle,
      message: "Links replaced.",
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
  it("publishes fixed-project read and write tools with private no-cache metadata", async () => {
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
      "list_pages",
      "get_page_changes",
      "create_page",
      "append_to_page",
      "update_page",
      "replace_links",
    ]);
    expect(
      result.tools.find(({ name }) => name === "list_pages")?.description,
    ).toContain("pinned pages first");
    expect(
      result.tools.find(({ name }) => name === "list_pages")?.description,
    ).toContain("reported total page count");
    expect(
      result.tools.find(({ name }) => name === "get_page_changes")?.description,
    ).toContain("do not call for routine page reads");

    const expectedProperties = {
      get_page: ["title"],
      search_full_text: ["limit", "match", "query", "sort"],
      search_vector: ["limit", "query"],
      get_related_pages: ["cursor", "hop", "limit", "match", "query", "title"],
      list_pages: ["limit", "skip", "sort"],
      get_page_changes: ["commitId", "pageId"],
      create_page: ["text", "title"],
      append_to_page: ["expectedCommitId", "text", "title"],
      update_page: ["body", "expectedCommitId", "newTitle", "title"],
      replace_links: ["fromTitle", "toTitle"],
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
      list_pages: [
        "hasNext",
        "nextSkip",
        "reportedCount",
        "results",
        "returned",
        "skip",
      ],
      get_page_changes: [
        "afterCommitId",
        "changes",
        "commitCount",
        "latestCommitId",
        "latestTitleChange",
        "pageId",
        "returned",
        "totalChanges",
        "truncated",
      ],
      create_page: [
        "action",
        "addedLines",
        "canonicalUrl",
        "commitId",
        "previousCommitId",
        "title",
      ],
      append_to_page: [
        "action",
        "addedLines",
        "canonicalUrl",
        "commitId",
        "previousCommitId",
        "title",
      ],
      update_page: [
        "action",
        "bodyChanged",
        "canonicalUrl",
        "changed",
        "commitId",
        "previousCommitId",
        "previousTitle",
        "title",
        "titleChanged",
      ],
      replace_links: ["action", "fromTitle", "message", "toTitle"],
    };
    const expectedTitles = {
      get_page: "Get Cosense page",
      search_full_text: "Search Cosense text",
      search_vector: "Search Cosense semantically",
      get_related_pages: "Get related Cosense pages",
      list_pages: "List Cosense pages",
      get_page_changes: "Get Cosense page changes",
      create_page: "Create Cosense page",
      append_to_page: "Append to Cosense page",
      update_page: "Update Cosense page",
      replace_links: "Replace Cosense links",
    };

    for (const tool of result.tools) {
      if (tool.name === "create_page" || tool.name === "append_to_page") {
        expect(tool.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        });
      } else if (tool.name === "update_page" || tool.name === "replace_links") {
        expect(tool.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        });
      } else {
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true,
          openWorldHint: true,
        });
      }
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

  it("creates a page only with the exact bounded title and text", async () => {
    const client = createStubClient();
    const response = await modernRequest(createHandler(client), "tools/call", {
      name: "create_page",
      arguments: { title: " 山形 ", text: "候補1\n候補2" },
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      resultType: "complete",
      content: [{ type: "text", text: "Created “山形” with 3 total lines." }],
      structuredContent: {
        action: "create",
        title: "山形",
        commitId: "created-commit-id",
        addedLines: 3,
      },
    });
    expect(client.createPage).toHaveBeenCalledOnce();
    expect(client.createPage).toHaveBeenCalledWith(
      { title: "山形", text: "候補1\n候補2" },
      expect.any(AbortSignal),
    );
  });

  it("appends only against the approved commit", async () => {
    const client = createStubClient();
    const response = await modernRequest(createHandler(client), "tools/call", {
      name: "append_to_page",
      arguments: {
        title: " 山形 ",
        text: "\n新しい候補",
        expectedCommitId: " commit-id ",
      },
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      resultType: "complete",
      content: [{ type: "text", text: "Appended 2 lines to “山形”." }],
      structuredContent: {
        action: "append",
        title: "山形",
        commitId: "appended-commit-id",
        previousCommitId: "commit-id",
        addedLines: 2,
      },
    });
    expect(client.appendToPage).toHaveBeenCalledOnce();
    expect(client.appendToPage).toHaveBeenCalledWith(
      {
        title: "山形",
        text: "\n新しい候補",
        expectedCommitId: "commit-id",
      },
      expect.any(AbortSignal),
    );
  });

  it("updates to an approved complete body and title against one commit", async () => {
    const client = createStubClient();
    const response = await modernRequest(createHandler(client), "tools/call", {
      name: "update_page",
      arguments: {
        title: " 山形 ",
        expectedCommitId: " commit-id ",
        body: "",
        newTitle: " 蔵王 ",
      },
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      resultType: "complete",
      content: [
        {
          type: "text",
          text: "Updated “山形” and renamed it to “蔵王”.",
        },
      ],
      structuredContent: {
        action: "update",
        previousTitle: "山形",
        title: "蔵王",
        previousCommitId: "commit-id",
        commitId: "updated-commit-id",
        changed: true,
        titleChanged: true,
        bodyChanged: true,
      },
    });
    expect(client.updatePage).toHaveBeenCalledOnce();
    expect(client.updatePage).toHaveBeenCalledWith(
      {
        title: "山形",
        expectedCommitId: "commit-id",
        body: "",
        newTitle: "蔵王",
      },
      expect.any(AbortSignal),
    );
  });

  it("replaces project links only for the exact approved title pair", async () => {
    const client = createStubClient();
    const response = await modernRequest(createHandler(client), "tools/call", {
      name: "replace_links",
      arguments: { fromTitle: " 山形 ", toTitle: " 蔵王 " },
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      resultType: "complete",
      content: [
        {
          type: "text",
          text: "Replaced project links from “山形” to “蔵王”.",
        },
      ],
      structuredContent: {
        action: "replace-links",
        fromTitle: "山形",
        toTitle: "蔵王",
        message: "Links replaced.",
      },
    });
    expect(client.replaceLinks).toHaveBeenCalledOnce();
    expect(client.replaceLinks).toHaveBeenCalledWith(
      { fromTitle: "山形", toTitle: "蔵王" },
      expect.any(AbortSignal),
    );
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

  it("passes list defaults to one bounded client request", async () => {
    const client = createStubClient();
    const response = await modernRequest(createHandler(client), "tools/call", {
      name: "list_pages",
      arguments: {},
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      resultType: "complete",
      content: [{ type: "text", text: "Listed 0 Cosense pages." }],
      structuredContent: {
        reportedCount: 0,
        skip: 0,
        returned: 0,
        hasNext: false,
        results: [],
      },
    });
    expect(client.listPages).toHaveBeenCalledOnce();
    expect(client.listPages).toHaveBeenCalledWith(
      { sort: "updated", limit: 10, skip: 0 },
      expect.any(AbortSignal),
    );
  });

  it("passes page and optional commit IDs to one change-history request", async () => {
    const client = createStubClient();
    const response = await modernRequest(createHandler(client), "tools/call", {
      name: "get_page_changes",
      arguments: { pageId: " page-id ", commitId: " commit-id " },
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      resultType: "complete",
      content: [
        {
          type: "text",
          text: "Found 0 changes across 0 commits.",
        },
      ],
      structuredContent: {
        pageId: "page-id",
        afterCommitId: "commit-id",
        commitCount: 0,
        totalChanges: 0,
        returned: 0,
        truncated: false,
        changes: [],
      },
    });
    expect(client.getPageChanges).toHaveBeenCalledOnce();
    expect(client.getPageChanges).toHaveBeenCalledWith(
      { pageId: "page-id", commitId: "commit-id" },
      expect.any(AbortSignal),
    );
  });

  it("rejects unsafe list and change-history inputs before calling Cosense", async () => {
    const client = createStubClient();
    const handler = createHandler(client);

    for (const [name, arguments_] of [
      ["list_pages", { limit: 21 }],
      ["list_pages", { skip: -1 }],
      ["list_pages", { skip: Number.MAX_SAFE_INTEGER + 1 }],
      ["get_page_changes", { pageId: ".." }],
      ["get_page_changes", { pageId: "page-id", commitId: " " }],
    ] as const) {
      const response = await modernRequest(handler, "tools/call", {
        name,
        arguments: arguments_,
      });
      expect(response.result).toMatchObject({ isError: true });
    }

    expect(client.listPages).not.toHaveBeenCalled();
    expect(client.getPageChanges).not.toHaveBeenCalled();
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

  it("rejects unsafe write input before calling Cosense", async () => {
    const client = createStubClient();
    const handler = createHandler(client);

    for (const [name, arguments_] of [
      ["create_page", { title: "山形", text: " " }],
      ["create_page", { title: "..", text: "本文" }],
      ["create_page", { title: "山形", text: "a".repeat(10_001) }],
      ["create_page", { title: "山形", text: "line\n".repeat(100) }],
      ["create_page", { title: "山形", text: "before\u0000after" }],
      ["create_page", { title: "山\n形", text: "本文" }],
      ["create_page", { title: "山\u0000形", text: "本文" }],
      ["create_page", { title: "山形", text: "本文", project: "other" }],
      [
        "append_to_page",
        { title: "山形", text: "本文", expectedCommitId: " " },
      ],
      ["update_page", { title: "山形", expectedCommitId: "commit-id" }],
      [
        "update_page",
        {
          title: "山形",
          expectedCommitId: "commit-id",
          body: "a".repeat(10_001),
        },
      ],
      [
        "update_page",
        {
          title: "山形",
          expectedCommitId: "commit-id",
          body: "line\n".repeat(100),
        },
      ],
      [
        "update_page",
        {
          title: "山形",
          expectedCommitId: "commit-id",
          body: "before\u0000after",
        },
      ],
      ["replace_links", { fromTitle: "Foo Bar", toTitle: "foo_bar" }],
      ["replace_links", { fromTitle: "山形", toTitle: "蔵\n王" }],
    ] as const) {
      const response = await modernRequest(handler, "tools/call", {
        name,
        arguments: arguments_,
      });
      expect(response.result).toMatchObject({ isError: true });
    }

    expect(client.createPage).not.toHaveBeenCalled();
    expect(client.appendToPage).not.toHaveBeenCalled();
    expect(client.updatePage).not.toHaveBeenCalled();
    expect(client.replaceLinks).not.toHaveBeenCalled();
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

  it.each([
    [
      new CosenseWriteConflictError("stale-commit", "page append"),
      "The Cosense page state changed after it was read. Read the current page and confirm the write again.",
    ],
    [
      new CosenseWriteConflictError("page-already-exists", "page create"),
      "A Cosense page with this title already exists. Read it before deciding whether to append.",
    ],
    [
      new CosenseWriteOutcomeUnknownError(new TypeError("secret detail")),
      "Cosense may have committed the write, but the result could not be confirmed. Do not retry; call get_page first.",
    ],
    [
      new CosenseUpstreamError(404, "page edit submit"),
      "The Cosense write preview is unavailable or already consumed. Do not retry; call get_page first.",
    ],
  ])("returns an actionable safe write failure", async (error, message) => {
    const client = createStubClient();
    vi.mocked(client.createPage).mockRejectedValue(error);

    const response = await modernRequest(createHandler(client), "tools/call", {
      name: "create_page",
      arguments: { title: "山形", text: "本文" },
    });

    expect(response.result).toMatchObject({
      resultType: "complete",
      isError: true,
      content: [{ type: "text", text: message }],
    });
    expect(JSON.stringify(response)).not.toContain("secret detail");
  });

  it("returns a safe retry instruction for an uncertain link replacement", async () => {
    const client = createStubClient();
    vi.mocked(client.replaceLinks).mockRejectedValue(
      new CosenseReplaceLinksRetryableError(new TypeError("secret detail")),
    );

    const response = await modernRequest(createHandler(client), "tools/call", {
      name: "replace_links",
      arguments: { fromTitle: "山形", toTitle: "蔵王" },
    });

    expect(response.result).toMatchObject({
      resultType: "complete",
      isError: true,
      content: [
        {
          type: "text",
          text: "The Cosense link replacement result could not be confirmed. Do not retry automatically; after user confirmation, the exact same replace_links arguments are safe to retry.",
        },
      ],
    });
    expect(JSON.stringify(response)).not.toContain("secret detail");
  });
});
