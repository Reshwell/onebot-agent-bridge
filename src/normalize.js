import { createHash } from "node:crypto";
import { id } from "./errors.js";

function unescapeCQ(text, parameter = false) {
  let result = text.replaceAll("&#91;", "[").replaceAll("&#93;", "]");
  if (parameter) result = result.replaceAll("&#44;", ",");
  return result.replaceAll("&amp;", "&");
}

export function segmentsOf(message) {
  if (Array.isArray(message)) return message.filter((segment) => segment && typeof segment.type === "string" && segment.data && typeof segment.data === "object");
  if (typeof message !== "string") return [];
  const result = [];
  let cursor = 0;
  for (const match of message.matchAll(/\[CQ:([a-zA-Z0-9_-]+)((?:,[^\]]*)?)\]/g)) {
    if (match.index > cursor) result.push({ type: "text", data: { text: unescapeCQ(message.slice(cursor, match.index)) } });
    const data = Object.create(null);
    for (const entry of match[2].split(",").slice(1)) {
      const position = entry.indexOf("=");
      if (position > 0) data[entry.slice(0, position)] = unescapeCQ(entry.slice(position + 1), true);
    }
    result.push({ type: match[1], data });
    cursor = match.index + match[0].length;
  }
  if (cursor < message.length) result.push({ type: "text", data: { text: unescapeCQ(message.slice(cursor)) } });
  return result;
}

export function normalizeMessage(event) {
  if (event?.post_type !== "message" || !["private", "group"].includes(event.message_type)) return null;
  const selfId = id(event.self_id, "self_id");
  const userId = id(event.user_id, "user_id");
  if (userId === selfId) return null;
  const groupId = event.message_type === "group" ? id(event.group_id, "group_id") : undefined;
  const segments = segmentsOf(event.message ?? event.raw_message);
  const conversationId = `${event.message_type}:${groupId ?? userId}`;
  const timestamp = Number.isFinite(Number(event.time)) ? Number(event.time) : Math.floor(Date.now() / 1000);
  const messageId = event.message_id === undefined ? null : String(event.message_id);
  const synthetic = createHash("sha256").update(JSON.stringify({ timestamp, userId, segments })).digest("hex");
  const key = `${selfId}:${conversationId}:${messageId ?? synthetic}`;
  const attachments = segments.flatMap((segment, index) => {
    if (!["image", "record", "video", "file"].includes(segment.type)) return [];
    const rawFile = String(segment.data.file_id ?? segment.data.file ?? "");
    return [{
      kind: segment.type === "record" ? "voice" : segment.type,
      segmentIndex: index,
      ...(rawFile && !/^(?:https?:|file:|base64:|\/|[a-z]:\\)/i.test(rawFile) ? { fileId: rawFile } : {}),
      ...(segment.data.name ? { fileName: String(segment.data.name).slice(0, 255) } : {}),
      ...(Number.isFinite(Number(segment.data.size)) ? { bytes: Number(segment.data.size) } : {}),
    }];
  });
  return {
    key, selfId, conversationId, messageId, direction: "incoming", messageType: event.message_type,
    subType: String(event.sub_type ?? ""), userId, ...(groupId ? { groupId } : {}), timestamp,
    senderName: String(event.sender?.card || event.sender?.nickname || userId),
    text: segments.filter((segment) => segment.type === "text").map((segment) => String(segment.data.text ?? "")).join(""),
    mentions: segments.filter((segment) => segment.type === "at").map((segment) => String(segment.data.qq ?? "")),
    replyTo: segments.find((segment) => segment.type === "reply")?.data.id,
    segmentTypes: segments.map((segment) => segment.type), attachments,
  };
}

export function acceptsMessage(message, config) {
  if (!message) return false;
  if (config.allowedUsers.size && !config.allowedUsers.has(message.userId)) return false;
  if (message.groupId) {
    if (config.allowedGroups.size && !config.allowedGroups.has(message.groupId)) return false;
    if (config.groupMentionOnly && !message.mentions.includes(message.selfId)) return false;
  }
  return true;
}

// Other speakers in an allowed group are background, not new AI tasks.
export function retainsMessage(message, config) {
  if (!message) return false;
  if (message.groupId) return !config.allowedGroups.size || config.allowedGroups.has(message.groupId);
  return !config.allowedUsers.size || config.allowedUsers.has(message.userId);
}
