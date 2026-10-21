import { describe, expect, it } from "vitest";
import { FieldCapsSchema } from "../src/config.js";
import { checkFieldCaps, maskSecrets } from "../src/support.js";

describe("maskSecrets", () => {
  const masked: Array<[string, string, string]> = [
    ["aws access key id", "key AKIAIOSFODNN7EXAMPLE here", "key [masked] here"],
    ["aws session key id", "ASIAY34FZKBOKMUTVV7A", "[masked]"],
    ["github classic", "ghp_16C7e42F292c6912E7710c838347Ae178B4a", "[masked]"],
    ["github oauth/server", "gho_16C7e42F292c6912E7710c838347Ae178B4a ghs_16C7e42F292c6912E7710c838347Ae178B4a", "[masked] [masked]"],
    ["github fine-grained", "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ", "[masked]"],
    ["slack bot token", "xoxb-1234567890-0987654321-AbCdEfGhIjKlMnOp", "[masked]"],
    ["slack refresh token", "xoxe-1-AbCdEfGhIjKlMnOpQrSt", "[masked]"],
    ["resend api key", "re_AbCdEfGh12345678_ijklMNOP", "[masked]"],
    ["stripe live", "sk_live_4eC39HqLyjWDarjtT1zdp7dc", "[masked]"],
    ["stripe restricted", "rk_live_4eC39HqLyjWDarjtT1zdp7dc", "[masked]"],
    ["openai", "sk-abcdefghijklmnopqrstuvwxyz123456", "[masked]"],
    ["openai project", "OPENAI_KEY sk-proj-abcDEF123_ghiJKL456-mnoPQR789stu", "OPENAI_KEY [masked]"],
    ["anthropic", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-0123456789", "[masked]"],
    ["google api key", "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY", "[masked]"],
    ["jwt", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U ok", "token [masked] ok"],
    ["pem", "a\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----\nb", "a\n[masked]\nb"],
    ["bearer header", 'curl -H "Authorization: Bearer abc.def-123"', 'curl -H "Authorization: Bearer [masked]"'],
    ["url query", "https://api.acme.dev/v1?api_key=abc123&page=2", "https://api.acme.dev/v1?api_key=[masked]&page=2"],
    ["env line", "ACME_SECRET_KEY=hunter2hunter2\nDB_PASSWORD='p@ss'", "ACME_SECRET_KEY=[masked]\nDB_PASSWORD='[masked]'"],
    ["token assignment", "GITHUB_TOKEN=whatever token=xyz", "GITHUB_TOKEN=[masked] token=[masked]"],
    ["json secret", '{"client_secret": "a1b2c3d4e5f6"}', '{"client_secret": "[masked]"}'],
    ["url credentials", "postgres://app:s3cretpw@db.acme.dev:5432/app", "postgres://app:[masked]@db.acme.dev:5432/app"],
  ];
  it.each(masked)("masks %s", (_l, input, out) => {
    expect(maskSecrets(input)).toBe(out);
  });

  const kept: Array<[string, string]> = [
    ["prose about tokens", "The token expired and the password: incorrect message showed up."],
    ["max_tokens", "max_tokens=4096 temperature=0.2"],
    ["short hex and commit ids", "commit 3f2a9c1 failed; see deadbeef"],
    ["uuid", "request id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"],
    ["prefixes alone", "AKIA sk- ghp_ xoxb- eyJ re_ re_try"],
    ["ordinary hyphenated words", "scikit-learn sk-learn task-runner-configuration-loader"],
    ["bearer in prose", "Bearer of bad news: the build failed"],
    ["url with port", "https://localhost:8080/path"],
    ["masked already", "Authorization: Bearer [masked]"],
  ];
  it.each(kept)("keeps %s", (_l, input) => {
    expect(maskSecrets(input)).toBe(input);
  });
});

describe("checkFieldCaps", () => {
  const caps = FieldCapsSchema.parse({});

  it("passes fields at their caps", () => {
    expect(checkFieldCaps({ message: "a".repeat(2000), error: "e".repeat(4000), tried: "t".repeat(2000), environment: "v".repeat(500) }, caps)).toBeNull();
  });

  it.each([
    ["message", { message: "a".repeat(2001) }, "message", 2000],
    ["error", { message: "hi", error: "e".repeat(4001) }, "context.error", 4000],
    ["tried", { message: "hi", tried: "t".repeat(2001) }, "context.tried", 2000],
    ["environment", { message: "hi", environment: "v".repeat(501) }, "context.environment", 500],
  ])("rejects %s over its cap with invalid_request naming field and cap", (_l, fields, name, cap) => {
    const e = checkFieldCaps(fields, caps);
    expect(e?.code).toBe("invalid_request");
    expect(e?.retryable).toBe(false);
    expect(e?.message).toContain(name);
    expect(e?.message).toContain(String(cap));
  });
});
