import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadEnv, parseConfig } from "../src/config.js";
import { ipBucket } from "../src/middleware/ratelimit.js";
import type { CommunicationConnector } from "../src/connectors/types.js";
import type { MessageOps } from "../src/messages.js";
import { createApp } from "../src/server.js";
import { Store } from "../src/store/sqlite.js";

const config = parseConfig({
  vendor_id: "m1",
  vendor_name: "Test",
  limits: { per_ip_per_min: 25, per_key_per_min: 1000 },
});
const dbPath = join(mkdtempSync(join(tmpdir(), "sd-http-")), "t.sqlite");
const settings = loadEnv({ API_KEYS: "secret", DB_PATH: dbPath });

/** A thread-capable fake channel; the real Slack one is covered in test/slack.test.ts. */
const fakeChannel = (opened: string[] = []): CommunicationConnector => ({
  notify: async () => {},
  openThread: async (o) => (opened.push(o.thread_id), { provider_ref: `ts.${opened.length}` }),
  postToThread: async () => {},
  onOwnerMessage: () => {},
  start: async () => {},
  stop: async () => {},
  status: () => ({ connected: true }),
});

/** Any /api route that exists and answers without side effects: an unknown thread is a plain 404. */
const PROBE = "/api/threads/t_nope";

let server: Server;
let base = "";
beforeAll(async () => {
  const app = createApp(config, settings, { store: new Store(dbPath), owner: fakeChannel() });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

/** Raw request with a chosen Host header (fetch does not let a caller set Host). */
function withHost(url: string, host: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request(url, { headers: { host, ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data) as Record<string, unknown> }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function serveWith(env: Record<string, string>, owner: CommunicationConnector | null = fakeChannel()) {
  const s2 = loadEnv({ DB_PATH: join(mkdtempSync(join(tmpdir(), "sd-srv-")), "t.sqlite"), ...env });
  const app = createApp(config, s2, { store: new Store(s2.db_path), owner });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  return { srv, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` };
}

const KEY = { authorization: "Bearer secret" };

describe("http adapter + middleware", () => {
  it.each([
    { name: "public, no key", m: "GET", p: PROBE, h: {}, status: 404, code: "unknown_thread" },
    { name: "valid key", m: "GET", p: PROBE, h: KEY, status: 404, code: "unknown_thread" },
    { name: "wrong key -> 401", m: "GET", p: PROBE, h: { authorization: "Bearer nope" }, status: 401, code: "unauthorized" },
    { name: "non-Bearer auth -> 401", m: "POST", p: "/api/messages", b: {}, h: { authorization: "Basic x" }, status: 401, code: "unauthorized" },
    { name: "malformed JSON", m: "POST", p: "/api/messages", b: "{nope", h: {}, status: 400, code: "invalid_request" },
    { name: "no requester", m: "POST", p: "/api/messages", b: { message: "hi" }, h: {}, status: 400, code: "invalid_customer" },
    { name: "booking routes are gone", m: "POST", p: "/api/book", b: {}, h: {}, status: 400, code: "invalid_request" },
  ])("$name", async ({ m, p, b, h, status, code }) => {
    const r = await call(m, p, b, h as Record<string, string>);
    expect(r.status).toBe(status);
    if (code) expect(r.body).toMatchObject({ code, retryable: false });
  });

  it("loopback bind without ALLOWED_HOSTS: only localhost Host and Origin pass", async () => {
    expect((await withHost(`${base}${PROBE}`, "localhost:1234")).status).toBe(404);
    const evil = await withHost(`${base}${PROBE}`, "evil.example.com");
    expect(evil.status).toBe(400);
    expect(evil.body).toMatchObject({ code: "invalid_request", retryable: false });
    const origin = await withHost(`${base}${PROBE}`, "127.0.0.1", { origin: "https://evil.example.com" });
    expect(origin.body).toMatchObject({ code: "invalid_request" });
  });

  it.each([
    ["203.0.113.7", "203.0.113.7"],
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["2001:db8:1:2::1", "2001:db8:1:2::/64"],
    ["2001:0db8:0001:0002:ffff:1:2:3", "2001:db8:1:2::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
  ])("rate-limit bucket for %s is %s", (ip, bucket) => {
    expect(ipBucket(ip)).toBe(bucket);
  });

  it("TRUST_PROXY hop count: per-client buckets behind a remote proxy; spoofed headers ignored", async () => {
    const { srv, url: b } = await serveWith({ TRUST_PROXY: "1" });
    const url = `${b}${PROBE}`;
    const get = async (h: Record<string, string>) => (await fetch(url, { headers: h })).status;
    try {
      for (let i = 0; i < 25; i++) expect(await get({ "x-forwarded-for": "198.51.100.1" })).toBe(404);
      expect(await get({ "x-forwarded-for": "198.51.100.1" })).toBe(429);
      // Spoofing a leftmost XFF entry or CF-Connecting-IP doesn't escape the bucket.
      expect(await get({ "x-forwarded-for": "6.6.6.6, 198.51.100.1" })).toBe(429);
      expect(await get({ "x-forwarded-for": "198.51.100.1", "cf-connecting-ip": "9.9.9.9" })).toBe(429);
      // Another caller behind the same proxy has its own bucket.
      expect(await get({ "x-forwarded-for": "198.51.100.2" })).toBe(404);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it("default TRUST_PROXY ignores a spoofed CF-Connecting-IP from a local proxy (nginx/Caddy)", async () => {
    const { srv, url: b } = await serveWith({});
    const url = `${b}${PROBE}`;
    let i = 0;
    const get = async () =>
      (await fetch(url, { headers: { "x-forwarded-for": "198.51.100.7", "cf-connecting-ip": `9.9.9.${i++ % 250}` } })).status;
    try {
      for (let n = 0; n < 25; n++) expect(await get()).toBe(404);
      expect(await get()).toBe(429);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it("per-IP limit -> 429 with Retry-After; keyed agents use the higher limit", async () => {
    let last;
    for (let i = 0; i < 30; i++) last = await call("GET", PROBE);
    expect(last!.status).toBe(429);
    expect(last!.body).toMatchObject({ code: "rate_limited", retryable: true });
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await call("GET", PROBE, undefined, KEY)).status).toBe(404);
  });
});

describe("messages over HTTP", () => {
  const opened: string[] = [];
  const channel = fakeChannel(opened);
  let mbase = "";
  let mserver: Server;
  let mops: MessageOps;
  beforeAll(async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sd-msg-")), "t.sqlite");
    const c2 = parseConfig({ ...config, limits: {} });
    const app = createApp(c2, loadEnv({ DB_PATH: path }), { store: new Store(path), owner: channel });
    mops = app.locals.messages as MessageOps;
    mserver = app.listen(0, "127.0.0.1");
    await new Promise((r) => mserver.once("listening", r));
    mbase = `http://127.0.0.1:${(mserver.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => mserver.close(r)));

  const mcall = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(mbase + path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const MSG = { requester: { name: "Ann", email: "ann@example.com" }, message: "Do you groom cats?" };

  it("leave, read with the header token, follow up; the token is never read from the query string", async () => {
    const left = await mcall("POST", "/api/messages", MSG);
    expect(left.status).toBe(201);
    const { thread_id, read_token } = left.body as { thread_id: string; read_token: string };
    const read = await mcall("GET", `/api/threads/${thread_id}`, undefined, { "x-thread-token": read_token });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ status: "awaiting_owner", poll_after_seconds: 60, delivery: "delivered" });

    const wrong = await mcall("GET", `/api/threads/${thread_id}`, undefined, { "x-thread-token": "nope" });
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const query = await mcall("GET", `/api/threads/${thread_id}?read_token=${read_token}`);
    await new Promise((r) => setTimeout(r, 5));
    const logged = logs.mock.calls.flat().join("\n");
    logs.mockRestore();
    expect(logged).toContain("read_token=[redacted]");
    expect(logged).not.toContain(read_token); // a token put in the query is never written to the access log
    const unknown = await mcall("GET", "/api/threads/t_nope", undefined, { "x-thread-token": read_token });
    expect([wrong.status, query.status, unknown.status]).toEqual([404, 404, 404]);
    expect(query.body).toEqual(wrong.body);
    expect(unknown.body).toEqual(wrong.body);

    const f = await mcall("POST", `/api/threads/${thread_id}/messages`, { message: "She is 12." }, { "x-thread-token": read_token });
    expect(f.status).toBe(201);
    expect((f.body.messages as unknown[]).length).toBe(2);
    expect((await mcall("POST", `/api/threads/${thread_id}/owner-reply`, { text: "x" })).body).toMatchObject({ code: "invalid_request" });
  });

  it("?wait holds until the owner replies; a bad wait is 400", async () => {
    const left = await mcall("POST", "/api/messages", { ...MSG, message: "Can I bring two dogs?" });
    const { thread_id, read_token } = left.body as { thread_id: string; read_token: string };
    const tok = { "x-thread-token": read_token };
    const started = Date.now();
    const held = mcall("GET", `/api/threads/${thread_id}?wait=1`, undefined, tok);
    await new Promise((r) => setTimeout(r, 50));
    const ref = `ts.${opened.indexOf(thread_id) + 1}`;
    expect(await mops.onOwnerMessage({ provider_ref: ref, provider_msg_id: "w1", user_id: "U1", text: "Yes, both welcome." })).toBe("accepted");
    const r = await held;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "answered" });
    for (const q of ["wait=abc", "wait=-1", "wait=1&wait=2"]) {
      const bad = await mcall("GET", `/api/threads/${thread_id}?${q}`, undefined, tok);
      expect([q, bad.status, bad.body.code]).toEqual([q, 400, "invalid_request"]);
    }
  });

  it("close: header token, idempotent 200, wrong token 404 like get_thread, follow-up after close 409", async () => {
    const left = await mcall("POST", "/api/messages", { ...MSG, message: "Do you do nails?" });
    const { thread_id, read_token } = left.body as { thread_id: string; read_token: string };
    const wrong = await mcall("POST", `/api/threads/${thread_id}/close`, undefined, { "x-thread-token": "nope" });
    const getWrong = await mcall("GET", `/api/threads/${thread_id}`, undefined, { "x-thread-token": "nope" });
    expect(wrong.status).toBe(404);
    expect(wrong.body).toEqual(getWrong.body);
    const c1 = await mcall("POST", `/api/threads/${thread_id}/close`, undefined, { "x-thread-token": read_token });
    const c2 = await mcall("POST", `/api/threads/${thread_id}/close`, undefined, { "x-thread-token": read_token });
    expect([c1.status, c2.status]).toEqual([200, 200]);
    expect(c2.body).toMatchObject({ thread_id, status: "closed" });
    const f = await mcall("POST", `/api/threads/${thread_id}/messages`, { message: "one more" }, { "x-thread-token": read_token });
    expect(f.status).toBe(409);
    expect(f.body).toMatchObject({ code: "thread_closed" });
  });

  it("follow-up with done closes the thread", async () => {
    const left = await mcall("POST", "/api/messages", { ...MSG, message: "Any openings Friday?" });
    const { thread_id, read_token } = left.body as { thread_id: string; read_token: string };
    const f = await mcall("POST", `/api/threads/${thread_id}/messages`, { message: "Thanks!", done: true }, { "x-thread-token": read_token });
    expect(f.status).toBe(201);
    expect(f.body).toMatchObject({ status: "closed" });
  });

  it("/healthz reports the channel and outbox", async () => {
    const h = (await (await fetch(`${mbase}/healthz`)).json()) as Record<string, unknown>;
    expect(h).toEqual({ ok: true, channel: { mode: "two_way", enabled: true, connected: true }, outbox: { queued: 0, failed: 0 } });
  });

  it("without a support channel the routes do not exist", async () => {
    const { srv, url } = await serveWith({}, null);
    try {
      const r = await fetch(`${url}/api/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(MSG) });
      expect(await r.json()).toMatchObject({ code: "invalid_request", message: "Unknown endpoint" });
      expect(await (await fetch(`${url}/healthz`)).json()).toEqual({ ok: true });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe("ALLOWED_HOSTS", () => {
  let hserver: Server;
  let hbase = "";
  beforeAll(async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sd-hosts-")), "t.sqlite");
    const app = createApp(config, loadEnv({ DB_PATH: path, ALLOWED_HOSTS: "gw.example.com" }), { store: new Store(path), owner: fakeChannel() });
    hserver = app.listen(0, "127.0.0.1");
    await new Promise((r) => hserver.once("listening", r));
    hbase = `http://127.0.0.1:${(hserver.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => hserver.close(r)));

  it("a listed Host passes (port ignored); any other is rejected with the shared error body", async () => {
    expect((await withHost(`${hbase}${PROBE}`, "gw.example.com:443")).status).toBe(404);
    const other = await withHost(`${hbase}${PROBE}`, "localhost");
    expect(other.status).toBe(400);
    expect(other.body).toMatchObject({ code: "invalid_request", message: "Host not allowed: localhost", retryable: false });
  });
});
