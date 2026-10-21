// Config: everything comes from env vars (no config file). `parseConfig` validates the
// vendor-facing object (tests build one directly); `loadEnv` reads the runtime settings and
// secrets; `loadStartup` does both and refuses to start when a required var is missing,
// with a fix hint naming the vars.
//
// Every config key the build plan needs is declared here up front (T1), so the parallel
// lanes (A: Slack delivery, B: masking + Resend, C: discovery copy) read keys instead of
// adding lines to this file. A key's comment names the task that gives it behaviour.

import { z } from "zod";

const int = () => z.number().int();

export const LimitsSchema = z.object({
  /** The owner channel should time out on its own; the core bounds a hung provider at this + 2 s. */
  connector_timeout_ms: int().positive().default(8000),
  /** Anonymous per-IP and keyed-agent request limits, per minute. */
  per_ip_per_min: int().positive().default(60),
  per_key_per_min: int().positive().default(600),
  /** New questions + follow-ups per requester contact (email), per hour. */
  per_contact_per_hour: int().positive().default(10),
  /** New questions + follow-ups, vendor-wide, per hour: bounds what a flood of agents can push into the support channel. */
  max_messages_per_hour: int().positive().default(30),
  /** Open (not closed) threads per requester contact. */
  max_open_threads_per_contact: int().positive().default(3),
  /**
   * T5c: open questions per caller (IP bucket, or API key) whose requester has not confirmed them by email yet. The
   * per-contact cap above counts only confirmed questions, so naming someone else's address cannot lock them out.
   */
  max_unconfirmed_threads_per_caller: int().positive().default(5),
  /** A thread support answered closes this long after the last support reply when the agent sends nothing more (7 days). */
  thread_close_after_reply_hours: int().positive().default(168),
  /** A thread still waiting for support closes this long after the last agent message. */
  thread_close_unanswered_days: int().positive().default(7),
  /**
   * Longest hold for GET /api/threads/:id?wait=N (long-poll); a larger wait is clamped to it. 0 turns long-polling off.
   * At most 240: Railway's edge cuts a request at about 300 s, and agents' own curl gives up at 61-270 s.
   * The published loop waits 110 s with a 130 s client timeout, under this 120 s default.
   */
  thread_wait_max_seconds: int().min(0).max(240).default(120),
  /** Held GET /api/threads/:id requests across all threads; over it, a request answers at once and the agent falls back to plain polling. */
  max_waiting_requests: int().positive().default(200),
});

/** Per-field character caps on POST /api/messages (design section 2). Over a cap is rejected with invalid_request (T4a). */
export const FieldCapsSchema = z.object({
  message: int().positive().default(2000),
  error: int().positive().default(4000),
  tried: int().positive().default(2000),
  environment: int().positive().default(500),
});

/** Support-door settings with the approved defaults (eng review R3, D4). Behaviour lands in the task named on each. */
export const SupportSchema = z.object({
  /** T4a: caps on the question and its context fields. */
  field_caps: FieldCapsSchema.default(FieldCapsSchema.parse({})),
  /** T5b: a reply email waits at least this long after a support reply, so an open agent session reads it first. */
  reply_email_grace_min: int().positive().default(5),
  /** T5b: at most one reply email per thread per this many minutes (coalescing). */
  reply_email_spacing_min: int().positive().default(15),
  /** T5b: a confirmed address may receive reply emails for this many days without confirming again. */
  verified_address_days: int().positive().default(90),
  /** Require a confirm click before a reply or failure email goes to the requester's address. Off: the email goes
   *  straight out when the agent missed the answer.
   *  gstack-shortcut(dec-a55e10d3): anyone can name any address, upgrade when an unwanted reply email is reported. */
  require_confirm: z.boolean().default(false),
  /** No read from the agent for this long, with support's answer not yet received: its session is gone, so the
   *  developer gets the confirm email that lets the reply be emailed. Above the wait loop's longest back-off (5 min). */
  agent_gone_after_min: int().positive().default(6),
  /** T5b: confirm emails per address per day. */
  confirm_emails_per_address_per_day: int().positive().default(3),
  /** T5b: confirm emails per vendor per day. */
  confirm_emails_per_vendor_per_day: int().positive().default(50),
  /** T5b: a confirm link works this long, once (confirm is a POST). */
  confirm_link_hours: int().positive().default(24),
  /** T3: a Slack post keeps retrying this long before the thread's delivery becomes `failed`. */
  slack_retry_window_hours: int().positive().default(24),
  /** T3: the Slack retry backoff never waits longer than this between attempts. */
  slack_retry_max_backoff_min: int().positive().default(30),
});

