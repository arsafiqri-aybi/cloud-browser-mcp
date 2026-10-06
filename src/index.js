const SERVER_NAME = "cloud-browser-mcp";
const SERVER_VERSION = "1.2.0";
const PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
  { name: "browser_navigate", description: "Navigate the current browser tab to a URL.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } },
  { name: "browser_snapshot", description: "Read the current page and return visible text plus interactive elements and stable-enough CSS selectors.", inputSchema: { type: "object", properties: { maxText: { type: "integer", minimum: 1000, maximum: 30000, default: 12000 } }, additionalProperties: false } },
  { name: "browser_click", description: "Click an element using a CSS selector returned by browser_snapshot.", inputSchema: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"], additionalProperties: false } },
  { name: "browser_fill", description: "Fill an input, textarea, select, or editable element using a CSS selector.", inputSchema: { type: "object", properties: { selector: { type: "string" }, value: { type: "string" } }, required: ["selector", "value"], additionalProperties: false } },
  { name: "browser_key", description: "Send a keyboard key such as Enter, Tab, Escape, ArrowDown, or Backspace.", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false } },
  { name: "browser_scroll", description: "Scroll the current page by x/y pixels.", inputSchema: { type: "object", properties: { x: { type: "integer", default: 0 }, y: { type: "integer", default: 700 } }, additionalProperties: false } },
  { name: "browser_wait", description: "Wait briefly for navigation or UI changes.", inputSchema: { type: "object", properties: { ms: { type: "integer", minimum: 0, maximum: 10000, default: 1000 } }, additionalProperties: false } },
  { name: "browser_back", description: "Go back in browser history.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "browser_screenshot", description: "Capture a PNG screenshot of the current page.", inputSchema: { type: "object", properties: { fullPage: { type: "boolean", default: false } }, additionalProperties: false } },
  { name: "browser_tabs", description: "List open page tabs/targets and their IDs.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "browser_tab_open", description: "Open a new tab, optionally at a URL.", inputSchema: { type: "object", properties: { url: { type: "string", default: "about:blank" } }, additionalProperties: false } },
  { name: "browser_tab_activate", description: "Activate a tab by target ID.", inputSchema: { type: "object", properties: { targetId: { type: "string" } }, required: ["targetId"], additionalProperties: false } },
  { name: "browser_tab_close", description: "Close a tab by target ID.", inputSchema: { type: "object", properties: { targetId: { type: "string" } }, required: ["targetId"], additionalProperties: false } },
  { name: "browser_status", description: "Show Browser Run session, limits, tabs, and a temporary Live View URL when available.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }
];

function jsonRpc(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}
function textContent(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}
function responseJson(body, status = 200, sessionId) {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  return new Response(JSON.stringify(body), { status, headers });
}
function safeInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

async function ensureBrowserSession(env, request) {
  const requested = request.headers.get("Mcp-Session-Id");
  if (requested) {
    try {
      const current = await env.BROWSER.getSession(requested);
      if (current) return { sessionId: requested, reused: true };
    } catch (_) {}
  }
  const created = await env.BROWSER.acquire({ keepAlive: 60000, targets: true, liveViewUrlExpiresInMs: 300000 });
  return { sessionId: created.sessionId, reused: false, targets: created.targets || [] };
}

async function pageTarget(env, sessionId) {
  let targets = await env.BROWSER.devtools.listTargets(sessionId, { liveViewUrlExpiresInMs: 300000 });
  let pages = targets.filter((t) => t.type === "page");
  if (!pages.length) {
    const opened = await env.BROWSER.devtools.newTarget(sessionId, "about:blank", { liveViewUrlExpiresInMs: 300000 });
    return opened;
  }
  return pages[pages.length - 1];
}

async function withCdp(env, sessionId, fn) {
  const connection = await env.BROWSER.connectSession(sessionId);
  const upgrade = await connection.webSocket.fetch("https://browser-binding.invalid", { headers: { Upgrade: "websocket" } });
  if (!upgrade.webSocket) throw new Error("Browser Run did not return a CDP WebSocket");
  const socket = upgrade.webSocket;
  socket.accept();
  let nextId = 0;

  const send = (method, params = {}, targetSessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { cleanup(); reject(new Error(`CDP ${method} timed out`)); }, 25000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
    };
    const onClose = () => { cleanup(); reject(new Error("CDP connection closed")); };
    const onMessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (msg.id !== id) return;
      cleanup();
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    try {
      socket.send(JSON.stringify({ id, method, params, ...(targetSessionId ? { sessionId: targetSessionId } : {}) }));
    } catch (e) { cleanup(); reject(e); }
  });

  try {
    return await fn(send);
  } finally {
    try { socket.close(); } catch (_) {}
  }
}

async function withPage(env, browserSessionId, fn) {
  const target = await pageTarget(env, browserSessionId);
  return await withCdp(env, browserSessionId, async (send) => {
    const attached = await send("Target.attachToTarget", { targetId: target.id, flatten: true });
    const sid = attached.sessionId;
    await send("Runtime.enable", {}, sid);
    await send("Page.enable", {}, sid);
    return await fn(send, sid, target);
  });
}

async function evaluate(env, browserSessionId, expression, returnByValue = true) {
  return await withPage(env, browserSessionId, async (send, sid) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue, userGesture: true }, sid);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Page evaluation failed");
    return result.result?.value;
  });
}

