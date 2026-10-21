// SQLite store for the support threads (threads, thread_messages, owner_outbox,
// message_requests), the event log, and the tables the support lanes fill in later
// (requester_emails, email_confirmations, verified_addresses: schema only for now; resume_tokens: T6).
// node:sqlite (built into Node >= 22.13), WAL mode, one file per server.
// All timestamps are stored as UTC epoch ms next to the RFC 3339 strings
// that were returned to the caller.

import { DatabaseSync } from "node:sqlite";
import type { Customer } from "../customer.js";

export interface LogEntry {
  vendor_id: string;
  idem_key: string | null;
  contact: string | null;
  outcome: string;
  detail?: unknown;
}

const SCHEMA = `
-- What happened, for the vendor (message_left, owner_replied, thread_closed, ...). Never read by the core.
CREATE TABLE IF NOT EXISTS event_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  vendor_id   TEXT NOT NULL,
  idem_key    TEXT,
  contact     TEXT,
  outcome     TEXT NOT NULL,
  detail      TEXT
);

-- Support threads. The read token is stored only as a sha256 hash; the
-- plaintext lives in message_requests.response so an idempotent retry can return it.
CREATE TABLE IF NOT EXISTS threads (
  thread_id     TEXT PRIMARY KEY,
  vendor_id   TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  state         TEXT NOT NULL,
  mode          TEXT NOT NULL,
  customer      TEXT NOT NULL,
  contact_keys  TEXT NOT NULL,
  provider_ref  TEXT,
  agent_count   INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  closed_at_ms  INTEGER,
  -- T4b: the question's masked context {error, tried, environment} as JSON.
  context_json  TEXT,
  -- T5c: who asked (ip:<bucket> or k:<key id>), so unconfirmed questions are capped per caller, not per contact.
  caller_key    TEXT,
  -- When an agent last read this thread (its background wait loop polls back to back); NULL for old rows.
  agent_seen_ms  INTEGER,
  -- Set once the sweep has handled the agent leaving; cleared when the agent reads again.
  departed_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS threads_provider_ref ON threads (provider_ref);
CREATE INDEX IF NOT EXISTS threads_state ON threads (state);

CREATE TABLE IF NOT EXISTS thread_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id       TEXT NOT NULL REFERENCES threads (thread_id) ON DELETE CASCADE,
  author          TEXT NOT NULL,
  text            TEXT NOT NULL,
  provider_msg_id TEXT UNIQUE,
  at              TEXT NOT NULL,
  -- Owner (support) messages only. T5b: set when a 200 GET /api/threads/:id carrying it finished sending (R2/R7).
  delivered_at    INTEGER,
  -- T5b: set when a reply email carried it.
  emailed_at      INTEGER
);
CREATE INDEX IF NOT EXISTS thread_messages_thread ON thread_messages (thread_id, id);

CREATE TABLE IF NOT EXISTS owner_outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   TEXT NOT NULL REFERENCES threads (thread_id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  text        TEXT NOT NULL,
  state       TEXT NOT NULL,
  attempts    INTEGER NOT NULL,
  next_at_ms  INTEGER,
  last_error  TEXT,
  updated_at  TEXT NOT NULL,
  created_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS outbox_next ON owner_outbox (state, next_at_ms);

-- Small durable facts an owner channel keeps across restarts (Slack: the ts of the
-- newest message it handled, so replies typed while it was down can be fetched).
CREATE TABLE IF NOT EXISTS channel_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Idempotency for leave_message / follow_up: the row is claimed before the send;
-- response stays NULL while the send is in flight (message_in_progress).
CREATE TABLE IF NOT EXISTS message_requests (
  vendor_id    TEXT NOT NULL,
  idem_key     TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  thread_id    TEXT NOT NULL REFERENCES threads (thread_id) ON DELETE CASCADE,
  response     TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (vendor_id, idem_key)
);

-- T5b (eng review R1, D2): at most one pending reply email per thread, swept in the 30 s pass.
-- Kept apart from owner_outbox so a reply email never changes the agent-visible delivery field.
CREATE TABLE IF NOT EXISTS requester_emails (
  thread_id   TEXT PRIMARY KEY REFERENCES threads (thread_id) ON DELETE CASCADE,
  due_at_ms   INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  state       TEXT NOT NULL,
  last_error  TEXT
);
CREATE INDEX IF NOT EXISTS requester_emails_due ON requester_emails (due_at_ms);

-- T6: one row per reply email; every token stays valid until the thread is purged. Hash only.
CREATE TABLE IF NOT EXISTS resume_tokens (
  thread_id   TEXT NOT NULL REFERENCES threads (thread_id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS resume_tokens_thread ON resume_tokens (thread_id);

-- T5b (eng review R5, D6): per-question confirm links; single use, expire after support.confirm_link_hours.
CREATE TABLE IF NOT EXISTS email_confirmations (
  thread_id     TEXT NOT NULL REFERENCES threads (thread_id) ON DELETE CASCADE,
  address       TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at_ms INTEGER NOT NULL,
  confirmed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS email_confirmations_thread ON email_confirmations (thread_id);

-- T5b: addresses confirmed in the last support.verified_address_days. Written on every confirm; no longer gates emails (those need the question itself confirmed).
CREATE TABLE IF NOT EXISTS verified_addresses (
  address      TEXT PRIMARY KEY,
  verified_at  INTEGER NOT NULL
);
`;

