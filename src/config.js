import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { BridgeError, bool, id, integer } from "./errors.js";

function url(value, name, protocols) {
  if (!value) return "";
  let parsed;
  try { parsed = new URL(value); } catch { throw new BridgeError("INVALID_CONFIG", `${name} must be a valid URL.`); }
  if (!protocols.includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new BridgeError("INVALID_CONFIG", `${name} has an unsupported scheme or contains URL credentials.`);
  }
  return parsed.href;
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  let fromFile = {};
  try { fromFile = parseEnv(readFileSync(resolve(cwd, ".env"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new BridgeError("INVALID_CONFIG", "Cannot read .env."); }
  const values = { ...fromFile, ...env };
  const get = (name, fallback = "") => values[name] ?? fallback;
  const mode = get("ONEBOT_MODE", "forward");
  if (!["forward", "reverse", "http"].includes(mode)) throw new BridgeError("INVALID_CONFIG", "ONEBOT_MODE must be forward, reverse or http.");
  const list = (name) => new Set(get(name).split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => id(entry, name)));
  const fileRoot = resolve(cwd, get("QBRIDGE_FILE_ROOT", "./shared"));
  return {
    mode,
    host: get("QBRIDGE_HOST", "127.0.0.1"),
    port: integer(get("QBRIDGE_PORT", "8787"), "QBRIDGE_PORT", 0, 65535),
    bridgeUrl: url(get("QBRIDGE_URL", "http://127.0.0.1:8787"), "QBRIDGE_URL", ["http:", "https:"]),
    bridgeToken: get("QBRIDGE_TOKEN"),
    stateDir: resolve(cwd, get("QBRIDGE_STATE_DIR", "./data")),
    fileRoot,
    onebotFileRoot: get("ONEBOT_FILE_ROOT", fileRoot) || fileRoot,
    wsUrl: url(get("ONEBOT_WS_URL", "ws://127.0.0.1:3001/"), "ONEBOT_WS_URL", ["ws:", "wss:"]),
    httpUrl: url(get("ONEBOT_HTTP_URL"), "ONEBOT_HTTP_URL", ["http:", "https:"]),
    accessToken: get("ONEBOT_ACCESS_TOKEN"),
    httpAccessToken: get("ONEBOT_HTTP_ACCESS_TOKEN", get("ONEBOT_ACCESS_TOKEN")) || get("ONEBOT_ACCESS_TOKEN"),
    httpSecret: get("ONEBOT_HTTP_SECRET"),
    selfId: get("ONEBOT_SELF_ID") ? id(get("ONEBOT_SELF_ID"), "ONEBOT_SELF_ID") : "",
    groupMentionOnly: bool(values.QBRIDGE_GROUP_MENTION_ONLY, "QBRIDGE_GROUP_MENTION_ONLY"),
    allowedUsers: list("QBRIDGE_ALLOWED_USERS"),
    allowedGroups: list("QBRIDGE_ALLOWED_GROUPS"),
    apiTimeoutMs: integer(get("QBRIDGE_API_TIMEOUT_MS", "15000"), "QBRIDGE_API_TIMEOUT_MS", 100, 60000),
    maxHistory: integer(get("QBRIDGE_MAX_HISTORY", "10000"), "QBRIDGE_MAX_HISTORY", 1, 1000000),
    maxMediaBytes: integer(get("QBRIDGE_MAX_MEDIA_BYTES", "10485760"), "QBRIDGE_MAX_MEDIA_BYTES", 1, 52428800),
  };
}

export function validateServerConfig(config) {
  if (config.bridgeToken.length < 16 || config.bridgeToken === "replace-with-a-random-bridge-token") {
    throw new BridgeError("INVALID_CONFIG", "Set QBRIDGE_TOKEN to your own random value with at least 16 characters.");
  }
  if (config.mode === "forward" && !config.wsUrl) throw new BridgeError("INVALID_CONFIG", "Forward mode requires ONEBOT_WS_URL.");
  if (config.mode === "reverse" && !config.accessToken) throw new BridgeError("INVALID_CONFIG", "Reverse mode requires ONEBOT_ACCESS_TOKEN.");
  if (config.mode === "http" && (!config.httpUrl || (!config.httpSecret && !config.accessToken))) {
    throw new BridgeError("INVALID_CONFIG", "HTTP mode requires ONEBOT_HTTP_URL and either ONEBOT_HTTP_SECRET or ONEBOT_ACCESS_TOKEN for events.");
  }
}
