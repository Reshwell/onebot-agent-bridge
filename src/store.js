import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BridgeError, integer } from "./errors.js";

export class Store {
  constructor(config) {
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    this.maxHistory = config.maxHistory;
    const file = join(config.stateDir, "bridge.sqlite");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        conversation TEXT NOT NULL,
        pending INTEGER NOT NULL,
        json TEXT NOT NULL,
        raw TEXT
      );
      CREATE INDEX IF NOT EXISTS pending_messages ON messages(pending, seq);
      CREATE INDEX IF NOT EXISTS conversation_messages ON messages(conversation, seq);
      CREATE TABLE IF NOT EXISTS deliveries (
        request_id TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        state TEXT NOT NULL,
        result TEXT
      );
    `);
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  account() { return this.db.prepare("SELECT value FROM meta WHERE key = 'selfId'").get()?.value ?? ""; }

  pinAccount(selfId) {
    return this.transaction(() => {
      const saved = this.account();
      if (saved && saved !== selfId) throw new BridgeError("ACCOUNT_MISMATCH", "This state directory belongs to another QQ account. Use a separate daemon and state directory.", 409);
      this.db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('selfId', ?)").run(selfId);
    });
  }

  trim() {
    this.db.prepare("DELETE FROM messages WHERE pending = 0 AND seq NOT IN (SELECT seq FROM messages WHERE pending = 0 ORDER BY seq DESC LIMIT ?)").run(this.maxHistory);
  }

  insert(message, raw, { pending = true } = {}) {
    return this.transaction(() => {
      if (this.db.prepare("INSERT OR IGNORE INTO seen(key) VALUES (?)").run(message.key).changes === 0) return null;
      const row = this.db.prepare("INSERT INTO messages(key, conversation, pending, json, raw) VALUES (?, ?, ?, ?, ?)").run(message.key, message.conversationId, pending ? 1 : 0, JSON.stringify({ ...message, contextOnly: !pending }), JSON.stringify(raw));
      this.trim();
      return Number(row.lastInsertRowid);
    });
  }

  publicRow(row) {
    const message = JSON.parse(row.json);
    if (message.attachments) message.attachments = message.attachments.map((attachment, attachmentIndex) => ({
      ...attachment,
      ...(attachment.kind === "image" ? { imageRef: { seq: row.seq, attachmentIndex } } : {}),
    }));
    return { ...message, seq: row.seq, pending: Boolean(row.pending) };
  }

  incoming(seq) {
    seq = integer(seq, "seq", 1);
    const row = this.db.prepare("SELECT * FROM messages WHERE seq = ? AND raw IS NOT NULL").get(seq);
    if (!row) throw new BridgeError("MESSAGE_NOT_FOUND", "That incoming message is not in retained history.", 404);
    return { message: this.publicRow(row), raw: JSON.parse(row.raw) };
  }

  context(message, limit) {
    limit = integer(limit, "context limit", 0, 100);
    if (!message.groupId || !limit) return [];
    return this.db.prepare("SELECT * FROM messages WHERE conversation = ? AND seq < ? ORDER BY seq DESC LIMIT ?")
      .all(message.conversationId, message.seq, limit).reverse()
      .map((row) => ({ ...this.publicRow(row), pending: false, contextOnly: true }));
  }

  reclassifyGroups(shouldTrigger) {
    this.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM messages WHERE pending = 1 AND json_extract(json, '$.groupId') IS NOT NULL").all();
      for (const row of rows) {
        if (!shouldTrigger(this.publicRow(row))) {
          const json = { ...JSON.parse(row.json), contextOnly: true };
          this.db.prepare("UPDATE messages SET pending = 0, json = ? WHERE seq = ?").run(JSON.stringify(json), row.seq);
        }
      }
      this.trim();
    });
  }

  pending({ limit = 20, conversationId } = {}) {
    limit = integer(limit, "limit", 1, 100);
    const rows = conversationId
      ? this.db.prepare("SELECT * FROM messages WHERE pending = 1 AND conversation = ? ORDER BY seq LIMIT ?").all(conversationId, limit)
      : this.db.prepare("SELECT * FROM messages WHERE pending = 1 ORDER BY seq LIMIT ?").all(limit);
    return rows.map((row) => this.publicRow(row));
  }

  ack(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw new BridgeError("INVALID_ARGUMENT", "ids must contain 1 to 100 message sequence numbers.");
    const sequences = [...new Set(ids.map((value) => integer(value, "message sequence", 1)))];
    return this.transaction(() => {
      let acknowledged = 0;
      for (const seq of sequences) acknowledged += Number(this.db.prepare("UPDATE messages SET pending = 0 WHERE seq = ? AND pending = 1").run(seq).changes);
      this.trim();
      return { acknowledged };
    });
  }

  history({ conversationId, limit = 20, before } = {}) {
    limit = integer(limit, "limit", 1, 100);
    const upper = before === undefined ? Number.MAX_SAFE_INTEGER : integer(before, "before", 1);
    const rows = conversationId
      ? this.db.prepare("SELECT * FROM messages WHERE conversation = ? AND seq < ? ORDER BY seq DESC LIMIT ?").all(conversationId, upper, limit)
      : this.db.prepare("SELECT * FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT ?").all(upper, limit);
    return rows.reverse().map((row) => this.publicRow(row));
  }

  conversations() {
    return this.db.prepare(`SELECT conversation, MAX(seq) AS lastSeq, SUM(pending) AS pending,
      COUNT(*) AS retainedMessages FROM messages GROUP BY conversation ORDER BY lastSeq DESC LIMIT 100`).all()
      .map((row) => ({ conversationId: row.conversation, lastSeq: row.lastSeq, pending: row.pending, retainedMessages: row.retainedMessages }));
  }

  counts() { return this.db.prepare("SELECT COUNT(*) AS retainedMessages, COALESCE(SUM(pending), 0) AS pending FROM messages").get(); }

  existingDelivery(requestId, hash) {
    const old = this.db.prepare("SELECT * FROM deliveries WHERE request_id = ?").get(requestId);
    if (!old) return null;
    if (old.hash !== hash) throw new BridgeError("IDEMPOTENCY_CONFLICT", "requestId was already used with different send parameters.", 409);
    if (old.state === "sent") return JSON.parse(old.result);
    if (old.state === "failed") {
      const result = JSON.parse(old.result);
      throw new BridgeError(result.error.code, result.error.message, 502, { ...result.error.details, requestId });
    }
    throw new BridgeError("SEND_UNCERTAIN", "This request may already have been delivered. Check QQ before sending again; the bridge will not resend it.", 409, { requestId });
  }

  beginDelivery(requestId, hash) {
    return this.transaction(() => {
      const old = this.existingDelivery(requestId, hash);
      if (old) return old;
      this.db.prepare("INSERT INTO deliveries(request_id, hash, state) VALUES (?, ?, 'sending')").run(requestId, hash);
      return null;
    });
  }

  finishDelivery(requestId, result, message) {
    this.transaction(() => {
      this.db.prepare("UPDATE deliveries SET state = 'sent', result = ? WHERE request_id = ?").run(JSON.stringify(result), requestId);
      this.db.prepare("INSERT INTO messages(key, conversation, pending, json) VALUES (?, ?, 0, ?)").run(message.key, message.conversationId, JSON.stringify(message));
      this.trim();
    });
  }

  failDelivery(requestId, state, result) {
    this.db.prepare("UPDATE deliveries SET state = ?, result = ? WHERE request_id = ?").run(state, JSON.stringify(result), requestId);
  }

  delivery(requestId) {
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(requestId)) throw new BridgeError("INVALID_ARGUMENT", "A valid requestId is required.");
    const row = this.db.prepare("SELECT state, result FROM deliveries WHERE request_id = ?").get(requestId);
    if (!row) throw new BridgeError("NOT_FOUND", "Unknown requestId.", 404);
    return { requestId, state: row.state, ...(row.result ? { result: JSON.parse(row.result) } : {}) };
  }

  close() { this.db.close(); }
}