export type ThreadState = "awaiting_owner" | "answered" | "closed";
/** two_way: replies come back in-band (Slack thread). one_way: notify only, the owner contacts the customer directly. */
export type ThreadMode = "two_way" | "one_way";

/** T4b: the question's optional detail, stored masked. */
export interface ThreadContext {
  error?: string;
  tried?: string;
  environment?: string;
}

export interface ThreadRow {
  thread_id: string;
  vendor_id: string;
  token_hash: string;
  state: ThreadState;
  mode: ThreadMode;
  customer: Customer;
  contact_keys: string[];
  provider_ref: string | null;
  /** Agent-authored messages, opener included (capped per thread). */
  agent_count: number;
  created_at: string;
  updated_at_ms: number;
  closed_at_ms: number | null;
  /** T4b: masked context; absent on rows written before it existed. */
  context?: ThreadContext | null;
  /** T5c: the caller bucket that asked; null when unknown (direct op calls, older rows). */
  caller_key?: string | null;
}

export interface ThreadMessageRow {
  id: number;
  thread_id: string;
  author: "agent" | "owner";
  text: string;
  provider_msg_id: string | null;
  at: string;
}

export type OutboxState = "sending" | "queued" | "delivered" | "failed";
/** open: the thread opener (openThread); post: a follow-up into the thread; notify: one-way channel. */
export type OutboxKind = "open" | "post" | "notify";

export interface OutboxRow {
  id: number;
  thread_id: string;
  kind: OutboxKind;
  text: string;
  state: OutboxState;
  attempts: number;
  next_at_ms: number | null;
  last_error: string | null;
  /** null on rows written before the column existed. */
  created_at_ms: number | null;
}

export interface MessageRequestRow {
  vendor_id: string;
  idem_key: string;
  request_hash: string;
  thread_id: string;
  response: unknown | null;
}

type Raw = Record<string, unknown>;

function toThread(r: Raw): ThreadRow {
  return {
    thread_id: r.thread_id as string,
    vendor_id: r.vendor_id as string,
    token_hash: r.token_hash as string,
    state: r.state as ThreadState,
    mode: r.mode as ThreadMode,
    customer: JSON.parse(r.customer as string) as Customer,
    contact_keys: JSON.parse(r.contact_keys as string) as string[],
    provider_ref: (r.provider_ref as string | null) ?? null,
    agent_count: Number(r.agent_count),
    created_at: r.created_at as string,
    updated_at_ms: Number(r.updated_at_ms),
    closed_at_ms: r.closed_at_ms === null || r.closed_at_ms === undefined ? null : Number(r.closed_at_ms),
    context: typeof r.context_json === "string" ? (JSON.parse(r.context_json) as ThreadContext) : null,
    caller_key: (r.caller_key as string | null | undefined) ?? null,
  };
}

