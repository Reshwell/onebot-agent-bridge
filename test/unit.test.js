import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeMessage, segmentsOf, acceptsMessage } from "../src/normalize.js";
import { loadConfig, validateServerConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { Bridge, targetOf } from "../src/bridge.js";
import { BridgeError } from "../src/errors.js";
import { setupConfig, message } from "./helpers.js";

test("normalize private and group routes, mentions, replies, metadata without media URLs", () => {
  const privateMessage = normalizeMessage(message());
  assert.equal(privateMessage.conversationId, "private:20002");
  const group = normalizeMessage(message({ message_type: "group", group_id: 30003, message: [
    { type: "at", data: { qq: "10001" } }, { type: "reply", data: { id: "45" } },
    { type: "text", data: { text: "look" } }, { type: "image", data: { file: "a.png", url: "https://example.qq.com/photo?secret=yes" } },
  ] }));
  assert.equal(group.conversationId, "group:30003");
  assert.deepEqual(group.mentions, ["10001"]);
  assert.equal(group.replyTo, "45");
  assert.equal(group.attachments[0].fileId, "a.png");
  assert.ok(!JSON.stringify(group).includes("secret=yes"));
  assert.equal(normalizeMessage(message({ user_id: 10001 })), null);
  assert.equal(normalizeMessage({ post_type: "message_sent" }), null);
});

test("parse CQ entities once and retain commas/equal signs in parameters", () => {
  const segments = segmentsOf("a&#91;b&#93;&amp;[CQ:at,qq=10001][CQ:share,title=x&#44;y=z,url=https://qq.com/?a=1&amp;b=2]&amp;#91;");
  assert.equal(segments[0].data.text, "a[b]&");
  assert.equal(segments[1].data.qq, "10001");
  assert.equal(segments[2].data.title, "x,y=z");
  assert.equal(segments[2].data.url, "https://qq.com/?a=1&b=2");
  assert.equal(segments[3].data.text, "&#91;");
});

test("routing rejects ambiguity and filters only selected users/groups and actual @bot", async (t) => {
  assert.equal(targetOf({ conversationId: "group:30003" }).params.group_id, 30003);
  assert.throws(() => targetOf({ groupId: "1", userId: "2" }), /exactly one/);
  assert.throws(() => targetOf({ conversationId: "group:1", groupId: "1" }), /not both/);
  assert.throws(() => targetOf({ userId: "9007199254740993" }), /integer/);
  const config = await setupConfig(t, { groupMentionOnly: true, allowedGroups: new Set(["30003"]) });
  const group = normalizeMessage(message({ message_type: "group", group_id: 30003 }));
  assert.equal(acceptsMessage(group, config), false);
  group.mentions.push("10001");
  assert.equal(acceptsMessage(group, config), true);
  group.groupId = "30004";
  assert.equal(acceptsMessage(group, config), false);
  assert.equal(acceptsMessage(normalizeMessage(message()), config), true);
});

test("config rejects invalid transport/token combinations and preserves env precedence", async (t) => {
  const config = await setupConfig(t);
  assert.doesNotThrow(() => validateServerConfig(config));
  assert.throws(() => validateServerConfig({ ...config, bridgeToken: "short" }), /QBRIDGE_TOKEN/);
  assert.throws(() => validateServerConfig({ ...config, mode: "http" }), /HTTP mode/);
  assert.throws(() => validateServerConfig({ ...config, mode: "reverse", accessToken: "" }), /Reverse mode/);
  assert.throws(() => loadConfig({ ONEBOT_MODE: "bad" }), /ONEBOT_MODE/);
  const dir = join(config.stateDir, "config-test");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".env"), "QBRIDGE_PORT=1111\nQBRIDGE_GROUP_MENTION_ONLY=true\n");
  const parsed = loadConfig({ QBRIDGE_PORT: "2222" }, dir);
  assert.equal(parsed.port, 2222);
  assert.equal(parsed.groupMentionOnly, true);
});

test("SQLite keeps pending events across restart, deduplicates and retains acknowledged history", async (t) => {
  const config = await setupConfig(t, { maxHistory: 1 });
  let store = new Store(config);
  store.pinAccount("10001");
  const normalized = normalizeMessage(message());
  const seq = store.insert(normalized, message());
  assert.equal(store.insert(normalized, message()), null);
  store.close();
  store = new Store(config);
  t.after(() => store.close());
  assert.equal(store.pending()[0].seq, seq);
  assert.deepEqual(store.ack([seq, seq]), { acknowledged: 1 });
  assert.equal(store.pending().length, 0);
  assert.equal(store.history().length, 1);
  const second = store.insert(normalizeMessage(message({ message_id: 102 })), message({ message_id: 102 }));
  store.ack([second]);
  assert.equal(store.history().length, 1);
  assert.equal(store.insert(normalized, message()), null, "dedup survives history pruning");
  assert.throws(() => store.pinAccount("99999"), /another QQ account/);
  assert.equal(store.account(), "10001");
});

