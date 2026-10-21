// Slack support channel (Communication module): posts agent questions and notices
// to one Slack channel, and reads the support team's typed replies in each
// message's thread over Socket Mode (slack-socket.ts), so no inbound URL.
// Only replies inside a question's thread are passed on (eng review R4): a
// top-level post in the channel is the team's own chatter and is ignored.
// A CommunicationConnector with every thread member (see types.ts). Thread methods throw
// ConnectorError so the core can queue (channel_unavailable) or refuse
// (channel_auth_failed, channel_rejected); `notify` only logs.
//
// Durability. Outbound: every thread post carries its dedupe key as Slack message
// metadata, and findPosted reads it back (conversations.history / .replies with
// include_all_metadata), so the core never re-posts a message Slack already has.
// Inbound: Socket Mode does not replay events, so on every hello the connector
// reads the channel and each open thread since the newest message it has handled
// (a ts kept by the core, see ChannelContext) and runs what it finds through the
// same path as live events; the core dedups on the message ts. Every hello
// also runs the core's onConnected hook, which sends queued questions at once.

import { SocketModeClient, type WebSocketCtor } from "./slack-socket.js";
import { ConnectorError, type ChannelContext, type OwnerInboundMessage, type OwnerMessageHandler, type ThreadCapableChannel } from "./types.js";

const API = "https://slack.com/api";
const DEFAULT_TIMEOUT_MS = 10_000;
/** When Slack gives no Retry-After (5xx, timeout), the core's queue waits this long. */
const DEFAULT_RETRY_S = 30;
/** event_type of the message metadata that carries the dedupe key. */
const METADATA_TYPE = "gateway_outbox";
/** Reads start this long before the point of interest: clocks differ, and the core dedups what is read twice. */
const OVERLAP_S = 60;
const PAGE_LIMIT = 200;
/** A read gives up after this many pages (2000 messages): it throws instead of returning part of the range. */
const MAX_PAGES = 10;
const DEFAULT_BACKFILL_RETRY_MS = 30_000;

/** Slack `error` strings that mean the bot token or channel setup is wrong; retrying cannot help. */
const AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "not_in_channel", "channel_not_found", "is_archived", "missing_scope", "no_permission"]);
/** Slack-side hiccups the core should queue and retry. */
const TRANSIENT_ERRORS = new Set(["fatal_error", "internal_error", "ratelimited", "service_unavailable", "request_timeout"]);

/** The fix a vendor can act on, per Slack error. Exported for the init wizard and the docs test. */
export function slackHint(error: string, needed?: string): string {
  switch (error) {
    case "invalid_auth":
    case "not_authed":
    case "account_inactive":
    case "token_revoked":
    case "token_expired":
      return "SLACK_BOT_TOKEN is wrong or revoked: copy the Bot User OAuth Token (xoxb-...) from OAuth & Permissions in your Slack app";
    case "not_in_channel":
    case "channel_not_found":
      return "invite the app to the channel (type /invite @<your app> in it), then check SLACK_CHANNEL_ID is that channel's ID (C...)";
    case "is_archived":
      return "the channel in SLACK_CHANNEL_ID is archived: unarchive it or pick another channel";
    case "missing_scope":
    case "no_permission":
      return `the bot token lacks a scope${needed ? ` (${needed})` : ""}: add it under OAuth & Permissions, then click Reinstall to Workspace`;
    default:
      return `Slack refused the request (${error})`;
  }
}

