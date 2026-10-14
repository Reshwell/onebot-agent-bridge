import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { BridgeError } from "./errors.js";

function responseData(response) {
  if (!response || typeof response !== "object") throw new BridgeError("ONEBOT_BAD_RESPONSE", "OneBot returned an invalid response.", 502);
  if (response.status === "async" || Number(response.retcode) === 1) {
    throw new BridgeError("ONEBOT_ASYNC", "OneBot accepted the request asynchronously; final delivery is not confirmed.", 502);
  }
  if (response.status !== "ok" || Number(response.retcode) !== 0) {
    throw new BridgeError("ONEBOT_API_ERROR", "OneBot rejected this action. Check backend support, permissions and parameters.", 502, { retcode: Number.isFinite(Number(response.retcode)) ? Number(response.retcode) : null });
  }
  return response.data;
}

export class OneBot extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.socket = null;
    this.pending = new Map();
    this.stopped = true;
    this.lastEventAt = null;
    this.lastError = null;
    this.retry = null;
    this.reconnectAttempts = 0;
    this.heartbeat = null;
    this.generation = 0;
  }

  start() {
    this.stopped = false;
    if (this.config.mode === "forward") this.connect();
  }

  connect() {
    if (this.stopped) return;
    const headers = this.config.accessToken ? { Authorization: `Bearer ${this.config.accessToken}` } : {};
    const socket = new WebSocket(this.config.wsUrl, { headers, handshakeTimeout: this.config.apiTimeoutMs, maxPayload: 64 * 1024 * 1024 });
    this.attach(socket);
  }

  attach(socket) {
    this.generation++;
    this.socket = socket;
    let alive = true;
    socket.on("pong", () => { alive = true; });
    const opened = () => {
      this.lastError = null;
      this.reconnectAttempts = 0;
      this.heartbeat = setInterval(() => {
        if (!alive) { socket.terminate(); return; }
        alive = false;
        socket.ping();
      }, 30000);
      this.heartbeat.unref();
      this.emit("connected");
    };
    if (socket.readyState === WebSocket.OPEN) opened();
    else socket.once("open", opened);
    socket.on("message", (bytes) => {
      let packet;
      try { packet = JSON.parse(bytes.toString()); } catch { this.lastError = "INVALID_JSON"; return; }
      if (packet && Object.hasOwn(packet, "echo")) {
        const waiting = this.pending.get(packet.echo);
        if (waiting) {
          clearTimeout(waiting.timer);
          this.pending.delete(packet.echo);
          try { waiting.resolve(responseData(packet)); } catch (error) { waiting.reject(error); }
          return;
        }
      }
      if (packet?.post_type) {
        this.lastEventAt = new Date().toISOString();
        this.emit("event", packet);
      }
    });
    socket.on("error", () => { this.lastError = "CONNECTION_ERROR"; });
    socket.once("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.generation++;
      clearInterval(this.heartbeat);
      for (const waiting of this.pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new BridgeError("ONEBOT_DISCONNECTED", "OneBot disconnected; an in-flight action may have been delivered.", 503));
      }
      this.pending.clear();
      this.emit("disconnected");
      if (!this.stopped && this.config.mode === "forward") {
        const delay = Math.min(30000, 500 * 2 ** Math.min(this.reconnectAttempts++, 6));
        this.retry = setTimeout(() => this.connect(), delay);
        this.retry.unref();
      }
    });
  }

  async call(action, params = {}) {
    if (this.config.httpUrl) return this.callHttp(action, params);
    if (this.socket?.readyState !== WebSocket.OPEN) throw new BridgeError("ONEBOT_NOT_CONNECTED", "The OneBot WebSocket is not connected.", 503);
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new BridgeError("ONEBOT_TIMEOUT", "OneBot did not confirm the action before timeout; delivery may have occurred.", 504));
      }, this.config.apiTimeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ action, params, echo }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(new BridgeError("ONEBOT_DISCONNECTED", "Could not confirm the WebSocket action.", 503));
      });
    });
  }

  async callHttp(action, params) {
    const target = new URL(this.config.httpUrl);
    target.pathname = `${target.pathname.replace(/\/$/, "")}/${action}`;
    target.search = "";
    let response;
    try {
      response = await fetch(target, {
        method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", ...(this.config.httpAccessToken ? { Authorization: `Bearer ${this.config.httpAccessToken}` } : {}) },
        body: JSON.stringify(params), signal: AbortSignal.timeout(this.config.apiTimeoutMs),
      });
    } catch {
      throw new BridgeError("ONEBOT_HTTP_UNCERTAIN", "The OneBot HTTP request failed or timed out; delivery may have occurred.", 502);
    }
    if (!response.ok) throw new BridgeError("ONEBOT_HTTP_ERROR", "OneBot returned an HTTP error.", 502, { httpStatus: response.status });
    let packet;
    try { packet = await response.json(); } catch { throw new BridgeError("ONEBOT_BAD_RESPONSE", "OneBot returned invalid JSON; action outcome is unknown.", 502); }
    return responseData(packet);
  }

  status() {
    return { mode: this.config.mode, websocketConnected: this.socket?.readyState === WebSocket.OPEN,
      apiTransport: this.config.httpUrl ? "http" : "websocket", lastEventAt: this.lastEventAt, lastError: this.lastError };
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    if (this.socket) this.socket.terminate();
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new BridgeError("BRIDGE_STOPPED", "Bridge stopped with an action in flight.", 503));
    }
    this.pending.clear();
  }
}
