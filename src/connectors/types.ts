// Connector contracts. Two kinds:
//
// - CommunicationConnector: the vendor's support channel (Slack). Questions from agents
//   are posted there as threads; the support team's typed replies come back in-thread.
// - RequesterNotifier: how a reply reaches the developer when their agent session is
//   closed (email; first implementation Resend, lane B / T5a).
//
// Connectors throw ConnectorError; the core maps it into the shared error body.
// Connectors never shape HTTP responses themselves.

/**
 * The support channel: how the vendor's team hears from agents. `notify` is one-way
 * and is all a provider must implement. A provider that can also carry a two-way thread (Slack)
 * implements the optional members; the core uses them only when all are present
 * (see `supportsThreads`). Delivery failures of `notify` are logged, never
 * thrown; thread methods throw ConnectorError so the core can decide between
 * queueing (transient) and refusing (permanent).
 */
export interface CommunicationConnector {
  notify(message: string): Promise<void>;
  /** Post the first message of a thread; returns the provider's thread handle (Slack: the message ts). */
  openThread?(opener: ThreadOpener): Promise<{ provider_ref: string }>;
  /** Post a follow-up into an existing thread (agent follow-ups, gateway notices). */
  postToThread?(provider_ref: string, text: string, opts?: { dedupe_key?: string }): Promise<void>;
  /**
   * Reconcile-first retry: the provider's id of a message already posted with this
   * `dedupe_key`, or null. The core asks before every re-send, so a post whose answer
   * was lost (timeout, crash) is never posted twice. Throws ConnectorError like a send.
   */
  findPosted?(q: PostedQuery): Promise<string | null>;
  /**
   * Register the handler for owner-typed messages. Called once at boot, before `start`.
   * `ctx` lets the channel fetch what it missed while disconnected (see ChannelContext).
   */
  onOwnerMessage?(handler: OwnerMessageHandler, ctx?: ChannelContext): void;
  /** Best-effort visible acknowledgement of an owner message (Slack: a ✅ reaction, keyed by the message id even when it is top-level). Never throws. */
  acknowledge?(provider_ref: string, provider_msg_id: string): Promise<void>;
  /** Open the inbound connection (Slack Socket Mode). Resolves once connected and caught up on missed replies; reconnects on its own afterwards. */
  start?(): Promise<void>;
  stop?(): Promise<void>;
  /** Startup check: throws ConnectorError("channel_auth_failed") with a fix hint a vendor can act on. */
  checkAccess?(): Promise<void>;
  /** Live state for /healthz. */
  status?(): { connected: boolean; last_error?: string };
}

export interface ThreadOpener {
  thread_id: string;
  /** Rendered text for support (who, contact, the message, how to reply). */
  text: string;
  /** Unique per outbox row; the channel attaches it to the post so `findPosted` can find it. */
  dedupe_key?: string;
}

export interface PostedQuery {
  dedupe_key: string;
  /** Set for a follow-up: the thread to look in. Absent for an opener (look in the channel). */
  provider_ref?: string | undefined;
  /** The message cannot be older than this (when its outbox row was created). */
  since_ms: number;
}

/**
 * What a channel needs from the core to catch up after a gap (stop-then-start
 * deploy, reconnect): which threads are open, and a durable cursor (the provider's
 * id of the newest message the channel has handled; Slack: a ts).
 */
export interface ChannelContext {
  /** provider_ref of every open two-way thread. */
  openThreadRefs(): string[];
  getCursor(): string | null;
  setCursor(cursor: string): void;
}