const snapshotExpression = (maxText) => `(() => {
  const esc = (s) => { try { return CSS.escape(String(s)); } catch { return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&"); } };
  const selectorFor = (el) => {
    if (el.id) return '#' + esc(el.id);
    const testid = el.getAttribute('data-testid');
    if (testid) return '[data-testid="' + String(testid).replace(/"/g, '\\\\"') + '"]';
    if (el.getAttribute('name')) return el.tagName.toLowerCase() + '[name="' + String(el.getAttribute('name')).replace(/"/g, '\\\\"') + '"]';
    const path = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter(x => x.tagName === cur.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      path.unshift(part);
      cur = parent;
      if (path.length >= 5) break;
    }
    return path.join(' > ');
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')]
    .filter(visible).slice(0, 180).map((el, i) => ({
      i,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || undefined,
      text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 300),
      aria: el.getAttribute('aria-label') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      name: el.getAttribute('name') || undefined,
      href: el.href || undefined,
      selector: selectorFor(el)
    }));
  return {
    url: location.href,
    title: document.title,
    text: (document.body?.innerText || '').slice(0, ${maxText}),
    interactive: nodes
  };
})()`;

async function runTool(env, browserSessionId, name, args = {}) {
  switch (name) {
    case "browser_navigate": {
      const url = new URL(String(args.url)).toString();
      return await withPage(env, browserSessionId, async (send, sid) => {
        await send("Page.navigate", { url }, sid);
        await new Promise(r => setTimeout(r, 900));
        const state = await send("Runtime.evaluate", { expression: "({url:location.href,title:document.title})", returnByValue: true }, sid);
        return textContent(state.result?.value || { url });
      });
    }
    case "browser_snapshot": {
      const maxText = safeInt(args.maxText, 12000, 1000, 30000);
      return textContent(await evaluate(env, browserSessionId, snapshotExpression(maxText)));
    }
    case "browser_click": {
      const selector = JSON.stringify(String(args.selector));
      const expr = `(() => { const el=document.querySelector(${selector}); if(!el) throw new Error('Element not found'); el.scrollIntoView({block:'center'}); el.click(); return {clicked:true,tag:el.tagName.toLowerCase(),text:(el.innerText||el.value||'').slice(0,200),url:location.href}; })()`;
      const result = await evaluate(env, browserSessionId, expr);
      await new Promise(r => setTimeout(r, 500));
      return textContent(result);
    }
    case "browser_fill": {
      const selector = JSON.stringify(String(args.selector));
      const value = JSON.stringify(String(args.value));
      const expr = `(() => { const el=document.querySelector(${selector}); if(!el) throw new Error('Element not found'); el.scrollIntoView({block:'center'}); el.focus(); const v=${value}; if(el.tagName==='SELECT'){ el.value=v; } else if('value' in el){ const proto=Object.getPrototypeOf(el); const desc=Object.getOwnPropertyDescriptor(proto,'value'); if(desc&&desc.set) desc.set.call(el,v); else el.value=v; } else { el.textContent=v; } el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return {filled:true,tag:el.tagName.toLowerCase(),value:('value' in el?el.value:el.textContent)}; })()`;
      return textContent(await evaluate(env, browserSessionId, expr));
    }
    case "browser_key": {
      const key = String(args.key);
      const codes = { Enter:13, Tab:9, Escape:27, Backspace:8, Delete:46, ArrowDown:40, ArrowUp:38, ArrowLeft:37, ArrowRight:39, Space:32 };
      return await withPage(env, browserSessionId, async (send, sid) => {
        await send("Input.dispatchKeyEvent", { type:"keyDown", key, code:key, windowsVirtualKeyCode:codes[key]||0 }, sid);
        await send("Input.dispatchKeyEvent", { type:"keyUp", key, code:key, windowsVirtualKeyCode:codes[key]||0 }, sid);
        return textContent({ sent: key });
      });
    }
    case "browser_scroll": {
      const x = safeInt(args.x, 0, -10000, 10000);
      const y = safeInt(args.y, 700, -10000, 10000);
      return textContent(await evaluate(env, browserSessionId, `(() => { scrollBy(${x},${y}); return {x:scrollX,y:scrollY}; })()`));
    }
    case "browser_wait": {
      const ms = safeInt(args.ms, 1000, 0, 10000);
      await new Promise(r => setTimeout(r, ms));
      return textContent({ waitedMs: ms });
    }
    case "browser_back": {
      return textContent(await evaluate(env, browserSessionId, `(() => { history.back(); return {ok:true}; })()`));
    }
    case "browser_screenshot": {
      const result = await withPage(env, browserSessionId, async (send, sid) => {
        const shot = await send("Page.captureScreenshot", { format:"png", captureBeyondViewport: !!args.fullPage, fromSurface: true }, sid);
        return shot.data;
      });
      return { content: [{ type: "image", data: result, mimeType: "image/png" }, { type: "text", text: "Screenshot captured." }] };
    }
    case "browser_tabs": {
      const tabs = await env.BROWSER.devtools.listTargets(browserSessionId, { liveViewUrlExpiresInMs: 300000 });
      return textContent(tabs.filter(t => t.type === "page").map(t => ({ id:t.id, title:t.title, url:t.url, liveView:t.devtoolsFrontendUrl })));
    }
    case "browser_tab_open": {
      const url = args.url ? new URL(String(args.url)).toString() : "about:blank";
      const tab = await env.BROWSER.devtools.newTarget(browserSessionId, url, { liveViewUrlExpiresInMs: 300000 });
      return textContent({ id:tab.id, title:tab.title, url:tab.url, liveView:tab.devtoolsFrontendUrl });
    }
    case "browser_tab_activate": {
      await env.BROWSER.devtools.activateTarget(browserSessionId, String(args.targetId));
      return textContent({ activated:String(args.targetId) });
    }
    case "browser_tab_close": {
      const ok = await env.BROWSER.devtools.closeTarget(browserSessionId, String(args.targetId));
      return textContent({ closed:String(args.targetId), result:ok });
    }
    case "browser_status": {
      const [session, limits, tabs] = await Promise.all([
        env.BROWSER.getSession(browserSessionId),
        env.BROWSER.limits(),
        env.BROWSER.devtools.listTargets(browserSessionId, { liveViewUrlExpiresInMs: 300000 })
      ]);
      return textContent({ sessionId: browserSessionId, session, limits, tabs: tabs.filter(t=>t.type==='page').map(t=>({id:t.id,title:t.title,url:t.url,liveView:t.devtoolsFrontendUrl})) });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMcp(request, env) {
  if (request.method === "GET") return new Response("Method Not Allowed", { status: 405 });
  if (request.method === "DELETE") {
    const sid = request.headers.get("Mcp-Session-Id");
    if (sid) { try { await env.BROWSER.closeSession(sid); } catch (_) {} }
    return new Response(null, { status: 204 });
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let msg;
  try { msg = await request.json(); }
  catch { return responseJson(rpcError(null, -32700, "Parse error"), 400); }

  if (Array.isArray(msg)) return responseJson(rpcError(null, -32600, "Batch requests are not supported"), 400);
  const id = msg.id;
  const method = msg.method;

  if (method === "notifications/initialized" || method === "notifications/cancelled") return new Response(null, { status: 202 });
  if (method === "ping") return responseJson(jsonRpc(id, {}));

  if (method === "initialize") {
    const browser = await ensureBrowserSession(env, request);
    return responseJson(jsonRpc(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: "Use browser_snapshot before browser_click or browser_fill. This is a private Browser Run session."
    }), 200, browser.sessionId);
  }

  if (method === "tools/list") return responseJson(jsonRpc(id, { tools: TOOLS }), 200, request.headers.get("Mcp-Session-Id") || undefined);

  if (method === "tools/call") {
    try {
      const browser = await ensureBrowserSession(env, request);
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};
      const result = await runTool(env, browser.sessionId, name, args);
      return responseJson(jsonRpc(id, result), 200, browser.sessionId);
    } catch (e) {
      return responseJson(jsonRpc(id, { content: [{ type:"text", text:`Browser tool error: ${e?.message || String(e)}` }], isError: true }), 200, request.headers.get("Mcp-Session-Id") || undefined);
    }
  }

  return responseJson(rpcError(id, -32601, `Method not found: ${method}`), 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok:true, service:SERVER_NAME, version:SERVER_VERSION, runtime:"cloudflare-browser-run-native-cdp" }, { headers:{"cache-control":"no-store"} });
    }
    const token = env.MCP_PATH_TOKEN;
    if (!token || url.pathname !== `/mcp/${token}`) return new Response("Not Found", { status: 404 });
    return await handleMcp(request, env);
  }
};
