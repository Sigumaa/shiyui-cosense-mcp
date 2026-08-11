import {
  type AuthRequest,
  type ClientInfo,
} from "@cloudflare/workers-oauth-provider";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

import {
  READ_SCOPE,
  getMcpServerUrl,
  normalizeEmail,
  type AuthorizationProps,
  type Env,
} from "./env";

const STATE_TTL_SECONDS = 600;
const CSRF_COOKIE = "__Host-cosense_mcp_csrf";
const FLOW_COOKIE = "__Host-cosense_mcp_flow";

const accessTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  id_token: z.string().min(1),
});

interface AccessState {
  oauthRequest: AuthRequest;
  browserNonce: string;
  codeVerifier: string;
  nonce: string;
}

interface ConsentState {
  oauthRequest: AuthRequest;
  identity: AuthorizationProps;
  csrf: string;
}

type StateKind = "access" | "consent";

class FlowError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function securityHeaders(contentType?: string): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });

  if (contentType) {
    headers.set("Content-Type", contentType);
  }

  return headers;
}

function textResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: securityHeaders("text/plain; charset=utf-8"),
  });
}

function htmlResponse(html: string, cookies: string[]): Response {
  const headers = securityHeaders("text/html; charset=utf-8");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(html, { status: 200, headers });
}

