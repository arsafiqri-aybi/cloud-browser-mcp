# Cloud Browser MCP

Private browser-control MCP for ChatGPT.

## Production runtime

The deployable runtime uses Cloudflare Browser Run with `@cloudflare/playwright-mcp` and exposes Streamable HTTP only behind an unguessable private MCP path supplied as a Worker secret. The repository remains private.

The original uploaded Cloud Browser MCP 1.0.0 remains the design/reference baseline; this deployment path is adapted to the available Cloudflare Workers Free account so a real browser can run without requiring Cloudflare Containers.

## Security

- MCP route is disabled unless `MCP_PATH_TOKEN` exists.
- The public health endpoint reveals no token.
- Do not commit the token or place it in logs.
- Browser Run usage is limited by the Cloudflare account plan.

## Deploy

`npx wrangler deploy`
