import { afterEach, describe, expect, it } from "vitest";
import { createSlackChannel, slackOwnerChannel, type SlackOwnerOptions } from "../src/connectors/slack.js";
import type { WebSocketLike } from "../src/connectors/slack-socket.js";
import { ConnectorError, type ChannelContext, type OwnerInboundMessage, type OwnerMessageHandler } from "../src/connectors/types.js";

const CHANNEL = "C0123";
type Call = { method: string; token: string; params: URLSearchParams };
type Reply = Response | Error | ((c: Call) => Response | Error);

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });

/** Scripted Slack Web API: each method answers from its queue (last entry repeats), every call is recorded. */
function slackApi(routes: Record<string, Reply[]>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const method = String(url).replace("https://slack.com/api/", "");
    const call = { method, token: String((init?.headers as Record<string, string>).authorization).replace("Bearer ", ""), params: new URLSearchParams(String(init?.body)) };
    calls.push(call);
    const q = routes[method];
    if (!q?.length) throw new Error(`unscripted Slack method ${method}`);
    let r = q.length > 1 ? q.shift()! : q[0]!;
    if (typeof r === "function") r = r(call);
    if (r instanceof Error) throw r;
    return r.clone();
  };
  return { calls, fetchImpl, of: (m: string) => calls.filter((c) => c.method === m) };
}

/** In-process fake Socket Mode server: every `new WebSocket(url)` is a connection the test drives. */
class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = [];
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  sent: unknown[] = [];
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.onclose?.({ code: 1000 }));
  }
  /** Server side: push one frame. */
  push(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  hello() {
    this.push({ type: "hello" });
  }
}

const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 500) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await wait(2);
  }
};

const okConnect = (c: Call) => json({ ok: true, url: `wss://fake/${c.token}/${Math.random()}` });

function channel(routes: Record<string, Reply[]>, extra: Partial<SlackOwnerOptions> = {}) {
  const api = slackApi({ "apps.connections.open": [okConnect], "chat.postMessage": [json({ ok: true, ts: "1700000000.000100" })], "reactions.add": [json({ ok: true })], ...routes });
  const logs: string[] = [];
  const ch = slackOwnerChannel({
    botToken: "xoxb-bot",
    appToken: "xapp-app",
    channelId: CHANNEL,
    fetch: api.fetchImpl,
    WebSocket: FakeSocket,
    warn: (m) => logs.push(m),
    minBackoffMs: 1,
    maxBackoffMs: 4,
    helloTimeoutMs: 200,
    ...extra,
  });
  return { ch, api, logs };
}

/** Starts the channel against the fake server and returns the live socket. */
async function connected(ch: ReturnType<typeof channel>["ch"]) {
  const before = FakeSocket.all.length;
  const started = ch.start();
  await until(() => FakeSocket.all.length > before);
  const sock = FakeSocket.all.at(-1)!;
  sock.hello();
  await started;
  return sock;
}

const ownerEvent = (envelope_id: string, event: Record<string, unknown>) => ({
  type: "events_api",
  envelope_id,
  payload: { event: { type: "message", channel: CHANNEL, thread_ts: "1700000000.000100", ts: "1700000050.000200", user: "U_OWNER", text: "Yes, 3pm works", ...event } },
});

async function expectCode(p: Promise<unknown>, code: string, text?: RegExp) {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(ConnectorError);
  expect((e as ConnectorError).code).toBe(code);
  if (text) expect((e as Error).message).toMatch(text);
  return e as ConnectorError;
}

const live: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((c) => c.stop()));
});

