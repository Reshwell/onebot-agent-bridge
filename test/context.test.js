import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import { Bridge } from "../src/bridge.js";
import { Store } from "../src/store.js";
import { normalizeMessage } from "../src/normalize.js";
import { loadConfig } from "../src/config.js";
import { setupConfig, message, png } from "./helpers.js";

function backend() {
  const client = new EventEmitter();
  client.stop = () => {};
  client.status = () => ({});
  client.call = async () => ({ user_id: 10001 });
  return client;
}

const group = (id, text, extra = {}) => message({ message_id: id, message_type: "group", group_id: 30003, message: [{ type: "text", data: { text } }], ...extra });
const mention = (id, text) => group(id, text, { message: [{ type: "at", data: { qq: "10001" } }, { type: "text", data: { text } }] });

test("ordinary group messages stay in bounded background history, not pending and do not wake long-poll", async (t) => {
  const config = await setupConfig(t, { groupMentionOnly: true, groupContextLimit: 2, allowedGroups: new Set(["30003"]), allowedUsers: new Set(["20002"]) });
  const store = new Store(config); t.after(() => store.close());
  const bridge = new Bridge(config, store, backend());
  let triggers = 0;
  bridge.on("message", () => triggers++);
  let completed = false;
  const waiting = bridge.fetchMessages({ waitMs: 1000 }).then((value) => { completed = true; return value; });
  const background = bridge.ingest(group(1, "background by another member", { user_id: 20003 }));
  assert.equal(background.contextOnly, true);
  assert.equal((await bridge.fetchMessages()).messages.length, 0);
  await pause(30);
  assert.equal(completed, false);
  bridge.ingest(group(2, "another group", { group_id: 30004 }));
  bridge.ingest(group(3, "second"));
  bridge.ingest(group(4, "third", { user_id: 20003 }));
  bridge.ingest(mention(5, "question"));
  const batch = await waiting;
  assert.equal(triggers, 1);
  assert.equal(batch.messages.length, 1);
  assert.deepEqual(batch.messages[0].context.map((entry) => entry.text), ["second", "third"]);
  assert.ok(batch.messages[0].context.every((entry) => entry.contextOnly && !entry.pending));
  assert.deepEqual(batch.ackIds, [batch.messages[0].seq]);
  bridge.ingest(group(6, "future"));
  assert.deepEqual((await bridge.fetchMessages()).messages[0].context.map((entry) => entry.text), ["second", "third"], "context is bounded before the triggering message");
  store.ack(batch.ackIds);
  assert.equal((await bridge.fetchMessages()).messages.length, 0);
  assert.equal(store.history({ conversationId: "group:30003" }).length, 5);
});

test("group context survives restart, exposes readable image refs and does not cross conversations", async (t) => {
  const config = await setupConfig(t, { groupMentionOnly: true, groupContextLimit: 20, allowedGroups: new Set(["30003", "30004"]) });
  let store = new Store(config), bridge = new Bridge(config, store, backend());
  bridge.ingest(group(1, "old"));
  bridge.ingest(group(2, "", { message: [{ type: "image", data: { file: `base64://${png.toString("base64")}` } }] }));
  bridge.ingest(group(3, "other", { group_id: 30004 }));
  bridge.stop(); store.close();
  store = new Store(config); t.after(() => store.close());
  bridge = new Bridge(config, store, backend());
  bridge.ingest(mention(4, "what is the photo?"));
  const batch = await bridge.fetchMessages();
  assert.equal(batch.messages.length, 1);
  assert.equal(batch.messages[0].context.length, 2);
  const imageRef = batch.messages[0].context[1].attachments[0].imageRef;
  assert.equal((await bridge.getImage(imageRef)).base64, png.toString("base64"));
  assert.equal(store.counts().pending, 1);
  assert.equal((await bridge.fetchMessages()).messages[0].context.some((entry) => entry.text === "other"), false);
});

test("only explicit @bot triggers; @all and disallowed speakers are background; private unaffected", async (t) => {
  assert.equal(loadConfig({}).groupMentionOnly, true);
  assert.equal(loadConfig({}).groupContextLimit, 20);
  const config = await setupConfig(t, { groupMentionOnly: true, allowedUsers: new Set(["20002"]) });
  const store = new Store(config); t.after(() => store.close());
  const bridge = new Bridge(config, store, backend());
  bridge.ingest(group(1, "all", { message: [{ type: "at", data: { qq: "all" } }] }));
  bridge.ingest({ ...mention(2, "disallowed speaker"), user_id: 20003 });
  bridge.ingest(message({ message_id: 3 }));
  const batch = await bridge.fetchMessages();
  assert.equal(batch.messages.length, 1);
  assert.equal(batch.messages[0].conversationId, "private:20002");
  assert.equal(batch.messages[0].context, undefined);
  assert.equal(store.history({ conversationId: "group:30003" }).length, 2);
});

test("upgrade reclassifies old ordinary pending group messages without losing their history", async (t) => {
  const config = await setupConfig(t, { groupMentionOnly: true, groupContextLimit: 20 });
  const store = new Store(config); t.after(() => store.close());
  const ordinary = group(1, "previously queued under all-message mode");
  store.insert(normalizeMessage(ordinary), ordinary);
  assert.equal(store.counts().pending, 1);
  const bridge = new Bridge(config, store, backend());
  assert.equal(store.counts().pending, 0);
  assert.equal(store.history()[0].contextOnly, true);
  bridge.ingest(mention(2, "new request"));
  assert.equal((await bridge.fetchMessages()).messages[0].context[0].text, ordinary.message[0].data.text);
});
