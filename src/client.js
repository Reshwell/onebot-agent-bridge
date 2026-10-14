import { BridgeError } from "./errors.js";

export async function rpc(config, method, params = {}) {
  if (!config.bridgeToken) throw new BridgeError("INVALID_CONFIG", "Set QBRIDGE_TOKEN to match the running daemon.");
  const target = new URL(config.bridgeUrl);
  target.pathname = `${target.pathname.replace(/\/$/, "")}/rpc`;
  target.search = "";
  let response;
  try {
    response = await fetch(target, {
      method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.bridgeToken}` },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(Math.max(config.apiTimeoutMs + 5000, Number(params.waitMs ?? 0) + 5000)),
    });
  } catch {
    throw new BridgeError("BRIDGE_UNREACHABLE", "Cannot reach the bridge daemon. Check that qbridge serve is running and QBRIDGE_URL is correct. A send may have reached the daemon; retry only with the same requestId.", 503);
  }
  let payload;
  try { payload = await response.json(); } catch { throw new BridgeError("BRIDGE_BAD_RESPONSE", "Bridge returned invalid JSON.", 502); }
  if (!response.ok || !payload.ok) throw new BridgeError(payload.error?.code ?? "BRIDGE_ERROR", payload.error?.message ?? "Bridge request failed.", response.status, payload.error?.details);
  return payload.data;
}
