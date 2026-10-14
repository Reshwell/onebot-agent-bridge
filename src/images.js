import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeError } from "./errors.js";

export function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())) return "image/gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(address, prefix, "ipv4");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) return globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
  return false;
}

export function imageUrl(value, config) {
  let url;
  try { url = new URL(value); } catch { throw new BridgeError("IMAGE_SOURCE_BLOCKED", "Image source is not an allowed HTTP URL.", 403); }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      ![...config.imageAllowedHosts].some((allowed) => host === allowed || (!isIP(allowed) && host.endsWith(`.${allowed}`))) ||
      (!config.imageAllowPrivateNetwork && isIP(host) && !isPublicAddress(host))) {
    throw new BridgeError("IMAGE_SOURCE_BLOCKED", "Image source host or address is not allowed by the operator.", 403);
  }
  return url;
}

// Validate and pin the actual DNS answers used by the socket; no second lookup.
function safeLookup(config) {
  return (hostname, options, callback) => {
    lookup(hostname, { all: true }).then((addresses) => {
      if (!addresses.length || (!config.imageAllowPrivateNetwork && addresses.some(({ address }) => !isPublicAddress(address)))) {
        throw new BridgeError("IMAGE_SOURCE_BLOCKED", "Image DNS resolved to a private or reserved address.", 403);
      }
      const family = typeof options === "number" ? options : options.family;
      const matching = addresses.filter((entry) => !family || entry.family === family);
      if (!matching.length) throw new BridgeError("IMAGE_DOWNLOAD_FAILED", "No usable image address was found.", 502);
      if (options.all) callback(null, matching); else callback(null, matching[0].address, matching[0].family);
    }).catch((error) => callback(error instanceof BridgeError ? error : new BridgeError("IMAGE_DOWNLOAD_FAILED", "Cannot resolve the image source.", 502)));
  };
}

async function download(value, config, deadline, redirects = 0) {
  const url = imageUrl(value, config);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new BridgeError("IMAGE_TIMEOUT", "Image download exceeded its time limit.", 504);
  const result = await new Promise((resolveResult, reject) => {
    let settled = false;
    let response;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { response?.destroy(); request.destroy(); reject(error); } else resolveResult(value);
    };
    // Never forward OneBot or bridge tokens, cookies or other credentials to a CDN.
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET", agent: false, lookup: safeLookup(config),
      headers: { Accept: "image/png,image/jpeg,image/gif,image/webp", "User-Agent": "onebot-agent-bridge" },
    }, (incoming) => {
      response = incoming;
      if ([301, 302, 303, 307, 308].includes(incoming.statusCode)) {
        const location = incoming.headers.location;
        incoming.destroy();
        if (!location || redirects >= 3) return finish(new BridgeError("IMAGE_DOWNLOAD_FAILED", "Image redirect limit exceeded or target is missing.", 502));
        let redirected;
        try { redirected = imageUrl(new URL(location, url).href, config).href; }
        catch (error) { return finish(error); }
        return finish(null, { redirect: redirected });
      }
      if (incoming.statusCode !== 200) return finish(new BridgeError("IMAGE_DOWNLOAD_FAILED", "Image server did not return an image. Its temporary link may have expired.", 502, { httpStatus: incoming.statusCode }));
      if (Number(incoming.headers["content-length"]) > config.maxMediaBytes) return finish(new BridgeError("IMAGE_TOO_LARGE", "Image exceeds QBRIDGE_MAX_MEDIA_BYTES.", 413));
      const chunks = [];
      let bytes = 0;
      incoming.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > config.maxMediaBytes) return finish(new BridgeError("IMAGE_TOO_LARGE", "Image exceeds QBRIDGE_MAX_MEDIA_BYTES.", 413));
        chunks.push(chunk);
      });
      incoming.on("end", () => finish(null, { bytes: Buffer.concat(chunks) }));
      incoming.on("error", () => finish(new BridgeError("IMAGE_DOWNLOAD_FAILED", "Image transfer did not complete.", 502)));
      incoming.on("aborted", () => finish(new BridgeError("IMAGE_DOWNLOAD_FAILED", "Image transfer was interrupted.", 502)));
    });
    const timer = setTimeout(() => finish(new BridgeError("IMAGE_TIMEOUT", "Image download exceeded its time limit.", 504)), remaining);
    request.on("error", (error) => finish(error instanceof BridgeError ? error : new BridgeError("IMAGE_DOWNLOAD_FAILED", "Cannot connect to the image source.", 502)));
    request.end();
  });
  return result.redirect ? download(result.redirect, config, deadline, redirects + 1) : result.bytes;
}

