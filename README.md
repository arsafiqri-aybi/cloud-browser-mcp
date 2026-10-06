# Cloud Browser MCP

Private single-owner browser MCP for ChatGPT.

## Runtime v1.2.1

The production runtime uses Cloudflare Browser Run directly through the native browser binding and Chrome DevTools Protocol (CDP). The MCP handshake is stateless: `initialize` and `tools/list` do not launch a browser. A browser session is created lazily only when a browser tool is called, and its active Browser Run session ID is stored in Workers KV so consecutive tool calls can reuse it while it remains alive.

Implemented MCP tools: navigate, page snapshot with selectors, click, fill, key input, scroll, wait, back, screenshot, tabs, open/activate/close tab, and status/Live View metadata.

The public MCP endpoint is protected by a secret path stored as the Worker secret `MCP_PATH_TOKEN`. `/healthz` is public and reveals no secret.

Browser Run sessions are plan-limited and are not equivalent to a permanently mounted Chromium profile. The original uploaded 1.0.0 design remains the reference for future persistent-profile/admin-handoff parity.
