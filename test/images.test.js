import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readImage, isPublicAddress, imageUrl } from "../src/images.js";
import { startServer } from "../src/server.js";
import { rpc } from "../src/client.js";
import { setupConfig, mockWS, eventually, message, png } from "./helpers.js";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

async function imageServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("image bytes: base64, sniffed MIME, caps and no automatic queue acknowledgement", async (t) => {
  const backend = await mockWS(t);
  const config = await setupConfig(t, { wsUrl: backend.url });
  const daemon = await startServer(config); t.after(() => daemon.close());
  const client = { ...config, bridgeUrl: `http://127.0.0.1:${daemon.port}` };
  await eventually(() => daemon.bridge.accountReady);
  backend.emit(message({ message: [{ type: "text", data: { text: "photo" } }, { type: "image", data: { file: `base64://${png.toString("base64")}` } }] }));
  await eventually(() => daemon.store.counts().pending === 1);
  const batch = await rpc(client, "fetchMessages");
  const reference = batch.messages[0].attachments[0].imageRef;
  assert.deepEqual(reference, { seq: batch.messages[0].seq, attachmentIndex: 0 });
  assert.ok(!JSON.stringify(batch).includes(png.toString("base64")), "normal fetch stays compact");
  const image = await rpc(client, "getImage", reference);
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.bytes, png.length);
  assert.deepEqual(Buffer.from(image.base64, "base64"), png);
  assert.equal(daemon.store.counts().pending, 1);
  await assert.rejects(() => rpc(client, "getImage", { seq: reference.seq, attachmentIndex: 1 }), (error) => error.code === "IMAGE_NOT_FOUND");
  await assert.rejects(() => rpc(client, "getImage", { seq: 99999 }), (error) => error.code === "MESSAGE_NOT_FOUND");
  await assert.rejects(() => readImage({ file: "base64://PCE=" }, null, config), (error) => error.code === "INVALID_IMAGE");
  await assert.rejects(() => readImage({ file: "base64://not@@base64" }, null, config), (error) => error.code === "INVALID_IMAGE");
  await assert.rejects(() => readImage({ file: `base64://${png.toString("base64")}` }, null, { ...config, maxMediaBytes: 10 }), (error) => error.code === "IMAGE_TOO_LARGE");
});

test("get_image refreshes stale event URL; HTTP RPC returns bytes without tokens or signed links", async (t) => {
  const requests = [];
  const base = await imageServer(t, (request, response) => {
    requests.push(request);
    response.setHeader("Content-Type", "image/png"); response.end(png);
  });
  const backend = await mockWS(t);
  backend.imageInfo("photo-id", { url: `${base}/fresh?rkey=private-download-key` });
  const config = await setupConfig(t, { wsUrl: backend.url, imageAllowedHosts: new Set(["127.0.0.1"]), imageAllowPrivateNetwork: true });
  const daemon = await startServer(config); t.after(() => daemon.close());
  const client = { ...config, bridgeUrl: `http://127.0.0.1:${daemon.port}` };
  await eventually(() => daemon.bridge.accountReady);
  backend.emit(message({ message: [{ type: "image", data: { file: "photo-id", url: `${base}/stale?rkey=expired-key` } }] }));
  await eventually(() => daemon.store.counts().pending === 1);
  const batch = await rpc(client, "fetchMessages");
  const result = await rpc(client, "getImage", batch.messages[0].attachments[0].imageRef);
  assert.equal(result.base64, png.toString("base64"));
  assert.equal(backend.calls.filter((call) => call.action === "get_image")[0].params.file, "photo-id");
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.includes("/fresh"));
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[0].headers.cookie, undefined);
  assert.ok(!JSON.stringify({ batch, result }).includes("rkey="));
  assert.ok(!JSON.stringify(result).includes(config.accessToken));
});

