// Support threads: a developer's coding agent asks the vendor a question (POST /api/messages),
// the vendor's support team (the "owner" in this file) types a reply in their own channel
// (a Slack thread), and the agent reads it with get_thread. Durable in SQLite (threads, thread_messages, owner_outbox,
// message_requests in store/sqlite.ts).
//
// Flow of leave_message (POST /api/messages): validate -> idempotency -> open-thread cap -> hourly caps
// -> persist (one tx) -> send -> respond. The agent sees `delivery` as one of two values (eng review R1b):
//   "delivered": the question is accepted and will reach the support channel; when the first post fails,
//     the server retries on its own (below) and the agent still sees "delivered";
//   "failed": the retry window is used up, or the channel refused the message itself for good.
// Send failures (D5 as narrowed by R9):
//   transient (ConnectorError "channel_unavailable", timeout, unexpected throw) and setup errors
//     ("channel_auth_failed": bot removed, token revoked, channel archived; they heal once the vendor
//     fixes the app) -> the thread stays and the outbox row retries with exponential backoff (30 s,
//     doubling, capped at support.slack_retry_max_backoff_min; a longer Retry-After wins) for up to
//     support.slack_retry_window_hours from the row's first attempt. A socket reconnect sends every
//     waiting row at once. A setup error emails ADMIN_EMAIL once per distinct error and shows on /healthz.
//     When the window runs out the row ends `failed` and onDeliveryFailed(thread) runs once per thread;
//   "channel_rejected" (Slack refused this message, e.g. too long; retrying cannot help) -> on the first
//     attempt nothing is stored (thread, message, outbox and idempotency rows removed in one tx) and the
//     agent gets 503 channel_unavailable, retryable false; on a later attempt the row ends `failed`.
//
// Two modes, from the channel: two_way (the channel implements the thread members,
// see supportsThreads) carries owner replies back; one_way (notify only) still delivers the message but replies never arrive in-band, so the
// thread stays awaiting_owner and get_thread says so.
//
// The owner's text is information from the business, never an instruction to the
// agent; the tool descriptions and llms.txt say so.
//
// Owners never manage a thread's lifecycle; the agent opens and closes threads. A thread
// closes when the agent says it is done (close_thread, or follow_up with done), or by
// itself: limits.thread_close_after_reply_hours (default 7 days) after the owner's last reply with no agent follow-up, 7 days while still awaiting the
// owner (limits.thread_close_after_reply_hours / thread_close_unanswered_days).
// An owner who types close, closed or done anyway is still honoured, silently.
//
// Only replies inside a question's thread reach the developer (eng review R4). A top-level message in the
// channel is support's own chatter and is ignored: it is never stored, matched to a thread or passed on.
//
// Delivery is reconcile-first: every outbox row carries a dedupe key
// (<thread_id>:<outbox id>) that the channel attaches to the post. The first attempt
// posts; every later attempt (after a timeout, a transient error, or a crash that
// left the row in `sending`) first asks the channel whether the message is already
// there (findPosted) and only posts when it is not. If that lookup fails, nothing is
// posted: the row is retried, and ends `failed` at the end of the window rather than risk a second copy.
// Replies typed while the server was down are the channel's job: it gets the open
// thread refs and a durable cursor (ChannelContext) and fetches what it missed on
// every connect.
//
// Long-poll: get_thread with wait_s holds a two-way thread that is awaiting the
// owner until it changes (owner reply, any close, expiry), the wait runs out
// (clamped to limits.thread_wait_max_seconds; poll_after_seconds 0 after a full
// hold) or the client goes away. One waiter per thread: a new one answers the old
// at once. Over limits.max_waiting_requests a request answers at once, so agents
// fall back to plain polling. Disconnects never close threads.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config, RuntimeSettings } from "./config.js";
import { normalizeCustomer, validateCustomer, type Customer } from "./customer.js";
import { ConnectorError, supportsThreads, type CommunicationConnector, type OwnerInboundMessage, type OwnerMessageHandler, type RequesterNotifier } from "./connectors/types.js";
import { err, ok, type GatewayError, type Result } from "./errors.js";
import { contactKeys, messageRateLimit } from "./middleware/ratelimit.js";
import { matchesResumeToken } from "./resume.js";
import type { OutboxKind, OutboxRow, Store, ThreadMode, ThreadRow, ThreadState } from "./store/sqlite.js";

export type { ThreadMode, ThreadState } from "./store/sqlite.js";

// T4b / T5b / T5c (lane D)
import { checkFieldCaps, maskSecrets, type SupportRequest } from "./support.js";
import type { SupportEmails } from "./emails.js";
import type { ThreadContext } from "./store/sqlite.js";

/**
 * What the agent sees (eng review R1b): "delivered" = accepted and on its way to the support channel (the server
 * retries a failed post by itself); "failed" = the retry window is used up or the channel refused the message for good.
 */
export type Delivery = "delivered" | "failed";

export interface ThreadMessage {
  from: "agent" | "owner";
  text: string;
  at: string;
}

export interface ThreadView {
  thread_id: string;
  status: ThreadState;
  /** Seconds to wait before calling get_thread again: 60 while awaiting the owner, 0 once answered or closed (or when replies cannot arrive in-band). */
  poll_after_seconds: number;
  delivery: Delivery;
  /** False when the owner channel is one-way: the owner will contact the customer directly, not through this thread. */
  owner_replies_in_band: boolean;
  /** Who asked: {name, email}. */
  requester: Customer;
  messages: ThreadMessage[];
}

export interface LeaveMessageResult extends ThreadView {
  /** Private token for get_thread and follow_up; returned only here (and to a retry with the same idempotency_key). */
  read_token: string;
}

/** POST /api/messages body (design section 2): requester {name, email}, message, optional context; idempotency_key to retry safely. */
export interface LeaveMessageRequest extends SupportRequest {
  /** T5c: the caller's rate-limit bucket (ip:<bucket> or k:<key id>), set by the HTTP adapter; caps unconfirmed questions per caller. */
  caller?: string;
}

export interface GetThreadRequest {
  thread_id?: string;
  read_token?: string;
  /** T6: a token from an emailed resume link (x-resume-token), accepted in place of read_token. */
  resume_token?: string;
  /** Long-poll: hold up to this many seconds (an integer, clamped to limits.thread_wait_max_seconds) while the owner has not answered. */
  wait_s?: number;
  /** Aborted when the client goes away; ends the hold. */
  signal?: AbortSignal;
}

export interface FollowUpRequest extends GetThreadRequest {
  message?: string;
  idempotency_key?: string;
  /** Post the message and close the thread in one step. */
  done?: boolean;
}