function redirectResponse(location: string, cookie?: string): Response {
  const headers = securityHeaders();
  headers.set("Location", location);
  if (cookie) {
    headers.set("Set-Cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
}

function oauthErrorRedirect(
  request: Pick<AuthRequest, "redirectUri" | "state" | "issuer">,
  error: string,
  description: string,
  cookie?: string,
): Response {
  const url = new URL(request.redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (request.state) {
    url.searchParams.set("state", request.state);
  }
  if (request.issuer) {
    url.searchParams.set("iss", request.issuer);
  }
  return redirectResponse(url.toString(), cookie);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const base64 = padded.padEnd(Math.ceil(padded.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomValue(size = 32): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) {
    throw new Error("COOKIE_ENCRYPTION_KEY is too short");
  }

  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signState(
  kind: StateKind,
  id: string,
  secret: string,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(`${kind}:${id}`),
  );
  return `${id}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function verifyState(
  kind: StateKind,
  value: string,
  secret: string,
): Promise<string | undefined> {
  const separator = value.indexOf(".");
  if (separator <= 0 || value.indexOf(".", separator + 1) !== -1) {
    return undefined;
  }

  const id = value.slice(0, separator);
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      base64UrlToBytes(value.slice(separator + 1)),
      new TextEncoder().encode(`${kind}:${id}`),
    );
    return valid ? id : undefined;
  } catch {
    return undefined;
  }
}

async function putState<T>(
  env: Env,
  kind: StateKind,
  value: T,
): Promise<string> {
  const id = crypto.randomUUID();
  await env.OAUTH_KV.put(`${kind}:${id}`, JSON.stringify(value), {
    expirationTtl: STATE_TTL_SECONDS,
  });
  return signState(kind, id, env.COOKIE_ENCRYPTION_KEY);
}

async function consumeState<T>(
  env: Env,
  kind: StateKind,
  value: string,
): Promise<T | undefined> {
  const id = await verifyState(kind, value, env.COOKIE_ENCRYPTION_KEY);
  if (!id) {
    return undefined;
  }

  const key = `${kind}:${id}`;
  const stored = await env.OAUTH_KV.get(key);
  if (!stored) {
    return undefined;
  }

  await env.OAUTH_KV.delete(key);
  try {
    return JSON.parse(stored) as T;
  } catch {
    return undefined;
  }
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

async function accessPkce(): Promise<{
  verifier: string;
  challenge: string;
}> {
  while (true) {
    const verifier = randomValue();
    const challenge = await pkceChallenge(verifier);
    if (/^[A-Za-z0-9]/u.test(challenge)) {
      return { verifier, challenge };
    }
  }
}

function hasReadScope(request: AuthRequest): boolean {
  const scopes = new Set(request.scope);
  return scopes.size === 1 && scopes.has(READ_SCOPE);
}

function isAllowedMcpRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    const ipv4Parts = url.hostname.split(".");
    const isIpv4Loopback =
      ipv4Parts.length === 4 &&
      ipv4Parts[0] === "127" &&
      ipv4Parts.every((part) => {
        const octet = Number(part);
        return Number.isInteger(octet) && octet >= 0 && octet <= 255;
      });
    const isLocalHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        isIpv4Loopback ||
        url.hostname === "[::1]");
    return (
      (url.protocol === "https:" || isLocalHttp) &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function hasS256Pkce(request: AuthRequest): boolean {
  return (
    request.codeChallengeMethod === "S256" &&
    typeof request.codeChallenge === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(request.codeChallenge)
  );
}

function getAccessConfiguration(env: Env): {
  authorizationUrl: URL;
  tokenUrl: URL;
  jwksUrl: URL;
  issuer: string;
} {
  const authorizationUrl = new URL(env.ACCESS_AUTHORIZATION_URL);
  const tokenUrl = new URL(env.ACCESS_TOKEN_URL);
  const jwksUrl = new URL(env.ACCESS_JWKS_URL);

  if (
    authorizationUrl.protocol !== "https:" ||
    authorizationUrl.search !== "" ||
    authorizationUrl.hash !== "" ||
    !authorizationUrl.pathname.endsWith("/authorization")
  ) {
    throw new Error("ACCESS_AUTHORIZATION_URL is invalid");
  }

  const issuer = authorizationUrl.toString().replace(/\/authorization$/u, "");
  if (
    tokenUrl.toString() !== `${issuer}/token` ||
    jwksUrl.toString() !== `${issuer}/jwks`
  ) {
    throw new Error("Access OIDC endpoints must share one issuer");
  }

  if (!env.ACCESS_CLIENT_ID || !env.ACCESS_CLIENT_SECRET) {
    throw new Error("Access client credentials are missing");
  }

  return { authorizationUrl, tokenUrl, jwksUrl, issuer };
}

function callbackUrl(env: Env): string {
  return new URL("/callback", getMcpServerUrl(env.MCP_SERVER_URL)).toString();
}

function csrfCookie(value: string): string {
  return `${CSRF_COOKIE}=${value}; Path=/; Max-Age=${STATE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

function flowCookie(value: string): string {
  return `${FLOW_COOKIE}=${value}; Path=/; Max-Age=${STATE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

function clearFlowCookie(): string {
  return `${FLOW_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function clearCsrfCookie(): string {
  return `${CSRF_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function getCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie");
  if (!header) {
    return undefined;
  }

  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (item.slice(0, separator).trim() === name) {
      return item.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function clientLabel(client: ClientInfo): string {
  return client.clientName?.trim() || "MCP client";
}

function consentPage(
  client: ClientInfo,
  email: string,
  state: string,
  csrf: string,
): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cosense MCP の接続確認</title>
</head>
<body>
  <main>
    <h1>Cosense MCP の接続確認</h1>
    <p>${escapeHtml(clientLabel(client))} が ${escapeHtml(email)} として Cosense の読み取りを要求しています。</p>
    <p>許可する権限: <code>${READ_SCOPE}</code></p>
    <form method="post" action="/authorize/complete">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button type="submit" name="decision" value="approve">許可</button>
      <button type="submit" name="decision" value="deny">拒否</button>
    </form>
  </main>
</body>
</html>`;
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch {
    return textResponse("Invalid OAuth request", 400);
  }

  if (
    oauthRequest.responseType !== "code" ||
    !oauthRequest.clientId ||
    !oauthRequest.redirectUri
  ) {
    return textResponse("Invalid OAuth request", 400);
  }

  if (!isAllowedMcpRedirectUri(oauthRequest.redirectUri)) {
    return textResponse("Invalid OAuth redirect URI", 400);
  }

  if (!hasS256Pkce(oauthRequest)) {
    return oauthErrorRedirect(
      oauthRequest,
      "invalid_request",
      "PKCE S256 is required",
    );
  }

  if (!hasReadScope(oauthRequest)) {
    return oauthErrorRedirect(
      oauthRequest,
      "invalid_scope",
      `Only ${READ_SCOPE} is supported`,
    );
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) {
    return oauthErrorRedirect(
      oauthRequest,
      "unauthorized_client",
      "Unknown OAuth client",
    );
  }

  const access = getAccessConfiguration(env);
  const browserNonce = randomValue();
  const { verifier: codeVerifier, challenge: codeChallenge } =
    await accessPkce();
  const nonce = randomValue();
  const state = await putState<AccessState>(env, "access", {
    oauthRequest,
    browserNonce,
    codeVerifier,
    nonce,
  });

  const authorizationUrl = new URL(access.authorizationUrl);
  authorizationUrl.searchParams.set("client_id", env.ACCESS_CLIENT_ID);
  authorizationUrl.searchParams.set("redirect_uri", callbackUrl(env));
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", "openid email profile");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("nonce", nonce);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  return redirectResponse(
    authorizationUrl.toString(),
    flowCookie(browserNonce),
  );
}

async function exchangeAccessCode(
  code: string,
  state: AccessState,
  env: Env,
  fetcher: typeof fetch,
): Promise<z.infer<typeof accessTokenResponseSchema>> {
  const access = getAccessConfiguration(env);
  const response = await fetcher(access.tokenUrl, {
    method: "POST",
    cache: "no-store",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: env.ACCESS_CLIENT_ID,
      client_secret: env.ACCESS_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl(env),
      code_verifier: state.codeVerifier,
    }),
  });

  if (!response.ok) {
    throw new FlowError(502, "Cloudflare Access token exchange failed");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new FlowError(502, "Cloudflare Access returned invalid JSON");
  }

  const parsed = accessTokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new FlowError(
      502,
      "Cloudflare Access returned an invalid token response",
    );
  }
  return parsed.data;
}

async function verifyIdentity(
  idToken: string,
  nonce: string,
  env: Env,
): Promise<AuthorizationProps> {
  const access = getAccessConfiguration(env);
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    ({ payload } = await jwtVerify(
      idToken,
      createRemoteJWKSet(access.jwksUrl),
      {
        algorithms: ["RS256"],
        audience: env.ACCESS_CLIENT_ID,
        issuer: access.issuer,
        requiredClaims: ["exp", "iat", "sub", "email", "nonce"],
      },
    ));
  } catch {
    throw new FlowError(403, "Cloudflare Access identity verification failed");
  }

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const hasExpectedAudience =
    audiences.length > 0 &&
    audiences.every((audience) => typeof audience === "string") &&
    audiences.includes(env.ACCESS_CLIENT_ID);
  const hasValidAuthorizedParty =
    audiences.length > 1
      ? payload.azp === env.ACCESS_CLIENT_ID
      : payload.azp === undefined || payload.azp === env.ACCESS_CLIENT_ID;
  if (
    !hasExpectedAudience ||
    !hasValidAuthorizedParty ||
    typeof payload.iat !== "number" ||
    !Number.isFinite(payload.iat)
  ) {
    throw new FlowError(403, "Cloudflare Access identity verification failed");
  }

  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const email =
    typeof payload.email === "string" ? normalizeEmail(payload.email) : "";
  const allowedEmail = normalizeEmail(env.ALLOWED_EMAIL);
  if (!sub || !email || !allowedEmail || email !== allowedEmail) {
    throw new FlowError(403, "This account is not allowed");
  }
  if (payload.nonce !== nonce) {
    throw new FlowError(403, "Cloudflare Access nonce verification failed");
  }

  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  return {
    sub,
    email,
    scopes: [READ_SCOPE],
    ...(name ? { name } : {}),
  };
}

async function handleCallback(
  request: Request,
  env: Env,
  fetcher: typeof fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state");
  if (!stateValue) {
    throw new FlowError(400, "Missing OAuth state");
  }

  const state = await consumeState<AccessState>(env, "access", stateValue);
  if (!state) {
    throw new FlowError(400, "OAuth state is invalid or expired");
  }

  if (getCookie(request, FLOW_COOKIE) !== state.browserNonce) {
    throw new FlowError(400, "OAuth browser session is invalid or expired");
  }

  if (url.searchParams.has("error")) {
    return oauthErrorRedirect(
      state.oauthRequest,
      "access_denied",
      "Cloudflare Access sign-in was denied",
      clearFlowCookie(),
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    throw new FlowError(400, "Missing authorization code");
  }

  const tokens = await exchangeAccessCode(code, state, env, fetcher);
  const identity = await verifyIdentity(tokens.id_token, state.nonce, env);
  const client = await env.OAUTH_PROVIDER.lookupClient(
    state.oauthRequest.clientId,
  );
  if (!client) {
    return oauthErrorRedirect(
      state.oauthRequest,
      "unauthorized_client",
      "Unknown OAuth client",
    );
  }

  const csrf = randomValue();
  const consentState = await putState<ConsentState>(env, "consent", {
    oauthRequest: state.oauthRequest,
    identity,
    csrf,
  });
  return htmlResponse(consentPage(client, identity.email, consentState, csrf), [
    csrfCookie(csrf),
    clearFlowCookie(),
  ]);
}

async function userIdFor(identity: AuthorizationProps): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity.sub),
  );
  return `access-${bytesToBase64Url(new Uint8Array(digest))}`;
}

function formString(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value ? value : undefined;
}

async function handleConsent(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    throw new FlowError(415, "Unsupported form content type");
  }

  const form = await request.formData();
  const stateValue = formString(form, "state");
  const csrf = formString(form, "csrf");
  const decision = formString(form, "decision");
  const csrfFromCookie = getCookie(request, CSRF_COOKIE);
  if (!stateValue || !csrf || !csrfFromCookie || csrf !== csrfFromCookie) {
    throw new FlowError(400, "Consent request is invalid or expired");
  }

  const state = await consumeState<ConsentState>(env, "consent", stateValue);
  if (!state || state.csrf !== csrf) {
    throw new FlowError(400, "Consent request is invalid or expired");
  }

  if (decision === "deny") {
    return oauthErrorRedirect(
      state.oauthRequest,
      "access_denied",
      "The user denied the request",
      clearCsrfCookie(),
    );
  }
  if (decision !== "approve") {
    throw new FlowError(400, "Consent decision is invalid");
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: state.oauthRequest,
    userId: await userIdFor(state.identity),
    metadata: { label: state.identity.email },
    scope: [READ_SCOPE],
    props: state.identity,
  });
  return redirectResponse(redirectTo, clearCsrfCookie());
}

export function createAuthorizationHandler(
  fetcher: typeof fetch = fetch,
): ExportedHandler<Env> {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      try {
        if (request.method === "GET" && url.pathname === "/authorize") {
          return await handleAuthorize(request, env);
        }
        if (request.method === "GET" && url.pathname === "/callback") {
          return await handleCallback(request, env, fetcher);
        }
        if (
          request.method === "POST" &&
          url.pathname === "/authorize/complete"
        ) {
          return await handleConsent(request, env);
        }
        return textResponse("Not found", 404);
      } catch (error) {
        if (error instanceof FlowError) {
          return textResponse(error.message, error.status);
        }
        return textResponse("Authorization failed", 500);
      }
    },
  };
}