function toOutbox(r: Raw): OutboxRow {
  return {
    id: Number(r.id),
    thread_id: r.thread_id as string,
    kind: r.kind as OutboxKind,
    text: r.text as string,
    state: r.state as OutboxState,
    attempts: Number(r.attempts),
    next_at_ms: r.next_at_ms === null || r.next_at_ms === undefined ? null : Number(r.next_at_ms),
    last_error: (r.last_error as string | null) ?? null,
    created_at_ms: r.created_at_ms === null || r.created_at_ms === undefined ? null : Number(r.created_at_ms),
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    // T5c: databases created before caller_key existed.
    const cols = this.db.prepare("PRAGMA table_info(threads)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "caller_key")) this.db.exec("ALTER TABLE threads ADD COLUMN caller_key TEXT");
    if (!cols.some((c) => c.name === "agent_seen_ms")) this.db.exec("ALTER TABLE threads ADD COLUMN agent_seen_ms INTEGER");
    if (!cols.some((c) => c.name === "departed_at_ms")) this.db.exec("ALTER TABLE threads ADD COLUMN departed_at_ms INTEGER");
    // A crash mid-send leaves rows in `sending`; nobody else will pick them up, so queue them again.
    this.resetSendingOutbox();
  }

  close(): void {
    this.db.close();
  }

  /** Run fn inside BEGIN IMMEDIATE / COMMIT; rolls back on throw. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  log(e: LogEntry, nowIso: string): void {
    this.db
      .prepare(
        "INSERT INTO event_log (at, vendor_id, idem_key, contact, outcome, detail) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        nowIso,
        e.vendor_id,
        e.idem_key,
        e.contact,
        e.outcome,
        e.detail === undefined ? null : JSON.stringify(e.detail),
      );
  }

  readLog(limit = 100): Raw[] {
    return this.db.prepare("SELECT * FROM event_log ORDER BY id DESC LIMIT ?").all(limit) as Raw[];
  }

  // ---- threads ----

  insertThread(t: ThreadRow): void {
    this.db
      .prepare(
        `INSERT INTO threads (thread_id, vendor_id, token_hash, state, mode, customer, contact_keys,
           provider_ref, agent_count, created_at, updated_at_ms, closed_at_ms, context_json, caller_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.thread_id,
        t.vendor_id,
        t.token_hash,
        t.state,
        t.mode,
        JSON.stringify(t.customer),
        JSON.stringify(t.contact_keys),
        t.provider_ref,
        t.agent_count,
        t.created_at,
        t.updated_at_ms,
        t.closed_at_ms,
        t.context ? JSON.stringify(t.context) : null,
        t.caller_key ?? null,
      );
  }

  getThread(threadId: string): ThreadRow | null {
    const r = this.db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(threadId) as Raw | undefined;
    return r ? toThread(r) : null;
  }

  getThreadByProviderRef(providerRef: string): ThreadRow | null {
    const r = this.db.prepare("SELECT * FROM threads WHERE provider_ref = ?").get(providerRef) as Raw | undefined;
    return r ? toThread(r) : null;
  }

  /** Set state (and closed_at when closing) plus the agent message count. */
  updateThread(threadId: string, patch: { state: ThreadState; agent_count?: number; updated_at_ms: number }): void {
    const closed = patch.state === "closed" ? patch.updated_at_ms : null;
    this.db
      .prepare(
        `UPDATE threads SET state = ?, agent_count = COALESCE(?, agent_count), updated_at_ms = ?,
           closed_at_ms = CASE WHEN ? IS NULL THEN NULL ELSE COALESCE(closed_at_ms, ?) END
         WHERE thread_id = ?`,
      )
      .run(patch.state, patch.agent_count ?? null, patch.updated_at_ms, closed, closed, threadId);
  }

  /** The opener reached the channel. Counts as a change to the thread (updated_at_ms): from now on it can be matched to owner messages. */
  setProviderRef(threadId: string, providerRef: string, nowMs: number): void {
    this.db.prepare("UPDATE threads SET provider_ref = ?, updated_at_ms = ? WHERE thread_id = ?").run(providerRef, nowMs, threadId);
  }

  deleteThread(threadId: string): void {
    // ON DELETE CASCADE removes its messages, outbox rows and idempotency rows.
    this.db.prepare("DELETE FROM threads WHERE thread_id = ?").run(threadId);
  }

  /**
   * Not-closed threads of this vendor that share any of `keys` and whose requester confirmed them by email (T5c):
   * an unconfirmed question naming someone's address must not use up that person's per-contact cap.
   */
  countOpenThreads(vendorId: string, keys: string[]): number {
    const want = new Set(keys);
    const rows = this.db
      .prepare(
        `SELECT contact_keys FROM threads t WHERE vendor_id = ? AND state != 'closed'
           AND EXISTS (SELECT 1 FROM email_confirmations c WHERE c.thread_id = t.thread_id AND c.confirmed_at IS NOT NULL)`,
      )
      .all(vendorId) as { contact_keys: string }[];
    let n = 0;
    for (const r of rows) if ((JSON.parse(r.contact_keys) as string[]).some((k) => want.has(k))) n++;
    return n;
  }

  /**
   * When (ms) this vendor's threads sharing any of `keys`, asked at or after `sinceMs` and confirmed by their requester,
   * were asked; closed ones included. The hourly per-contact limit counts only these (an unconfirmed question naming
   * someone's address must not spend their quota).
   */
  confirmedThreadTimesSince(vendorId: string, keys: string[], sinceMs: number): number[] {
    const want = new Set(keys);
    const rows = this.db
      .prepare(
        `SELECT contact_keys, created_at FROM threads t WHERE vendor_id = ? AND created_at >= ?
           AND EXISTS (SELECT 1 FROM email_confirmations c WHERE c.thread_id = t.thread_id AND c.confirmed_at IS NOT NULL)`,
      )
      .all(vendorId, new Date(sinceMs).toISOString()) as { contact_keys: string; created_at: string }[];
    return rows.filter((r) => (JSON.parse(r.contact_keys) as string[]).some((k) => want.has(k))).map((r) => Date.parse(r.created_at));
  }

  /** Not-closed threads of this vendor that share any of `keys`. */
  listOpenThreadsForContact(vendorId: string, keys: string[]): ThreadRow[] {
    const want = new Set(keys);
    const rows = this.db.prepare("SELECT * FROM threads WHERE vendor_id = ? AND state != 'closed'").all(vendorId) as Raw[];
    return rows.map(toThread).filter((t) => t.contact_keys.some((k) => want.has(k)));
  }

  /** provider_ref of every not-closed two-way thread of this vendor whose opener reached the channel. */
  listOpenThreadRefs(vendorId: string): string[] {
    const rows = this.db
      .prepare("SELECT provider_ref FROM threads WHERE vendor_id = ? AND state != 'closed' AND mode = 'two_way' AND provider_ref IS NOT NULL")
      .all(vendorId) as Raw[];
    return rows.map((r) => r.provider_ref as string);
  }

  getChannelState(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM channel_state WHERE key = ?").get(key) as Raw | undefined;
    return r ? (r.value as string) : null;
  }

  setChannelState(key: string, value: string): void {
    this.db.prepare("INSERT INTO channel_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /**
   * Close idle threads: answered ones last touched before `answeredCutoffMs` (the owner replied
   * and the agent never came back), awaiting_owner ones before `awaitingCutoffMs`. Returns their ids.
   */
  expireIdleThreads(answeredCutoffMs: number, awaitingCutoffMs: number, nowMs: number): string[] {
    return this.tx(() => {
      const ids = (
        this.db
          .prepare(
            `SELECT thread_id FROM threads
             WHERE (state = 'answered' AND updated_at_ms < ?) OR (state = 'awaiting_owner' AND updated_at_ms < ?)`,
          )
          .all(answeredCutoffMs, awaitingCutoffMs) as Raw[]
      ).map((r) => r.thread_id as string);
      for (const id of ids) this.updateThread(id, { state: "closed", updated_at_ms: nowMs });
      return ids;
    });
  }

  /** Delete threads closed before `cutoffMs` (and everything hanging off them). Returns rows removed. */
  purgeClosedThreads(cutoffMs: number): number {
    return this.tx(() => {
      // Resume tokens die with their thread (the FK cascades too; this keeps it explicit).
      this.db
        .prepare("DELETE FROM resume_tokens WHERE thread_id IN (SELECT thread_id FROM threads WHERE state = 'closed' AND closed_at_ms < ?)")
        .run(cutoffMs);
      const r = this.db.prepare("DELETE FROM threads WHERE state = 'closed' AND closed_at_ms < ?").run(cutoffMs);
      return Number(r.changes);
    });
  }

  /** T6: store one resume token's sha256 hash (hex). The token itself is never stored. */
  insertResumeToken(threadId: string, tokenHashHex: string, createdAtMs: number): void {
    this.db.prepare("INSERT INTO resume_tokens (thread_id, token_hash, created_at) VALUES (?, ?, ?)").run(threadId, tokenHashHex, createdAtMs);
  }

  /** T6: every resume-token hash (hex) of a thread; all stay valid until the thread is purged. */
  listResumeTokenHashes(threadId: string): string[] {
    return (this.db.prepare("SELECT token_hash FROM resume_tokens WHERE thread_id = ? ORDER BY rowid").all(threadId) as Raw[]).map((r) => r.token_hash as string);
  }

  /** Insert a message. Returns null when provider_msg_id was already stored (redelivered event). */
  insertThreadMessage(m: Omit<ThreadMessageRow, "id">): number | null {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO thread_messages (thread_id, author, text, provider_msg_id, at) VALUES (?, ?, ?, ?, ?)")
      .run(m.thread_id, m.author, m.text, m.provider_msg_id, m.at);
    return Number(r.changes) === 0 ? null : Number(r.lastInsertRowid);
  }

  hasProviderMessage(providerMsgId: string): boolean {
    return this.db.prepare("SELECT 1 AS x FROM thread_messages WHERE provider_msg_id = ?").get(providerMsgId) !== undefined;
  }

  deleteThreadMessage(id: number): void {
    this.db.prepare("DELETE FROM thread_messages WHERE id = ?").run(id);
  }

  listThreadMessages(threadId: string): ThreadMessageRow[] {
    return (this.db.prepare("SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY id").all(threadId) as Raw[]).map((r) => ({
      id: Number(r.id),
      thread_id: r.thread_id as string,
      author: r.author as "agent" | "owner",
      text: r.text as string,
      provider_msg_id: (r.provider_msg_id as string | null) ?? null,
      at: r.at as string,
    }));
  }

  insertOutbox(o: { thread_id: string; kind: OutboxKind; text: string; state: OutboxState; attempts: number; next_at_ms: number | null }, nowIso: string): number {
    const r = this.db
      .prepare(
        "INSERT INTO owner_outbox (thread_id, kind, text, state, attempts, next_at_ms, last_error, updated_at, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
      )
      .run(o.thread_id, o.kind, o.text, o.state, o.attempts, o.next_at_ms, nowIso, Date.parse(nowIso));
    return Number(r.lastInsertRowid);
  }

  getOutbox(id: number): OutboxRow | null {
    const r = this.db.prepare("SELECT * FROM owner_outbox WHERE id = ?").get(id) as Raw | undefined;
    return r ? toOutbox(r) : null;
  }

  deleteOutbox(id: number): void {
    this.db.prepare("DELETE FROM owner_outbox WHERE id = ?").run(id);
  }

  updateOutbox(id: number, patch: { state: OutboxState; next_at_ms?: number | null; last_error?: string | null }, nowIso: string): void {
    this.db
      .prepare("UPDATE owner_outbox SET state = ?, next_at_ms = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(patch.state, patch.next_at_ms ?? null, patch.last_error ?? null, nowIso, id);
  }

  /**
   * Claim queued rows that are due: flip them to `sending` and count the attempt, in one
   * transaction, so an in-request send and a sweep never pick the same row.
   */
  claimDueOutbox(nowMs: number, limit: number, nowIso: string): OutboxRow[] {
    return this.tx(() => {
      const rows = (
        this.db.prepare("SELECT * FROM owner_outbox WHERE state = 'queued' AND next_at_ms <= ? ORDER BY id LIMIT ?").all(nowMs, limit) as Raw[]
      ).map(toOutbox);
      const flip = this.db.prepare("UPDATE owner_outbox SET state = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ?");
      for (const r of rows) flip.run(nowIso, r.id);
      return rows.map((r) => ({ ...r, state: "sending" as const, attempts: r.attempts + 1 }));
    });
  }

  /** Put a claimed row back without spending its attempt (it is waiting on its thread's opener). */
  deferOutbox(id: number, nextAtMs: number, nowIso: string): void {
    this.db
      .prepare("UPDATE owner_outbox SET state = 'queued', attempts = attempts - 1, next_at_ms = ?, updated_at = ? WHERE id = ?")
      .run(nextAtMs, nowIso, id);
  }

  /** Make every queued row due now (the channel reconnected). Returns how many were waiting. */
  expediteOutbox(nowMs: number): number {
    const r = this.db.prepare("UPDATE owner_outbox SET next_at_ms = ? WHERE state = 'queued' AND (next_at_ms IS NULL OR next_at_ms > ?)").run(nowMs, nowMs);
    return Number(r.changes);
  }

  listOutbox(threadId: string): OutboxRow[] {
    return (this.db.prepare("SELECT * FROM owner_outbox WHERE thread_id = ? ORDER BY id").all(threadId) as Raw[]).map(toOutbox);
  }

  resetSendingOutbox(): number {
    const r = this.db.prepare("UPDATE owner_outbox SET state = 'queued', next_at_ms = COALESCE(next_at_ms, 0) WHERE state = 'sending'").run();
    return Number(r.changes);
  }

  outboxCounts(): { queued: number; failed: number } {
    const rows = this.db
      .prepare("SELECT state, COUNT(*) AS n FROM owner_outbox WHERE state IN ('queued', 'sending', 'failed') GROUP BY state")
      .all() as { state: string; n: number }[];
    let queued = 0;
    let failed = 0;
    for (const r of rows) {
      if (r.state === "failed") failed += Number(r.n);
      else queued += Number(r.n);
    }
    return { queued, failed };
  }

  /** Claim an idempotency key. Returns false when the key already has a row. */
  claimMessageRequest(r: Omit<MessageRequestRow, "response">, nowIso: string): boolean {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO message_requests (vendor_id, idem_key, request_hash, thread_id, response, created_at) VALUES (?, ?, ?, ?, NULL, ?)")
      .run(r.vendor_id, r.idem_key, r.request_hash, r.thread_id, nowIso);
    return Number(res.changes) === 1;
  }

  getMessageRequest(vendorId: string, idemKey: string): MessageRequestRow | null {
    const r = this.db.prepare("SELECT * FROM message_requests WHERE vendor_id = ? AND idem_key = ?").get(vendorId, idemKey) as Raw | undefined;
    if (!r) return null;
    return {
      vendor_id: r.vendor_id as string,
      idem_key: r.idem_key as string,
      request_hash: r.request_hash as string,
      thread_id: r.thread_id as string,
      response: r.response ? (JSON.parse(r.response as string) as unknown) : null,
    };
  }

  setMessageResponse(vendorId: string, idemKey: string, response: unknown): void {
    this.db.prepare("UPDATE message_requests SET response = ? WHERE vendor_id = ? AND idem_key = ?").run(JSON.stringify(response), vendorId, idemKey);
  }

  deleteMessageRequest(vendorId: string, idemKey: string): void {
    this.db.prepare("DELETE FROM message_requests WHERE vendor_id = ? AND idem_key = ?").run(vendorId, idemKey);
  }

  // ---- T5c: unconfirmed questions per caller ----

  /** Not-closed threads this caller opened that no requester has confirmed by email. */
  countUnconfirmedOpenThreadsByCaller(vendorId: string, callerKey: string): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM threads t WHERE vendor_id = ? AND state != 'closed' AND caller_key = ?
           AND state = 'awaiting_owner'
           AND NOT EXISTS (SELECT 1 FROM email_confirmations c WHERE c.thread_id = t.thread_id AND c.confirmed_at IS NOT NULL)`,
      )
      .get(vendorId, callerKey) as { n: number };
    return Number(r.n);
  }

  // ---- Agent presence: who is still listening for a reply ----

  /** An agent read this thread now; it is listening again, so a later departure is handled afresh. */
  touchAgentSeen(threadId: string, nowMs: number): void {
    this.db.prepare("UPDATE threads SET agent_seen_ms = ?, departed_at_ms = NULL WHERE thread_id = ?").run(nowMs, threadId);
  }

  markDeparted(threadId: string, nowMs: number): void {
    this.db.prepare("UPDATE threads SET departed_at_ms = ? WHERE thread_id = ?").run(nowMs, threadId);
  }

  /**
   * Open threads whose agent stopped reading before it got everything: still waiting for support, or holding
   * support replies the agent never received nor any email carried. Departure not handled yet, no confirm link yet.
   */
  listDepartedThreads(lastSeenBeforeMs: number, limit: number): ThreadRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM threads t WHERE state != 'closed' AND mode = 'two_way'
             AND agent_seen_ms IS NOT NULL AND agent_seen_ms < ? AND departed_at_ms IS NULL
             AND (state = 'awaiting_owner' OR EXISTS (SELECT 1 FROM thread_messages m WHERE m.thread_id = t.thread_id
                    AND m.author = 'owner' AND m.delivered_at IS NULL AND m.emailed_at IS NULL))
             AND NOT EXISTS (SELECT 1 FROM email_confirmations c WHERE c.thread_id = t.thread_id)
           ORDER BY agent_seen_ms LIMIT ?`,
        )
        .all(lastSeenBeforeMs, limit) as Raw[]
    ).map(toThread);
  }

  // ---- T5b: read signal and reply emails ----

  /** The agent received these owner messages (a 200 GET /api/threads/:id finished sending). Sets delivered_at once. */
  markMessagesDelivered(threadId: string, ids: number[], nowMs: number): void {
    const q = this.db.prepare("UPDATE thread_messages SET delivered_at = ? WHERE id = ? AND thread_id = ? AND author = 'owner' AND delivered_at IS NULL");
    for (const id of ids) q.run(nowMs, id, threadId);
  }

  /** Owner messages the agent has not received and no email has carried yet. */
  listUnsentOwnerMessages(threadId: string): ThreadMessageRow[] {
    return (
      this.db
        .prepare("SELECT * FROM thread_messages WHERE thread_id = ? AND author = 'owner' AND delivered_at IS NULL AND emailed_at IS NULL ORDER BY id")
        .all(threadId) as Raw[]
    ).map((r) => ({
      id: Number(r.id),
      thread_id: r.thread_id as string,
      author: "owner" as const,
      text: r.text as string,
      provider_msg_id: (r.provider_msg_id as string | null) ?? null,
      at: r.at as string,
    }));
  }

  /** Delivery marks of one message (tests and diagnostics). */
  messageMarks(id: number): { delivered_at: number | null; emailed_at: number | null } {
    const r = this.db.prepare("SELECT delivered_at, emailed_at FROM thread_messages WHERE id = ?").get(id) as Raw | undefined;
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return { delivered_at: n(r?.delivered_at), emailed_at: n(r?.emailed_at) };
  }

  markMessagesEmailed(ids: number[], nowMs: number): void {
    const q = this.db.prepare("UPDATE thread_messages SET emailed_at = ? WHERE id = ?");
    for (const id of ids) q.run(nowMs, id);
  }

  /** When this thread's last reply email went out, or null. */
  lastEmailedMs(threadId: string): number | null {
    const r = this.db.prepare("SELECT MAX(emailed_at) AS m FROM thread_messages WHERE thread_id = ?").get(threadId) as Raw | undefined;
    return r?.m === null || r?.m === undefined ? null : Number(r.m);
  }

  getRequesterEmail(threadId: string): RequesterEmailRow | null {
    const r = this.db.prepare("SELECT * FROM requester_emails WHERE thread_id = ?").get(threadId) as Raw | undefined;
    return r ? toRequesterEmail(r) : null;
  }

  /** Insert or replace the thread's one pending row (attempts reset). */
  upsertRequesterEmail(threadId: string, dueAtMs: number): void {
    this.db
      .prepare(
        `INSERT INTO requester_emails (thread_id, due_at_ms, attempts, state, last_error) VALUES (?, ?, 0, 'pending', NULL)
         ON CONFLICT (thread_id) DO UPDATE SET due_at_ms = excluded.due_at_ms, attempts = 0, state = 'pending', last_error = NULL`,
      )
      .run(threadId, dueAtMs);
  }

  updateRequesterEmail(threadId: string, patch: { state: RequesterEmailState; due_at_ms?: number; attempts?: number; last_error?: string | null }): void {
    this.db
      .prepare(
        "UPDATE requester_emails SET state = ?, due_at_ms = COALESCE(?, due_at_ms), attempts = COALESCE(?, attempts), last_error = ? WHERE thread_id = ?",
      )
      .run(patch.state, patch.due_at_ms ?? null, patch.attempts ?? null, patch.last_error ?? null, threadId);
  }

  deleteRequesterEmail(threadId: string): void {
    this.db.prepare("DELETE FROM requester_emails WHERE thread_id = ?").run(threadId);
  }

  /** Pending rows that are due, oldest first. */
  dueRequesterEmails(nowMs: number, limit: number): RequesterEmailRow[] {
    return (
      this.db.prepare("SELECT * FROM requester_emails WHERE state = 'pending' AND due_at_ms <= ? ORDER BY due_at_ms LIMIT ?").all(nowMs, limit) as Raw[]
    ).map(toRequesterEmail);
  }

  /** Held rows (address not verified yet) of threads asked with this email: due now. Returns how many. */
  releaseHeldRequesterEmails(email: string, nowMs: number): number {
    const key = JSON.stringify(`e:${email.toLowerCase()}`);
    const r = this.db
      .prepare(
        `UPDATE requester_emails SET state = 'pending', due_at_ms = ? WHERE state = 'held'
           AND thread_id IN (SELECT thread_id FROM threads WHERE instr(contact_keys, ?) > 0)`,
      )
      .run(nowMs, key);
    return Number(r.changes);
  }

  // ---- T5b: per-question confirm links and verified addresses ----

  insertConfirmation(c: { thread_id: string; address: string; token_hash: string; expires_at_ms: number }): void {
    this.db
      .prepare("INSERT INTO email_confirmations (thread_id, address, token_hash, expires_at_ms, confirmed_at) VALUES (?, ?, ?, ?, NULL)")
      .run(c.thread_id, c.address, c.token_hash, c.expires_at_ms);
  }

  getConfirmation(tokenHash: string): ConfirmationRow | null {
    const r = this.db.prepare("SELECT * FROM email_confirmations WHERE token_hash = ?").get(tokenHash) as Raw | undefined;
    if (!r) return null;
    return {
      thread_id: r.thread_id as string,
      address: r.address as string,
      expires_at_ms: Number(r.expires_at_ms),
      confirmed_at: r.confirmed_at === null || r.confirmed_at === undefined ? null : Number(r.confirmed_at),
    };
  }

  /** Single use: true only for the call that set confirmed_at. */
  markConfirmed(tokenHash: string, nowMs: number): boolean {
    const r = this.db.prepare("UPDATE email_confirmations SET confirmed_at = ? WHERE token_hash = ? AND confirmed_at IS NULL").run(nowMs, tokenHash);
    return Number(r.changes) === 1;
  }

  isThreadConfirmed(threadId: string): boolean {
    return this.db.prepare("SELECT 1 AS x FROM email_confirmations WHERE thread_id = ? AND confirmed_at IS NOT NULL").get(threadId) !== undefined;
  }

  /** Confirm links created after `sinceMs` (from their expiry and the link lifetime), for one address or (null) all. */
  countConfirmationsSince(address: string | null, sinceMs: number, linkMs: number): number {
    const r = (
      address === null
        ? this.db.prepare("SELECT COUNT(*) AS n FROM email_confirmations WHERE expires_at_ms - ? > ?").get(linkMs, sinceMs)
        : this.db.prepare("SELECT COUNT(*) AS n FROM email_confirmations WHERE address = ? AND expires_at_ms - ? > ?").get(address, linkMs, sinceMs)
    ) as { n: number };
    return Number(r.n);
  }

  setVerifiedAddress(address: string, nowMs: number): void {
    this.db
      .prepare("INSERT INTO verified_addresses (address, verified_at) VALUES (?, ?) ON CONFLICT (address) DO UPDATE SET verified_at = excluded.verified_at")
      .run(address, nowMs);
  }

  verifiedAt(address: string): number | null {
    const r = this.db.prepare("SELECT verified_at FROM verified_addresses WHERE address = ?").get(address) as Raw | undefined;
    return r ? Number(r.verified_at) : null;
  }
}

/** pending: waiting for its due time; held: due, but the address is not verified yet (released on confirm); sending; failed: gave up. */
export type RequesterEmailState = "pending" | "held" | "sending" | "failed";

export interface RequesterEmailRow {
  thread_id: string;
  due_at_ms: number;
  attempts: number;
  state: RequesterEmailState;
  last_error: string | null;
}

function toRequesterEmail(r: Raw): RequesterEmailRow {
  return {
    thread_id: r.thread_id as string,
    due_at_ms: Number(r.due_at_ms),
    attempts: Number(r.attempts),
    state: r.state as RequesterEmailState,
    last_error: (r.last_error as string | null) ?? null,
  };
}

export interface ConfirmationRow {
  thread_id: string;
  address: string;
  expires_at_ms: number;
  confirmed_at: number | null;
}

export function openStore(path: string): Store {
  return new Store(path);
}
