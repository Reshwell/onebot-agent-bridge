import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { acceptsMessage, retainsMessage, normalizeMessage, segmentsOf } from "./normalize.js";
import { BridgeError, failure, id, integer } from "./errors.js";
import { imageMime, readImage } from "./images.js";

export function targetOf(args) {
  let userId = args.userId;
  let groupId = args.groupId;
  if (args.conversationId !== undefined) {
    if (userId !== undefined || groupId !== undefined) throw new BridgeError("INVALID_ARGUMENT", "Use conversationId or userId/groupId, not both.");
    const match = /^(private|group):(\d+)$/.exec(args.conversationId);
    if (!match) throw new BridgeError("INVALID_ARGUMENT", "conversationId must be private:QQ_ID or group:GROUP_ID.");
    if (match[1] === "private") userId = match[2]; else groupId = match[2];
  }
  if ((userId !== undefined) === (groupId !== undefined)) throw new BridgeError("INVALID_ARGUMENT", "Choose exactly one userId or groupId.");
  const kind = groupId !== undefined ? "group" : "private";
  const targetId = id(groupId ?? userId, `${kind} ID`);
  return { kind, targetId, conversationId: `${kind}:${targetId}`, params: { [kind === "group" ? "group_id" : "user_id"]: Number(targetId) } };
}

export class Bridge extends EventEmitter {
  constructor(config, store, onebot) {
    super();
    this.config = config;
    this.store = store;
    this.onebot = onebot;
    this.lastIngressError = null;
    this.login = null;
    this.accountReady = false;
    this.loginRequest = null;
    this.closed = false;
    if (config.selfId) this.pin(config.selfId);
    store.reclassifyGroups((message) => acceptsMessage(message, config));
    onebot.on("event", (event) => {
      try { this.ingest(event); } catch (error) { this.lastIngressError = failure(error).error.code; }
    });
    onebot.on("connected", () => {
      this.accountReady = false;
      this.login = null;
      void this.refreshLogin().catch((error) => { this.lastIngressError = failure(error).error.code; });
    });
    onebot.on("disconnected", () => { this.accountReady = false; this.login = null; });
  }

  pin(selfId) {
    const value = id(selfId, "self_id");
    if (this.config.selfId && this.config.selfId !== value) throw new BridgeError("ACCOUNT_MISMATCH", "Received data from a different QQ account.", 409);
    this.store.pinAccount(value);
  }

  async refreshLogin() {
    if (this.loginRequest) return this.loginRequest;
    const generation = this.onebot.generation;
    this.loginRequest = (async () => {
      const login = await this.onebot.call("get_login_info");
      if (this.closed || generation !== this.onebot.generation) return;
      this.pin(login?.user_id);
      this.login = { userId: id(login.user_id, "login ID"), nickname: String(login.nickname ?? "") };
      this.accountReady = true;
      return this.login;
    })();
    try { return await this.loginRequest; } finally { this.loginRequest = null; }
  }

  async ensureAccount() {
    if (!this.accountReady) await this.refreshLogin();
    if (!this.accountReady) throw new BridgeError("ACCOUNT_NOT_READY", "The connected OneBot QQ account has not been verified yet.", 503);
  }

  ingest(event) {
    if (this.closed) throw new BridgeError("BRIDGE_STOPPED", "Bridge is shutting down.", 503);
    if (!event || typeof event !== "object" || !event.post_type) throw new BridgeError("INVALID_EVENT", "Expected a OneBot event object.");
    if (event.self_id !== undefined) this.pin(event.self_id);
    if (event.post_type === "meta_event") return { accepted: false, reason: "meta_event" };
    const message = normalizeMessage(event);
    if (!retainsMessage(message, this.config)) return { accepted: false, reason: "filtered_or_unsupported" };
    const pending = acceptsMessage(message, this.config);
    const seq = this.store.insert(message, event, { pending });
    this.lastIngressError = null;
    if (seq !== null && pending) this.emit("message", message.conversationId);
    return { accepted: seq !== null, ...(seq !== null ? { seq, pending, contextOnly: !pending } : { reason: "duplicate" }) };
  }