export type OwnerOutcome = Awaited<ReturnType<OwnerMessageHandler>>;

export interface MessageHealth {
  mode: ThreadMode;
  enabled: boolean;
  /** null when the channel has no live connection to report (notify-only providers). */
  connected: boolean | null;
  last_error?: string;
  /** A setup error from the channel (bot removed, token revoked, channel archived) that only the vendor can fix; cleared by the next successful post. */
  permanent_error?: string;
  outbox: { queued: number; failed: number };
}

export interface MessageOps {
  readonly enabled: boolean;
  readonly mode: ThreadMode;
  leaveMessage(req: LeaveMessageRequest): Promise<Result<LeaveMessageResult>>;
  getThread(req: GetThreadRequest): Promise<Result<ThreadView>>;
  agentFollowUp(req: FollowUpRequest): Promise<Result<ThreadView>>;
  /** The agent is done with the thread. Idempotent: an already closed thread answers ok with status closed. */
  closeThread(req: GetThreadRequest): Promise<Result<ThreadView>>;
  /** Owner typed a reply in the thread. */
  ownerReply(m: OwnerInboundMessage): Promise<OwnerOutcome>;
  /** Owner typed close, closed or done. Not asked of owners; accepted for those who do it anyway. */
  ownerClose(m: OwnerInboundMessage): Promise<OwnerOutcome>;
  /** The handler registered with the channel: close, closed or done alone (any case) closes, anything else is a reply. */
  onOwnerMessage: OwnerMessageHandler;
  /** One outbox pass: retry due sends, close idle threads (see limits.thread_close_*), purge old closed ones. start() runs it every 30 s. */
  sweep(): Promise<void>;
  /** Make every waiting outbox row due and sweep now; runs when the channel reconnects. */
  flush(): Promise<void>;
  /** Register the owner handler, start the sweep timer and the channel's inbound connection. */
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): MessageHealth;
  /**
   * T5b read signal (R2, R7): the agent received these owner messages. Called only by GET /api/threads/:id once a 200
   * response finished sending (either token); never by the /t resume page.
   */
  markDelivered(threadId: string, messageIds: number[]): void;
}

/** Ids of the owner messages a view carries, for markDelivered; kept off the JSON. */
const viewOwnerIds = new WeakMap<object, { thread_id: string; ids: number[] }>();
export function ownerMessageIds(view: unknown): { thread_id: string; ids: number[] } | undefined {
  return view && typeof view === "object" ? viewOwnerIds.get(view) : undefined;
}

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** How a held get_thread ended; logged as telemetry. */
type WaitOutcome = "replied" | "closed" | "timeout" | "client_closed" | "replaced" | "shutdown";

export interface MessageDeps {
  config: Config;
  store: Store;
  channel: CommunicationConnector | undefined;
  settings: Pick<RuntimeSettings, "messages_enabled"> & Partial<Pick<RuntimeSettings, "admin_email">>;
  /** Emails ADMIN_EMAIL once per distinct channel setup error (R9). Optional: without it (or without admin_email) the alert is only logged. */
  notifier?: RequesterNotifier;
  /**
   * Called once per thread when its delivery becomes "failed" (retry window used up, or the channel refused a queued
   * message for good). Phase 2 sends the developer the "didn't reach <vendor>" email from here. Default: a log line.
   */
  onDeliveryFailed?: (thread: ThreadRow) => void | Promise<void>;
  /** T5b: requester emails (confirm per question, coalesced reply emails). Optional: without it replies reach only open sessions. */
  emails?: Pick<SupportEmails, "requestConfirm" | "onOwnerReply" | "sweep">;
  now?: () => Date;
  timers?: Timers;
  log?: (line: string) => void;
}

export const POLL_SECONDS = 60;
/** Default cap on a question or follow-up; the live value is support.field_caps.message. */
export const MAX_MESSAGE_CHARS = 2000;
/** Agent-authored messages per thread, opener included. */
export const MAX_AGENT_MESSAGES = 20;
export const RETRY_BASE_MS = 30_000;
export const SWEEP_EVERY_MS = 30_000;
const SWEEP_BATCH = 20;
const HOUR_MS = 3_600_000;
const PURGE_CLOSED_MS = 30 * 86_400_000;
const NOT_FOUND = "No such thread, or the read_token does not match";
/** Posted in the owner's thread when the agent closes it. */
export const CLOSE_NOTICE = "Thanks, the assistant has what it needs.";
/** Whole-message words an owner might type to end a thread; accepted silently, never asked for. */
const OWNER_CLOSE_WORDS = /^(close|closed|done)[.!]?$/i;
/** channel_state key of the channel's catch-up cursor. */
const CURSOR_KEY = "owner_channel_cursor";
/** channel_state keys: the current channel setup error ("" when none), and the last one the admin was emailed about. */
const PERMANENT_ERROR_KEY = "owner_channel_permanent_error";
const ALERTED_KEY = "owner_channel_alerted_error";

/**
 * A channel that can say when its inbound connection (re)connects (Slack: every Socket Mode hello). The core then sends
 * every waiting outbox row at once instead of at its backoff time (R9).
 */
export interface ReconnectAware {
  onConnected(fn: () => void): void;
}
const reconnectAware = (c: unknown): c is ReconnectAware => typeof (c as Partial<ReconnectAware> | undefined)?.onConnected === "function";

// ---- Thread state machine ----

export type ThreadEvent = "agent_message" | "agent_close" | "owner_reply" | "owner_close" | "expire";
export type Transition = { ok: true; state: ThreadState; changed: boolean } | { ok: false; reason: "thread_closed" };

const NOOP = "noop" as const;
const CLOSED = "thread_closed" as const;

/** Every (state, event) cell. A closed thread never reopens: the agent starts a new one. */
export const TRANSITIONS: Record<ThreadState, Record<ThreadEvent, ThreadState | typeof NOOP | typeof CLOSED>> = {
  awaiting_owner: { agent_message: "awaiting_owner", agent_close: "closed", owner_reply: "answered", owner_close: "closed", expire: "closed" },
  answered: { agent_message: "awaiting_owner", agent_close: "closed", owner_reply: "answered", owner_close: "closed", expire: "closed" },
  closed: { agent_message: CLOSED, agent_close: NOOP, owner_reply: CLOSED, owner_close: NOOP, expire: NOOP },
};

export function transition(state: ThreadState, event: ThreadEvent): Transition {
  const next = TRANSITIONS[state][event];
  if (next === CLOSED) return { ok: false, reason: "thread_closed" };
  if (next === NOOP) return { ok: true, state, changed: false };
  return { ok: true, state: next, changed: next !== state };
}

