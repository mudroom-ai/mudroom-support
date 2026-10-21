// Support-door contracts laid down by T1 so the parallel lanes build against fixed
// signatures. Everything here is a stub: no behaviour yet, and nothing in the core calls it.
// Each export names the task that implements it (see the design's Implementation Tasks).

import type { FieldCaps } from "./config.js";
import { err, type GatewayError } from "./errors.js";

// ---- T4a (lane B): masking and field caps, pure functions ----

const MASK = "[masked]";

/**
 * Secret patterns, most specific first. Each is either a whole-match pattern (the match
 * becomes `[masked]`) or keeps capture group 1 (the label, e.g. `password=`) and masks the rest.
 * Conservative on purpose: every pattern needs a vendor prefix, a JWT's three parts, or an
 * explicit secret-ish label, so ordinary words, ids, UUIDs and short hex stay as typed.
 */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp; keepLabel?: true }> = [
  { name: "pem private key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { name: "stripe", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: "github", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { name: "slack", re: /\b(?:xox[abeprs]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,})/g },
  { name: "resend", re: /\bre_[A-Za-z0-9_]{16,}/g },
  { name: "aws access key id", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "google api key", re: /\bAIza[0-9A-Za-z_-]{35}/g },
  // Authorization: Bearer <token> (also Basic/Token), as a header line or a curl -H value.
  { name: "authorization header", re: /(\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)\s+)[^\s"',;]+/gi, keepLabel: true },
  { name: "api key header", re: /(\b(?:x-api-key|api-key|x-auth-token)["']?\s*:\s*["']?)[^\s"',;]+/gi, keepLabel: true },
  // scheme://user:password@host
  { name: "url credentials", re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/gi, keepLabel: true },
  // password=..., GITHUB_TOKEN=..., ?api_key=...&, "client_secret": "..." (the label must end in the keyword: max_tokens=4096 stays).
  {
    name: "secret assignment",
    re: /(\b[A-Za-z0-9_-]*?(?:password|passwd|secret|secret[_-]?key|token|api[_-]?key|access[_-]?key|private[_-]?key)\b["']?\s*=\s*["']?)[^\s"'&;,]+/gi,
    keepLabel: true,
  },
  // The same with ":" (YAML, JSON), only when the value looks like a credential (8+ chars with a digit), so prose like "password: incorrect" stays.
  {
    name: "secret key-value",
    re: /(\b[A-Za-z0-9_-]*?(?:password|passwd|secret|secret[_-]?key|token|api[_-]?key|access[_-]?key|private[_-]?key)\b["']?\s*:\s*["']?)(?=[^\s"'&;,]*\d)[^\s"'&;,]{8,}/gi,
    keepLabel: true,
  },
];

/** T4a: replace API-key and token patterns with `[masked]` before anything is stored (design section 2). */
export function maskSecrets(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p.re, (match: string, label?: string) => {
      if (!p.keepLabel) return MASK;
      const value = match.slice((label ?? "").length);
      return value === MASK ? match : `${label ?? ""}${MASK}`;
    });
  }
  return out;
}

/** The question's text fields as the agent sent them (design section 2). */
export interface TicketFields {
  message: string;
  error?: string | undefined;
  tried?: string | undefined;
  environment?: string | undefined;
}

const CAPPED_FIELDS = ["message", "error", "tried", "environment"] as const;

/** T4a: null when every field is within its cap, else invalid_request naming the field and its cap (never truncate). Lengths count characters (code points). */
export function checkFieldCaps(fields: TicketFields, caps: FieldCaps): GatewayError | null {
  for (const f of CAPPED_FIELDS) {
    const v = fields[f];
    if (typeof v !== "string") continue;
    const n = Array.from(v).length;
    if (n > caps[f]) {
      const where = f === "message" ? "message" : `context.${f}`;
      return err("invalid_request", `${where} is ${n} characters; the cap is ${caps[f]}. Shorten it (keep the most relevant part) and send again.`).error;
    }
  }
  return null;
}

// ---- T4b: the support request shape ----

/** T4b: POST /api/messages body; `requester` maps onto the stored customer (email required), `context` is stored masked in threads.context_json. */
export interface SupportRequest {
  requester?: { name?: string; email?: string };
  message?: string;
  context?: { error?: string; tried?: string; environment?: string };
  idempotency_key?: string;
}

// ---- T5b: the reply-email queue (requester_emails table, one pending row per thread) ----

/** T5b: one pending reply email for a thread; mirrors a requester_emails row. */
export interface PendingReplyEmail {
  thread_id: string;
  due_at_ms: number;
  attempts: number;
  /** held: due, but the address is not verified yet; released when the requester confirms. */
  state: "pending" | "held" | "sending" | "failed";
  last_error: string | null;
}

/** T5b: queue a support reply for email (upsert, due at max(now + grace, last email + spacing)), and send what is due in the 30 s sweep. */
export interface ReplyEmailQueue {
  /** Called on every support reply. */
  onOwnerReply(threadId: string, nowMs: number): void;
  /** Called from the sweep: sends due rows, at most one email per thread, marks the carried messages emailed_at. */
  sweep(nowMs: number): Promise<void>;
}

// ---- T5b: per-question email confirmation (email_confirmations, verified_addresses) ----

/** T5b: one confirm email per new question (3/address/day, 50/vendor/day); confirm by POST, single use, 24 h. */
export interface ConfirmFlow {
  /** Send the confirm email for this question if the caps allow; returns whether one was sent. */
  requestConfirm(threadId: string, address: string, nowMs: number): Promise<{ sent: boolean }>;
  /** The POST behind the confirm button. Marks the question confirmed and the address verified. */
  confirm(token: string, nowMs: number): Promise<{ ok: true; thread_id: string } | { ok: false; reason: "unknown" | "expired" | "used" }>;
  /** True when this address confirmed a question within support.verified_address_days. Does not gate emails: those need the question itself confirmed. */
  isVerified(address: string, nowMs: number): boolean;
}

// ---- T6: resume tokens (resume_tokens table) ----

/** T6: a new token per reply email; every hash stays valid until the thread is purged. Separate from the agent's read_token. */
export interface ResumeTokens {
  /** Mint a token (24 random bytes, base64url) for one email; only its hash is stored. */
  mint(threadId: string, nowMs: number): string;
  /** True when `token` is one of this thread's resume tokens. */
  verify(threadId: string, token: string): boolean;
}