describe("slack REST", () => {
  it("openThread posts to the channel and returns the message ts as provider_ref; postToThread replies in the thread", async () => {
    const { ch, api } = channel({});
    expect(await ch.openThread({ thread_id: "t_1", text: "Jane Doe (+1 202 555 0199) asks: open Sunday?" })).toEqual({ provider_ref: "1700000000.000100" });
    await ch.postToThread("1700000000.000100", "follow-up");
    const [open, reply] = api.of("chat.postMessage");
    expect(open!.token).toBe("xoxb-bot");
    expect(Object.fromEntries(open!.params)).toEqual({ channel: CHANNEL, text: "Jane Doe (+1 202 555 0199) asks: open Sunday?", unfurl_links: "false", unfurl_media: "false" });
    expect(reply!.params.get("thread_ts")).toBe("1700000000.000100");
  });

  it("a post carries its dedupe key as message metadata, and findPosted reads it back from the channel or the thread", async () => {
    const meta = (key: string) => ({ event_type: "gateway_outbox", event_payload: { key } });
    const { ch, api } = channel({
      "auth.test": [json({ ok: true, bot_id: "B1" })],
      "conversations.history": [json({ ok: true, messages: [{ ts: "1700000003.000100", bot_id: "B_OTHER", metadata: meta("t_1:1") }, { ts: "1700000001.000100", bot_id: "B1", metadata: meta("t_1:1") }, { ts: "1700000000.000900", user: "U1", text: "hi" }] })],
      "conversations.replies": [json({ ok: true, messages: [{ ts: "1700000001.000100", bot_id: "B1", metadata: meta("t_1:1") }, { ts: "1700000002.000100", bot_id: "B1", metadata: meta("t_1:2") }] })],
    });
    await ch.openThread({ thread_id: "t_1", text: "x", dedupe_key: "t_1:1" });
    expect(JSON.parse(api.of("chat.postMessage")[0]!.params.get("metadata")!)).toEqual(meta("t_1:1"));

    // Another app's message with the same key is not ours.
    expect(await ch.findPosted({ dedupe_key: "t_1:1", since_ms: 1_700_000_000_000 })).toBe("1700000001.000100");
    expect(await ch.findPosted({ dedupe_key: "t_1:7", since_ms: 1_700_000_000_000 })).toBeNull();
    expect(Object.fromEntries(api.of("conversations.history")[0]!.params)).toEqual({ channel: CHANNEL, limit: "200", oldest: "1699999940.000000", include_all_metadata: "true" });

    expect(await ch.findPosted({ dedupe_key: "t_1:2", provider_ref: "1700000001.000100", since_ms: 1_700_000_000_000 })).toBe("1700000002.000100");
    expect(api.of("conversations.replies")[0]!.params.get("ts")).toBe("1700000001.000100");
    expect(api.of("conversations.replies")[0]!.params.get("include_all_metadata")).toBe("true");
  });

  it("a failed findPosted read throws like a failed send, so the core does not post", async () => {
    const auth = { "auth.test": [json({ ok: true, bot_id: "B1" })] };
    await expectCode(channel({ ...auth, "conversations.history": [new Response("", { status: 503 })] }).ch.findPosted({ dedupe_key: "k", since_ms: 0 }), "channel_unavailable");
    // A range too large to read in full is a failure, not "not found".
    const endless = json({ ok: true, messages: [{ ts: "1.1", user: "U1", text: "x" }], has_more: true, response_metadata: { next_cursor: "more" } });
    await expectCode(channel({ ...auth, "conversations.history": [endless] }).ch.findPosted({ dedupe_key: "k", since_ms: 0 }), "channel_unavailable", /more than 2000 messages/);
  });

  it("escapes Slack control sequences in everything it posts so customer text cannot ping or fake a mention", async () => {
    const { ch, api } = channel({});
    await ch.openThread({ thread_id: "t", text: "<!channel> <@U1> &" });
    await ch.postToThread("1.1", "<!channel> <@U1> &");
    await ch.notify("<!channel> <@U1> &");
    const posts = api.of("chat.postMessage");
    expect(posts).toHaveLength(3);
    for (const p of posts) {
      expect(p.params.get("text")).toBe("&lt;!channel&gt; &lt;@U1&gt; &amp;");
      expect([p.params.get("unfurl_links"), p.params.get("unfurl_media")]).toEqual(["false", "false"]);
    }
  });

  it("429 uses Retry-After; 5xx and timeouts are channel_unavailable with a default retry", async () => {
    const r429 = await expectCode(channel({ "chat.postMessage": [new Response("", { status: 429, headers: { "retry-after": "12" } })] }).ch.openThread({ thread_id: "t", text: "x" }), "channel_unavailable");
    expect(r429.retry_after_s).toBe(12);
    const r503 = await expectCode(channel({ "chat.postMessage": [new Response("", { status: 503 })] }).ch.postToThread("1.2", "x"), "channel_unavailable");
    expect(r503.retry_after_s).toBe(30);
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    await expectCode(channel({ "chat.postMessage": [timeout] }).ch.openThread({ thread_id: "t", text: "x" }), "channel_unavailable", /timed out/);
    await expectCode(channel({ "chat.postMessage": [json({ ok: false, error: "internal_error" })] }).ch.openThread({ thread_id: "t", text: "x" }), "channel_unavailable");
  });

  it("setup errors are channel_auth_failed with a fix hint", async () => {
    const cases: Array<[string, RegExp]> = [
      ["invalid_auth", /SLACK_BOT_TOKEN is wrong.*xoxb-/],
      ["not_in_channel", /\/invite @<your app>/],
      ["channel_not_found", /SLACK_CHANNEL_ID/],
      ["is_archived", /archived: unarchive/],
      ["missing_scope", /lacks a scope \(chat:write\).*Reinstall to Workspace/],
    ];
    for (const [error, hint] of cases) {
      const { ch } = channel({ "chat.postMessage": [json({ ok: false, error, needed: "chat:write" })] });
      await expectCode(ch.openThread({ thread_id: "t", text: "x" }), "channel_auth_failed", hint);
    }
  });

  it("an unknown Slack error is channel_rejected (permanent, not queued)", async () => {
    await expectCode(channel({ "chat.postMessage": [json({ ok: false, error: "msg_too_long" })] }).ch.openThread({ thread_id: "t", text: "x" }), "channel_rejected", /msg_too_long/);
  });

  it("notify logs a failure instead of throwing; acknowledge adds a reaction and never throws", async () => {
    const { ch, api, logs } = channel({ "chat.postMessage": [json({ ok: false, error: "invalid_auth" })], "reactions.add": [json({ ok: false, error: "already_reacted" }), new Error("down")] });
    await expect(ch.notify("Notice for support: Jane Doe")).resolves.toBeUndefined();
    expect(logs[0]).toMatch(/owner notice to Slack failed.*invalid_auth/);
    await ch.acknowledge("1.1", "1.2");
    await ch.acknowledge("1.1", "1.3");
    expect(Object.fromEntries(api.of("reactions.add")[0]!.params)).toEqual({ channel: CHANNEL, timestamp: "1.2", name: "white_check_mark" });
    expect(logs).toHaveLength(2); // already_reacted is silent, the network error is logged
  });
});