  async fetchMessages(args = {}) {
    const waitMs = integer(args.waitMs ?? 0, "waitMs", 0, 30000);
    integer(args.limit ?? 20, "limit", 1, 100);
    let messages = this.store.pending(args);
    if (!messages.length && waitMs && !this.closed) {
      await new Promise((done) => {
        const finish = () => { clearTimeout(timer); this.off("message", onMessage); this.off("shutdown", finish); done(); };
        const onMessage = (conversation) => { if (!args.conversationId || args.conversationId === conversation) finish(); };
        const timer = setTimeout(finish, waitMs);
        this.on("message", onMessage);
        this.on("shutdown", finish);
      });
      messages = this.store.pending(args);
    }
    messages = messages.map((message) => message.groupId ? { ...message, context: this.store.context(message, this.config.groupContextLimit) } : message);
    return { messages, ackIds: messages.map((message) => message.seq), ...this.store.counts(), delivery: "at-least-once; call ackMessages after processing; context entries are background only" };
  }

  async getImage(args) {
    const { message, raw } = this.store.incoming(args.seq);
    if (!retainsMessage(message, this.config)) throw new BridgeError("TARGET_NOT_ALLOWED", "That message is outside the current conversation allowlist.", 403);
    const attachmentIndex = integer(args.attachmentIndex ?? 0, "attachmentIndex", 0, 10000);
    const attachment = message.attachments?.[attachmentIndex];
    if (attachment?.kind !== "image") throw new BridgeError("IMAGE_NOT_FOUND", "That attachment is not an image.", 404);
    const segment = segmentsOf(raw.message ?? raw.raw_message)[attachment.segmentIndex];
    if (segment?.type !== "image") throw new BridgeError("IMAGE_NOT_FOUND", "The retained message has no matching image segment.", 404);
    let info;
    const file = String(segment.data.file_id || segment.data.file || "");
    // Refresh expiring QQ CDN URLs via get_image when an opaque file ID exists.
    if (file && file.length <= 4096 && !/^(?:https?:|file:|base64:|data:|\/|[a-z]:[\\/])/i.test(file)) {
      try { await this.ensureAccount(); info = await this.onebot.call("get_image", { file }); }
      catch (error) {
        if (error.code === "ACCOUNT_MISMATCH") throw error;
        // Direct image bytes / event URL can still work while API is offline.
      }
    }
    return { seq: message.seq, attachmentIndex, conversationId: message.conversationId, messageId: message.messageId, ...await readImage(segment.data, info, this.config) };
  }

  async localFile(filePath) {
    if (typeof filePath !== "string" || !filePath) throw new BridgeError("INVALID_ARGUMENT", "filePath is required.");
    await mkdir(this.config.fileRoot, { recursive: true, mode: 0o700 });
    let root, path, handle;
    try {
      root = await realpath(this.config.fileRoot);
      path = await realpath(resolve(root, filePath));
      const suffix = relative(root, path);
      if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new BridgeError("FILE_OUTSIDE_ROOT", "Files must be inside QBRIDGE_FILE_ROOT.");
      handle = await open(path, "r");
      const stat = await handle.stat();
      if (!stat.isFile()) throw new BridgeError("INVALID_FILE", "filePath must be a regular file.");
      if (!stat.size || stat.size > this.config.maxMediaBytes) throw new BridgeError("INVALID_FILE", "File is empty or exceeds QBRIDGE_MAX_MEDIA_BYTES.");
      const bytes = await handle.readFile();
      if (bytes.length > this.config.maxMediaBytes) throw new BridgeError("INVALID_FILE", "File exceeds QBRIDGE_MAX_MEDIA_BYTES.");
      return { bytes, relativePath: relative(root, path), name: basename(path) };
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError("FILE_UNAVAILABLE", "Cannot read that file inside QBRIDGE_FILE_ROOT.");
    } finally { await handle?.close(); }
  }

  checkTarget(target) {
    const allowed = target.kind === "group" ? this.config.allowedGroups : this.config.allowedUsers;
    if (allowed.size && !allowed.has(target.targetId)) throw new BridgeError("TARGET_NOT_ALLOWED", "This destination is outside the configured allowlist.", 403);
  }

