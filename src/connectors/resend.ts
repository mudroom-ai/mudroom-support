// Resend requester notifier (eng review R8): emails the developer a support reply when
// their agent session has closed. A RequesterNotifier (see types.ts). The vendor brings
// its own Resend account, API key and verified sending domain; nothing here is Mudroom's.
//
// API (checked against resend.com/docs on 2026-10-19):
// - POST https://api.resend.com/emails, `Authorization: Bearer re_...`, JSON {from, to, subject, text};
//   200 answers {id}. Every request must carry a User-Agent or Resend answers 403.
// - `Idempotency-Key` header (max 256 chars, kept 24 h): a retry with the same key and body gets
//   the same response without a second send; same key with a different body is 409
//   invalid_idempotent_request; a retry while the first is in flight is 409 concurrent_idempotent_requests.
// - Errors answer {statusCode, name, message}; 429 carries `retry-after` (seconds).
// - GET https://api.resend.com/domains lists domains with `status` (verified, partially_verified,
//   pending, not_started, failed, partially_failed, temporary_failure). A sending_access key
//   (the kind the docs tell vendors to create) gets 401 restricted_api_key on it: the key
//   authenticated, so checkAccess passes and the domain is checked on the first send instead.

import { ConnectorError, type RequesterNotifier } from "./types.js";

const API = "https://api.resend.com";
const DEFAULT_TIMEOUT_MS = 10_000;
/** When Resend gives no Retry-After (5xx, timeout), the reply-email queue waits this long. */
const DEFAULT_RETRY_S = 30;
const USER_AGENT = "mudroom-support/0.1";
/** Domain statuses Resend sends from. */
const SENDABLE = new Set(["verified", "partially_verified"]);

export const AUTH_HINT = "RESEND_API_KEY was rejected; create a key with sending access at resend.com/api-keys";
export const domainHint = (domain: string) => `verify ${domain} in Resend and add its SPF/DKIM records`;

/** Resend `name` values that mean the key itself is wrong, revoked or lacks permission. */
const AUTH_NAMES = new Set(["missing_api_key", "invalid_api_key", "restricted_api_key", "suspended_api_key", "invalid_access", "invalid_permission"]);

export interface ResendOptions {
  apiKey: string;
  /** The From header, e.g. "Acme support <support@acme.dev>"; its domain must be verified in the vendor's Resend account. */
  from: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  warn?: (m: string) => void;
}

/** The domain part of an address, with or without a display name ("Acme <support@acme.dev>" -> "acme.dev"). */
export function fromDomain(from: string): string | undefined {
  const addr = /<([^>]+)>/.exec(from)?.[1] ?? from;
  const at = addr.lastIndexOf("@");
  const d = at >= 0 ? addr.slice(at + 1).trim().toLowerCase() : "";
  return d || undefined;
}

type ResendError = { statusCode?: number; name?: string; message?: string };

export class ResendNotifier implements RequesterNotifier {
  readonly name = "resend";
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly warn: (m: string) => void;
  private readonly domain: string;

  constructor(private readonly opts: ResendOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.warn = opts.warn ?? ((m: string) => console.warn(m));
    const domain = fromDomain(opts.from);
    if (!domain) throw new Error(`EMAIL_FROM must be an address on your Resend-verified domain, e.g. "Acme support <support@acme.dev>" (got "${opts.from}")`);
    this.domain = domain;
  }

  async checkAccess(): Promise<void> {
    const res = await this.request("GET", "/domains");
    if (res.status === 401 || res.status === 403) {
      const body = await readError(res);
      // A sending-only key authenticates but cannot list domains: the key works, the domain is checked on first send.
      if (body.name === "restricted_api_key" && /only send/i.test(body.message ?? "")) {
        this.warn(`resend: RESEND_API_KEY has sending access only, so ${this.domain} could not be checked at startup; an unverified domain shows on the first send`);
        return;
      }
      throw new ConnectorError("notifier_auth_failed", `${AUTH_HINT} (Resend: ${describe(res.status, body)})`);
    }
    if (!res.ok) throw await this.failure(res);
    const list = (await res.json().catch(() => ({}))) as { data?: Array<{ name?: string; status?: string }> };
    const d = (list.data ?? []).find((x) => x.name?.toLowerCase() === this.domain);
    if (!d) throw new ConnectorError("notifier_domain_unverified", `${domainHint(this.domain)} (it is not in this Resend account)`);
    if (!SENDABLE.has(d.status ?? "")) throw new ConnectorError("notifier_domain_unverified", `${domainHint(this.domain)} (Resend status: ${d.status ?? "unknown"})`);
  }