export const ConfigSchema = z.object({
  /** Single-tenant id stored on every row; one server serves one vendor. */
  vendor_id: z.string().min(1).default("default"),
  /** VENDOR_NAME: the vendor as agents and developers see it ("Acme"). */
  vendor_name: z.string().min(1),
  /** PUBLIC_URL: the door's public base URL, used in every link. Required at startup; optional here so tests can derive it from the request. */
  public_url: z.string().url().optional(),
  limits: LimitsSchema.default(LimitsSchema.parse({})),
  support: SupportSchema.default(SupportSchema.parse({})),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Limits = z.infer<typeof LimitsSchema>;
export type SupportSettings = z.infer<typeof SupportSchema>;
export type FieldCaps = z.infer<typeof FieldCapsSchema>;

const boolEnv = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

/** Runtime settings and secrets, from env only. Every var here is documented in docs/configuration.md. */
export const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("127.0.0.1"),
  /** Comma-separated hostnames allowed in the Host header (tunnel / public domain). */
  ALLOWED_HOSTS: z.string().optional(),
  DB_PATH: z.string().default("support.sqlite"),
  /** Required at startup: the vendor's name ("Acme"). */
  VENDOR_NAME: z.string().optional(),
  /** Required at startup: the door's public base URL (https://support.acme.dev). */
  PUBLIC_URL: z.string().optional(),
  /** Kill switch for the message routes. Default true. */
  MESSAGES_ENABLED: boolEnv.optional(),
  /** Comma-separated optional bearer keys. */
  API_KEYS: z.string().optional(),
  /** Express "trust proxy": hop count, or comma list of proxy IPs/CIDRs/loopback/uniquelocal; "false" = none. */
  TRUST_PROXY: z.string().default("loopback"),
  /** Log how each anonymous caller's IP was resolved (to verify TRUST_PROXY). */
  TRUST_PROXY_DEBUG: boolEnv.optional(),
  /** Honor CF-Connecting-IP from trusted peers. Only safe when the trusted proxy is Cloudflare/cloudflared, which overwrites it. */
  TRUST_CF_CONNECTING_IP: boolEnv.optional(),
  /** Required: the support channel (src/connectors/slack.ts), two-way threads over Socket Mode. */
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_CHANNEL_ID: z.string().optional(),
  /** Comma-separated Slack user ids whose thread replies count as support's; unset = anyone in the channel. */
  SLACK_OWNER_USER_IDS: z.string().optional(),
  /** Optional (lane B, T5a): the vendor's own Resend key; without it replies reach only open agent sessions. */
  RESEND_API_KEY: z.string().optional(),
  /** Optional (lane B, T5a): the From address on the vendor's verified Resend domain, e.g. "Acme support <support@acme.dev>". */
  EMAIL_FROM: z.string().optional(),
  /** Optional (lane A, T3): who is emailed at once when Slack delivery fails for good (bot removed, token revoked). */
  ADMIN_EMAIL: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export interface RuntimeSettings {
  port: number;
  host: string;
  allowed_hosts: string[];
  db_path: string;
  messages_enabled: boolean;
  api_keys: string[];
  trust_proxy: TrustProxy;
  trust_proxy_debug: boolean;
  trust_cf_connecting_ip: boolean;
  slack_bot_token: string | undefined;
  slack_app_token: string | undefined;
  slack_channel_id: string | undefined;
  slack_owner_user_ids: string[];
  resend_api_key: string | undefined;
  email_from: string | undefined;
  admin_email: string | undefined;
}

const csv = (s: string | undefined) =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const trimmed = (s: string | undefined) => s?.trim() || undefined;

/** Express "trust proxy" value: false (none), a hop count, or proxy addresses/CIDRs/names. */
export type TrustProxy = false | number | string[];

export function parseTrustProxy(raw: string): TrustProxy {
  const v = raw.trim();
  if (/^(false|none|0)$/i.test(v)) return false;
  if (/^true$/i.test(v)) {
    throw new Error("TRUST_PROXY=true would trust a client-supplied X-Forwarded-For; set a hop count (e.g. 1) or the proxy's IP/CIDR");
  }
  if (/^\d+$/.test(v)) return Number(v);
  const list = csv(v);
  return list.length ? list : ["loopback"];
}

/** Parse and validate a config object. Throws a readable error on failure. */
export function parseConfig(raw: unknown): Config {
  const r = ConfigSchema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`Invalid config:\n${issues}`);
  }
  return r.data;
}