describe("slack checkAccess", () => {
  const ok = { "auth.test": [json({ ok: true })], "conversations.info": [json({ ok: true, channel: { is_member: true } })] };

  it("passes when the bot token, channel and app token all work", async () => {
    const { ch, api } = channel(ok);
    await ch.checkAccess();
    expect(api.of("apps.connections.open")[0]!.token).toBe("xapp-app");
  });

  it("names the fix for each of the three setup parts", async () => {
    await expectCode(channel({ ...ok, "auth.test": [json({ ok: false, error: "invalid_auth" })] }).ch.checkAccess(), "channel_auth_failed", /SLACK_BOT_TOKEN/);
    await expectCode(channel({ ...ok, "conversations.info": [json({ ok: true, channel: { is_member: false } })] }).ch.checkAccess(), "channel_auth_failed", /\/invite/);
    await expectCode(channel({ ...ok, "apps.connections.open": [json({ ok: false, error: "invalid_auth" })] }).ch.checkAccess(), "channel_auth_failed", /SLACK_APP_TOKEN must be an app-level token \(xapp-/);
  });
});

describe("slack Socket Mode", () => {
  function withHandler(result: Awaited<ReturnType<OwnerMessageHandler>> | Error, extra: Partial<SlackOwnerOptions> = {}) {
    const c = channel({}, extra);
    const got: OwnerInboundMessage[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    c.ch.onOwnerMessage(async (m) => {
      got.push(m);
      await gate;
      if (result instanceof Error) throw result;
      return result;
    });
    live.push(c.ch);
    return { ...c, got, release };
  }

  it("start resolves on hello; the envelope is acked only after the handler resolves, and no reaction unless the core calls acknowledge", async () => {
    const { ch, api, got, release } = withHandler("accepted");
    const sock = await connected(ch);
    expect(ch.status()).toEqual({ connected: true });
    sock.push(ownerEvent("env-1", {}));
    await until(() => got.length === 1);
    expect(got[0]).toEqual({ provider_ref: "1700000000.000100", provider_msg_id: "1700000050.000200", user_id: "U_OWNER", text: "Yes, 3pm works" });
    await wait();
    expect(sock.sent).toEqual([]); // handler still running
    release();
    await until(() => sock.sent.length === 1);
    expect(sock.sent).toEqual([{ envelope_id: "env-1" }]);
    await wait(10);
    expect(api.of("reactions.add")).toEqual([]); // the core's acknowledge() is the only path to the reaction
  });

  it("a handler throw (storage failure) leaves the envelope un-acked so Slack redelivers", async () => {
    const { ch, got, release, logs } = withHandler(new Error("SQLITE_BUSY"));
    const sock = await connected(ch);
    release();
    sock.push(ownerEvent("env-2", {}));
    await until(() => got.length === 1);
    await until(() => logs.some((l) => l.includes("not acknowledged")));
    expect(sock.sent).toEqual([]);
  });

  it("messages with a subtype, a bot_id, or another channel are acked and never reach the handler, in a thread or top-level", async () => {
    const { ch, got, release } = withHandler("accepted");
    release();
    const sock = await connected(ch);
    sock.push(ownerEvent("e1", { subtype: "message_changed" }));
    sock.push(ownerEvent("e2", { bot_id: "B1" }));
    sock.push(ownerEvent("e3", { channel: "C_OTHER" }));
    sock.push(ownerEvent("e4", { thread_ts: undefined, subtype: "channel_join" }));
    sock.push(ownerEvent("e5", { thread_ts: undefined, bot_id: "B1" }));
    await until(() => sock.sent.length === 5);
    expect(got).toEqual([]);
  });

  it("a top-level post is never passed to the core and gets no notice, even from an allowlisted owner (R4)", async () => {
    const { ch, api, got, release } = withHandler("accepted", { ownerUserIds: ["U_OWNER"] });
    release();
    const sock = await connected(ch);
    sock.push(ownerEvent("e1", { thread_ts: undefined, user: "U_OWNER", ts: "4.1", text: "Internal: refund this one" }));
    sock.push(ownerEvent("e2", { thread_ts: undefined, user: "U_STRANGER", ts: "4.2" }));
    await until(() => sock.sent.length === 2);
    await wait(10);
    expect(got).toEqual([]);
    expect(api.of("chat.postMessage")).toEqual([]);
  });

  it("runs the core's connect hook on every hello, so queued questions go out on reconnect", async () => {
    const { ch } = withHandler("accepted");
    let hellos = 0;
    ch.onConnected(() => void hellos++);
    const first = await connected(ch);
    expect(hellos).toBe(1);
    first.push({ type: "disconnect", reason: "refresh_requested" });
    await until(() => FakeSocket.all.at(-1) !== first);
    FakeSocket.all.at(-1)!.hello();
    await until(() => hellos === 2);
  });

  it('"close" is passed through as text; the core decides what it means', async () => {
    const { ch, got, release } = withHandler("accepted");
    release();
    const sock = await connected(ch);
    sock.push(ownerEvent("e1", { text: "close" }));
    await until(() => got.length === 1);
    expect(got[0]!.text).toBe("close");
  });

  it("unescapes Slack entities so the agent reads what the owner typed", async () => {
    const { ch, got, release } = withHandler("accepted");
    release();
    const sock = await connected(ch);
    sock.push(ownerEvent("e1", { text: "3 &lt; 4 &amp; 5 &gt; 2" }));
    await until(() => got.length === 1);
    expect(got[0]!.text).toBe("3 < 4 & 5 > 2");
  });

  it("with an owner allowlist a stranger gets one notice per thread and is not passed on", async () => {
    const { ch, api, got, release } = withHandler("accepted", { ownerUserIds: ["U_OWNER"] });
    release();
    const sock = await connected(ch);
    sock.push(ownerEvent("e1", { user: "U_STRANGER", ts: "1.1" }));
    sock.push(ownerEvent("e2", { user: "U_STRANGER", ts: "1.2" }));
    await until(() => sock.sent.length === 2);
    await wait(10);
    expect(got).toEqual([]);
    const notices = api.of("chat.postMessage");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.params.get("thread_ts")).toBe("1700000000.000100");
    expect(notices[0]!.params.get("text")).toMatch(/Only the business owner/);
  });

  it("a rejected reply (closed thread) gets one in-thread notice and is acked", async () => {
    const { ch, api, release } = withHandler("rejected:thread_closed");
    release();
    const sock = await connected(ch);
    sock.push(ownerEvent("e1", { ts: "2.1" }));
    sock.push(ownerEvent("e2", { ts: "2.2" }));
    await until(() => sock.sent.length === 2);
    await wait(10);
    expect(api.of("chat.postMessage").map((c) => c.params.get("text"))).toEqual(["This conversation is closed, so the agent will not see this reply."]);
  });

  it("any other rejection reason gets a generic notice naming it", async () => {
    const { ch, api, release } = withHandler("rejected:thread_limit_reached");
    release();
    const sock = await connected(ch);
    sock.push(ownerEvent("e1", { ts: "3.1" }));
    await until(() => sock.sent.length === 1);
    await wait(10);
    expect(api.of("chat.postMessage").map((c) => c.params.get("text"))).toEqual(["This reply was not passed to the agent (thread_limit_reached)."]);
  });

  describe("catch-up after a gap", () => {
    const OPENER = "1700000000.000100";
    function gapped(routes: Record<string, Reply[]>, cursor: string | null = "1700000040.000000", refs: string[] = [OPENER]) {
      const c = channel(routes, { backfillRetryMs: 5 });
      const got: OwnerInboundMessage[] = [];
      const state = { cursor };
      const ctx: ChannelContext = { openThreadRefs: () => refs, getCursor: () => state.cursor, setCursor: (v) => void (state.cursor = v) };
      c.ch.onOwnerMessage(async (m) => (got.push(m), "accepted"), ctx);
      live.push(c.ch);
      return { ...c, got, state };
    }
    const replies = json({
      ok: true,
      messages: [
        { ts: OPENER, bot_id: "B1", text: "New message" },
        { ts: "1700000090.000300", thread_ts: OPENER, user: "U_OWNER", text: "And bring the vaccination card" },
        { ts: "1700000060.000200", thread_ts: OPENER, user: "U_OWNER", text: "Yes &amp; we have a slot at 3pm" },
      ],
    });
    it("on hello, thread replies typed while disconnected reach the handler once each, oldest first, before start resolves; top-level history is not read", async () => {
      const { ch, api, got, state } = gapped({ "conversations.replies": [replies] });
      await connected(ch);
      expect(got).toEqual([
        { provider_ref: OPENER, provider_msg_id: "1700000060.000200", user_id: "U_OWNER", text: "Yes & we have a slot at 3pm", backfilled: true, sent_at_ms: 1700000060000 },
        { provider_ref: OPENER, provider_msg_id: "1700000090.000300", user_id: "U_OWNER", text: "And bring the vaccination card", backfilled: true, sent_at_ms: 1700000090000 },
      ]);
      expect(state.cursor).toBe("1700000090.000300");
      expect(api.of("conversations.history")).toEqual([]);
      // Read from the cursor minus the overlap, but never from before the oldest open thread.
      expect(Object.fromEntries(api.of("conversations.replies")[0]!.params)).toMatchObject({ channel: CHANNEL, ts: OPENER, oldest: "1700000000.000100" });
    });

    it("a live event moves the cursor, and the next hello reads from there", async () => {
      const { ch, api, state } = gapped({ "conversations.replies": [json({ ok: true, messages: [] })] }, null);
      const first = await connected(ch);
      expect(api.of("conversations.replies")[0]!.params.get("oldest")).toBe("1700000000.000100"); // no cursor yet: the oldest open thread
      first.push(ownerEvent("e1", { ts: "1700000500.000200" }));
      await until(() => first.sent.length === 1);
      expect(state.cursor).toBe("1700000500.000200");
      first.push({ type: "disconnect", reason: "refresh_requested" });
      await until(() => FakeSocket.all.at(-1) !== first);
      FakeSocket.all.at(-1)!.hello();
      await until(() => api.of("conversations.replies").length === 2);
      expect(api.of("conversations.replies")[1]!.params.get("oldest")).toBe("1700000440.000200");
    });

    it("while catch-up is failing, live events do not move the stored cursor past the gap; it moves once catch-up succeeds", async () => {
      const down = new Response("", { status: 503 });
      const { ch, api, state } = gapped({ "conversations.replies": [down, down, down, replies] });
      const sock = await connected(ch);
      sock.push(ownerEvent("e1", { ts: "1700000500.000200" }));
      await until(() => sock.sent.length === 1);
      expect(state.cursor).toBe("1700000040.000000"); // a restart now would still read the gap
      await until(() => api.of("conversations.replies").length === 4);
      await until(() => state.cursor === "1700000500.000200");
    });

    it("a failed read is retried until it succeeds, and /healthz shows it meanwhile", async () => {
      const { ch, got, logs } = gapped({ "conversations.replies": [new Response("", { status: 429, headers: { "retry-after": "1" } }), replies] });
      await connected(ch);
      expect(got).toEqual([]);
      expect(ch.status()).toEqual({ connected: true, last_error: expect.stringContaining("Slack catch-up failed") });
      await until(() => got.length === 2);
      await until(() => ch.status().last_error === undefined);
      expect(logs.filter((l) => l.includes("catch-up failed"))).toHaveLength(1);
    });

    it("any other read failure on a thread ends the pass, so the cursor does not move past unread replies", async () => {
      const { ch, got, state } = gapped({ "conversations.replies": [json({ ok: false, error: "some_new_error" })] });
      await connected(ch);
      expect(got).toEqual([]);
      expect(state.cursor).toBe("1700000040.000000");
      expect(ch.status().last_error).toContain("Slack catch-up failed");
    });

    it("a thread Slack no longer has is skipped without blocking the rest", async () => {
      const GONE = "1699999999.000100";
      const { ch, got, logs } = gapped(
        { "conversations.replies": [(c) => (c.params.get("ts") === GONE ? json({ ok: false, error: "thread_not_found" }) : replies)] },
        undefined,
        [GONE, OPENER],
      );
      await connected(ch);
      expect(got.map((m) => m.provider_msg_id)).toEqual(["1700000060.000200", "1700000090.000300"]);
      expect(logs.some((l) => l.includes("catch-up skipped thread"))).toBe(true);
    });
  });

  it("a disconnect envelope reconnects with a fresh url and backoff", async () => {
    const { ch, api } = withHandler("accepted");
    const first = await connected(ch);
    first.push({ type: "disconnect", reason: "refresh_requested" });
    await until(() => FakeSocket.all.at(-1) !== first);
    expect(ch.status().connected).toBe(false);
    FakeSocket.all.at(-1)!.hello();
    await until(() => ch.status().connected);
    expect(api.of("apps.connections.open")).toHaveLength(2);
  });

  it("a transient first connect failure rejects start but keeps reconnecting in the background", async () => {
    const c = channel({ "apps.connections.open": [new Response("", { status: 503 }), okConnect] });
    live.push(c.ch);
    const before = FakeSocket.all.length;
    await expectCode(c.ch.start(), "channel_unavailable");
    await until(() => FakeSocket.all.length > before);
    FakeSocket.all.at(-1)!.hello();
    await until(() => c.ch.status().connected);
  });

  it("a bad app token rejects start with the hint and does not retry", async () => {
    const c = channel({ "apps.connections.open": [json({ ok: false, error: "invalid_auth" })] });
    live.push(c.ch);
    await expectCode(c.ch.start(), "channel_auth_failed", /SLACK_APP_TOKEN/);
    await wait(20);
    expect(c.api.of("apps.connections.open")).toHaveLength(1);
    expect(c.ch.status()).toEqual({ connected: false, last_error: expect.stringContaining("SLACK_APP_TOKEN") });
  });
});

describe("createSlackChannel", () => {
  it("is undefined with nothing set, and names the missing vars or the wrong token on a bad set", () => {
    expect(createSlackChannel({})).toBeUndefined();
    expect(() => createSlackChannel({ slack_bot_token: "xoxb-1" })).toThrow(/set SLACK_APP_TOKEN, SLACK_CHANNEL_ID too/);
    expect(() => createSlackChannel({ slack_bot_token: "xapp-1", slack_app_token: "xoxb-1", slack_channel_id: CHANNEL })).toThrow(/SLACK_BOT_TOKEN must be the Bot User OAuth Token/);
    expect(createSlackChannel({ slack_bot_token: "xoxb-1", slack_app_token: "xapp-1", slack_channel_id: CHANNEL })?.status()).toEqual({ connected: false });
  });
});
