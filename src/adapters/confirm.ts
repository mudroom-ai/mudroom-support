// The one-button confirm page behind a confirm email's link (T5b, eng review R5).
//   GET  /v/<token>  a tiny page with a Confirm button; never changes state (mail scanners prefetch GETs)
//   POST /v/<token>  confirms this question: the thread is confirmed, the address verified for reply emails
// An unknown, expired or used token answers a plain message and changes nothing. Rate-limited like llms.txt
// (server.ts). This is the only human-facing page on the door.

import type { Request, Response } from "express";
import type { SupportEmails } from "../emails.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const NOT_VALID = "This confirm link has expired or was already used. Nothing was changed.";

function noStore(res: Response): void {
  res.set({ "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" });
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.6rem 1.4rem;cursor:pointer}</style>
</head><body>${body}</body></html>
`;
}

export function confirmPageHandler(vendorName: string, emails: SupportEmails, now: () => number = () => Date.now()) {
  return (req: Request, res: Response) => {
    noStore(res);
    const token = typeof req.params.token === "string" ? req.params.token : "";
    const check = emails.checkConfirm(token, now());
    if (!check.ok) return void res.status(410).type("text/plain; charset=utf-8").send(`${NOT_VALID}\n`);
    res.type("text/html; charset=utf-8").send(
      page(
        `Confirm your question to ${vendorName}`,
        `<p>Confirm that you asked ${esc(vendorName)} support a question. ${esc(vendorName)} can then email you their reply if your coding agent's session has ended.</p>
<form method="post"><button type="submit">Confirm</button></form>
<p>If you did not ask, close this page.</p>`,
      ),
    );
  };
}

export function confirmSubmitHandler(vendorName: string, emails: SupportEmails, now: () => number = () => Date.now()) {
  return async (req: Request, res: Response) => {
    noStore(res);
    const token = typeof req.params.token === "string" ? req.params.token : "";
    const r = await emails.confirm(token, now());
    if (!r.ok) return void res.status(410).type("text/plain; charset=utf-8").send(`${NOT_VALID}\n`);
    res.type("text/html; charset=utf-8").send(page("Confirmed", `<p>Confirmed. ${esc(vendorName)} support can now email you their reply. You can close this page.</p>`));
  };
}