/** Runtime settings from env. Does not enforce the required vars (see loadStartup), so tests can build partial settings. */
export function loadEnv(env: NodeJS.ProcessEnv): RuntimeSettings {
  const e = EnvSchema.parse(env);
  return {
    port: e.PORT,
    host: e.HOST,
    allowed_hosts: csv(e.ALLOWED_HOSTS),
    db_path: e.DB_PATH,
    messages_enabled: e.MESSAGES_ENABLED ?? true,
    api_keys: csv(e.API_KEYS),
    trust_proxy: parseTrustProxy(e.TRUST_PROXY),
    trust_proxy_debug: e.TRUST_PROXY_DEBUG ?? false,
    trust_cf_connecting_ip: e.TRUST_CF_CONNECTING_IP ?? false,
    slack_bot_token: trimmed(e.SLACK_BOT_TOKEN),
    slack_app_token: trimmed(e.SLACK_APP_TOKEN),
    slack_channel_id: trimmed(e.SLACK_CHANNEL_ID),
    slack_owner_user_ids: csv(e.SLACK_OWNER_USER_IDS),
    resend_api_key: trimmed(e.RESEND_API_KEY),
    email_from: trimmed(e.EMAIL_FROM),
    admin_email: trimmed(e.ADMIN_EMAIL),
  };
}

/** The vars the server cannot start without, grouped so one fix hint covers each group. */
export const REQUIRED_ENV: ReadonlyArray<{ vars: readonly string[]; hint: string }> = [
  { vars: ["VENDOR_NAME"], hint: 'the name developers know you by, e.g. VENDOR_NAME="Acme"' },
  { vars: ["PUBLIC_URL"], hint: "this door's public https URL, e.g. PUBLIC_URL=https://support.acme.dev (used in every link agents and emails get)" },
  { vars: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_CHANNEL_ID"], hint: "the Slack app that carries questions to your support channel (see docs/connectors/slack.md)" },
];

/** One line per missing group, or null when every required var is set. */
export function missingRequiredEnv(env: NodeJS.ProcessEnv): string | null {
  const lines: string[] = [];
  for (const g of REQUIRED_ENV) {
    const missing = g.vars.filter((v) => !env[v]?.trim());
    if (missing.length) lines.push(`  - set ${missing.join(", ")}: ${g.hint}`);
  }
  return lines.length ? `Missing required environment variables:\n${lines.join("\n")}\nRun \`npm run init\` to list every variable, or put them in .env.` : null;
}

/** What main() starts from: the required vars checked (throws with fix hints), then config and settings. */
export function loadStartup(env: NodeJS.ProcessEnv): { config: Config; settings: RuntimeSettings } {
  const missing = missingRequiredEnv(env);
  if (missing) throw new Error(missing);
  const settings = loadEnv(env);
  const config = parseConfig({ vendor_name: env.VENDOR_NAME!.trim(), public_url: env.PUBLIC_URL!.trim().replace(/\/+$/, "") });
  return { config, settings };
}
