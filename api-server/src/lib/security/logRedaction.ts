/**
 * Log redaction for credentials that can leak through provider error messages (query-string API keys, bearer
 * tokens, vendor key formats) and for personal identifiers that should never reach logs.
 */

const REDACTIONS: Array<[RegExp, string]> = [
  // Query-string and form credentials: api_key=..., apikey=..., key=..., token=..., access_token=...
  [/([?&](?:api[_-]?key|apikey|key|token|access[_-]?token|auth|signature|sig|client[_-]?secret)=)[^&\s"'#]+/gi, "$1[redacted]"],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [redacted]"],
  [/\b(unstract-key|x-api-key|api-key|authorization)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi, "$1: [redacted]"],
  [/\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{16,}/g, "[redacted-key]"],
  [/\bgsk_[A-Za-z0-9]{20,}/g, "[redacted-key]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted-key]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted-key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "[redacted-key]"],
  [/\bpostgres(?:ql)?:\/\/[^\s"'@]+@/gi, "postgresql://[redacted]@"],
  // Personal identifiers that occupational-health documents can carry.
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[redacted-ssn]"],
  [/\b(?:DOB|date of birth)\s*[:#]?\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/gi, "[redacted-dob]"],
];

export function redactSensitiveText(value: string): string {
  let output = value;
  for (const [pattern, replacement] of REDACTIONS) output = output.replace(pattern, replacement);
  return output;
}

function redactArgument(argument: unknown): unknown {
  if (typeof argument === "string") return redactSensitiveText(argument);
  if (argument instanceof Error) {
    const copy = new Error(redactSensitiveText(argument.message));
    copy.name = argument.name;
    copy.stack = argument.stack ? redactSensitiveText(argument.stack) : undefined;
    return copy;
  }
  return argument;
}

let installed = false;

/** Wraps console methods so every structured JSON log line is redacted before it is written. Idempotent. */
export function installConsoleRedaction(target: Console = console): void {
  if (installed && target === console) return;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => original(...args.map(redactArgument));
  }
  if (target === console) installed = true;
}
