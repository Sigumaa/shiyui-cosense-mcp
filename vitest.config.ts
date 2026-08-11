import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        kvNamespaces: ["OAUTH_KV"],
        bindings: {
          MCP_SERVER_URL: "https://mcp.example.com/mcp",
          ACCESS_CLIENT_ID: "access-client-id",
          ACCESS_CLIENT_SECRET: "access-client-secret",
          ACCESS_TOKEN_URL:
            "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/access-client-id/token",
          ACCESS_AUTHORIZATION_URL:
            "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/access-client-id/authorization",
          ACCESS_JWKS_URL:
            "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/access-client-id/jwks",
          ALLOWED_EMAIL: "allowed@example.com",
          COOKIE_ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
