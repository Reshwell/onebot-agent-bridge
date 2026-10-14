#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { rpc } from "./client.js";
import { BridgeError, failure } from "./errors.js";

const help = `OneBot Agent Bridge (Node.js 24+)

  qbridge serve
  qbridge status
  qbridge fetch [--limit 20] [--wait 10000] [--conversation private:123]
  qbridge ack --ids 1,2,3
  qbridge conversations
  qbridge history [--conversation group:456] [--limit 20] [--before 50]
  qbridge image --seq 17 [--attachment 0] [--output ./photo.png]
  qbridge users
  qbridge groups
  qbridge send --user 123 --text "hello" [--request-id unique-id]
  qbridge send --group 456 --stdin [--reply-to 789] [--at 123]
  qbridge send --conversation private:123 --image image.png
  qbridge send --group 456 --file report.pdf
  qbridge delivery --request-id unique-id

Configuration: .env / environment. QBRIDGE_TOKEN must match the daemon.
All client commands output JSON. fetch does not acknowledge messages.
Images/files must be inside the daemon's QBRIDGE_FILE_ROOT.
File uploads require backend extensions and a shared path with OneBot.
image --output saves an incoming image on THIS client without overwriting.
OneBot events require a continuously running daemon; a fetch command
cannot recover messages sent while the daemon was disconnected.
`;

function optionsOf(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!key.startsWith("--") || Object.hasOwn(options, key)) throw new BridgeError("INVALID_ARGUMENT", "Unexpected or duplicate CLI option. Run qbridge help.");
    if (["--stdin", "--json"].includes(key)) options[key] = true;
    else {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new BridgeError("INVALID_ARGUMENT", "CLI option is missing a value.");
      options[key] = value;
    }
  }
  return options;
}

function only(options, allowed) {
  if (Object.keys(options).some((key) => ![...allowed, "--json"].includes(key))) throw new BridgeError("INVALID_ARGUMENT", "This command received an unsupported option. Run qbridge help.");
}

async function main() {
  const [command = "help", ...argv] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) { process.stdout.write(help); return; }
  const options = optionsOf(argv);
  const config = loadConfig();
  if (command === "serve") {
    only(options, []);
    const { startServer } = await import("./server.js");
    const daemon = await startServer(config);
    process.stderr.write(`qbridge listening on port ${daemon.port}; mode=${config.mode}\n`);
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      await daemon.close();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }
  let method, params = {};
  const basic = { status: "status", conversations: "listConversations", users: "listUsers", groups: "listGroups" };
  if (basic[command]) { only(options, []); method = basic[command]; }
  else if (["fetch", "history"].includes(command)) {
    only(options, command === "fetch" ? ["--limit", "--wait", "--conversation"] : ["--limit", "--before", "--conversation"]);
    method = command === "fetch" ? "fetchMessages" : "history";
    if (options["--limit"] !== undefined) params.limit = options["--limit"];
    if (options["--wait"] !== undefined) params.waitMs = options["--wait"];
    if (options["--before"] !== undefined) params.before = options["--before"];
    if (options["--conversation"] !== undefined) params.conversationId = options["--conversation"];
  } else if (command === "image") {
    only(options, ["--seq", "--attachment", "--output"]);
    method = "getImage";
    params.seq = options["--seq"];
    if (options["--attachment"] !== undefined) params.attachmentIndex = options["--attachment"];
  } else if (command === "ack") {
    only(options, ["--ids"]);
    method = "ackMessages";
    params.ids = String(options["--ids"] ?? "").split(",");
  } else if (command === "delivery") {
    only(options, ["--request-id"]);
    method = "getDelivery";
    params.requestId = options["--request-id"];
  } else if (command === "send") {
    only(options, ["--user", "--group", "--conversation", "--text", "--stdin", "--image", "--file", "--reply-to", "--at", "--request-id"]);
    const kinds = ["--text", "--stdin", "--image", "--file"].filter((key) => options[key] !== undefined);
    if (kinds.length !== 1) throw new BridgeError("INVALID_ARGUMENT", "Choose exactly one --text, --stdin, --image or --file.");
    const kind = kinds[0];
    method = kind === "--image" ? "sendImage" : kind === "--file" ? "sendFile" : "sendText";
    for (const [key, name] of [["--user", "userId"], ["--group", "groupId"], ["--conversation", "conversationId"], ["--reply-to", "replyTo"], ["--at", "atUserId"]]) {
      if (options[key] !== undefined) params[name] = options[key];
    }
    if (method !== "sendText" && (params.replyTo !== undefined || params.atUserId !== undefined)) throw new BridgeError("INVALID_ARGUMENT", "--reply-to and --at are supported for text sends only.");
    if (kind === "--stdin") {
      if (process.stdin.isTTY) throw new BridgeError("INVALID_ARGUMENT", "Pipe text into --stdin.");
      let text = "";
      for await (const chunk of process.stdin) {
        text += chunk.toString();
        if (text.length > 16000) throw new BridgeError("INVALID_ARGUMENT", "stdin text exceeds 16000 characters.");
      }
      params.text = text.trimEnd();
    } else if (method === "sendText") params.text = options[kind];
    else params.filePath = options[kind];
    params.requestId = options["--request-id"] ?? randomUUID();
    // Available before network I/O even if a caller loses the response.
    process.stderr.write(`requestId=${params.requestId}\n`);
  } else throw new BridgeError("INVALID_ARGUMENT", "Unknown command. Run qbridge help.");
  const data = await rpc(config, method, params);
  if (method === "getImage" && options["--output"] !== undefined) {
    const filePath = resolve(options["--output"]);
    try { await writeFile(filePath, Buffer.from(data.base64, "base64"), { flag: "wx", mode: 0o600 }); }
    catch (error) { throw new BridgeError(error.code === "EEXIST" ? "OUTPUT_FILE_EXISTS" : "OUTPUT_FILE_UNAVAILABLE", "Cannot save image. Choose a new path in an existing writable directory; existing files are not overwritten."); }
    const { base64, ...metadata } = data;
    process.stdout.write(`${JSON.stringify({ ok: true, data: { ...metadata, filePath } }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify(failure(error), null, 2)}\n`);
  process.exitCode = 1;
});