  async sendEmail(msg: { to: string; subject: string; text: string; idempotency_key: string }): Promise<{ provider_ref: string }> {
    const res = await this.request("POST", "/emails", { from: this.opts.from, to: [msg.to], subject: msg.subject, text: msg.text }, { "idempotency-key": msg.idempotency_key });
    if (!res.ok) throw await this.failure(res);
    const body = (await res.json().catch(() => ({}))) as { id?: unknown };
    if (typeof body.id !== "string") throw new ConnectorError("notifier_unavailable", "Resend accepted the email but returned no id", { retry_after_s: DEFAULT_RETRY_S });
    return { provider_ref: body.id };
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
    try {
      return await this.fetchImpl(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          "user-agent": USER_AGENT,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const err = e as Error | undefined;
      const why = err?.name === "TimeoutError" || err?.name === "AbortError" ? `timed out after ${this.timeoutMs} ms` : `network error: ${err?.message ?? e}`;
      throw new ConnectorError("notifier_unavailable", `Resend ${method} ${path} ${why}`, { retry_after_s: DEFAULT_RETRY_S, cause: e });
    }
  }

  /** Map a non-2xx Resend answer to the notifier codes. */
  private async failure(res: Response): Promise<ConnectorError> {
    const body = await readError(res);
    const why = `Resend: ${describe(res.status, body)}`;
    const name = body.name ?? "";
    const message = body.message ?? "";
    if (res.status === 429 || res.status >= 500 || name === "concurrent_idempotent_requests") {
      return new ConnectorError("notifier_unavailable", why, { retry_after_s: retryAfter(res) ?? DEFAULT_RETRY_S });
    }
    if (res.status === 401 || AUTH_NAMES.has(name) || /api key is invalid/i.test(message)) {
      return new ConnectorError("notifier_auth_failed", `${AUTH_HINT} (${why})`);
    }
    if (name === "invalid_from_address") return new ConnectorError("notifier_domain_unverified", `check EMAIL_FROM, then ${domainHint(this.domain)} (${why})`);
    if (res.status === 403 && /domain is not verified|verify a domain|testing emails/i.test(message)) {
      return new ConnectorError("notifier_domain_unverified", `${domainHint(this.domain)} (${why})`);
    }
    // Key reused with another body: this exact send cannot succeed, but the caller may resend under a fresh key.
    if (name === "invalid_idempotent_request") return new ConnectorError("notifier_rejected", why, { detail: "idempotency_mismatch" });
    // Bad recipient, validation error: retrying the same email cannot help.
    return new ConnectorError("notifier_rejected", why);
  }
}

async function readError(res: Response): Promise<ResendError> {
  const raw = await res.text().catch(() => "");
  try {
    const j = JSON.parse(raw) as ResendError;
    return j && typeof j === "object" ? j : {};
  } catch {
    return raw ? { message: raw.slice(0, 200) } : {};
  }
}

const describe = (status: number, b: ResendError) => `${status}${b.name ? ` ${b.name}` : ""}${b.message ? `: ${b.message}` : ""}`;

function retryAfter(res: Response): number | undefined {
  for (const h of ["retry-after", "ratelimit-reset"]) {
    const n = Number(res.headers.get(h));
    if (Number.isFinite(n) && n > 0) return Math.ceil(n);
  }
  return undefined;
}

export interface ResendSettings {
  resend_api_key: string | undefined;
  email_from: string | undefined;
}

/** The vendor's Resend notifier, or undefined when neither var is set (replies then reach only open agent sessions). Half-configured throws a fix hint. */
export function createResendNotifier(settings: ResendSettings, opts: Omit<ResendOptions, "apiKey" | "from"> = {}): ResendNotifier | undefined {
  const key = settings.resend_api_key;
  const from = settings.email_from;
  if (!key && !from) return undefined;
  if (!key) throw new Error("EMAIL_FROM is set but RESEND_API_KEY is not: create a key with sending access at resend.com/api-keys, or unset EMAIL_FROM");
  if (!from) throw new Error('RESEND_API_KEY is set but EMAIL_FROM is not: set it to an address on your Resend-verified domain, e.g. EMAIL_FROM="Acme support <support@acme.dev>"');
  return new ResendNotifier({ ...opts, apiKey: key, from });
}
