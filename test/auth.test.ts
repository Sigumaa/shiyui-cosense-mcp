import type {
  AuthRequest,
  ClientInfo,
  CompleteAuthorizationOptions,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createAuthorizationHandler } from "../src/auth";
import { READ_SCOPE, type Env } from "../src/env";

const ACCESS_CLIENT_ID = "access-client-id";
const ACCESS_ISSUER =
  "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/access-client-id";
const ACCESS_AUTHORIZATION_URL = `${ACCESS_ISSUER}/authorization`;
const ACCESS_TOKEN_URL = `${ACCESS_ISSUER}/token`;
const ACCESS_JWKS_URL = `${ACCESS_ISSUER}/jwks`;
const MCP_CALLBACK_URL = "https://mcp.example.com/callback";
const CLIENT_CALLBACK_URL = "https://client.example/callback";
const ALLOWED_EMAIL = "allowed@example.com";
const ACCESS_SUBJECT = "access-user:123";
const ACCESS_TOKEN = "access-token-must-not-leak";
const KEY_ID = "test-key";

interface StoredAccessState {
  oauthRequest: AuthRequest;
  browserNonce: string;
  codeVerifier: string;
  nonce: string;
}

interface StoredConsentState {
  oauthRequest: AuthRequest;
  identity: {
    sub: string;
    email: string;
    scopes: string[];
    name?: string;
  };
  csrf: string;
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface FlowFixture {
  env: Env;
  entries: Map<string, string>;
  oauthRequest: AuthRequest;
  parseAuthRequest: ReturnType<typeof vi.fn>;
  lookupClient: ReturnType<typeof vi.fn>;
  completeAuthorization: ReturnType<typeof vi.fn>;
}

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
  vi.unstubAllGlobals();
});

function createFlowFixture(scope: string[] = [READ_SCOPE]): FlowFixture {
  const entries = new Map<string, string>();
  const oauthRequest: AuthRequest = {
    responseType: "code",
    clientId: "mcp-client",
    redirectUri: CLIENT_CALLBACK_URL,
    scope,
    state: "client-state",
    codeChallenge: "client-code-challenge",
    codeChallengeMethod: "S256",
    issuer: "https://mcp.example.com",
  };
  const client: ClientInfo = {
    clientId: oauthRequest.clientId,
    clientName: "Test MCP Client",
    redirectUris: [oauthRequest.redirectUri],
    tokenEndpointAuthMethod: "none",
  };
  const parseAuthRequest = vi.fn(
    async (_request: Request): Promise<AuthRequest> => oauthRequest,
  );
  const lookupClient = vi.fn(
    async (_clientId: string): Promise<ClientInfo | null> => client,
  );
  const completeAuthorization = vi.fn(
    async (_options: CompleteAuthorizationOptions) => ({
      redirectTo: `${CLIENT_CALLBACK_URL}?code=provider-code&state=client-state`,
    }),
  );
  const oauthProvider = {
    parseAuthRequest,
    lookupClient,
    completeAuthorization,
  } as unknown as OAuthHelpers;
  const oauthKv = {
    get: vi.fn(async (key: string) => entries.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      entries.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      entries.delete(key);
    }),
  } as unknown as KVNamespace;

  return {
    env: {
      OAUTH_KV: oauthKv,
      OAUTH_PROVIDER: oauthProvider,
      MCP_SERVER_URL: "https://mcp.example.com/mcp",
      ACCESS_CLIENT_ID,
      ACCESS_CLIENT_SECRET: "access-client-secret",
      ACCESS_TOKEN_URL,
      ACCESS_AUTHORIZATION_URL,
      ACCESS_JWKS_URL,
      ALLOWED_EMAIL,
      COOKIE_ENCRYPTION_KEY:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    entries,
    oauthRequest,
    parseAuthRequest,
    lookupClient,
    completeAuthorization,
  };
}

function createUpstreamFetch(): {
  fetcher: typeof fetch;
  calls: FetchCall[];
  setIdToken: (token: string) => void;
} {
  const calls: FetchCall[] = [];
  let idToken: string | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === ACCESS_TOKEN_URL) {
      if (!idToken) throw new Error("ID token fixture is missing");
      return Response.json({ access_token: ACCESS_TOKEN, id_token: idToken });
    }
    if (url === ACCESS_JWKS_URL) {
      return Response.json(jwks);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  return {
    fetcher,
    calls,
    setIdToken(token) {
      idToken = token;
    },
  };
}

