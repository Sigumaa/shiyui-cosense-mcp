import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEAM_DOMAIN: "https://team.cloudflareaccess.com",
          POLICY_AUD: "access-application-audience",
          COSENSE_PAT: "test-only-cosense-pat",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