/** Slack's three control characters (mrkdwn mentions, links, entities); everything else is literal. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inverse of escapeSlack for inbound text: Slack sends the owner's "&" and "<" as entities, and the agent should read what the owner typed. */
export function unescapeSlack(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

const APP_TOKEN_HINT = "SLACK_APP_TOKEN must be an app-level token (xapp-...) with the connections:write scope, and Socket Mode must be turned on in your Slack app";

export interface SlackOwnerOptions {
  /** Bot User OAuth Token (xoxb-...). */
  botToken: string;
  /** App-level token (xapp-...) with connections:write, for Socket Mode. */
  appToken: string;
  /** The channel the owner reads (C... or G...). */
  channelId: string;
  /** Optional allowlist of Slack user ids whose thread replies count as the owner's. */
  ownerUserIds?: string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  warn?: (m: string) => void;
  WebSocket?: WebSocketCtor;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  helloTimeoutMs?: number;
  /** How long after a failed catch-up read the next one starts. */
  backfillRetryMs?: number;
}

type SlackMessage = Record<string, unknown>;
type SlackResponse = { ok?: boolean; error?: string; needed?: string; [k: string]: unknown };

export type SlackChannel = ThreadCapableChannel &
  Required<Pick<ThreadCapableChannel, "acknowledge" | "checkAccess" | "status" | "findPosted">> & {
    /** Called on every Socket Mode hello (first connect and each reconnect); the core flushes its outbox (messages.ts ReconnectAware). */
    onConnected(fn: () => void): void;
  };

/** A paged read that hit MAX_PAGES. Transient to the core, so a lookup that could not see everything never ends in a post. */
class RangeTooLarge extends ConnectorError {
  constructor(method: string) {
    super("channel_unavailable", `Slack ${method}: more than ${MAX_PAGES * PAGE_LIMIT} messages in range, not read`, { retry_after_s: DEFAULT_RETRY_S });
  }
}

const tsNum = (ts: string) => Number(ts);
const oldestOf = (a: string, b: string) => (tsNum(a) <= tsNum(b) ? a : b);

export function slackOwnerChannel(opts: SlackOwnerOptions): SlackChannel {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const owners = new Set(opts.ownerUserIds ?? []);
  let handler: OwnerMessageHandler | undefined;
  const connectedHooks: Array<() => void> = [];
  let ctx: ChannelContext | undefined;
  let stopped = true;
  /** Cursor as of the oldest connect not yet caught up; undefined when there is nothing to catch up on. */
  let backfillFrom: string | null | undefined;
  /** Newest message handled while a catch-up was outstanding; stored once it succeeds (see seen). */
  let heldCursor: string | undefined;
  let backfillWanted = false;
  let backfilling: Promise<void> | null = null;
  let backfillTimer: ReturnType<typeof setTimeout> | undefined;
  let backfillError: string | undefined;
  /** "<thread ref>|<reason>" already answered with a notice, so the owner sees it once per thread. */
  const noticed = new Set<string>();

  async function call(method: string, params: Record<string, string>, token = opts.botToken): Promise<SlackResponse> {
    let res: Response;
    try {
      // Form encoding works for every Web API method; JSON bodies are refused by the read methods.
      res = await fetchImpl(`${API}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = e as Error | undefined;
      const why = err?.name === "TimeoutError" || err?.name === "AbortError" ? `timed out after ${timeoutMs} ms` : `network error: ${err?.message ?? e}`;
      throw new ConnectorError("channel_unavailable", `Slack ${method} ${why}`, { retry_after_s: DEFAULT_RETRY_S, cause: e });
    }
    if (res.status === 429) {
      const after = Number(res.headers.get("retry-after"));
      throw new ConnectorError("channel_unavailable", `Slack ${method} rate limited`, { retry_after_s: Number.isFinite(after) && after > 0 ? after : DEFAULT_RETRY_S });
    }
    if (res.status >= 500) throw new ConnectorError("channel_unavailable", `Slack ${method} failed (${res.status})`, { retry_after_s: DEFAULT_RETRY_S });
    let body: SlackResponse;
    try {
      body = (await res.json()) as SlackResponse;
    } catch {
      throw new ConnectorError("channel_rejected", `Slack ${method} answered ${res.status} without JSON`);
    }
    if (body.ok) return body;
    const error = String(body.error ?? `http_${res.status}`);
    if (TRANSIENT_ERRORS.has(error)) throw new ConnectorError("channel_unavailable", `Slack ${method}: ${error}`, { retry_after_s: DEFAULT_RETRY_S });
    // No method in the message: the core alerts the admin once per distinct message, and one revoked token fails every method alike.
    if (AUTH_ERRORS.has(error)) throw new ConnectorError("channel_auth_failed", `Slack: ${error}: ${slackHint(error, body.needed)}`);
    // Unknown errors are permanent (plan D5): queueing a message Slack refuses would only fail again later.
    throw new ConnectorError("channel_rejected", `Slack ${method}: ${error}`);
  }

  async function post(text: string, threadTs?: string, dedupeKey?: string): Promise<string> {
    // Escaped here, once, for every caller: customer text like "<!channel>" or "<@U123>" would otherwise ping the workspace or fake a mention.
    const params: Record<string, string> = { channel: opts.channelId, text: escapeSlack(text), unfurl_links: "false", unfurl_media: "false" };
    if (threadTs) params.thread_ts = threadTs;
    // Invisible to the owner; findPosted matches on it.
    if (dedupeKey) params.metadata = JSON.stringify({ event_type: METADATA_TYPE, event_payload: { key: dedupeKey } });
    const r = await call("chat.postMessage", params);
    if (typeof r.ts !== "string") throw new ConnectorError("channel_rejected", "Slack chat.postMessage returned no ts");
    return r.ts;
  }

  async function noticeOnce(ref: string, key: string, text: string): Promise<void> {
    if (noticed.has(`${ref}|${key}`)) return;
    noticed.add(`${ref}|${key}`);
    try {
      await post(text, ref);
    } catch (e) {
      warn(`[support] Slack notice in thread ${ref} failed: ${(e as Error)?.message ?? e}`);
    }
  }

  function rejectionNotice(reason: string): string {
    if (reason === "thread_closed") return "This conversation is closed, so the agent will not see this reply.";
    return `This reply was not passed to the agent (${reason}).`;
  }

  /** Every message of a paged read (conversations.history or conversations.replies); all of the range or a throw, never a part. */
  async function readAll(method: string, params: Record<string, string>): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await call(method, { channel: opts.channelId, limit: String(PAGE_LIMIT), ...params, ...(cursor ? { cursor } : {}) });
      if (Array.isArray(r.messages)) out.push(...(r.messages as SlackMessage[]));
      const next = (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
      if (!r.has_more || !next) return out;
      cursor = next;
    }
    throw new RangeTooLarge(method);
  }

  let ownBotId: Promise<string> | undefined;
  /** This app's bot id, asked once: only its own posts can answer findPosted. */
  function botId(): Promise<string> {
    ownBotId ??= call("auth.test", {}).then((r) => {
      if (typeof r.bot_id !== "string") throw new ConnectorError("channel_rejected", "Slack auth.test returned no bot_id");
      return r.bot_id;
    });
    // A failed ask is not remembered.
    ownBotId.catch(() => (ownBotId = undefined));
    return ownBotId;
  }

  const slackTs = (seconds: number) => Math.max(0, seconds).toFixed(6);

  /** Remember the newest message handled, so the next catch-up starts there. */
  function seen(ts: string): void {
    if (!ctx) return;
    // While a catch-up is outstanding the stored cursor stays at the start of the gap: if the process restarts
    // before the pass succeeds, the next one must read the gap again, not start after the live events since.
    if (backfillFrom !== undefined) {
      if (heldCursor === undefined || tsNum(ts) > tsNum(heldCursor)) heldCursor = ts;
      return;
    }
    const cur = ctx.getCursor();
    if (cur === null || tsNum(ts) > tsNum(cur)) ctx.setCursor(ts);
  }

  async function onEvent(payload: unknown): Promise<void> {
    const ev = (payload as { event?: SlackMessage } | undefined)?.event;
    if (!ev || ev.type !== "message" || ev.channel !== opts.channelId) return;
    await onMessage(ev, false);
    // Only after the handler: a message that failed to store must stay ahead of the cursor.
    if (typeof ev.ts === "string") seen(ev.ts);
  }

  /** One channel message, live or fetched after a gap. */
  async function onMessage(ev: SlackMessage, backfilled: boolean): Promise<void> {
    // Edits, deletes, joins and our own posts carry a subtype or bot_id; only fresh human text counts.
    if (ev.subtype !== undefined || ev.bot_id !== undefined) return;
    const ts = typeof ev.ts === "string" ? ev.ts : undefined;
    const threadTs = typeof ev.thread_ts === "string" ? ev.thread_ts : undefined;
    const user = typeof ev.user === "string" ? ev.user : undefined;
    const text = typeof ev.text === "string" ? unescapeSlack(ev.text) : undefined;
    if (!ts || threadTs === ts || !user || text === undefined) return;
    const flag = backfilled ? { backfilled: true, sent_at_ms: Math.round(tsNum(ts) * 1000) } : {};
    // A top-level post is never a reply (R4): it is not passed on, and gets no notice.
    if (!threadTs) return;
    // The owner allowlist is optional; tighten it if strangers start replying in the channel.
    // Notices are not awaited: Slack wants the envelope ack within 3 s and a slow post must not cause a redelivery.
    if (owners.size && !owners.has(user)) {
      void noticeOnce(threadTs, "not_owner", "Only the business owner's replies reach the agent; this one was not passed on.");
      return;
    }
    if (!handler) return;
    const m: OwnerInboundMessage = { provider_ref: threadTs, provider_msg_id: ts, user_id: user, text, ...flag };
    // Throws on a storage failure: the socket client then leaves the envelope un-acked for redelivery.
    // The ✅ reaction is not added here: the core calls acknowledge() once it has stored an accepted message.
    const result = await handler(m);
    if (result.startsWith("rejected:")) {
      const reason = result.slice("rejected:".length);
      void noticeOnce(threadTs, reason, rejectionNotice(reason));
    }
  }

  /** One catch-up pass: read what was typed since `backfillFrom` and handle it oldest first. Throws when a read or the handler fails. */
  async function backfillOnce(): Promise<void> {
    if (!ctx || !handler) return;
    const refs = ctx.openThreadRefs();
    // Without an open thread no reply can be routed anywhere.
    if (refs.length === 0) return;
    const firstOpener = refs.reduce(oldestOf);
    // Nothing before the oldest open thread matters; with no cursor yet (first run) that is also where to start.
    const from = backfillFrom ? Math.max(tsNum(backfillFrom) - OVERLAP_S, tsNum(firstOpener)) : tsNum(firstOpener);
    const oldest = slackTs(from);
    const found = new Map<string, SlackMessage>();
    // Only thread replies matter (R4), so the channel's top-level history is not read.
    for (const ref of refs) {
      let replies: SlackMessage[];
      try {
        replies = await readAll("conversations.replies", { ts: ref, oldest });
      } catch (e) {
        // A thread whose opener was deleted in Slack must not block the others. Any other failure ends the pass,
        // so the cursor never moves past replies that were not read.
        if (!(e instanceof ConnectorError) || !e.message.endsWith("thread_not_found")) throw e;
        warn(`[support] Slack catch-up skipped thread ${ref}: ${e.message}`);
        continue;
      }
      for (const m of replies) if (typeof m.ts === "string" && m.ts !== ref) found.set(m.ts, { ...m, thread_ts: ref });
    }
    const ordered = [...found.values()].sort((a, b) => tsNum(a.ts as string) - tsNum(b.ts as string));
    for (const m of ordered) {
      await onMessage(m, true);
      seen(m.ts as string);
    }
  }

  async function runBackfill(): Promise<void> {
    while (backfillWanted && !stopped) {
      backfillWanted = false;
      try {
        await backfillOnce();
        backfillError = undefined;
      } catch (e) {
        backfillError = `Slack catch-up failed: ${(e as Error)?.message ?? e}`;
        warn(`[support] ${backfillError}; replies typed while disconnected are fetched on the next try`);
        if (!stopped && !backfillTimer) {
          backfillTimer = setTimeout(() => {
            backfillTimer = undefined;
            void requestBackfill();
          }, opts.backfillRetryMs ?? DEFAULT_BACKFILL_RETRY_MS);
          backfillTimer.unref?.();
        }
        return;
      }
    }
    // Caught up: the next connect starts from the cursor as it is then.
    backfillFrom = undefined;
    const held = heldCursor;
    heldCursor = undefined;
    if (held !== undefined) seen(held);
  }

  /** Called on every hello. Resolves when the pass it joined has ended; never rejects. */
  function requestBackfill(): Promise<void> {
    if (!ctx || stopped) return Promise.resolve();
    // Captured now, before live events move the cursor past the gap; a retry keeps the older start.
    if (backfillFrom === undefined) backfillFrom = ctx.getCursor();
    backfillWanted = true;
    backfilling ??= runBackfill().finally(() => {
      backfilling = null;
    });
    return backfilling;
  }

  const socket = new SocketModeClient({
    openUrl: async () => {
      try {
        const r = await call("apps.connections.open", {}, opts.appToken);
        if (typeof r.url !== "string") throw new ConnectorError("channel_unavailable", "Slack apps.connections.open returned no url");
        return r.url;
      } catch (e) {
        if (e instanceof ConnectorError && e.code === "channel_auth_failed") throw new ConnectorError("channel_auth_failed", APP_TOKEN_HINT, { cause: e });
        throw e;
      }
    },
    onEvent,
    onConnected: () => {
      void requestBackfill();
      for (const fn of connectedHooks) {
        try {
          fn();
        } catch (e) {
          warn(`[support] Slack connect hook failed: ${(e as Error)?.message ?? e}`);
        }
      }
    },
    WebSocket: opts.WebSocket,
    warn,
    minBackoffMs: opts.minBackoffMs,
    maxBackoffMs: opts.maxBackoffMs,
    helloTimeoutMs: opts.helloTimeoutMs,
  });

  const channel: SlackChannel = {
    async notify(message) {
      try {
        await post(message);
      } catch (e) {
        warn(`[support] owner notice to Slack failed: ${(e as Error)?.message ?? e}`);
      }
    },
    async openThread(opener) {
      return { provider_ref: await post(opener.text, undefined, opener.dedupe_key) };
    },
    async postToThread(ref, text, o) {
      await post(text, ref, o?.dedupe_key);
    },
    async findPosted(q) {
      // Without include_all_metadata Slack returns the metadata field without its payload.
      const params = { oldest: slackTs(q.since_ms / 1000 - OVERLAP_S), include_all_metadata: "true" };
      const self = await botId();
      const messages = q.provider_ref ? await readAll("conversations.replies", { ...params, ts: q.provider_ref }) : await readAll("conversations.history", params);
      const hit = messages.find((m) => {
        const md = m.metadata as { event_type?: unknown; event_payload?: { key?: unknown } } | undefined;
        // Another app in the channel can post metadata too; only this bot's own message counts as "already posted".
        return m.bot_id === self && md?.event_type === METADATA_TYPE && md.event_payload?.key === q.dedupe_key;
      });
      return typeof hit?.ts === "string" ? hit.ts : null;
    },
    onOwnerMessage(h, c) {
      handler = h;
      ctx = c;
    },
    onConnected(fn) {
      connectedHooks.push(fn);
    },
    async acknowledge(_ref, msgId) {
      try {
        await call("reactions.add", { channel: opts.channelId, timestamp: msgId, name: "white_check_mark" });
      } catch (e) {
        if ((e as Error)?.message?.endsWith("already_reacted")) return;
        warn(`[support] Slack reaction on ${msgId} failed: ${(e as Error)?.message ?? e}`);
      }
    },
    async start() {
      stopped = false;
      await socket.start();
      // Replies typed while the server was down are in before the core's first sweep.
      await backfilling;
    },
    async stop() {
      stopped = true;
      if (backfillTimer) clearTimeout(backfillTimer);
      backfillTimer = undefined;
      await socket.stop();
    },
    async checkAccess() {
      await call("auth.test", {});
      const info = await call("conversations.info", { channel: opts.channelId });
      const ch = info.channel as { is_member?: boolean; is_archived?: boolean } | undefined;
      if (ch?.is_archived) throw new ConnectorError("channel_auth_failed", `Slack conversations.info: is_archived: ${slackHint("is_archived")}`);
      // Public channels answer conversations.info without membership; posting would then fail with not_in_channel.
      if (ch && ch.is_member === false) throw new ConnectorError("channel_auth_failed", `Slack conversations.info: not_in_channel: ${slackHint("not_in_channel")}`);
      try {
        await call("apps.connections.open", {}, opts.appToken);
      } catch (e) {
        if (e instanceof ConnectorError && e.code === "channel_auth_failed") throw new ConnectorError("channel_auth_failed", APP_TOKEN_HINT, { cause: e });
        throw e;
      }
    },
    status() {
      const s = socket.status();
      return s.connected && backfillError ? { connected: true, last_error: backfillError } : s;
    },
  };
  return channel;
}

export interface SlackSettings {
  slack_bot_token?: string | undefined;
  slack_app_token?: string | undefined;
  slack_channel_id?: string | undefined;
  slack_owner_user_ids?: string[] | undefined;
}

/**
 * Slack channel when the three required settings are set, undefined when none
 * are, and an Error naming what to fix when only some are or a token has the
 * wrong prefix (the most common paste mistake: the two tokens swapped).
 */
export function createSlackChannel(settings: SlackSettings, opts: Omit<SlackOwnerOptions, "botToken" | "appToken" | "channelId" | "ownerUserIds"> = {}): SlackChannel | undefined {
  const fields: Array<[keyof SlackSettings, string]> = [
    ["slack_bot_token", "SLACK_BOT_TOKEN"],
    ["slack_app_token", "SLACK_APP_TOKEN"],
    ["slack_channel_id", "SLACK_CHANNEL_ID"],
  ];
  const missing = fields.filter(([k]) => !settings[k]).map(([, env]) => env);
  if (missing.length === fields.length) return undefined;
  if (missing.length > 0) {
    throw new Error(`Slack is partly configured: set ${missing.join(", ")} too, or unset all of SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_CHANNEL_ID`);
  }
  if (!settings.slack_bot_token!.startsWith("xoxb-")) throw new Error("SLACK_BOT_TOKEN must be the Bot User OAuth Token (starts with xoxb-), from OAuth & Permissions in your Slack app");
  if (!settings.slack_app_token!.startsWith("xapp-")) throw new Error("SLACK_APP_TOKEN must be an app-level token (starts with xapp-), from Basic Information > App-Level Tokens in your Slack app");
  return slackOwnerChannel({
    ...opts,
    botToken: settings.slack_bot_token!,
    appToken: settings.slack_app_token!,
    channelId: settings.slack_channel_id!,
    ownerUserIds: settings.slack_owner_user_ids ?? [],
  });
}
