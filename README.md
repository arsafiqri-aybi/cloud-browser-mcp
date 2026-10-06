# Cloud Browser MCP

Private single-owner browser MCP for ChatGPT.

## Runtime v1.2.0

The production path uses Cloudflare Browser Run directly through the native browser binding and Chrome DevTools Protocol (CDP). It does not require npm browser libraries or Cloudflare Containers.

Implemented MCP tools: navigate, page snapshot with selectors, click, fill, key input, scroll, wait, back, screenshot, tabs, open/activate/close tab, and status/Live View metadata.

The public MCP endpoint is protected by a secret path stored as the Worker secret `MCP_PATH_TOKEN`. `/healthz` is public and reveals no secret.

The original uploaded 1.0.0 design remains the reference for future persistent-profile/admin-handoff parity. Browser Run sessions are plan-limited and are not equivalent to a permanently mounted Chromium profile.
