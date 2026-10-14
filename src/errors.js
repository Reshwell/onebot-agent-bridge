export class BridgeError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function failure(error) {
  if (!(error instanceof BridgeError)) {
    return { ok: false, error: { code: "INTERNAL_ERROR", message: "An internal operation failed; inspect the bridge process and its state." } };
  }
  return { ok: false, error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } };
}

export function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === "" || typeof value === "boolean") {
    throw new BridgeError("INVALID_ARGUMENT", `${name} must be an integer between ${min} and ${max}.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new BridgeError("INVALID_ARGUMENT", `${name} must be an integer between ${min} and ${max}.`);
  }
  return number;
}

export function id(value, name) {
  if (!/^\d+$/.test(String(value))) throw new BridgeError("INVALID_ARGUMENT", `${name} must be a positive numeric ID.`);
  return String(integer(value, name, 1));
}

export function bool(value, name, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new BridgeError("INVALID_ARGUMENT", `${name} must be true or false.`);
}
