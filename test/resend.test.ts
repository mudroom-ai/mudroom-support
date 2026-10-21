import { describe, expect, it } from "vitest";
import { createResendNotifier, fromDomain, ResendNotifier } from "../src/connectors/resend.js";
import { ConnectorError } from "../src/connectors/types.js";

type Call = { method: string; path: string; headers: Record<string, string>; body: unknown };
type Reply = Response | Error;

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
const fail = (statusCode: number, name: string, message: string, headers: Record<string, string> = {}) => json({ statusCode, name, message }, { status: statusCode, headers });

/** Scripted Resend API: each "METHOD /path" answers from its queue (last entry repeats); every call is recorded. */
function resendApi(routes: Record<string, Reply[]>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = String(url).replace("https://api.resend.com", "");
    const method = init?.method ?? "GET";
    calls.push({ method, path, headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const q = routes[`${method} ${path}`];
    if (!q?.length) throw new Error(`unscripted Resend route ${method} ${path}`);
    const r = q.length > 1 ? q.shift()! : q[0]!;
    if (r instanceof Error) throw r;
    return r.clone();
  };
  return { calls, fetchImpl };
}

const FROM = "Acme support <support@acme.dev>";
const MSG = { to: "dev@example.com", subject: "Acme replied", text: "Try v2.", idempotency_key: "reply-email:t1:3" };
const notifier = (routes: Record<string, Reply[]>, warn: (m: string) => void = () => {}) => {
  const api = resendApi(routes);
  return { api, n: new ResendNotifier({ apiKey: "re_test_123", from: FROM, fetch: api.fetchImpl, warn }) };
};

async function code(p: Promise<unknown>): Promise<ConnectorError> {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(ConnectorError);
  return e as ConnectorError;
}

describe("resend sendEmail", () => {
  it("posts the email with the bearer key, a User-Agent and the Idempotency-Key header", async () => {
    const { api, n } = notifier({ "POST /emails": [json({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" })] });
    expect(await n.sendEmail(MSG)).toEqual({ provider_ref: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
    const c = api.calls[0]!;
    expect(c.headers.authorization).toBe("Bearer re_test_123");
    expect(c.headers["idempotency-key"]).toBe("reply-email:t1:3");
    expect(c.headers["user-agent"]).toBeTruthy();
    expect(c.body).toEqual({ from: FROM, to: ["dev@example.com"], subject: "Acme replied", text: "Try v2." });
  });

  it("a retry sends the same idempotency key", async () => {
    const { api, n } = notifier({ "POST /emails": [fail(500, "application_error", "An unexpected error occurred."), json({ id: "e1" })] });
    await code(n.sendEmail(MSG));
    await n.sendEmail(MSG);
    expect(api.calls.map((c) => c.headers["idempotency-key"])).toEqual([MSG.idempotency_key, MSG.idempotency_key]);
  });

  it.each([
    ["401 invalid key", fail(401, "validation_error", "API key is invalid")],
    ["403 suspended", fail(403, "suspended_api_key", "This API key is suspended")],
  ])("notifier_auth_failed on %s, with the fix hint", async (_l, r) => {
    const e = await code(notifier({ "POST /emails": [r] }).n.sendEmail(MSG));
    expect(e.code).toBe("notifier_auth_failed");
    expect(e.message).toContain("create a key with sending access at resend.com/api-keys");
  });

  it("notifier_domain_unverified when the From domain is not verified", async () => {
    const e = await code(notifier({ "POST /emails": [fail(403, "validation_error", "The acme.dev domain is not verified. Please, add and verify your domain.")] }).n.sendEmail(MSG));
    expect(e.code).toBe("notifier_domain_unverified");
    expect(e.message).toContain("verify acme.dev in Resend and add its SPF/DKIM records");
  });

  it.each([
    ["422 bad recipient", fail(422, "validation_error", "Invalid `to` field.")],
    ["409 key reused with another body", fail(409, "invalid_idempotent_request", "body does not match")],
  ])("notifier_rejected on %s (no retry)", async (_l, r) => {
    const e = await code(notifier({ "POST /emails": [r] }).n.sendEmail(MSG));
    expect(e.code).toBe("notifier_rejected");
    expect(e.retry_after_s).toBeUndefined();
  });

  it("a 409 key reused with another body is marked idempotency_mismatch; a bad recipient is not", async () => {
    expect((await code(notifier({ "POST /emails": [fail(409, "invalid_idempotent_request", "body does not match")] }).n.sendEmail(MSG))).detail).toBe("idempotency_mismatch");
    expect((await code(notifier({ "POST /emails": [fail(422, "validation_error", "Invalid `to` field.")] }).n.sendEmail(MSG))).detail).toBeUndefined();
  });

  it("notifier_unavailable on 429 carries Resend's retry-after", async () => {
    const e = await code(notifier({ "POST /emails": [fail(429, "rate_limit_exceeded", "Too many requests.", { "retry-after": "7" })] }).n.sendEmail(MSG));
    expect(e.code).toBe("notifier_unavailable");
    expect(e.retry_after_s).toBe(7);
  });

  it.each([
    ["503", fail(503, "service_unavailable", "API is temporarily unavailable")],
    ["409 concurrent", fail(409, "concurrent_idempotent_requests", "in progress")],
    ["network error", new TypeError("fetch failed")],
  ])("notifier_unavailable on %s, with a default retry", async (_l, r) => {
    const e = await code(notifier({ "POST /emails": [r] }).n.sendEmail(MSG));
    expect(e.code).toBe("notifier_unavailable");
    expect(e.retry_after_s).toBeGreaterThan(0);
  });
});

describe("resend checkAccess", () => {
  const domains = (status: string, name = "acme.dev") => json({ object: "list", has_more: false, data: [{ id: "d1", name, status }] });

  it("passes when the From domain is verified", async () => {
    await expect(notifier({ "GET /domains": [domains("verified")] }).n.checkAccess()).resolves.toBeUndefined();
  });

  it.each([["pending", domains("pending")], ["absent", domains("verified", "other.dev")]])("notifier_domain_unverified when the domain is %s", async (_l, r) => {
    const e = await code(notifier({ "GET /domains": [r] }).n.checkAccess());
    expect(e.code).toBe("notifier_domain_unverified");
    expect(e.message).toContain("verify acme.dev in Resend and add its SPF/DKIM records");
  });

  it("notifier_auth_failed when the key is rejected", async () => {
    const e = await code(notifier({ "GET /domains": [fail(401, "validation_error", "API key is invalid")] }).n.checkAccess());
    expect(e.code).toBe("notifier_auth_failed");
    expect(e.message).toContain("resend.com/api-keys");
  });

  it("a sending-only key passes with a warning (it cannot list domains)", async () => {
    const warnings: string[] = [];
    const { n } = notifier({ "GET /domains": [fail(401, "restricted_api_key", "This API key is restricted to only send emails.")] }, (m) => warnings.push(m));
    await expect(n.checkAccess()).resolves.toBeUndefined();
    expect(warnings.join()).toContain("acme.dev");
  });
});

describe("createResendNotifier", () => {
  it("is undefined when not configured and refuses half a config", () => {
    expect(createResendNotifier({ resend_api_key: undefined, email_from: undefined })).toBeUndefined();
    expect(() => createResendNotifier({ resend_api_key: "re_x", email_from: undefined })).toThrow(/EMAIL_FROM/);
    expect(() => createResendNotifier({ resend_api_key: undefined, email_from: FROM })).toThrow(/RESEND_API_KEY/);
    expect(createResendNotifier({ resend_api_key: "re_x", email_from: FROM })?.name).toBe("resend");
  });

  it("reads the domain from EMAIL_FROM", () => {
    expect(fromDomain(FROM)).toBe("acme.dev");
    expect(fromDomain("Support@Acme.dev")).toBe("acme.dev");
    expect(fromDomain("Acme")).toBeUndefined();
  });
});