async function dispatch(
  handler: ExportedHandler<Env>,
  request: Request,
  env: Env,
): Promise<Response> {
  const fetch = handler.fetch;
  if (!fetch) throw new Error("Authorization handler has no fetch");
  return fetch(
    request as Parameters<typeof fetch>[0],
    env,
    {} as ExecutionContext,
  );
}

function onlyEntry(entries: Map<string, string>): [string, string] {
  expect(entries.size).toBe(1);
  const entry = entries.entries().next().value;
  if (!entry) throw new Error("Expected one KV entry");
  return entry;
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function sha256(value: string): Promise<string> {
  return base64Url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function authorize(
  fixture: FlowFixture,
  handler: ExportedHandler<Env>,
): Promise<{
  response: Response;
  accessUrl: URL;
  cookie: string;
  state: string;
  stored: StoredAccessState;
}> {
  const response = await dispatch(
    handler,
    new Request("https://mcp.example.com/authorize"),
    fixture.env,
  );
  const accessUrl = new URL(response.headers.get("Location") ?? "");
  const state = accessUrl.searchParams.get("state") ?? "";
  const [, storedValue] = onlyEntry(fixture.entries);
  return {
    response,
    accessUrl,
    cookie: cookiePair(response),
    state,
    stored: JSON.parse(storedValue) as StoredAccessState,
  };
}

async function idToken(email: string, nonce: string): Promise<string> {
  return new SignJWT({ email, nonce, name: "Allowed User" })
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
    .setIssuer(ACCESS_ISSUER)
    .setAudience(ACCESS_CLIENT_ID)
    .setSubject(ACCESS_SUBJECT)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
}

async function callback(
  fixture: FlowFixture,
  email = ALLOWED_EMAIL,
): Promise<{
  handler: ExportedHandler<Env>;
  upstream: ReturnType<typeof createUpstreamFetch>;
  authorization: Awaited<ReturnType<typeof authorize>>;
  token: string;
  response: Response;
}> {
  const upstream = createUpstreamFetch();
  const handler = createAuthorizationHandler(upstream.fetcher);
  const authorization = await authorize(fixture, handler);
  const token = await idToken(email, authorization.stored.nonce);
  upstream.setIdToken(token);
  vi.stubGlobal("fetch", upstream.fetcher);
  const response = await dispatch(
    handler,
    new Request(
      `https://mcp.example.com/callback?code=access-code&state=${encodeURIComponent(authorization.state)}`,
      { headers: { Cookie: authorization.cookie } },
    ),
    fixture.env,
  );
  return { handler, upstream, authorization, token, response };
}

function hiddenValue(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`, "u"));
  if (!match?.[1]) throw new Error(`Missing hidden input: ${name}`);
  return match[1];
}

function cookiePair(response: Response): string {
  const pair = response.headers.get("Set-Cookie")?.split(";", 1)[0];
  if (!pair) throw new Error("Missing CSRF cookie");
  return pair;
}

function consentRequest(
  state: string,
  csrf: string,
  cookie: string,
  decision: "approve" | "deny",
): Request {
  return new Request("https://mcp.example.com/authorize/complete", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie,
    },
    body: new URLSearchParams({ state, csrf, decision }),
  });
}

describe("authorization flow", () => {
  it("redirects to Cloudflare Access with opaque state, PKCE S256, nonce, callback, and scopes", async () => {
    const fixture = createFlowFixture();
    const upstream = createUpstreamFetch();
    const result = await authorize(
      fixture,
      createAuthorizationHandler(upstream.fetcher),
    );

    expect(result.response.status).toBe(302);
    expect(result.accessUrl.origin + result.accessUrl.pathname).toBe(
      ACCESS_AUTHORIZATION_URL,
    );
    expect(Object.fromEntries(result.accessUrl.searchParams)).toEqual({
      client_id: ACCESS_CLIENT_ID,
      redirect_uri: MCP_CALLBACK_URL,
      response_type: "code",
      scope: "openid email profile",
      state: result.state,
      nonce: result.stored.nonce,
      code_challenge: await sha256(result.stored.codeVerifier),
      code_challenge_method: "S256",
    });
    expect(result.state).toMatch(
      /^[0-9a-f]{8}-[0-9a-f-]{27}\.[A-Za-z0-9_-]{43}$/u,
    );
    expect(result.state).not.toContain(fixture.oauthRequest.state);
    expect(result.state).not.toContain(fixture.oauthRequest.clientId);
    expect(result.state).not.toContain("codeVerifier");
    const [storedKey] = onlyEntry(fixture.entries);
    expect(storedKey).toBe(`access:${result.state.split(".")[0]}`);
    expect(storedKey).not.toContain(fixture.oauthRequest.state);
    expect(result.stored.oauthRequest).toEqual(fixture.oauthRequest);
    expect(result.stored.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.stored.browserNonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.stored.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.response.headers.get("Set-Cookie")).toContain(
      `__Host-cosense_mcp_flow=${result.stored.browserNonce}`,
    );
    expect(upstream.calls).toHaveLength(0);
  });

  it("rejects an unsupported requested scope before client or Access lookup", async () => {
    const fixture = createFlowFixture(["cosense:write"]);
    const upstream = createUpstreamFetch();
    const response = await dispatch(
      createAuthorizationHandler(upstream.fetcher),
      new Request("https://mcp.example.com/authorize"),
      fixture.env,
    );
    const redirect = new URL(response.headers.get("Location") ?? "");

    expect(response.status).toBe(302);
    expect(redirect.origin + redirect.pathname).toBe(CLIENT_CALLBACK_URL);
    expect(Object.fromEntries(redirect.searchParams)).toEqual({
      error: "invalid_scope",
      error_description: `Only ${READ_SCOPE} is supported`,
      state: fixture.oauthRequest.state,
      iss: fixture.oauthRequest.issuer,
    });
    expect(fixture.lookupClient).not.toHaveBeenCalled();
    expect(fixture.completeAuthorization).not.toHaveBeenCalled();
    expect(fixture.entries.size).toBe(0);
    expect(upstream.calls).toHaveLength(0);
  });

  it("verifies the callback identity and approves only cosense:read without retaining Access tokens", async () => {
    const fixture = createFlowFixture();
    const flow = await callback(fixture);
    const html = await flow.response.text();
    const setCookie = flow.response.headers.get("Set-Cookie") ?? "";
    const cookie = cookiePair(flow.response);
    const state = hiddenValue(html, "state");
    const csrf = hiddenValue(html, "csrf");
    const [consentKey, consentValue] = onlyEntry(fixture.entries);
    const stored = JSON.parse(consentValue) as StoredConsentState;

    expect(flow.response.status).toBe(200);
    expect(flow.response.headers.get("Content-Type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(html).toContain("Test MCP Client");
    expect(html).toContain(ALLOWED_EMAIL);
    expect(html).toContain(`<code>${READ_SCOPE}</code>`);
    expect(setCookie).toContain(`__Host-cosense_mcp_csrf=${csrf}`);
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=600");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Domain=");
    expect(consentKey).toBe(`consent:${state.split(".")[0]}`);
    expect(stored).toEqual({
      oauthRequest: fixture.oauthRequest,
      identity: {
        sub: ACCESS_SUBJECT,
        email: ALLOWED_EMAIL,
        scopes: [READ_SCOPE],
        name: "Allowed User",
      },
      csrf,
    });
    expect(html).not.toContain(ACCESS_TOKEN);
    expect(html).not.toContain(flow.token);
    expect(consentValue).not.toContain(ACCESS_TOKEN);
    expect(consentValue).not.toContain(flow.token);

    expect(flow.upstream.calls.map((call) => call.url)).toEqual([
      ACCESS_TOKEN_URL,
      ACCESS_JWKS_URL,
    ]);
    const tokenCall = flow.upstream.calls[0];
    expect(tokenCall?.init?.method).toBe("POST");
    const tokenBody = new URLSearchParams(String(tokenCall?.init?.body));
    expect(Object.fromEntries(tokenBody)).toEqual({
      client_id: ACCESS_CLIENT_ID,
      client_secret: "access-client-secret",
      code: "access-code",
      grant_type: "authorization_code",
      redirect_uri: MCP_CALLBACK_URL,
      code_verifier: flow.authorization.stored.codeVerifier,
    });

    const approval = await dispatch(
      flow.handler,
      consentRequest(state, csrf, cookie, "approve"),
      fixture.env,
    );

    expect(approval.status).toBe(302);
    expect(approval.headers.get("Location")).toBe(
      `${CLIENT_CALLBACK_URL}?code=provider-code&state=client-state`,
    );
    expect(approval.headers.get("Location")).not.toContain(ACCESS_TOKEN);
    expect(approval.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(fixture.completeAuthorization).toHaveBeenCalledTimes(1);
    const options = fixture.completeAuthorization.mock.calls[0]?.[0] as
      CompleteAuthorizationOptions | undefined;
    expect(options).toEqual({
      request: fixture.oauthRequest,
      userId: `access-${await sha256(ACCESS_SUBJECT)}`,
      metadata: { label: ALLOWED_EMAIL },
      scope: [READ_SCOPE],
      props: {
        sub: ACCESS_SUBJECT,
        email: ALLOWED_EMAIL,
        scopes: [READ_SCOPE],
        name: "Allowed User",
      },
    });
    expect(options?.userId).not.toContain(ACCESS_SUBJECT);
    expect(options?.userId).not.toContain(":");
    expect(JSON.stringify(options)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(options)).not.toContain(flow.token);
    expect(fixture.entries.size).toBe(0);

    const replay = await dispatch(
      flow.handler,
      consentRequest(state, csrf, cookie, "approve"),
      fixture.env,
    );
    expect(replay.status).toBe(400);
    await expect(replay.text()).resolves.toBe(
      "Consent request is invalid or expired",
    );
    expect(fixture.completeAuthorization).toHaveBeenCalledTimes(1);
  });

  it("rejects the wrong email and consumes callback state", async () => {
    const fixture = createFlowFixture();
    const flow = await callback(fixture, "other@example.com");

    expect(flow.response.status).toBe(403);
    await expect(flow.response.text()).resolves.toBe(
      "This account is not allowed",
    );
    expect(fixture.entries.size).toBe(0);
    expect(fixture.completeAuthorization).not.toHaveBeenCalled();

    const replay = await dispatch(
      flow.handler,
      new Request(
        `https://mcp.example.com/callback?code=second-code&state=${encodeURIComponent(flow.authorization.state)}`,
      ),
      fixture.env,
    );
    expect(replay.status).toBe(400);
    await expect(replay.text()).resolves.toBe(
      "OAuth state is invalid or expired",
    );
    expect(flow.upstream.calls).toHaveLength(2);
  });

  it("rejects a callback that is not bound to the browser that started the flow", async () => {
    const fixture = createFlowFixture();
    const upstream = createUpstreamFetch();
    const handler = createAuthorizationHandler(upstream.fetcher);
    const authorization = await authorize(fixture, handler);
    const response = await dispatch(
      handler,
      new Request(
        `https://mcp.example.com/callback?code=access-code&state=${encodeURIComponent(authorization.state)}`,
      ),
      fixture.env,
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe(
      "OAuth browser session is invalid or expired",
    );
    expect(upstream.calls).toHaveLength(0);
    expect(fixture.entries.size).toBe(0);
  });

  it("returns access_denied without completing authorization when consent is denied", async () => {
    const fixture = createFlowFixture();
    const flow = await callback(fixture);
    const html = await flow.response.text();
    const response = await dispatch(
      flow.handler,
      consentRequest(
        hiddenValue(html, "state"),
        hiddenValue(html, "csrf"),
        cookiePair(flow.response),
        "deny",
      ),
      fixture.env,
    );
    const redirect = new URL(response.headers.get("Location") ?? "");

    expect(response.status).toBe(302);
    expect(redirect.origin + redirect.pathname).toBe(CLIENT_CALLBACK_URL);
    expect(Object.fromEntries(redirect.searchParams)).toEqual({
      error: "access_denied",
      error_description: "The user denied the request",
      state: fixture.oauthRequest.state,
      iss: fixture.oauthRequest.issuer,
    });
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(fixture.completeAuthorization).not.toHaveBeenCalled();
    expect(fixture.entries.size).toBe(0);
  });
});
