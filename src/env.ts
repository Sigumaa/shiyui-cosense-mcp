import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export const READ_SCOPE = "cosense:read";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  MCP_SERVER_URL: string;
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
  ACCESS_TOKEN_URL: string;
  ACCESS_AUTHORIZATION_URL: string;
  ACCESS_JWKS_URL: string;
  ALLOWED_EMAIL: string;
  COOKIE_ENCRYPTION_KEY: string;
}

export interface AuthorizationProps {
  sub: string;
  email: string;
  scopes: string[];
  name?: string;
}

export function hasReadAuthorizationProps(
  value: unknown,
): value is AuthorizationProps {
  if (!value || typeof value !== "object") {
    return false;
  }
  const props = value as Partial<AuthorizationProps>;
  return (
    typeof props.sub === "string" &&
    props.sub.length > 0 &&
    typeof props.email === "string" &&
    props.email.length > 0 &&
    Array.isArray(props.scopes) &&
    props.scopes.includes(READ_SCOPE)
  );
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function hasCurrentReadAuthorizationProps(
  value: unknown,
  allowedEmail: string,
): value is AuthorizationProps {
  const normalizedAllowedEmail = normalizeEmail(allowedEmail);
  return (
    normalizedAllowedEmail.length > 0 &&
    hasReadAuthorizationProps(value) &&
    normalizeEmail(value.email) === normalizedAllowedEmail
  );
}

export function getMcpServerUrl(value: string): URL {
  const url = new URL(value);
  const isLocalHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");

  if (
    (url.protocol !== "https:" && !isLocalHttp) ||
    url.pathname !== "/mcp" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("MCP_SERVER_URL must be an HTTPS /mcp URL");
  }

  return url;
}