export interface OwnerInboundMessage {
  /**
   * The thread the message was typed in (Slack: the opener's ts). Undefined for a
   * top-level message in the owner's channel, outside any thread: the core then
   * matches it to the one thread awaiting the owner, if there is exactly one,
   * posts it into that thread with `postToThread`, and otherwise may post one
   * short hint with `notify` (so `notify` must post into the same channel).
   */
  provider_ref?: string | undefined;
  /** Provider's unique id for this message (Slack: ts); the core dedups on it. */
  provider_msg_id: string;
  /** Provider user id of the author, for the optional owner allowlist. */
  user_id: string;
  text: string;
  /**
   * True when the channel fetched it after a gap instead of receiving it live. The core then skips hints about it and
   * requires `sent_at_ms` on a top-level message.
   */
  backfilled?: boolean;
  /**
   * When the owner sent it, by the provider's clock (epoch ms). For a top-level (unquoted) message, the core checks
   * that no thread changed since `sent_at_ms` before matching it to the waiting thread. Required with `backfilled`.
   */
  sent_at_ms?: number;
}

/**
 * Returns "accepted" (persisted), "ignored" (unknown thread, duplicate, empty, or a
 * top-level message the core could not match to one waiting thread) or
 * "rejected:<reason>" (closed thread, not an owner); the channel posts one notice
 * in-thread for rejected. Throws on storage failure so the channel does NOT ack
 * and the provider redelivers.
 */
export type OwnerMessageHandler = (m: OwnerInboundMessage) => Promise<"accepted" | "ignored" | `rejected:${string}`>;

export type ThreadCapableChannel = CommunicationConnector &
  Required<Pick<CommunicationConnector, "openThread" | "postToThread" | "onOwnerMessage" | "start" | "stop">>;

export function supportsThreads(c: CommunicationConnector | undefined): c is ThreadCapableChannel {
  return !!c && !!c.openThread && !!c.postToThread && !!c.onOwnerMessage && !!c.start && !!c.stop;
}

export type ConnectorErrorCode =
  | "channel_unavailable" // transient provider failure (429/5xx/timeout); core queues the send
  | "channel_auth_failed" // permanent (bad token, not in channel, missing scope); core refuses
  | "channel_rejected" // provider refused this message (too long, bad channel); not retryable
  // RequesterNotifier codes (design section 4); thrown by the Resend connector (lane B, T5a).
  | "notifier_auth_failed" // RESEND_API_KEY rejected; fix hint names resend.com/api-keys
  | "notifier_domain_unverified" // EMAIL_FROM's domain is not verified in Resend (SPF/DKIM)
  | "notifier_rejected" // bad recipient; the thread notes it, no retry
  | "notifier_unavailable"; // transient; the reply-email queue retries

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly retry_after_s: number | undefined;
  /**
   * Narrows a code without adding one. "idempotency_mismatch": a notifier_rejected because the idempotency key was
   * already used for a different email body; a send under a fresh key can still succeed.
   */
  readonly detail: "idempotency_mismatch" | undefined;

  constructor(
    code: ConnectorErrorCode,
    message: string,
    opts: { retry_after_s?: number; cause?: unknown; detail?: "idempotency_mismatch" } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "ConnectorError";
    this.code = code;
    this.retry_after_s = opts.retry_after_s;
    this.detail = opts.detail;
  }
}

/**
 * Second connector kind: tells the developer (the requester) by email when a reply
 * arrives after their agent session closed (design section 4). Separate from
 * CommunicationConnector, which is the vendor's own channel. The vendor brings its own
 * provider account and sending domain (eng review R8). First implementation: Resend (T5a).
 */
export interface RequesterNotifier {
  name: string;
  /** Startup check: throws ConnectorError("notifier_auth_failed" | "notifier_domain_unverified") with a fix hint a vendor can act on. */
  checkAccess(): Promise<void>;
  /**
   * Send one plain-text email. `idempotency_key` is stable across retries of the same email,
   * so a retried send never delivers twice. Throws ConnectorError("notifier_rejected") for a
   * bad recipient (no retry) and ConnectorError("notifier_unavailable") when the caller should retry.
   */
  sendEmail(msg: { to: string; subject: string; text: string; idempotency_key: string }): Promise<{ provider_ref: string }>;
}
