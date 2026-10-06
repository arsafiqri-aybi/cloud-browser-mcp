import { env } from "cloudflare:workers";
import { createMcpAgent } from "@cloudflare/playwright-mcp";

export const PlaywrightMCP = createMcpAgent(env.BROWSER, {
  imageResponses: "allow",
} as any);

const mcp = PlaywrightMCP.serve("/mcp");

export default {
  async fetch(request: Request, runtimeEnv: any, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({
        ok: true,
        service: "cloud-browser-mcp",
        runtime: "cloudflare-browser-run",
        version: "1.1.0"
      });
    }

    const token = runtimeEnv.MCP_PATH_TOKEN;
    if (!token || url.pathname !== `/mcp/${token}`) {
      return new Response("Not Found", { status: 404 });
    }

    const internalUrl = new URL(request.url);
    internalUrl.pathname = "/mcp";
    const forwarded = new Request(internalUrl.toString(), request);
    return mcp.fetch(forwarded, runtimeEnv, ctx);
  }
} satisfies ExportedHandler<any>;