// ---- helpers ----

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** NFC, trimmed, 1..cap code points (over it: invalid_request naming the cap), no control characters except newline and tab. */
export function cleanMessage(v: unknown, cap = MAX_MESSAGE_CHARS): string | GatewayError {
  if (typeof v !== "string") return err("invalid_message", "message is required").error;
  const text = v.normalize("NFC").trim();
  if (!text) return err("invalid_message", "message is required").error;
  const over = checkFieldCaps({ message: text }, { message: cap, error: Infinity, tried: Infinity, environment: Infinity });
  if (over) return over;
  if (CONTROL.test(text)) return err("invalid_message", "message must not contain control characters").error;
  return text;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();
const requestHash = (parts: unknown[]) => sha256(JSON.stringify(parts)).toString("hex");
const isErr = (v: unknown): v is GatewayError => typeof v === "object" && v !== null && "code" in v && "retryable" in v;
const fail = <T>(e: GatewayError): Result<T> => ({ ok: false, error: e });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * transient: retry. setup: retry too (it heals when the vendor fixes the app) and alert the admin. rejected: the channel
 * refused this message itself, so retrying cannot help. An unexpected throw is transient: the window ends it if it persists.
 */
function classify(e: unknown): "transient" | "setup" | "rejected" {
  if (!(e instanceof ConnectorError)) return "transient";
  if (e.code === "channel_unavailable") return "transient";
  return e.code === "channel_auth_failed" ? "setup" : "rejected";
}

/** 30 s after attempt 1, doubling, never more than maxBackoffMs; a provider's Retry-After wins when longer. */
export function retryDelayMs(attempts: number, e?: unknown, maxBackoffMs = 30 * 60_000): number {
  const backoff = Math.min(maxBackoffMs, RETRY_BASE_MS * 2 ** Math.max(0, Math.min(attempts - 1, 30)));
  const hinted = e instanceof ConnectorError && e.retry_after_s ? e.retry_after_s * 1000 : 0;
  return Math.max(backoff, hinted);
}

const contactLine = (c: Customer) => [c.phone, c.email].filter(Boolean).join(", ");

/** Control characters other than newline and tab (ANSI escapes in pasted output, etc.). */
const CONTROL_ALL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** context {error, tried, environment}: each optional string, NFC, trimmed, control characters dropped; empty fields left out. */
function parseContext(v: unknown): ThreadContext | GatewayError {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) return err("invalid_request", "context must be an object with optional error, tried and environment strings").error;
  const o = v as Record<string, unknown>;
  const out: ThreadContext = {};
  for (const f of ["error", "tried", "environment"] as const) {
    const x = o[f];
    if (x === undefined || x === null) continue;
    if (typeof x !== "string") return err("invalid_request", `context.${f} must be a string`).error;
    const t = x.normalize("NFC").replace(CONTROL_ALL, "").trim();
    if (t) out[f] = t;
  }
  return out;
}

/** The requester as stored: name and email only (no phone on this door). */
function requesterOf(v: unknown): Customer {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return normalizeCustomer({ name: o.name, email: o.email });
}

/** Line breaks, control characters and text-direction overrides: in a name they could fake extra lines or text in the Slack opener. */
const NAME_UNSAFE = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

