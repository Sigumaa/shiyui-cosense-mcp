import { exports } from "cloudflare:workers";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const TEAM_DOMAIN = "https://team.cloudflareaccess.com";
const POLICY_AUD = "access-application-audience";
const KEY_ID = "test-key";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
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
    ]);
  });

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
