import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startServer } from "../src/server.js";
import { setupConfig, mockWS, message, eventually, png } from "./helpers.js";

test("official MCP client completes stdio handshake and calls QQ tools end to end", async (t) => {
  const backend = await mockWS(t);
  const config = await setupConfig(t, { wsUrl: backend.url });
  const daemon = await startServer(config); t.after(() => daemon.close());
  await eventually(() => daemon.bridge.login);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/mcp.js", import.meta.url))],
    env: { PATH: process.env.PATH, QBRIDGE_TOKEN: config.bridgeToken, QBRIDGE_URL: `http://127.0.0.1:${daemon.port}` },
    stderr: "pipe",
  });
  const client = new Client({ name: "qbridge-test", version: "1.0.0" });
  await client.connect(transport); t.after(() => client.close());
  const listed = await client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === "fetchMessages"));
  assert.ok(listed.tools.some((tool) => tool.name === "sendText"));
  assert.ok(listed.tools.some((tool) => tool.name === "getImage"));
  assert.ok(!JSON.stringify(listed).includes(backendTokenLiteral()));
  backend.emit(message());
  await eventually(() => daemon.store.counts().pending === 1);
  const fetched = await client.callTool({ name: "fetchMessages", arguments: {} });
  const batch = JSON.parse(fetched.content[0].text).data;
  const sent = await client.callTool({ name: "sendText", arguments: { conversationId: batch.messages[0].conversationId, text: "mcp reply", requestId: "mcp-send" } });
  assert.equal(JSON.parse(sent.content[0].text).data.messageId, "999");
  const acked = await client.callTool({ name: "ackMessages", arguments: { ids: batch.ackIds } });
  assert.equal(JSON.parse(acked.content[0].text).data.acknowledged, 1);
  const invalid = await client.callTool({ name: "sendText", arguments: { userId: "20002", text: "invalid", accessToken: "secret" } });
  assert.equal(invalid.isError, true);
  assert.equal(backend.calls.filter((call) => call.action === "send_private_msg").length, 1);
  backend.emit(message({ message_id: 202, message: [{ type: "image", data: { file: `base64://${png.toString("base64")}` } }] }));
  await eventually(() => daemon.store.counts().pending === 1);
  const imageBatch = JSON.parse((await client.callTool({ name: "fetchMessages", arguments: {} })).content[0].text).data;
  const imageResult = await client.callTool({ name: "getImage", arguments: imageBatch.messages[0].attachments[0].imageRef });
  assert.equal(imageResult.content[1].type, "image");
  assert.equal(imageResult.content[1].mimeType, "image/png");
  assert.equal(imageResult.content[1].data, png.toString("base64"));
  assert.equal(JSON.parse(imageResult.content[0].text).data.base64, undefined);
  assert.equal(daemon.store.counts().pending, 1);
});

function backendTokenLiteral() { return "test-onebot-token"; }