function requesterProblem(c: Customer): string | null {
  if (!c.name) return "requester.name is required";
  if (NAME_UNSAFE.test(c.name)) return "requester.name must be one line with no control or text-direction characters";
  if (!c.email) return "requester.email is required";
  return validateCustomer(c)?.replace(/^customer\./, "requester.") ?? null;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new ConnectorError("channel_unavailable", `owner channel did not answer within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

class KeyTaken extends Error {}

// ---- ops ----

/** Thread timestamps: UTC RFC 3339 without milliseconds. */
const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Message ops for the configured support channel, or undefined when there is none
 * (the routes are then not registered: a message nobody reads must not be reported as delivered).
 */
export function createMessageOps(deps: MessageDeps): MessageOps | undefined {
  const { config, store, channel } = deps;
  if (!channel) return undefined;
  const vendor = config.vendor_id;
  const enabled = deps.settings.messages_enabled;
  const mode: ThreadMode = supportsThreads(channel) ? "two_way" : "one_way";
  const clock = deps.now ?? (() => new Date());
  const timers: Timers = deps.timers ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const log = deps.log ?? ((line: string) => console.error(line));
  const rateLimit = messageRateLimit(config.limits, { confirmedSince: (keys, sinceMs) => store.confirmedThreadTimesSince(vendor, keys, sinceMs) });
  // The channel should time out on its own (connector_timeout_ms); this only bounds a hung provider.
  const sendTimeoutMs = config.limits.connector_timeout_ms + 2000;
  let timer: unknown;
  let sweeping: Promise<void> | null = null;
  /** A flush asked for while a sweep was running: run one more pass after it. */
  let sweepAgain = false;
  const retryWindowMs = config.support.slack_retry_window_hours * HOUR_MS;
  const maxBackoffMs = config.support.slack_retry_max_backoff_min * 60_000;
  const onDeliveryFailed = deps.onDeliveryFailed ?? ((t: ThreadRow) => log(`[support] delivery failed thread=${t.thread_id}; no email notifier, the developer is not told`));
  const msgCap = config.support.field_caps.message;
  /** Set by stop(): requests that arrive during shutdown answer at once instead of holding. */
  let stopping = false;
  /** Held get_thread requests, at most one per thread; size is the global count (limits.max_waiting_requests). */
  const waiters = new Map<string, (outcome: WaitOutcome) => void>();

  const local = stamp;
  const disabled = <T>(): Result<T> => err("messages_disabled", "Support has paused messages", { retryable: false });

  const eventLog = (outcome: string, contact: string | null, idemKey: string | null, detail: Record<string, unknown>) => {
    try {
      store.log({ vendor_id: vendor, idem_key: idemKey, contact, outcome, detail }, clock().toISOString());
    } catch {
      // The log must never change the outcome.
    }
  };

  function view(t: ThreadRow): ThreadView {
    const out = store.listOutbox(t.thread_id);
    const delivery: Delivery = out.some((o) => o.state === "failed") ? "failed" : "delivered";
    const rows = store.listThreadMessages(t.thread_id);
    // Key order is part of the contract: thread_id first, status second (the published loop's sed fallback reads them).
    const v: ThreadView = {
      thread_id: t.thread_id,
      status: t.state,
      poll_after_seconds: t.mode === "two_way" && t.state === "awaiting_owner" ? POLL_SECONDS : 0,
      delivery,
      owner_replies_in_band: t.mode === "two_way",
      requester: t.customer,
      messages: rows.map((m) => ({ from: m.author, text: m.text, at: m.at })),
    };
    viewOwnerIds.set(v, { thread_id: t.thread_id, ids: rows.filter((m) => m.author === "owner").map((m) => m.id) });
    return v;
  }

  /** The thread, if id and token match. Missing id, unknown id and wrong token all look the same to the caller. */
  function authorize(req: GetThreadRequest | undefined): ThreadRow | null {
    const id = typeof req?.thread_id === "string" ? req.thread_id : "";
    const token = typeof req?.read_token === "string" ? req.read_token : "";
    const resume = typeof req?.resume_token === "string" ? req.resume_token : "";
    if (!id || (!token && !resume)) return null;
    const t = store.getThread(id);
    if (!t || t.vendor_id !== vendor) return null;
    if (token) {
      const want = Buffer.from(t.token_hash, "hex");
      const got = sha256(token);
      if (want.length === got.length && timingSafeEqual(want, got)) return t;
    }
    return resume && matchesResumeToken(store, id, resume) ? t : null;
  }

  function replay<T>(key: string, hash: string): Result<T> | null {
    const prior = store.getMessageRequest(vendor, key);
    if (!prior) return null;
    if (prior.request_hash !== hash) return err("idempotency_conflict", "This idempotency_key was used with a different message");
    if (prior.response === null) {
      return err("message_in_progress", "The first request with this idempotency_key is still being delivered; retry with the same key", {
        retry_after_s: 2,
      });
    }
    return ok(prior.response as T);
  }

  function badKey(key: unknown): GatewayError | null {
    if (key === undefined) return null;
    if (typeof key !== "string" || key.length < 1 || key.length > 255) {
      return err("invalid_request", "idempotency_key must be 1-255 characters; reuse it when retrying").error;
    }
    return null;
  }

  /** What happens to a reply the agent never picks up. It depends on whether email is on and whether a confirm is required. */
  function missedReplyNote(): string {
    if (!deps.emails) return "If the agent does not come back, it will not see the reply.";
    return config.support.require_confirm
      ? "If the agent does not come back, the reply is emailed to the requester once they confirm."
      : "If the agent does not come back, the reply is emailed to the requester.";
  }

  /** The Slack ticket (design section 2). A new question is never confirmed yet; the confirm adds a line in the thread. */
  function openerText(t: ThreadRow, text: string): string {
    const lines = [`Question from ${t.customer.name} (${contactLine(t.customer)}${config.support.require_confirm ? ", not confirmed" : ", email not verified"}) via a coding agent (thread ${t.thread_id})`, "", text];
    const ctx = t.context ?? {};
    for (const [label, v] of [["Error", ctx.error], ["Tried", ctx.tried], ["Environment", ctx.environment]] as const) {
      if (v) lines.push("", `${label}:`, v);
    }
    lines.push(
      "",
      t.mode !== "two_way"
        ? "Replies cannot be passed back from here: contact the requester directly."
        : `Reply in this thread and the agent will pass it on. ${missedReplyNote()}`,
    );
    return lines.join("\n");
  }

  function followUpText(t: ThreadRow, text: string, done: boolean): string {
    // With done the closing line rides in the same post, so it can never arrive before the message.
    return t.mode === "two_way"
      ? `Follow-up from the assistant:\n\n${text}${done ? `\n\n${CLOSE_NOTICE}` : ""}`
      : `Follow-up on thread ${t.thread_id} from ${t.customer.name} (${contactLine(t.customer)}):\n\n${text}\n\nContact the customer directly to reply.`;
  }

  /** Best effort, not awaited: a slow channel must not hold up the agent. */
  function postNotice(t: ThreadRow, text: string): void {
    if (t.mode !== "two_way" || !t.provider_ref || !supportsThreads(channel)) return;
    const ref = t.provider_ref;
    try {
      withTimeout(channel.postToThread(ref, text), sendTimeoutMs).catch((e) => log(`[support] close notice failed thread=${t.thread_id}: ${errMsg(e)}`));
    } catch (e) {
      log(`[support] close notice failed thread=${t.thread_id}: ${errMsg(e)}`);
    }
  }

  function closeRow(t: ThreadRow, by: string, detail: Record<string, unknown> = {}): void {
    store.updateThread(t.thread_id, { state: "closed", updated_at_ms: clock().getTime() });
    log(`[support] thread closed thread=${t.thread_id} by=${by}`);
    eventLog("thread_closed", null, null, { thread_id: t.thread_id, by, ...detail });
    wake(t.thread_id, "closed");
  }

  /** Answer the thread's held get_thread, if any, with the current view. */
  function wake(threadId: string, outcome: WaitOutcome): void {
    waiters.get(threadId)?.(outcome);
  }

  const dedupeKey = (threadId: string, outboxId: number) => `${threadId}:${outboxId}`;

  /** Hand one message to the channel. Returns the provider's thread handle for an opener. */
  async function deliver(outboxId: number, kind: OutboxKind, text: string, t: ThreadRow): Promise<string | undefined> {
    if (kind === "notify") {
      await channel!.notify(text);
      return undefined;
    }
    if (!supportsThreads(channel)) throw new ConnectorError("channel_rejected", "owner channel cannot carry threads");
    const dedupe_key = dedupeKey(t.thread_id, outboxId);
    if (kind === "open") return (await channel.openThread({ thread_id: t.thread_id, text, dedupe_key })).provider_ref;
    await channel.postToThread(t.provider_ref!, text, { dedupe_key });
    return undefined;
  }

  /** Before a re-send: the provider's id of the message if an earlier attempt already posted it. */
  async function alreadyPosted(row: OutboxRow, t: ThreadRow): Promise<string | null> {
    if (row.kind === "notify" || !channel!.findPosted) return null;
    return channel!.findPosted({
      dedupe_key: dedupeKey(t.thread_id, row.id),
      provider_ref: row.kind === "post" ? t.provider_ref! : undefined,
      since_ms: row.created_at_ms ?? Date.parse(t.created_at),
    });
  }

  function markPosted(row: Pick<OutboxRow, "id" | "thread_id">, ref: string | undefined): void {
    const now = clock();
    const iso = now.toISOString();
    store.tx(() => {
      if (ref) store.setProviderRef(row.thread_id, ref, now.getTime());
      store.updateOutbox(row.id, { state: "delivered" }, iso);
    });
    clearSetupError();
  }

  const setupErrorKey = (e: unknown) => (e instanceof ConnectorError ? `${e.code}: ${e.message}` : errMsg(e));

  function clearSetupError(): void {
    if (!store.getChannelState(PERMANENT_ERROR_KEY)) return;
    store.setChannelState(PERMANENT_ERROR_KEY, "");
    store.setChannelState(ALERTED_KEY, "");
    log(`[support] owner channel works again; setup error cleared`);
  }

  /** A setup error: remember it for /healthz, and email the admin once per distinct error (not per thread). */
  function noteSetupError(e: unknown): void {
    const key = setupErrorKey(e);
    store.setChannelState(PERMANENT_ERROR_KEY, key);
    const before = store.getChannelState(ALERTED_KEY) ?? "";
    if (before === key) return;
    store.setChannelState(ALERTED_KEY, key);
    const to = deps.settings.admin_email;
    if (!deps.notifier || !to) {
      log(`[support] owner channel setup error, admin not emailed (${!deps.notifier ? "no email notifier" : "ADMIN_EMAIL unset"}): ${key}`);
      return;
    }
    const hours = config.support.slack_retry_window_hours;
    const text = [
      `${config.vendor_name}'s support door cannot post developers' questions to your support channel:`,
      "",
      errMsg(e),
      "",
      `Questions are kept and retried for up to ${hours} hours; once this is fixed they go out on their own.`,
      `After ${hours} hours a question that never reached the channel is marked failed.`,
    ].join("\n");
    const idempotency_key = `admin-alert:${sha256(key).toString("hex").slice(0, 32)}:${clock().getTime()}`;
    let sending: Promise<unknown>;
    try {
      sending = deps.notifier.sendEmail({ to, subject: `${config.vendor_name} support door: questions cannot reach your support channel`, text, idempotency_key });
    } catch (err) {
      sending = Promise.reject(err);
    }
    sending.then(
      () => log(`[support] admin alerted about owner channel setup error: ${key}`),
      (err) => {
        // Not lost: the next failed send with the same error tries the alert again.
        if (store.getChannelState(ALERTED_KEY) === key) store.setChannelState(ALERTED_KEY, before);
        log(`[support] admin alert failed: ${errMsg(err)}`);
      },
    );
  }

  /** A row ended `failed`. The thread's delivery flips to "failed" with its first failed row, so the hook runs once per thread. */
  function markFailed(row: Pick<OutboxRow, "id" | "attempts">, t: ThreadRow, reason: string): void {
    const firstFailure = !store.listOutbox(t.thread_id).some((o) => o.state === "failed");
    store.updateOutbox(row.id, { state: "failed", last_error: reason }, clock().toISOString());
    log(`[support] owner channel gave up thread=${t.thread_id} attempts=${row.attempts}: ${reason}`);
    eventLog("message_failed", null, null, { thread_id: t.thread_id, attempts: row.attempts });
    if (!firstFailure) return;
    try {
      Promise.resolve(onDeliveryFailed(t)).catch((e) => log(`[support] onDeliveryFailed failed thread=${t.thread_id}: ${errMsg(e)}`));
    } catch (e) {
      log(`[support] onDeliveryFailed failed thread=${t.thread_id}: ${errMsg(e)}`);
    }
  }

  /** Queue a row for its next attempt after a failed one, capped at the end of its retry window. */
  function scheduleRetry(row: Pick<OutboxRow, "id" | "attempts" | "kind">, firstAttemptMs: number, t: ThreadRow, e: unknown): void {
    const now = clock();
    const delay = retryDelayMs(row.attempts, e, maxBackoffMs);
    const next = Math.min(now.getTime() + delay, firstAttemptMs + retryWindowMs);
    store.updateOutbox(row.id, { state: "queued", next_at_ms: next, last_error: errMsg(e) }, now.toISOString());
    log(`[support] owner channel send failed thread=${t.thread_id} kind=${row.kind} attempt=${row.attempts} retry_in=${Math.round((next - now.getTime()) / 1000)}s: ${errMsg(e)}`);
  }

  /** First attempt, in the request. "rejected" means the caller must undo what it stored. */
  async function sendNow(outboxId: number, kind: OutboxKind, text: string, t: ThreadRow, firstAttemptMs: number): Promise<{ result: "delivered" | "retrying" } | { result: "rejected"; error: unknown }> {
    try {
      const ref = await withTimeout(deliver(outboxId, kind, text, t), sendTimeoutMs);
      markPosted({ id: outboxId, thread_id: t.thread_id }, ref);
      return { result: "delivered" };
    } catch (e) {
      const c = classify(e);
      if (c === "rejected") return { result: "rejected", error: e };
      if (c === "setup") noteSetupError(e);
      scheduleRetry({ id: outboxId, attempts: 1, kind }, firstAttemptMs, t, e);
      return { result: "retrying" };
    }
  }

  const permanentError = <T>(): Result<T> =>
    err("channel_unavailable", "The business's message channel refused the message; tell the user to contact the business another way", {
      retryable: false,
    });

  async function leaveMessageInner(req: LeaveMessageRequest | undefined, key: string | undefined, customer: Customer): Promise<Result<LeaveMessageResult>> {
    if (!enabled) return disabled();
    const kerr = badKey(req?.idempotency_key);
    if (kerr) return fail(kerr);
    const bad = requesterProblem(customer);
    if (bad) return err("invalid_customer", `${bad}, so support can reach them`);
    const raw = cleanMessage(req?.message, msgCap);
    if (isErr(raw)) return fail(raw);
    const rawCtx = parseContext(req?.context);
    if (isErr(rawCtx)) return fail(rawCtx);
    const over = checkFieldCaps({ message: raw, ...rawCtx }, config.support.field_caps);
    if (over) return fail(over);
    // Masked before anything is stored or sent (design section 2): DB, logs, Slack, email and pages see only this.
    const text = maskSecrets(raw);
    const context: ThreadContext = {};
    for (const [k, v] of Object.entries(rawCtx) as [keyof ThreadContext, string][]) context[k] = maskSecrets(v);

    // No await from here to the claim: two requests with one key cannot both pass the lookup.
    const now = clock();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const hash = requestHash(["leave", customer.name, customer.email ?? "", text, context]);
    if (key) {
      const prior = replay<LeaveMessageResult>(key, hash);
      if (prior) return prior;
    }
    const keys = contactKeys(customer);
    // T5c: only questions the requester confirmed by email count against their address, so naming someone else's
    // address cannot lock them out; unconfirmed questions are capped per caller instead.
    const open = store.countOpenThreads(vendor, keys);
    if (open >= config.limits.max_open_threads_per_contact) {
      return err(
        "thread_limit_reached",
        `This requester already has ${open} open question(s); the limit is ${config.limits.max_open_threads_per_contact}. Follow up on an existing thread, or close one.`,
      );
    }
    const caller = typeof req?.caller === "string" && req.caller ? req.caller : null;
    if (caller) {
      const unconfirmed = store.countUnconfirmedOpenThreadsByCaller(vendor, caller);
      if (unconfirmed >= config.limits.max_unconfirmed_threads_per_caller) {
        return err(
          "thread_limit_reached",
          `You have ${unconfirmed} unanswered question(s) whose requester has not confirmed them by email; the limit is ${config.limits.max_unconfirmed_threads_per_caller}. Wait for support to answer one, or close one.`,
        );
      }
    }
    const limited = rateLimit(keys, nowMs);
    if (limited) return fail(limited);

    const token = randomBytes(24).toString("base64url");
    const t: ThreadRow = {
      thread_id: `t_${randomBytes(8).toString("hex")}`,
      vendor_id: vendor,
      token_hash: sha256(token).toString("hex"),
      state: "awaiting_owner",
      mode,
      customer,
      contact_keys: keys,
      provider_ref: null,
      agent_count: 1,
      created_at: nowIso,
      updated_at_ms: nowMs,
      closed_at_ms: null,
      context: Object.keys(context).length ? context : null,
      caller_key: caller,
    };
    const kind: OutboxKind = mode === "two_way" ? "open" : "notify";
    const outText = openerText(t, text);
    let outboxId = 0;
    try {
      store.tx(() => {
        store.insertThread(t);
        store.touchAgentSeen(t.thread_id, nowMs);
        store.insertThreadMessage({ thread_id: t.thread_id, author: "agent", text, provider_msg_id: null, at: local(nowMs) });
        outboxId = store.insertOutbox({ thread_id: t.thread_id, kind, text: outText, state: "sending", attempts: 1, next_at_ms: null }, nowIso);
        if (key && !store.claimMessageRequest({ vendor_id: vendor, idem_key: key, request_hash: hash, thread_id: t.thread_id }, nowIso)) {
          throw new KeyTaken();
        }
      });
    } catch (e) {
      if (e instanceof KeyTaken && key) return replay<LeaveMessageResult>(key, hash) ?? err("message_in_progress", "Retry with the same idempotency_key");
      throw e;
    }

    const sent = await sendNow(outboxId, kind, outText, t, nowMs);
    if (sent.result === "rejected") {
      store.deleteThread(t.thread_id); // cascades the message, outbox and idempotency rows
      log(`[support] owner channel refused a message (nothing stored): ${errMsg(sent.error)}`);
      return permanentError();
    }
    const result: LeaveMessageResult = { ...view(store.getThread(t.thread_id)!), read_token: token };
    if (key) store.setMessageResponse(vendor, key, result);
    log(`[support] message left thread=${t.thread_id} mode=${mode} delivery=${result.delivery}`);
    // No confirm email here: it goes out only if the agent stops listening before support answers (sweepInner).
    return ok(result);
  }

  async function leaveMessage(req: LeaveMessageRequest): Promise<Result<LeaveMessageResult>> {
    const key = typeof req?.idempotency_key === "string" ? req.idempotency_key : undefined;
    const customer = requesterOf(req?.requester);
    const r = await leaveMessageInner(req, key, customer);
    const contact = customer.email ?? customer.phone ?? null;
    if (r.ok) eventLog("message_left", contact, key ?? null, { thread_id: r.data.thread_id });
    else eventLog(`message_rejected:${r.error.code}`, contact, key ?? null, { message: r.error.message });
    return r;
  }

  async function getThread(req: GetThreadRequest): Promise<Result<ThreadView>> {
    if (!enabled) return disabled();
    const t = authorize(req);
    if (!t) return err("unknown_thread", NOT_FOUND);
    store.touchAgentSeen(t.thread_id, clock().getTime());
    const max = config.limits.thread_wait_max_seconds;
    const asked = typeof req.wait_s === "number" && req.wait_s > 0 ? Math.min(req.wait_s, max) : 0;
    // Nothing to wait for, or shutting down: answer now (also the plain-polling fallback).
    if (asked <= 0 || t.mode !== "two_way" || t.state !== "awaiting_owner" || req.signal?.aborted || stopping) return ok(view(t));

    // No await from here to the registration: no reply can land between the check and the hold (S1).
    const id = t.thread_id;
    wake(id, "replaced"); // before the cap, so a same-thread retry never counts against it (O4)
    if (waiters.size >= config.limits.max_waiting_requests) return ok(view(t));
    const startMs = clock().getTime();
    return new Promise((resolve) => {
      const end = (outcome: WaitOutcome) => {
        if (waiters.get(id) !== end) return; // already answered or displaced
        waiters.delete(id);
        store.touchAgentSeen(id, clock().getTime());
        timers.clearTimeout(handle);
        req.signal?.removeEventListener("abort", onAbort);
        log(`[support] wait thread=${id} asked=${asked}s held=${clock().getTime() - startMs}ms outcome=${outcome}`);
        const v = view(store.getThread(id) ?? t);
        // A full hold with no change: call again right away (D3).
        if (outcome === "timeout" && v.status === "awaiting_owner") v.poll_after_seconds = 0;
        resolve(ok(v));
      };
      const onAbort = () => end("client_closed");
      waiters.set(id, end);
      const handle = timers.setTimeout(() => end("timeout"), asked * 1000);
      req.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function agentFollowUp(req: FollowUpRequest): Promise<Result<ThreadView>> {
    if (!enabled) return disabled();
    const t = authorize(req);
    if (!t) return err("unknown_thread", NOT_FOUND);
    const kerr = badKey(req?.idempotency_key);
    if (kerr) return fail(kerr);
    const key = req.idempotency_key;
    const raw = cleanMessage(req?.message, msgCap);
    if (isErr(raw)) return fail(raw);
    const text = maskSecrets(raw);
    if (req.done !== undefined && req.done !== null && typeof req.done !== "boolean") return err("invalid_request", "done must be true or false");
    const done = req.done === true;

    const now = clock();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const hash = requestHash(done ? ["follow_up", t.thread_id, text, "done"] : ["follow_up", t.thread_id, text]);
    if (key) {
      const prior = replay<ThreadView>(key, hash);
      if (prior) return prior;
    }
    const tr = transition(t.state, "agent_message");
    if (!tr.ok) return err("thread_closed", "This thread is closed; call leave_message to start a new one");
    if (t.agent_count >= MAX_AGENT_MESSAGES) {
      return err("thread_closed", `This thread reached ${MAX_AGENT_MESSAGES} messages; call leave_message to start a new one`);
    }
    const limited = rateLimit([], nowMs);
    if (limited) return fail(limited);

    const kind: OutboxKind = mode === "two_way" ? "post" : "notify";
    // Keep the owner's view in order: while anything earlier is still undelivered, this one waits behind it.
    const behind = kind === "post" && (!t.provider_ref || store.listOutbox(t.thread_id).some((o) => o.state !== "delivered"));
    const outText = followUpText(t, text, done);
    const nextState: ThreadState = done ? "closed" : tr.state;
    let outboxId = 0;
    let messageId = 0;
    try {
      store.tx(() => {
        messageId = store.insertThreadMessage({ thread_id: t.thread_id, author: "agent", text, provider_msg_id: null, at: local(nowMs) })!;
        store.updateThread(t.thread_id, { state: nextState, agent_count: t.agent_count + 1, updated_at_ms: nowMs });
        outboxId = store.insertOutbox(
          { thread_id: t.thread_id, kind, text: outText, state: behind ? "queued" : "sending", attempts: behind ? 0 : 1, next_at_ms: behind ? nowMs : null },
          nowIso,
        );
        if (key && !store.claimMessageRequest({ vendor_id: vendor, idem_key: key, request_hash: hash, thread_id: t.thread_id }, nowIso)) {
          throw new KeyTaken();
        }
      });
    } catch (e) {
      if (e instanceof KeyTaken && key) return replay<ThreadView>(key, hash) ?? err("message_in_progress", "Retry with the same idempotency_key");
      throw e;
    }

    if (!behind) {
      const sent = await sendNow(outboxId, kind, outText, t, nowMs);
      if (sent.result === "rejected") {
        store.tx(() => {
          store.deleteOutbox(outboxId);
          store.deleteThreadMessage(messageId);
          if (key) store.deleteMessageRequest(vendor, key);
          // Undo against the current row, not the snapshot: an owner reply, a close or another follow-up may have landed during the send.
          const cur = store.getThread(t.thread_id);
          if (cur) {
            store.updateThread(t.thread_id, {
              state: cur.state === nextState ? t.state : cur.state,
              agent_count: Math.max(1, cur.agent_count - 1),
              updated_at_ms: t.updated_at_ms,
            });
          }
        });
        log(`[support] owner channel refused a follow-up thread=${t.thread_id} (not stored): ${errMsg(sent.error)}`);
        return permanentError();
      }
    }
    const result = view(store.getThread(t.thread_id)!);
    if (key) store.setMessageResponse(vendor, key, result);
    log(`[support] follow-up thread=${t.thread_id} delivery=${result.delivery}${done ? " done" : ""}`);
    eventLog("message_left", null, key ?? null, { thread_id: t.thread_id, follow_up: true });
    if (done) {
      log(`[support] thread closed thread=${t.thread_id} by=agent`);
      eventLog("thread_closed", null, null, { thread_id: t.thread_id, by: "agent" });
      wake(t.thread_id, "closed"); // after the send, so the close is final (O3)
    }
    return ok(result);
  }

  async function closeThread(req: GetThreadRequest): Promise<Result<ThreadView>> {
    if (!enabled) return disabled();
    const t = authorize(req);
    if (!t) return err("unknown_thread", NOT_FOUND);
    const tr = transition(t.state, "agent_close");
    if (tr.ok && tr.changed) {
      closeRow(t, "agent");
      postNotice(t, CLOSE_NOTICE);
    }
    return ok(view(store.getThread(t.thread_id)!));
  }

  function acknowledge(t: ThreadRow, m: OwnerInboundMessage): void {
    try {
      // Best effort: the ✅ tells support the server has it; it never changes the outcome.
      channel!.acknowledge?.(t.provider_ref ?? m.provider_ref ?? "", m.provider_msg_id).catch(() => {});
    } catch {
      // ignore
    }
  }

  // Storage errors propagate on purpose: the channel must not ack, so the provider redelivers.
  async function ownerReply(m: OwnerInboundMessage): Promise<OwnerOutcome> {
    const t = typeof m?.provider_ref === "string" ? store.getThreadByProviderRef(m.provider_ref) : null;
    if (!t || t.vendor_id !== vendor) return "ignored";
    const text = typeof m.text === "string" ? m.text.normalize("NFC").trim() : "";
    if (!text || !m.provider_msg_id || store.hasProviderMessage(m.provider_msg_id)) return "ignored";
    const tr = transition(t.state, "owner_reply");
    if (!tr.ok) return "rejected:thread_closed";
    const now = clock();
    const stored = store.tx(() => {
      const id = store.insertThreadMessage({ thread_id: t.thread_id, author: "owner", text, provider_msg_id: m.provider_msg_id, at: local(now.getTime()) });
      if (id === null) return false;
      store.updateThread(t.thread_id, { state: tr.state, updated_at_ms: now.getTime() });
      return true;
    });
    if (!stored) return "ignored";
    log(`[support] owner replied thread=${t.thread_id} by=${m.user_id}`);
    eventLog("owner_replied", null, null, { thread_id: t.thread_id });
    wake(t.thread_id, "replied");
    acknowledge(t, m);
    deps.emails?.onOwnerReply(t.thread_id, now.getTime());
    return "accepted";
  }

  async function ownerClose(m: OwnerInboundMessage): Promise<OwnerOutcome> {
    const t = typeof m?.provider_ref === "string" ? store.getThreadByProviderRef(m.provider_ref) : null;
    if (!t || t.vendor_id !== vendor) return "ignored";
    const tr = transition(t.state, "owner_close");
    if (!tr.ok || !tr.changed) return "ignored";
    closeRow(t, "owner");
    acknowledge(t, m);
    return "accepted";
  }

  const onOwnerMessage: OwnerMessageHandler = async (m) => {
    if (!enabled) return "ignored";
    const text = typeof m?.text === "string" ? m.text.trim() : "";
    const close = OWNER_CLOSE_WORDS.test(text);
    // Only a reply inside a question's thread reaches the developer (R4): a top-level post is support's own chatter.
    if (!m || typeof m.provider_ref !== "string") return "ignored";
    return close ? ownerClose(m) : ownerReply(m);
  };

  async function sweepOne(row: OutboxRow): Promise<void> {
    const t = store.getThread(row.thread_id);
    if (!t) return; // purged meanwhile
    const now = clock();
    const iso = now.toISOString();
    if (row.kind === "post" && !t.provider_ref) {
      const opener = store.listOutbox(t.thread_id).find((o) => o.kind === "open");
      if (!opener || opener.state === "failed") {
        markFailed(row, t, "the thread's first message was never delivered");
        return;
      }
      store.deferOutbox(row.id, now.getTime() + RETRY_BASE_MS, iso);
      return;
    }
    try {
      // An earlier attempt may have reached the channel without the server learning it; a failed lookup counts as a failed send.
      const found = row.attempts > 1 ? await withTimeout(alreadyPosted(row, t), sendTimeoutMs) : null;
      if (found) {
        markPosted(row, row.kind === "open" ? found : undefined);
      } else {
        const ref = await withTimeout(deliver(row.id, row.kind, row.text, t), sendTimeoutMs);
        markPosted(row, ref);
      }
      log(`[support] owner channel ${found ? "reconciled (already posted)" : "delivered"} thread=${t.thread_id} kind=${row.kind} attempt=${row.attempts}`);
      eventLog("message_delivered", null, null, { thread_id: t.thread_id, attempts: row.attempts });
    } catch (e) {
      const c = classify(e);
      if (c === "setup") noteSetupError(e);
      // The window runs from the row's first attempt (for an opener: when the question was asked).
      const firstAttemptMs = row.created_at_ms ?? Date.parse(t.created_at);
      if (c === "rejected" || clock().getTime() >= firstAttemptMs + retryWindowMs) {
        markFailed(row, t, errMsg(e));
        return;
      }
      scheduleRetry(row, firstAttemptMs, t, e);
    }
  }

  /**
   * The agent's wait loop reads back to back, so a thread with no read for support.agent_gone_after_min means the
   * session ended (Claude Code closed, laptop asleep, loop gave up) before it got support's answer. Only then is the
   * developer sent the confirm email, so a question answered in-session never emails anyone.
   */
  async function handleDepartures(nowMs: number): Promise<void> {
    if (!config.support.require_confirm) return; // reply emails go out on their own (emails.ts sweep)
    const cutoff = nowMs - config.support.agent_gone_after_min * 60_000;
    for (const t of store.listDepartedThreads(cutoff, SWEEP_BATCH)) {
      if (waiters.has(t.thread_id)) continue;
      store.markDeparted(t.thread_id, nowMs);
      if (!t.customer.email) continue;
      log(`[support] agent stopped listening thread=${t.thread_id}; sending the confirm email`);
      try {
        await deps.emails!.requestConfirm(t.thread_id, t.customer.email, nowMs);
      } catch (e) {
        log(`[support] confirm email failed thread=${t.thread_id}: ${errMsg(e)}`);
      }
    }
  }

  async function sweepInner(): Promise<void> {
    const now = clock();
    const nowMs = now.getTime();
    const answeredCutoff = nowMs - config.limits.thread_close_after_reply_hours * HOUR_MS;
    const awaitingCutoff = nowMs - config.limits.thread_close_unanswered_days * 24 * HOUR_MS;
    for (const id of store.expireIdleThreads(answeredCutoff, awaitingCutoff, nowMs)) {
      log(`[support] thread closed thread=${id} by=expiry`);
      eventLog("thread_closed", null, null, { thread_id: id, by: "expiry" });
      wake(id, "closed");
    }
    store.purgeClosedThreads(nowMs - PURGE_CLOSED_MS);
    // Sequential on purpose: a slow provider must not pile up parallel sends.
    for (const row of store.claimDueOutbox(nowMs, SWEEP_BATCH, now.toISOString())) await sweepOne(row);
    if (deps.emails) await handleDepartures(clock().getTime());
    // T5b: reply emails ride the same 30 s pass, after the Slack outbox.
    if (deps.emails) {
      try {
        await deps.emails.sweep(clock().getTime());
      } catch (e) {
        log(`[support] reply email sweep failed: ${errMsg(e)}`);
      }
    }
  }

  function sweep(): Promise<void> {
    if (!sweeping) {
      sweeping = sweepInner().finally(() => {
        sweeping = null;
      });
    }
    return sweeping;
  }

  /** The channel (re)connected: every waiting row is due now (R9). A sweep already running gets one more pass after it. */
  function flush(): Promise<void> {
    store.expediteOutbox(clock().getTime());
    if (sweeping) {
      sweepAgain = true;
      return sweeping.then(() => {
        if (!sweepAgain) return;
        sweepAgain = false;
        return sweep();
      });
    }
    return sweep();
  }

  return {
    enabled,
    mode,
    leaveMessage,
    getThread,
    agentFollowUp,
    closeThread,
    ownerReply,
    ownerClose,
    onOwnerMessage,
    sweep,
    flush,

    markDelivered(threadId: string, messageIds: number[]) {
      if (messageIds.length) store.markMessagesDelivered(threadId, messageIds, clock().getTime());
    },

    async start() {
      if (!enabled) return;
      if (supportsThreads(channel)) {
        channel.onOwnerMessage(onOwnerMessage, {
          openThreadRefs: () => store.listOpenThreadRefs(vendor),
          getCursor: () => store.getChannelState(CURSOR_KEY),
          setCursor: (c) => store.setChannelState(CURSOR_KEY, c),
        });
      }
      if (reconnectAware(channel)) {
        channel.onConnected(() => {
          if (stopping) return;
          flush().catch((e) => log(`[support] outbox flush failed: ${errMsg(e)}`));
        });
      }
      timer = timers.setInterval(() => {
        sweep().catch((e) => log(`[support] outbox sweep failed: ${errMsg(e)}`));
      }, SWEEP_EVERY_MS);
      if (channel.start) {
        try {
          await channel.start();
        } catch (e) {
          // Boot continues: the outbox queues, /healthz shows the channel down.
          log(`[support] owner channel did not start: ${errMsg(e)}`);
        }
      }
      // The channel has caught up on missed replies by now, so the sweep's expiry cannot close a thread whose answer was waiting.
      // Rows queued before a restart go out now, not 30 s from now.
      sweep().catch((e) => log(`[support] outbox sweep failed: ${errMsg(e)}`));
    },

    async stop() {
      // Answer every hold first, and hold no new ones, so a shutdown never cuts an agent's request.
      stopping = true;
      for (const end of [...waiters.values()]) end("shutdown");
      if (timer !== undefined) timers.clearInterval(timer);
      timer = undefined;
      await sweeping?.catch(() => {});
      await channel.stop?.();
    },

    health() {
      const s = channel.status?.();
      return {
        mode,
        enabled,
        connected: s ? s.connected : null,
        ...(s?.last_error ? { last_error: s.last_error } : {}),
        ...(store.getChannelState(PERMANENT_ERROR_KEY) ? { permanent_error: store.getChannelState(PERMANENT_ERROR_KEY)! } : {}),
        outbox: store.outboxCounts(),
      };
    },
  };
}
