import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { loadConfig } from "../src/config.js";

export const token = "test-bridge-token-0123456789";
export const backendToken = "test-onebot-token";
export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=", "base64");

export async function setupConfig(t, override = {}) {
  const dir = await mkdtemp(join(tmpdir(), "qbridge-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { ...loadConfig({
    QBRIDGE_TOKEN: token, QBRIDGE_HOST: "127.0.0.1", QBRIDGE_PORT: "0",
    QBRIDGE_STATE_DIR: join(dir, "data"), QBRIDGE_FILE_ROOT: join(dir, "shared"),
    ONEBOT_ACCESS_TOKEN: backendToken,
    QBRIDGE_GROUP_MENTION_ONLY: "false",
  }, dir), ...override };
}

export function message(override = {}) {
  return { post_type: "message", message_type: "private", sub_type: "friend", time: 1800000000,
    self_id: 10001, user_id: 20002, message_id: 101, sender: { nickname: "Tester" },
    message: [{ type: "text", data: { text: "hello" } }], ...override };
}

export async function eventually(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(10); }
  throw new Error("Condition not reached before timeout");
}

export function respond(packet) {
  let data = {};
  if (packet.action === "get_login_info") data = { user_id: 10001, nickname: "Bridge Bot" };
  if (packet.action === "get_friend_list") data = [{ user_id: 20002, nickname: "Tester" }];
  if (packet.action === "get_group_list") data = [{ group_id: 30003, group_name: "Test Group" }];
  if (packet.action.startsWith("send_")) data = { message_id: 999 };
  return { status: "ok", retcode: 0, data, echo: packet.echo };
}

export async function mockWS(t) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));
  const calls = [], headers = [], sockets = [], images = new Map();
  let ignore = false;
  wss.on("connection", (socket, request) => {
    sockets.push(socket);
    headers.push(request.headers);
    socket.on("message", (bytes) => {
      const packet = JSON.parse(bytes.toString());
      calls.push(packet);
      if (ignore && packet.action.startsWith("send_")) return;
      const response = respond(packet);
      if (packet.action === "get_image" && images.has(packet.params.file)) response.data = images.get(packet.params.file);
      socket.send(JSON.stringify(response));
    });
  });
  t.after(async () => { for (const socket of wss.clients) socket.terminate(); await new Promise((resolve) => wss.close(resolve)); });
  return {
    url: `ws://127.0.0.1:${wss.address().port}/`, wss, calls, headers, sockets,
    ignoreSends() { ignore = true; },
    imageInfo(file, data) { images.set(file, data); },
    emit(event) { for (const socket of wss.clients) socket.send(JSON.stringify(event)); },
  };
}
