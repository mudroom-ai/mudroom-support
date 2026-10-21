// docs/errors.md is the page agents are pointed at for the error contract; keep it in step with src/errors.ts.
// Value: protects=every ERROR_CODES entry is documented with its HTTP status and retryability, and no stale code
//   stays documented; fails_when=a code is added, renamed or has its status/retryability changed without the doc,
//   or the doc lists a code the server no longer returns; why_new=connectors-dx covers connector docs only;
//   seam=none
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ERROR_CODES, HTTP_STATUS, isRetryable } from "../src/errors.js";

const doc = readFileSync("docs/errors.md", "utf8");
const codesTable = doc.split("\n## Codes\n")[1]?.split("\n## ")[0] ?? "";
const rows = new Map(
  [...codesTable.matchAll(/^\| `([a-z_]+)` \| (\d{3}) \| (yes|no) \|/gm)].map((m) => [m[1]!, { status: Number(m[2]), retryable: m[3] === "yes" }]),
);

describe("docs/errors.md matches src/errors.ts", () => {
  it("documents every code with its status and retryability", () => {
    for (const code of ERROR_CODES) {
      const row = rows.get(code);
      expect(row, `docs/errors.md lacks a row for \`${code}\``).toBeDefined();
      expect(row!.status, `docs/errors.md status for ${code}`).toBe(HTTP_STATUS[code]);
      expect(row!.retryable, `docs/errors.md retryability for ${code}`).toBe(isRetryable(code));
    }
  });

  it("documents no code the server does not return", () => {
    const stale = [...rows.keys()].filter((c) => !(ERROR_CODES as readonly string[]).includes(c));
    expect(stale, "remove stale rows from docs/errors.md").toEqual([]);
  });
});