function fakeBackend() {
  const onebot = new EventEmitter();
  onebot.calls = [];
  onebot.call = async (action, params) => {
    if (action === "get_login_info") return { user_id: 10001, nickname: "Test Bot" };
    onebot.calls.push({ action, params }); return { message_id: 88 };
  };
  onebot.status = () => ({ websocketConnected: true });
  onebot.stop = () => {};
  return onebot;
}

test("sendText is literal, uses reply/@ segments, and request IDs prevent duplicates", async (t) => {
  const config = await setupConfig(t);
  const store = new Store(config); t.after(() => store.close());
  const onebot = fakeBackend(), bridge = new Bridge(config, store, onebot);
  const args = { groupId: "30003", text: "[CQ:at,qq=all]", replyTo: "-10", atUserId: "20002", requestId: "unit-send" };
  const first = await bridge.send("text", args);
  const second = await bridge.send("text", args);
  assert.equal(first.messageId, "88");
  assert.equal(second.deduplicated, true);
  assert.equal(onebot.calls.length, 1);
  assert.deepEqual(onebot.calls[0].params.message.map((entry) => entry.type), ["reply", "at", "text"]);
  assert.equal(onebot.calls[0].params.message[2].data.text, args.text);
  onebot.emit("disconnected");
  onebot.call = async () => { throw new BridgeError("ONEBOT_NOT_CONNECTED", "offline"); };
  assert.equal((await bridge.send("text", args)).deduplicated, true, "cached delivery is still readable while QQ is offline");
  await assert.rejects(() => bridge.send("text", { ...args, text: "different" }), /different send parameters/);
});

test("uncertain sends never retry and survive restart", async (t) => {
  const config = await setupConfig(t);
  let store = new Store(config);
  const onebot = fakeBackend();
  onebot.call = async (action) => {
    if (action === "get_login_info") return { user_id: 10001 };
    throw new BridgeError("ONEBOT_TIMEOUT", "timeout", 504);
  };
  const bridge = new Bridge(config, store, onebot);
  const args = { userId: "20002", text: "hello", requestId: "uncertain-send" };
  await assert.rejects(() => bridge.send("text", args), (error) => error.code === "SEND_UNCERTAIN");
  store.close();
  store = new Store(config); t.after(() => store.close());
  const restarted = new Bridge(config, store, fakeBackend());
  await assert.rejects(() => restarted.send("text", args), (error) => error.code === "SEND_UNCERTAIN");
  assert.equal(store.delivery(args.requestId).state, "uncertain");
});

test("send image uses base64; upload file maps shared path; symlinks cannot escape file root", async (t) => {
  const config = await setupConfig(t, { onebotFileRoot: "/remote/shared" });
  const store = new Store(config); t.after(() => store.close());
  const onebot = fakeBackend(), bridge = new Bridge(config, store, onebot);
  await mkdir(config.fileRoot, { recursive: true });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=", "base64");
  await writeFile(join(config.fileRoot, "image.png"), png);
  await writeFile(join(config.fileRoot, "report.txt"), "report");
  await bridge.send("image", { userId: "20002", filePath: "image.png", requestId: "image-send" });
  assert.equal(onebot.calls[0].params.message[0].data.file, `base64://${png.toString("base64")}`);
  await bridge.send("file", { groupId: "30003", filePath: "report.txt", requestId: "file-send" });
  assert.equal(onebot.calls[1].action, "upload_group_file");
  assert.equal(onebot.calls[1].params.file, "/remote/shared/report.txt");
  await writeFile(join(config.stateDir, "outside.txt"), "outside");
  await symlink(join(config.stateDir, "outside.txt"), join(config.fileRoot, "escape.txt"));
  await assert.rejects(() => bridge.send("file", { userId: "20002", filePath: "escape.txt" }), (error) => error.code === "FILE_OUTSIDE_ROOT");
  await assert.rejects(() => bridge.send("image", { userId: "20002", filePath: "report.txt" }), (error) => error.code === "INVALID_IMAGE");
});

test("a backend connected to the wrong account cannot send even if its socket is open", async (t) => {
  const config = await setupConfig(t, { selfId: "10001" });
  const store = new Store(config); t.after(() => store.close());
  const onebot = fakeBackend();
  onebot.call = async (action) => {
    onebot.calls.push({ action });
    return { user_id: 99999 };
  };
  const bridge = new Bridge(config, store, onebot);
  await assert.rejects(() => bridge.send("text", { userId: "20002", text: "wrong account", requestId: "wrong-account" }), (error) => error.code === "ACCOUNT_MISMATCH");
  assert.equal(onebot.calls.filter((call) => call.action === "send_private_msg").length, 0);
  assert.equal(bridge.accountReady, false);
});