test("image URL security blocks credentials, non-CDNs, private DNS, mapped IPs and redirect escape", async (t) => {
  const config = await setupConfig(t);
  for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.1.1", "198.18.0.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "2001:db8::1"]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["1.1.1.1", "8.8.8.8", "240e::1", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(address), true, address);
  assert.equal(imageUrl("https://gchat.qpic.cn/photo", config).hostname, "gchat.qpic.cn");
  for (const value of ["https://qpic.cn.evil.example/image", "https://evilqpic.cn/image", "https://name:secret@gchat.qpic.cn/photo", "file:///etc/passwd", "http://127.0.0.1/image"]) assert.throws(() => imageUrl(value, config), (error) => error.code === "IMAGE_SOURCE_BLOCKED");
  const loopback = { ...config, imageAllowedHosts: new Set(["localhost"]) };
  await assert.rejects(() => readImage({ url: "http://localhost:1/image" }, null, loopback), (error) => error.code === "IMAGE_SOURCE_BLOCKED");
  const base = await imageServer(t, (_request, response) => { response.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" }); response.end(); });
  await assert.rejects(() => readImage({ url: `${base}/redirect` }, null, { ...config, imageAllowedHosts: new Set(["127.0.0.1"]), imageAllowPrivateNetwork: true }), (error) => error.code === "IMAGE_SOURCE_BLOCKED");
});

test("image HTTP handles redirects, streaming caps, invalid data, failures and timeout safely", async (t) => {
  const base = await imageServer(t, (request, response) => {
    if (request.url === "/redirect") { response.writeHead(302, { Location: "/photo" }); response.end(); }
    else if (request.url === "/loop") { response.writeHead(302, { Location: "/loop" }); response.end(); }
    else if (request.url === "/slow") { const timer = setTimeout(() => response.end(png), 300); response.on("close", () => clearTimeout(timer)); }
    else if (request.url === "/oversize") { response.writeHead(200, { "Transfer-Encoding": "chunked" }); response.write(png); response.end(png); }
    else if (request.url === "/html") response.end("<html>not an image</html>");
    else if (request.url === "/expired") { response.writeHead(403); response.end("expired rkey"); }
    else response.end(png);
  });
  const config = await setupConfig(t, { imageAllowedHosts: new Set(["127.0.0.1"]), imageAllowPrivateNetwork: true, imageTimeoutMs: 100 });
  assert.equal((await readImage({ url: `${base}/redirect` }, null, config)).mimeType, "image/png");
  await assert.rejects(() => readImage({ url: `${base}/loop` }, null, config), (error) => error.code === "IMAGE_DOWNLOAD_FAILED");
  await assert.rejects(() => readImage({ url: `${base}/slow` }, null, config), (error) => error.code === "IMAGE_TIMEOUT");
  await assert.rejects(() => readImage({ url: `${base}/oversize` }, null, { ...config, maxMediaBytes: png.length }), (error) => error.code === "IMAGE_TOO_LARGE");
  await assert.rejects(() => readImage({ url: `${base}/html` }, null, config), (error) => error.code === "INVALID_IMAGE");
  await assert.rejects(() => readImage({ url: `${base}/expired` }, null, config), (error) => error.code === "IMAGE_DOWNLOAD_FAILED" && !error.message.includes("rkey="));
});

test("backend local image paths require explicit roots; mapped paths and symlink confinement", async (t) => {
  const config = await setupConfig(t);
  await mkdir(config.fileRoot, { recursive: true });
  await writeFile(join(config.fileRoot, "photo.png"), png);
  await assert.rejects(() => readImage({}, { file: "/backend/images/photo.png" }, config), (error) => error.code === "IMAGE_LOCAL_ROOT_REQUIRED");
  const mapped = { ...config, imageLocalRoot: config.fileRoot, onebotImageLocalRoot: "/backend/images" };
  assert.equal((await readImage({}, { file: "/backend/images/photo.png" }, mapped)).base64, png.toString("base64"));
  await assert.rejects(() => readImage({}, { file: "/backend/private.png" }, mapped), (error) => error.code === "IMAGE_SOURCE_BLOCKED");
  await mkdir(config.stateDir, { recursive: true });
  await writeFile(join(config.stateDir, "outside.png"), png);
  await symlink(join(config.stateDir, "outside.png"), join(config.fileRoot, "escape.png"));
  await assert.rejects(() => readImage({}, { file: "/backend/images/escape.png" }, mapped), (error) => error.code === "IMAGE_SOURCE_BLOCKED");
});

test("CLI saves real incoming image on consumer filesystem without overwriting existing files", async (t) => {
  const backend = await mockWS(t);
  const config = await setupConfig(t, { wsUrl: backend.url });
  const daemon = await startServer(config); t.after(() => daemon.close());
  await eventually(() => daemon.bridge.accountReady);
  backend.emit(message({ message: [{ type: "image", data: { file: `base64://${png.toString("base64")}` } }] }));
  await eventually(() => daemon.store.counts().pending === 1);
  const seq = daemon.store.pending()[0].seq;
  const file = join(config.stateDir, "consumer.png");
  const args = ["src/cli.js", "image", "--seq", String(seq), "--output", file];
  const env = { ...process.env, QBRIDGE_TOKEN: config.bridgeToken, QBRIDGE_URL: `http://127.0.0.1:${daemon.port}` };
  const result = JSON.parse((await execFileAsync(process.execPath, args, { cwd: root, env })).stdout);
  assert.equal(result.data.filePath, file);
  assert.equal(result.data.base64, undefined);
  assert.deepEqual(await readFile(file), png);
  await assert.rejects(() => execFileAsync(process.execPath, args, { cwd: root, env }), (error) => JSON.parse(error.stdout).error.code === "OUTPUT_FILE_EXISTS");
  assert.equal(daemon.store.counts().pending, 1);
});
