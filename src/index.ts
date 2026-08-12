import { createMcpHandler } from "agents/mcp/server";

import { verifyAccessRequest } from "./access";
import type { Env } from "./env";
import { createCosenseMcpServer } from "./tools";

const mcpHandler = createMcpHandler(createCosenseMcpServer, {
  route: "/mcp",
  legacy: "reject",
  corsOptions: false,
});

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

function textResponse(body: string, status: 403 | 500): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      Pragma: "no-cache",
    },
  });
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env, context) {
    try {
      await verifyAccessRequest(request, env);
    } catch {
      return textResponse("Forbidden", 403);
    }

    try {
      return noStore(await mcpHandler(request, env, context));
    } catch {
      return textResponse("Server error", 500);
    }
  },
};

export default worker;
