import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { BridgeError, failure } from "./errors.js";
import { validateServerConfig } from "./config.js";
import { Store } from "./store.js";
import { OneBot } from "./onebot.js";
import { Bridge } from "./bridge.js";

function equal(a, b) {
  const left = Buffer.from(String(a ?? "")), right = Buffer.from(String(b ?? ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearer(request, expected, query = false) {
  const header = request.headers.authorization;
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : query ? new URL(request.url, "http://bridge").searchParams.get("access_token") : "";
  return expected && equal(supplied, expected);
}

async function bodyOf(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new BridgeError("BODY_TOO_LARGE", "Request body exceeds 1 MiB.", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function jsonOf(body) {
  try { return JSON.parse(body.toString("utf8")); } catch { throw new BridgeError("INVALID_JSON", "Request body must be JSON."); }
}

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(payload));
}

export async function startServer(config) {
  validateServerConfig(config);
  const store = new Store(config);
  let bridge;
  try { bridge = new Bridge(config, store, new OneBot(config)); } catch (error) { store.close(); throw error; }
  const onebot = bridge.onebot;
  const active = new Set();
  let stopping = false;
  const server = createServer((request, response) => {
    const task = handle(request, response).catch((error) => {
      if (!response.headersSent && !response.destroyed) json(response, error.status ?? 500, failure(error));
    });
    active.add(task);
    void task.finally(() => active.delete(task));
  });
  server.requestTimeout = 45000;
  server.headersTimeout = 10000;
  server.on("clientError", (_error, socket) => { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); });

  async function handle(request, response) {
    const path = new URL(request.url, "http://bridge").pathname;
    if (request.method === "GET" && path === "/healthz") return json(response, 200, { ok: !stopping });
    if (stopping) throw new BridgeError("BRIDGE_STOPPED", "Bridge is shutting down.", 503);
    if (request.method === "POST" && path === "/rpc") {
      if (request.headers.origin) throw new BridgeError("ORIGIN_NOT_ALLOWED", "Browser-origin requests are not accepted on the bridge RPC endpoint.", 403);
      if (!bearer(request, config.bridgeToken)) throw new BridgeError("UNAUTHORIZED", "Bridge token is missing or invalid.", 401);
      const packet = jsonOf(await bodyOf(request));
      const result = await bridge.dispatch(packet?.method, packet?.params ?? {});
      return json(response, 200, { ok: true, data: result });
    }
    if (request.method === "POST" && path === "/events" && config.mode === "http") {
      if (!config.httpSecret && !bearer(request, config.accessToken, true)) throw new BridgeError("UNAUTHORIZED", "OneBot event token is missing or invalid.", 401);
      const body = await bodyOf(request);
      if (config.httpSecret) {
        const expected = `sha1=${createHmac("sha1", config.httpSecret).update(body).digest("hex")}`;
        if (!equal(request.headers["x-signature"], expected)) throw new BridgeError("INVALID_SIGNATURE", "OneBot event signature is missing or invalid.", 401);
      }
      bridge.ingest(jsonOf(body));
      onebot.lastEventAt = new Date().toISOString();
      // An empty object cannot accidentally trigger OneBot quick-operation replies.
      return json(response, 200, {});
    }
    throw new BridgeError("NOT_FOUND", "Endpoint not found.", 404);
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    const deny = (status) => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); };
    if (stopping || config.mode !== "reverse" || new URL(request.url, "http://bridge").pathname !== "/onebot/v11/ws") return deny("404 Not Found");
    if (!bearer(request, config.accessToken, true)) return deny("401 Unauthorized");
    const role = String(request.headers["x-client-role"] ?? "Universal").toLowerCase();
    if (role !== "universal") return deny("400 Bad Request");
    if (onebot.socket) return deny("409 Conflict");
    try {
      if (request.headers["x-self-id"]) bridge.pin(request.headers["x-self-id"]);
    } catch { return deny("403 Forbidden"); }
    wss.handleUpgrade(request, socket, head, (websocket) => { onebot.attach(websocket); });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => { server.off("error", reject); resolve(); });
    });
  } catch {
    store.close();
    throw new BridgeError("LISTEN_FAILED", "Cannot listen on QBRIDGE_HOST/QBRIDGE_PORT. Check the address and whether another process uses the port.", 500);
  }
  onebot.start();
  if (config.mode === "http") void bridge.refreshLogin().catch((error) => { bridge.lastIngressError = failure(error).error.code; });
  let closed;
  return {
    server, bridge, store,
    port: server.address().port,
    close() {
      if (closed) return closed;
      stopping = true;
      bridge.stop();
      closed = (async () => {
        await new Promise((resolve) => server.close(resolve));
        await Promise.allSettled([...active]);
        wss.close();
        store.close();
      })();
      return closed;
    },
  };
}
