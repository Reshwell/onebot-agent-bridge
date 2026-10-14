import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import WebSocket from "ws";
import { startServer } from "../src/server.js";
import { rpc } from "../src/client.js";
import { setupConfig, mockWS, message, eventually, respond, backendToken } from "./helpers.js";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

test("forward WS: auth, persisted fetch/ack, long-poll, routing, idempotent send and reconnect", async (t) => {
  const backend = await mockWS(t);
  const config = await setupConfig(t, { wsUrl: backend.url });
  const daemon = await startServer(config); t.after(() => daemon.close());
  const client = { ...config, bridgeUrl: `http://127.0.0.1:${daemon.port}` };
  await eventually(() => daemon.bridge.login);
  assert.equal(backend.headers[0].authorization, `Bearer ${backendToken}`);
  backend.emit(message());
  await eventually(() => daemon.store.counts().pending === 1);
  const batch = await rpc(client, "fetchMessages");
  assert.equal(batch.messages[0].conversationId, "private:20002");
  assert.equal((await rpc(client, "fetchMessages")).messages.length, 1);
  assert.equal((await rpc(client, "ackMessages", { ids: batch.ackIds })).acknowledged, 1);
  const awaited = rpc(client, "fetchMessages", { waitMs: 2000, conversationId: "group:30003" });
  await pause(30);
  backend.emit(message({ message_id: 102 }));
  backend.emit(message({ message_id: 103, message_type: "group", group_id: 30003 }));
  const group = await awaited;
  assert.equal(group.messages.length, 1);
  assert.equal(group.messages[0].groupId, "30003");
  const args = { conversationId: "group:30003", text: "reply", requestId: "forward-send" };
  await rpc(client, "sendText", args);
  await rpc(client, "sendText", args);
  assert.equal(backend.calls.filter((call) => call.action === "send_group_msg").length, 1);
  assert.equal((await rpc(client, "history", { conversationId: "group:30003" })).messages.at(-1).direction, "outgoing");
  backend.sockets[0].terminate();
  await eventually(() => backend.sockets.length >= 2);
  await eventually(() => daemon.bridge.onebot.status().websocketConnected);
  backend.emit(message());
  await eventually(() => daemon.store.counts().pending === 2);
});

test("RPC rejects missing token, browser Origin, malformed JSON and unknown methods", async (t) => {
  const backend = await mockWS(t);
  const config = await setupConfig(t, { wsUrl: backend.url });
  const daemon = await startServer(config); t.after(() => daemon.close());
  const url = `http://127.0.0.1:${daemon.port}`;
  const request = (headers, body) => fetch(`${url}/rpc`, { method: "POST", headers, body });
  assert.equal((await request({}, "{}")).status, 401);
  const headers = { Authorization: `Bearer ${config.bridgeToken}`, "Content-Type": "application/json" };
  assert.equal((await request({ ...headers, Origin: "https://example.com" }, "{}")).status, 403);
  assert.equal((await request(headers, "not-json")).status, 400);
  assert.equal((await request(headers, '{"method":"dangerousAction"}')).status, 404);
  assert.deepEqual(await (await fetch(`${url}/healthz`)).json(), { ok: true });
  const status = await rpc({ ...config, bridgeUrl: url }, "status");
  assert.ok(!JSON.stringify(status).includes(config.bridgeToken));
  assert.ok(!JSON.stringify(status).includes(backendToken));
});

