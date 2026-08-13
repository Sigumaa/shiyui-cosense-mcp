import { exports } from "cloudflare:workers";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { worker } from "../src/index";

const TEAM_DOMAIN = "https://team.cloudflareaccess.com";
const POLICY_AUD = "access-application-audience";
const KEY_ID = "test-key";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const TEST_PERSONAL_ACCESS_TOKEN = "test-only-cosense-pat";
const workerBinding = (exports as unknown as { default: Fetcher }).default;

let signingKey: CryptoKey;
let jwks: { keys: Record<string, unknown>[] };

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  jwks = {
    keys: [
      {
        ...(await exportJWK(pair.publicKey)),
        alg: "RS256",
        kid: KEY_ID,
        use: "sig",
      },
    ],
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function expectNoStore(response: Response): void {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Pragma")).toBe("no-cache");
}

function mockJwks(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    expect(String(input)).toBe(`${TEAM_DOMAIN}/cdn-cgi/access/certs`);
    return Response.json(jwks);
  });
}

async function createAssertion(
  options: {
    audience?: string;
    expiresAt?: number;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
    .setIssuer(TEAM_DOMAIN)
    .setAudience(options.audience ?? POLICY_AUD)
    .setIssuedAt(now)
    .setNotBefore(now - 1)
    .setExpirationTime(options.expiresAt ?? now + 300)
    .sign(signingKey);
}

function toolsListRequest(assertion?: string): Request {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "Mcp-Method": "tools/list",
    "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
  });
  if (assertion) headers.set("Cf-Access-Jwt-Assertion", assertion);

  return new Request("https://mcp.example.com/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

function toolCallRequest(
  assertion: string,
  name: string,
  args: Record<string, unknown>,
): Request {
  return new Request("https://mcp.example.com/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Cf-Access-Jwt-Assertion": assertion,
      "Content-Type": "application/json",
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
      "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

function getPageRequest(assertion: string): Request {
  return toolCallRequest(assertion, "get_page", { title: "private page" });
}

function listPagesRequest(assertion: string): Request {
  return toolCallRequest(assertion, "list_pages", {
    sort: "updated",
    limit: 2,
    skip: 3,
  });
}

function mockJwksAndCosense(
  cosenseResponse: unknown = {
    persistent: true,
    title: "private page",
    id: "page-id",
    commitId: "commit-id",
    lines: [{ text: "private page" }, { text: "private body" }],
  },
): {
  cosenseCalls: Array<{
    cache: string | undefined;
    headers: Headers;
    method: string | undefined;
    url: string;
  }>;
} {
  const cosenseCalls: Array<{
    cache: string | undefined;
    headers: Headers;
    method: string | undefined;
    url: string;
  }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
      return Response.json(jwks);
    }
    if (url.startsWith("https://scrapbox.io/")) {
      cosenseCalls.push({
        url,
        method: init?.method,
        cache: init?.cache,
        headers: new Headers(init?.headers),
      });
      return Response.json(cosenseResponse);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { cosenseCalls };
}

async function fetchWorkerWithPat(
  request: Request,
  personalAccessToken?: string,
): Promise<Response> {
  const env = {
    TEAM_DOMAIN,
    POLICY_AUD,
    ...(personalAccessToken === undefined
      ? {}
      : { COSENSE_PAT: personalAccessToken }),
  } as Env;
  const fetch = worker.fetch as unknown as (
    request: Request,
    env: Env,
    context: ExecutionContext,
  ) => Promise<Response>;
  return fetch(request, env, {} as ExecutionContext);
}

describe("Access-protected MCP Worker", () => {
  it("rejects a request without an Access assertion", async () => {
    const externalFetch = vi.spyOn(globalThis, "fetch");
    const response = await workerBinding.fetch(toolsListRequest());

    expect(response.status).toBe(403);
    expectNoStore(response);
    expect(await response.text()).toBe("Forbidden");
    expect(externalFetch).not.toHaveBeenCalled();
  });

  it("accepts a valid assertion for this Access application", async () => {
    mockJwks();
    const response = await workerBinding.fetch(
      toolsListRequest(await createAssertion()),
    );
    const body = (await response.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(body.result?.tools?.map(({ name }) => name)).toEqual([
      "get_page",
      "search_full_text",
      "search_vector",
      "get_related_pages",
      "list_pages",
      "get_page_changes",
    ]);
  });

  it("uses the configured personal access token for a tool call", async () => {
    const { cosenseCalls } = mockJwksAndCosense();
    const response = await workerBinding.fetch(
      getPageRequest(await createAssertion()),
    );
    const body = (await response.json()) as {
      result?: { structuredContent?: Record<string, unknown> };
    };

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(body.result?.structuredContent).toMatchObject({
      exists: true,
      title: "private page",
      text: "private body",
    });
    expect(cosenseCalls).toHaveLength(1);
    expect(cosenseCalls[0]?.url).toBe(
      "https://scrapbox.io/api/pages/v2/shiyui/private%20page",
    );
    const headers = cosenseCalls[0]?.headers as Headers;
    expect(cosenseCalls[0]?.method).toBe("GET");
    expect(cosenseCalls[0]?.cache).toBe("no-store");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("x-personal-access-token")).toBe(
      TEST_PERSONAL_ACCESS_TOKEN,
    );
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("x-service-account-access-key")).toBe(false);
  });

  it("lists pages with one authenticated Cosense request and no detail fetches", async () => {
    const { cosenseCalls } = mockJwksAndCosense({
      projectName: "shiyui",
      count: 8,
      limit: 2,
      skip: 3,
      pages: [
        {
          id: "recent-page-id",
          title: "recent page",
          descriptions: ["recent description"],
          updated: 1_700_000_000,
        },
        {
          id: "older-page-id",
          title: "older page",
          descriptions: [],
          updated: 1_699_999_000,
        },
      ],
    });
    const response = await workerBinding.fetch(
      listPagesRequest(await createAssertion()),
    );
    const body = (await response.json()) as {
      result?: { structuredContent?: Record<string, unknown> };
    };

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(body.result?.structuredContent).toMatchObject({
      reportedCount: 8,
      skip: 3,
      returned: 2,
      hasNext: true,
      nextSkip: 5,
      results: [
        { pageId: "recent-page-id", title: "recent page" },
        { pageId: "older-page-id", title: "older page" },
      ],
    });
    expect(cosenseCalls).toHaveLength(1);
    expect(cosenseCalls[0]?.url).toBe(
      "https://scrapbox.io/api/pages/shiyui/?sort=updated&limit=2&skip=3",
    );
    const headers = cosenseCalls[0]?.headers as Headers;
    expect(cosenseCalls[0]?.method).toBe("GET");
    expect(cosenseCalls[0]?.cache).toBe("no-store");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("x-personal-access-token")).toBe(
      TEST_PERSONAL_ACCESS_TOKEN,
    );
  });

  it.each([
    ["missing", undefined],
    ["blank", " \n "],
  ])(
    "fails safely when COSENSE_PAT is %s",
    async (_case, personalAccessToken) => {
      const { cosenseCalls } = mockJwksAndCosense();
      const response = await fetchWorkerWithPat(
        getPageRequest(await createAssertion()),
        personalAccessToken,
      );

      expect(response.status).toBe(500);
      expectNoStore(response);
      expect(await response.text()).toBe("Server error");
      expect(cosenseCalls).toHaveLength(0);
    },
  );

  it("rejects an assertion for another Access application", async () => {
    mockJwks();
    const response = await workerBinding.fetch(
      toolsListRequest(
        await createAssertion({ audience: "another-application" }),
      ),
    );

    expect(response.status).toBe(403);
    expectNoStore(response);
    expect(await response.text()).toBe("Forbidden");
  });

  it("rejects an expired assertion", async () => {
    mockJwks();
    const response = await workerBinding.fetch(
      toolsListRequest(
        await createAssertion({
          expiresAt: Math.floor(Date.now() / 1_000) - 1,
        }),
      ),
    );

    expect(response.status).toBe(403);
    expectNoStore(response);
    expect(await response.text()).toBe("Forbidden");
  });
});