function decodeBase64(value, config) {
  const text = value.replace(/^base64:\/\//i, "").replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
  if (text.length > Math.ceil(config.maxMediaBytes / 3) * 4) throw new BridgeError("IMAGE_TOO_LARGE", "Image exceeds QBRIDGE_MAX_MEDIA_BYTES.", 413);
  if (!text || !/^[a-zA-Z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) throw new BridgeError("INVALID_IMAGE", "Backend returned invalid image base64.", 502);
  return Buffer.from(text, "base64");
}

async function localImage(value, config) {
  if (!config.imageLocalRoot || !config.onebotImageLocalRoot) throw new BridgeError("IMAGE_LOCAL_ROOT_REQUIRED", "Backend only has a local image path. Configure a read-only shared image root or enable a backend URL/base64 response.", 409);
  let handle;
  try {
    const source = value.startsWith("file:") ? fileURLToPath(value) : value;
    const remoteRoot = resolve(config.onebotImageLocalRoot);
    const suffix = relative(remoteRoot, resolve(remoteRoot, source));
    if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new BridgeError("IMAGE_SOURCE_BLOCKED", "Backend image path is outside the configured image root.", 403);
    const root = await realpath(config.imageLocalRoot);
    const path = await realpath(resolve(root, suffix));
    const actual = relative(root, path);
    if (actual === ".." || actual.startsWith(`..${sep}`) || isAbsolute(actual)) throw new BridgeError("IMAGE_SOURCE_BLOCKED", "Image symlink is outside the configured image root.", 403);
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) throw new BridgeError("INVALID_IMAGE", "Backend image path is not a regular file.", 502);
    if (stat.size > config.maxMediaBytes) throw new BridgeError("IMAGE_TOO_LARGE", "Image exceeds QBRIDGE_MAX_MEDIA_BYTES.", 413);
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65536, config.maxMediaBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > config.maxMediaBytes) throw new BridgeError("IMAGE_TOO_LARGE", "Image exceeds QBRIDGE_MAX_MEDIA_BYTES.", 413);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("IMAGE_UNAVAILABLE", "Cannot read the image in the configured shared image root.", 502);
  } finally { await handle?.close(); }
}

export async function readImage(segment, info, config) {
  const deadline = Date.now() + config.imageTimeoutMs;
  const sources = [...new Set([info?.base64 ? `base64://${info.base64}` : "", info?.url, info?.file, segment.url, segment.file].filter((value) => typeof value === "string" && value))];
  let lastError;
  for (const source of sources) {
    try {
      let bytes;
      if (/^(base64:\/\/|data:image\/[a-z0-9.+-]+;base64,)/i.test(source)) bytes = decodeBase64(source, config);
      else if (/^https?:\/\//i.test(source)) bytes = await download(source, config, deadline);
      else if (/^(file:|\/|[a-z]:[\\/])/i.test(source)) bytes = await localImage(source, config);
      else continue;
      if (bytes.length > config.maxMediaBytes) throw new BridgeError("IMAGE_TOO_LARGE", "Image exceeds QBRIDGE_MAX_MEDIA_BYTES.", 413);
      const mimeType = imageMime(bytes);
      if (!mimeType) throw new BridgeError("INVALID_IMAGE", "Image data is not PNG, JPEG, GIF or WebP; HTML, JSON and SVG are not accepted.", 502);
      return { mimeType, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), base64: bytes.toString("base64") };
    } catch (error) {
      if (!(error instanceof BridgeError)) throw error;
      lastError = error;
      if (["IMAGE_TOO_LARGE", "IMAGE_TIMEOUT"].includes(error.code)) break;
    }
  }
  throw lastError ?? new BridgeError("IMAGE_UNAVAILABLE", "The backend did not provide usable image bytes, a download URL or a configured shared path.", 502);
}
