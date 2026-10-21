// One error shape for every operation and every HTTP response.
// Adding a code later is fine; renaming or changing a
// code's meaning, retryability or status is a contract change.

export const ERROR_CODES = [
  // 400: bad input
  "invalid_request",
  "invalid_customer", // missing name, or no valid phone|email
  "invalid_message", // POST /api/messages / follow-up: empty, too long or control characters
  // 401: bearer key present but wrong
  "unauthorized",
  // 404
  "unknown_thread", // no such thread, or read_token missing or wrong (one body for all three)
  // 409
  "idempotency_conflict", // same key, different payload
  "thread_closed", // follow-up on a closed thread, or the thread hit its message cap; start a new one
  "thread_limit_reached", // open confirmed questions per contact, or open unconfirmed questions per caller
  "message_in_progress", // same idempotency_key while the first request is still sending
  // 429
  "rate_limited",
  // 503
  "messages_disabled", // MESSAGES_ENABLED=false kill switch
  "channel_unavailable", // the support channel refused the message for good (bad token, bot removed); nothing stored
  // 500
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface GatewayError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retry_after_s?: number;
}

/** Every core op returns this. Never throw across the core/adapter boundary. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: GatewayError };

export const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  invalid_customer: 400,
  invalid_message: 400,
  unauthorized: 401,
  unknown_thread: 404,
  idempotency_conflict: 409,
  thread_closed: 409,
  thread_limit_reached: 409, // waiting won't clear it, and 429 invites auto-retry
  message_in_progress: 409,
  rate_limited: 429,
  messages_disabled: 503,
  channel_unavailable: 503,
  internal: 500,
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "rate_limited",
  // Retrying with the same idempotency_key returns the stored result once the first send finishes.
  "message_in_progress",
  "internal",
]);

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE.has(code);
}

export function err(
  code: ErrorCode,
  message: string,
  extra: { retry_after_s?: number; retryable?: boolean } = {},
): { ok: false; error: GatewayError } {
  const error: GatewayError = {
    code,
    message,
    retryable: extra.retryable ?? isRetryable(code),
  };
  if (extra.retry_after_s !== undefined) error.retry_after_s = extra.retry_after_s;
  return { ok: false, error };
}

export function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}
