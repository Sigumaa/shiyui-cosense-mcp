import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hasCurrentReadAuthorizationProps, type Env } from "../src/env";
import worker, {
  mcpApiHandler,
  synchronizeAccessTokenProps,
} from "../src/index";

const mcpUrl = "https://mcp.example.com/mcp";
const workerBinding = (exports as unknown as { default: Fetcher }).default;

interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
}

interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  scopes_supported: string[];
  code_challenge_methods_supported: string[];
  client_id_metadata_document_supported: boolean;
}

function expectNoStore(response: Response): void {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Pragma")).toBe("no-cache");
}

async function fetchWorker(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return workerBinding.fetch(
    new Request(`https://mcp.example.com${path}`, init),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OAuth-protected MCP Worker", () => {
  it("rejects an unauthenticated tool call before it can reach Cosense", async () => {
    const externalFetch = vi.spyOn(globalThis, "fetch");
    const response = await fetchWorker("/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_page", arguments: { title: "private" } },
      }),
    });

    expect(response.status).toBe(401);
    expectNoStore(response);
    expect(await response.text()).toBe("");
    expect(externalFetch).not.toHaveBeenCalled();

    const challenge = response.headers.get("WWW-Authenticate");
    expect(challenge).toContain('Bearer realm="OAuth"');
    expect(challenge).toContain('scope="cosense:read"');

    const resourceMetadata = /resource_metadata="([^"]+)"/u.exec(
      challenge ?? "",
    )?.[1];
    expect(resourceMetadata).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    );

    const metadataResponse = await workerBinding.fetch(
      new Request(resourceMetadata as string),
    );
    expect(metadataResponse.status).toBe(200);
    expectNoStore(metadataResponse);
  });

  it.each([
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ])("advertises canonical protected-resource metadata at %s", async (path) => {
    const response = await fetchWorker(path);
    const metadata = (await response.json()) as ProtectedResourceMetadata;

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(metadata).toMatchObject({
      resource: mcpUrl,
      authorization_servers: ["https://mcp.example.com"],
      scopes_supported: ["cosense:read"],
      bearer_methods_supported: ["header"],
    });
  });

  it("advertises the local authorization endpoints and supported capabilities", async () => {
    const response = await fetchWorker(
      "/.well-known/oauth-authorization-server",
    );
    const metadata = (await response.json()) as AuthorizationServerMetadata;

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(metadata).toMatchObject({
      issuer: "https://mcp.example.com",
      authorization_endpoint: "https://mcp.example.com/authorize",
      token_endpoint: "https://mcp.example.com/oauth/token",
      scopes_supported: ["cosense:read"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
    });
  });

  it("binds each access token to its effective scope and the current allowed email", async () => {
    const narrowed = synchronizeAccessTokenProps(
      {
        sub: "access-user",
        email: "allowed@example.com",
        scopes: ["cosense:read"],
      },
      [],
      "allowed@example.com",
    );

    expect(narrowed).toEqual({
      sub: "access-user",
      email: "allowed@example.com",
      scopes: [],
    });
    expect(
      hasCurrentReadAuthorizationProps(narrowed, "allowed@example.com"),
    ).toBe(false);

    expect(() =>
      synchronizeAccessTokenProps(
        {
          sub: "access-user",
          email: "previous@example.com",
          scopes: ["cosense:read"],
        },
        ["cosense:read"],
        "allowed@example.com",
      ),
    ).toThrow("The authorized account is no longer allowed");
  });

  it("returns protected-resource guidance for insufficient scope", async () => {
    const response = await mcpApiHandler.fetch(
      new Request(mcpUrl, { method: "POST" }),
      env as unknown as Env,
      {
        props: {
          sub: "access-user",
          email: "allowed@example.com",
          scopes: [],
        },
      } as ExecutionContext & { props: unknown },
    );

    expect(response.status).toBe(403);
    expectNoStore(response);
    const challenge = response.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain('Bearer realm="OAuth"');
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="cosense:read"');
    expect(challenge).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("returns invalid_token when the current allowed email revokes a grant", async () => {
    const response = await mcpApiHandler.fetch(
      new Request(mcpUrl, { method: "POST" }),
      env as unknown as Env,
      {
        props: {
          sub: "access-user",
          email: "previous@example.com",
          scopes: ["cosense:read"],
        },
      } as ExecutionContext & { props: unknown },
    );

    expect(response.status).toBe(401);
    expectNoStore(response);
    const challenge = response.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain('Bearer realm="OAuth"');
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).not.toContain('scope="cosense:read"');
    expect(challenge).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("returns a detail-free server error for an invalid MCP_SERVER_URL", async () => {
    const invalidEnv = {
      ...(env as unknown as Env),
      MCP_SERVER_URL: "not a URL containing secret.example",
    };
    const response = await worker.fetch!(
      new Request(mcpUrl, { method: "POST" }),
      invalidEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(500);
    expectNoStore(response);
    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await response.text()).toBe("Server configuration error");
  });
});
