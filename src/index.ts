import OAuthProvider, { OAuthError } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";

import { createAuthorizationHandler } from "./auth";
import {
  READ_SCOPE,
  getMcpServerUrl,
  hasReadAuthorizationProps,
  hasCurrentReadAuthorizationProps,
  type Env,
} from "./env";
import { createCosenseMcpServer } from "./tools";

const mcpHandler = createMcpHandler(createCosenseMcpServer, {
  route: "/mcp",
  legacy: "reject",
  corsOptions: false,
});

function authorizationChallenge(
  mcpUrl: URL,
  error: "insufficient_scope" | "invalid_token",
): string {
  const resourceMetadata = new URL(
    `/.well-known/oauth-protected-resource${mcpUrl.pathname}`,
    mcpUrl,
  );
  const scope = error === "insufficient_scope" ? `, scope="${READ_SCOPE}"` : "";
  const description =
    error === "insufficient_scope"
      ? "Required scope is missing"
      : "The authorization is no longer valid";
  return `Bearer realm="OAuth", resource_metadata="${resourceMetadata}", error="${error}"${scope}, error_description="${description}"`;
}

function authorizationErrorResponse(
  status: 401 | 403,
  challenge: string,
): Response {
  return new Response(status === 401 ? "Invalid token" : "Insufficient scope", {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      Pragma: "no-cache",
      "WWW-Authenticate": challenge,
    },
  });
}

export const mcpApiHandler = {
  async fetch(request, env, context) {
    const props = (context as ExecutionContext & { props?: unknown }).props;
    const mcpUrl = getMcpServerUrl(env.MCP_SERVER_URL);
    if (!hasReadAuthorizationProps(props)) {
      return authorizationErrorResponse(
        403,
        authorizationChallenge(mcpUrl, "insufficient_scope"),
      );
    }
    if (!hasCurrentReadAuthorizationProps(props, env.ALLOWED_EMAIL)) {
      return authorizationErrorResponse(
        401,
        authorizationChallenge(mcpUrl, "invalid_token"),
      );
    }
    return mcpHandler(request, env, context);
  },
} satisfies ExportedHandler<Env>;

const authorizationHandler = createAuthorizationHandler();

export function synchronizeAccessTokenProps(
  props: unknown,
  requestedScope: string[],
  allowedEmail: string,
) {
  if (!hasCurrentReadAuthorizationProps(props, allowedEmail)) {
    throw new OAuthError("invalid_grant", {
      description: "The authorized account is no longer allowed",
    });
  }
  return { ...props, scopes: [...requestedScope] };
}

export function createOAuthProvider(env: Env): OAuthProvider<Env> {
  const mcpUrl = getMcpServerUrl(env.MCP_SERVER_URL);
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpApiHandler,
    defaultHandler: authorizationHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    accessTokenTTL: 3_600,
    refreshTokenTTL: 2_592_000,
    scopesSupported: [READ_SCOPE],
    allowImplicitFlow: false,
    allowPlainPKCE: false,
    tokenExchangeCallback: ({ props, requestedScope }) => ({
      accessTokenProps: synchronizeAccessTokenProps(
        props,
        requestedScope,
        env.ALLOWED_EMAIL,
      ),
    }),
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource: mcpUrl.toString(),
      authorization_servers: [mcpUrl.origin],
      scopes_supported: [READ_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Shiyui Cosense read-only MCP",
    },
  });
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env, context) {
    try {
      const response = await createOAuthProvider(env).fetch(
        request,
        env,
        context,
      );
      return noStore(response);
    } catch {
      return new Response("Server configuration error", {
        status: 500,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8",
          Pragma: "no-cache",
        },
      });
    }
  },
};

export default worker;