test("reverse universal WS: header auth, echo RPC and account/role rejection", async (t) => {
  const config = await setupConfig(t, { mode: "reverse", selfId: "10001" });
  const daemon = await startServer(config); t.after(() => daemon.close());
  const url = `ws://127.0.0.1:${daemon.port}/onebot/v11/ws`;
  const rejected = (headers) => new Promise((resolve) => {
    const socket = new WebSocket(url, { headers });
    socket.on("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode); socket.terminate(); });
    socket.on("error", () => {});
  });
  assert.equal(await rejected({}), 401);
  assert.equal(await rejected({ Authorization: `Bearer ${backendToken}`, "X-Self-ID": "99999" }), 403);
  assert.equal(await rejected({ Authorization: `Bearer ${backendToken}`, "X-Client-Role": "Event" }), 400);
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${backendToken}`, "X-Self-ID": "10001", "X-Client-Role": "Universal" } });
  t.after(() => socket.terminate());
  const calls = [];
  socket.on("message", (bytes) => { const packet = JSON.parse(bytes.toString()); calls.push(packet); socket.send(JSON.stringify(respond(packet))); });
  await new Promise((resolve) => socket.once("open", resolve));
  await eventually(() => daemon.bridge.login);
  socket.send(JSON.stringify(message()));
  await eventually(() => daemon.store.counts().pending === 1);
  await rpc({ ...config, bridgeUrl: `http://127.0.0.1:${daemon.port}` }, "sendText", { userId: "20002", text: "reverse", requestId: "reverse-send" });
  assert.equal(calls.at(-1).action, "send_private_msg");
  assert.equal(await rejected({ Authorization: `Bearer ${backendToken}` }), 409);
});

test("HTTP events validate HMAC over exact body; actions use HTTP auth", async (t) => {
  const calls = [], headers = [];
  const api = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    headers.push(request.headers);
    calls.push({ action: request.url.slice(1), params: JSON.parse(body) });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(respond(calls.at(-1))));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => api.close(resolve)));
  const config = await setupConfig(t, { mode: "http", httpUrl: `http://127.0.0.1:${api.address().port}/`, httpSecret: "event-signing-secret" });
  const daemon = await startServer(config); t.after(() => daemon.close());
  const url = `http://127.0.0.1:${daemon.port}`;
  const body = JSON.stringify(message());
  assert.equal((await fetch(`${url}/events`, { method: "POST", body })).status, 401);
  const signature = `sha1=${createHmac("sha1", config.httpSecret).update(body).digest("hex")}`;
  assert.equal((await fetch(`${url}/events`, { method: "POST", body: `${body} `, headers: { "X-Signature": signature } })).status, 401);
  const response = await fetch(`${url}/events`, { method: "POST", body, headers: { "X-Signature": signature } });
  assert.deepEqual(await response.json(), {});
  const client = { ...config, bridgeUrl: url };
  assert.equal((await rpc(client, "fetchMessages")).messages.length, 1);
  await rpc(client, "sendText", { userId: "20002", text: "http", requestId: "http-send" });
  assert.equal(calls.at(-1).action, "send_private_msg");
  assert.equal(headers.at(-1).authorization, `Bearer ${backendToken}`);
});

test("HTTP event Bearer authentication works without an HMAC secret", async (t) => {
  const api = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ status: "ok", retcode: 0, data: { user_id: 10001 } }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => api.close(resolve)));
  const config = await setupConfig(t, { mode: "http", httpUrl: `http://127.0.0.1:${api.address().port}/` });
  const daemon = await startServer(config); t.after(() => daemon.close());
  const url = `http://127.0.0.1:${daemon.port}/events`;
  const body = JSON.stringify(message());
  assert.equal((await fetch(url, { method: "POST", body, headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await fetch(url, { method: "POST", body, headers: { Authorization: `Bearer ${backendToken}` } })).status, 200);
  assert.equal(daemon.store.counts().pending, 1);
});

test("OneBot send timeout returns uncertainty and does not duplicate a possibly delivered message", async (t) => {
  const backend = await mockWS(t);
  backend.ignoreSends();
  const config = await setupConfig(t, { wsUrl: backend.url, apiTimeoutMs: 100 });
  const daemon = await startServer(config); t.after(() => daemon.close());
  await eventually(() => daemon.bridge.login);
  const client = { ...config, bridgeUrl: `http://127.0.0.1:${daemon.port}` };
  const args = { userId: "20002", text: "timeout", requestId: "timeout-send" };
  await assert.rejects(() => rpc(client, "sendText", args), (error) => error.code === "SEND_UNCERTAIN");
  await assert.rejects(() => rpc(client, "sendText", args), (error) => error.code === "SEND_UNCERTAIN");
  assert.equal(backend.calls.filter((call) => call.action === "send_private_msg").length, 1);
});

test("actual CLI process reads events, sends JSON and rejects invalid arguments", async (t) => {
  const backend = await mockWS(t);
  const config = await setupConfig(t, { wsUrl: backend.url });
  const daemon = await startServer(config); t.after(() => daemon.close());
  await eventually(() => daemon.bridge.login);
  const env = { ...process.env, QBRIDGE_TOKEN: config.bridgeToken, QBRIDGE_URL: `http://127.0.0.1:${daemon.port}` };
  backend.emit(message());
  await eventually(() => daemon.store.counts().pending === 1);
  const batch = await execFileAsync(process.execPath, ["src/cli.js", "fetch", "--json"], { cwd: root, env });
  assert.equal(JSON.parse(batch.stdout).data.messages.length, 1);
  const sent = await execFileAsync(process.execPath, ["src/cli.js", "send", "--user", "20002", "--text", "cli", "--request-id", "cli-send"], { cwd: root, env });
  assert.equal(JSON.parse(sent.stdout).data.messageId, "999");
  assert.ok(sent.stderr.includes("requestId=cli-send"));
  await assert.rejects(() => execFileAsync(process.execPath, ["src/cli.js", "send", "--user", "20002", "--text", "a", "--image", "b"], { cwd: root, env }), (error) => JSON.parse(error.stdout).error.code === "INVALID_ARGUMENT");
});
