import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { EnvSchema } from "../src/config.js";
import { slackOwnerChannel } from "../src/connectors/slack.js";
import { checkOwnerChannel, describeListenError, describeStartupError, emailWarning, listenOrExit } from "../src/server.js";
import { loadEnv } from "../src/config.js";

describe("describeStartupError", () => {
  it("lists env issues one per line, like config errors", () => {
    const r = EnvSchema.safeParse({ MESSAGES_ENABLED: "maybe", PORT: "abc" });
    expect(r.success).toBe(false);
    const msg = describeStartupError(r.success ? undefined : r.error);
    expect(msg).toMatch(/^Invalid environment:\n/);
    expect(msg).toContain("  - MESSAGES_ENABLED:");
    expect(msg).toContain("  - PORT:");
    expect(msg).not.toContain("    at ");
  });

  it("passes other errors through by message", () => {
    expect(describeStartupError(new Error("Invalid config:\n  - vendor_name: Required"))).toBe("Invalid config:\n  - vendor_name: Required");
  });
});

describe("listen errors", () => {
  it("names host, port and code with the PORT fix", () => {
    const e = Object.assign(new Error("listen EACCES"), { code: "EACCES" });
    expect(describeListenError("0.0.0.0", 80, e)).toBe("cannot listen on 0.0.0.0:80 (EACCES): stop the other process or set PORT in .env");
  });

  it("prints one line and exits 1 when the port is already bound", async () => {
    const holder = createServer();
    await new Promise<void>((r) => holder.listen(0, "127.0.0.1", r));
    const port = (holder.address() as AddressInfo).port;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await new Promise<number>((resolve) => {
        listenOrExit(createServer(), "127.0.0.1", port, () => resolve(-1), resolve);
      });
      expect(code).toBe(1);
      expect(errors.mock.calls).toEqual([
        [`[support] cannot listen on 127.0.0.1:${port} (EADDRINUSE): stop the other process or set PORT in .env`],
      ]);
    } finally {
      errors.mockRestore();
      holder.close();
    }
  });
});

describe("support channel startup check", () => {
  const slack = (authTest: Response) =>
    slackOwnerChannel({
      botToken: "xoxb-bot",
      appToken: "xapp-app",
      channelId: "C0123",
      fetch: async () => authTest.clone(),
    });

  it("a channel_auth_failed fails the boot and describeStartupError prints the fix hint", async () => {
    const e = await checkOwnerChannel(slack(new Response(JSON.stringify({ ok: false, error: "invalid_auth" })))).then(() => undefined, (x: unknown) => x);
    expect(describeStartupError(e)).toMatch(/SLACK_BOT_TOKEN is wrong or revoked: copy the Bot User OAuth Token/);
  });

  it("a transient outage only warns so the server still boots", async () => {
    const warns: string[] = [];
    await expect(checkOwnerChannel(slack(new Response("", { status: 503 })), (m) => warns.push(m))).resolves.toBeUndefined();
    expect(warns[0]).toMatch(/support channel not reachable at startup/);
  });

  it("no channel is a no-op", async () => {
    await expect(checkOwnerChannel(undefined)).resolves.toBeUndefined();
  });
});

describe("email notifier warning", () => {
  it("warns at startup, naming the vars, until RESEND_API_KEY and EMAIL_FROM are both set", () => {
    expect(emailWarning(loadEnv({}))).toMatch(/set RESEND_API_KEY and EMAIL_FROM .* replies reach only open agent sessions/);
    expect(emailWarning(loadEnv({ RESEND_API_KEY: "re_1" }))).not.toBeNull();
    expect(emailWarning(loadEnv({ RESEND_API_KEY: "re_1", EMAIL_FROM: "support@acme.dev" }))).toBeNull();
  });
});