  async send(kind, args) {
    const target = targetOf(args);
    this.checkTarget(target);
    const requestId = args.requestId ?? randomUUID();
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(requestId)) throw new BridgeError("INVALID_ARGUMENT", "requestId must be 1 to 128 letters, digits, dots, colons, underscores or hyphens.");
    let action = target.kind === "group" ? "send_group_msg" : "send_private_msg";
    let params = { ...target.params };
    let text = "";
    let descriptor = {};
    if (kind === "text") {
      if (typeof args.text !== "string" || !args.text.trim() || args.text.length > 16000) throw new BridgeError("INVALID_ARGUMENT", "text must contain 1 to 16000 characters.");
      const segments = [];
      if (args.replyTo !== undefined) segments.push({ type: "reply", data: { id: String(integer(args.replyTo, "replyTo", -Number.MAX_SAFE_INTEGER)) } });
      if (args.atUserId !== undefined) {
        if (target.kind !== "group") throw new BridgeError("INVALID_ARGUMENT", "atUserId is only available in groups.");
        segments.push({ type: "at", data: { qq: id(args.atUserId, "atUserId") } });
      }
      text = args.text;
      segments.push({ type: "text", data: { text } });
      params.message = segments;
    } else {
      const file = await this.localFile(args.filePath);
      descriptor = { name: file.name, sha256: createHash("sha256").update(file.bytes).digest("hex"), bytes: file.bytes.length };
      if (kind === "image") {
        const mimeType = imageMime(file.bytes);
        if (!mimeType) throw new BridgeError("INVALID_IMAGE", "Supported images are PNG, JPEG, GIF and WebP.");
        params.message = [{ type: "image", data: { file: `base64://${file.bytes.toString("base64")}` } }];
        descriptor.mimeType = mimeType;
      } else {
        action = target.kind === "group" ? "upload_group_file" : "upload_private_file";
        params.file = `${this.config.onebotFileRoot.replace(/[\\/]$/, "")}/${file.relativePath.split(sep).join("/")}`;
        params.name = file.name;
      }
    }
    const hash = createHash("sha256").update(JSON.stringify({ action, params })).digest("hex");
    const existing = this.store.existingDelivery(requestId, hash);
    if (existing) return { ...existing, deduplicated: true };
    await this.ensureAccount();
    const cached = this.store.beginDelivery(requestId, hash);
    if (cached) return { ...cached, deduplicated: true };
    let response;
    try { response = await this.onebot.call(action, params); }
    catch (error) {
      const definite = ["ONEBOT_API_ERROR", "ONEBOT_NOT_CONNECTED"].includes(error.code);
      const payload = failure(error);
      this.store.failDelivery(requestId, definite ? "failed" : "uncertain", payload);
      if (!definite) throw new BridgeError("SEND_UNCERTAIN", "Delivery could not be confirmed. Check QQ before sending again with a new requestId.", 502, { requestId, cause: payload.error.code });
      throw new BridgeError(payload.error.code, payload.error.message, error.status, { ...payload.error.details, requestId });
    }
    const result = { requestId, conversationId: target.conversationId, kind, ...(response?.message_id !== undefined ? { messageId: String(response.message_id) } : {}) };
    this.store.finishDelivery(requestId, result, {
      key: `outgoing:${requestId}`, selfId: this.store.account(), direction: "outgoing",
      conversationId: target.conversationId, messageType: target.kind, timestamp: Math.floor(Date.now() / 1000),
      text, kind, ...(result.messageId ? { messageId: result.messageId } : {}), ...(kind !== "text" ? { attachment: descriptor } : {}),
    });
    return result;
  }

  status() { return { ...this.onebot.status(), accountReady: this.accountReady, account: this.login ?? { userId: this.store.account() || null }, ...this.store.counts(), lastIngressError: this.lastIngressError }; }

  async dispatch(method, args = {}) {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new BridgeError("INVALID_ARGUMENT", "params must be an object.");
    if (this.closed) throw new BridgeError("BRIDGE_STOPPED", "Bridge is shutting down.", 503);
    switch (method) {
      case "status": return this.status();
      case "fetchMessages": return this.fetchMessages(args);
      case "ackMessages": return this.store.ack(args.ids);
      case "listConversations": return { conversations: this.store.conversations() };
      case "history": return { messages: this.store.history(args) };
      case "getImage": return this.getImage(args);
      case "listUsers": await this.ensureAccount(); return { users: await this.onebot.call("get_friend_list") };
      case "listGroups": await this.ensureAccount(); return { groups: await this.onebot.call("get_group_list") };
      case "sendText": return this.send("text", args);
      case "sendImage": return this.send("image", args);
      case "sendFile": return this.send("file", args);
      case "getDelivery": return this.store.delivery(args.requestId);
      default: throw new BridgeError("UNKNOWN_METHOD", "Unknown bridge method.", 404);
    }
  }

  stop() { this.closed = true; this.emit("shutdown"); this.onebot.stop(); }
}
