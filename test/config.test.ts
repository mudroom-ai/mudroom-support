import { describe, expect, it } from "vitest";
import { loadEnv, loadStartup, missingRequiredEnv, parseConfig, parseTrustProxy } from "../src/config.js";
import { describeStartupError } from "../src/server.js";

const REQUIRED = {
  VENDOR_NAME: "Acme",
  PUBLIC_URL: "https://support.acme.dev/",
  SLACK_BOT_TOKEN: "xoxb-1",
  SLACK_APP_TOKEN: "xapp-1",
  SLACK_CHANNEL_ID: "C0123",
};

describe("config schema", () => {
  it("fills the approved defaults (eng review R3)", () => {
    const c = parseConfig({ vendor_name: "Acme" });
    expect(c.vendor_id).toBe("default");
    expect(c.limits.thread_close_after_reply_hours).toBe(168);
    expect(c.limits.thread_wait_max_seconds).toBe(120);
    expect(c.support).toEqual({
      field_caps: { message: 2000, error: 4000, tried: 2000, environment: 500 },
      reply_email_grace_min: 5,
      reply_email_spacing_min: 15,
      verified_address_days: 90,
      require_confirm: false,
      agent_gone_after_min: 6,
      confirm_emails_per_address_per_day: 3,
      confirm_emails_per_vendor_per_day: 50,
      confirm_link_hours: 24,
      slack_retry_window_hours: 24,
      slack_retry_max_backoff_min: 30,
    });
  });

  it("rejects a missing vendor name", () => {
    expect(() => parseConfig({})).toThrow(/vendor_name/);
  });

  it.each([
    ["loopback", ["loopback"]],
    ["false", false],
    ["1", 1],
    [" 10.0.0.0/8, loopback ", ["10.0.0.0/8", "loopback"]],
  ])("TRUST_PROXY=%j parses to %j", (raw, want) => {
    expect(parseTrustProxy(raw as string)).toEqual(want);
  });

  it("TRUST_PROXY=true is rejected (would trust spoofed X-Forwarded-For)", () => {
    expect(() => parseTrustProxy("true")).toThrow(/hop count/);
  });

  it("reads the optional email and admin vars", () => {
    const s = loadEnv({ RESEND_API_KEY: " re_1 ", EMAIL_FROM: "Acme support <support@acme.dev>", ADMIN_EMAIL: "ops@acme.dev" });
    expect([s.resend_api_key, s.email_from, s.admin_email]).toEqual(["re_1", "Acme support <support@acme.dev>", "ops@acme.dev"]);
    expect(loadEnv({}).resend_api_key).toBeUndefined();
  });
});

describe("required env at startup", () => {
  it("starts with every required var; PUBLIC_URL loses its trailing slash", () => {
    const { config, settings } = loadStartup(REQUIRED);
    expect(config.vendor_name).toBe("Acme");
    expect(config.public_url).toBe("https://support.acme.dev");
    expect(settings.slack_channel_id).toBe("C0123");
  });

  it("refuses to start with a fix hint naming each missing var", () => {
    expect(missingRequiredEnv(REQUIRED)).toBeNull();
    const { VENDOR_NAME: _v, SLACK_APP_TOKEN: _a, SLACK_CHANNEL_ID: _c, ...rest } = REQUIRED;
    let e: unknown;
    try {
      loadStartup(rest);
    } catch (x) {
      e = x;
    }
    const msg = describeStartupError(e);
    expect(msg).toMatch(/^Missing required environment variables:\n/);
    expect(msg).toContain('  - set VENDOR_NAME: the name developers know you by, e.g. VENDOR_NAME="Acme"');
    expect(msg).toContain("  - set SLACK_APP_TOKEN, SLACK_CHANNEL_ID: the Slack app that carries questions to your support channel (see docs/connectors/slack.md)");
    expect(msg).not.toContain("PUBLIC_URL");
  });

  it("an empty value counts as missing", () => {
    expect(missingRequiredEnv({ ...REQUIRED, PUBLIC_URL: "  " })).toContain("set PUBLIC_URL");
  });
});
