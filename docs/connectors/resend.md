# Resend connector

## Overview

[Resend](https://resend.com) is an email-sending API. This connector is the support door's requester notifier: when support replies after the developer's agent session has closed, the door emails the reply to the developer. It implements `RequesterNotifier` (`src/connectors/types.ts`); the source is `src/connectors/resend.ts` (`ResendNotifier`, built by `createResendNotifier`).

**You, the vendor, own the Resend account and the sending domain.** Emails go out from your own domain (`support@acme.dev`), under your own Resend key, quota and reputation. Mudroom's domain is used only for the founder-run demo, never for a vendor's install.

It is optional. Without it, replies reach only open agent sessions (long-poll), and startup logs a warning naming `RESEND_API_KEY` and `EMAIL_FROM`.

Status: built and wired. `main()` creates it from `RESEND_API_KEY` and `EMAIL_FROM`, checks access at startup (a bad key or unverified domain stops startup with its fix hint), and uses it for admin alerts, the per-question confirm email, coalesced reply emails and the "didn't reach" email (`src/emails.ts`).

## Prerequisites

- A Resend account (the free plan is enough to start; check its daily and monthly sending quotas against your support volume).
- A domain or subdomain you control DNS for, added and **verified** in Resend: its SPF and DKIM records must be in DNS. Resend's shared test sender (`onboarding@resend.dev`) can only email your own address, so it does not work here.
- Outbound HTTPS from the server to `api.resend.com`.

## Setup

1. In Resend, open **Domains** and click **Add Domain**. Enter the domain you send from (a subdomain such as `support.acme.dev` keeps support mail apart from your marketing mail).
2. Add the DNS records Resend shows (the SPF and DKIM records) at your DNS host, then click **Verify DNS Records** and wait until the domain shows **Verified**.
3. Open **API Keys**, click **Create API Key**, choose **Sending access** (optionally limited to that domain), and copy the key (`re_...`). It is shown once.
4. Set the env vars:
   ```bash
   RESEND_API_KEY=re_...
   EMAIL_FROM="Acme support <support@acme.dev>"
   ```
   The address in `EMAIL_FROM` must be on the domain verified in step 2.
5. Run `npm run init` to see these vars listed under `resend (optional)`, then `npm start`.

The startup check (`checkAccess`) calls Resend's domains API and confirms the key works and the `EMAIL_FROM` domain is verified. A **Sending access** key cannot list domains (Resend answers `restricted_api_key`), so with that kind of key the check confirms only that the key is accepted, logs a warning, and an unverified domain shows up on the first send as `notifier_domain_unverified`. A **Full access** key gets the full check, but sending access is the safer key to keep on a server.

## Use cases

What a developer and their agent get end to end once Resend is set up:

- **Ask** a question over HTTP (`POST /api/messages`) with the developer's email as the requester; nothing is emailed while the agent keeps listening. A support reply the agent hasn't read within `support.reply_email_grace_min` is emailed to that address. With `support.require_confirm` on, if the agent stops reading (session closed, laptop asleep, wait loop gave up) for `support.agent_gone_after_min` before it received support's answer, the developer gets one confirm email for that question.
- **Wait for the reply** in the agent session (long-poll). When the session has closed, the reply arrives **by email** a few minutes after support types it (coalesced: at most one email per thread per 15 minutes).
- **Follow up** and **close** stay in the agent: the email carries a link that lets a later agent session resume the thread.

What it cannot do: the email is one-way. Replying to the email does not reach support, and there is no find, quote, book, cancel or reschedule in the support door. With `support.require_confirm` on, reply and "didn't reach" emails go only for a question its requester confirmed; an address confirmed for an earlier question does not count.

## Limitations

- Resend allows about 10 API requests per second per team by default, and plan quotas cap emails per day and per month. Over either, sends fail with `notifier_unavailable` and the reply-email queue retries later.
- Resend keeps an idempotency key for 24 hours. A retry of the same email after that could send it twice, so the reply-email queue has to give up on an email within 24 hours.
- Plain-text emails only (`text`); no HTML, attachments or reply-to threading.
- Deliverability (spam folders, bounces) depends on your domain's SPF/DKIM/DMARC setup and reputation, which the server cannot see.

## Errors

`sendEmail` and `checkAccess` throw these `ConnectorError` codes; the core never shows Resend's raw error to the agent.

| Code | When | What happens |
|---|---|---|
| `notifier_auth_failed` | Resend answers 401, or names the key as missing, invalid, suspended, inactive or lacking permission. | Permanent. Fix hint: `RESEND_API_KEY was rejected; create a key with sending access at resend.com/api-keys`. At startup the vendor sees it; at send time the email is not retried. |
| `notifier_domain_unverified` | The `EMAIL_FROM` domain is not in the Resend account, not yet verified, or Resend refuses the From address (`invalid_from_address`, "domain is not verified", test-sender-only). | Permanent until fixed. Fix hint: `verify <domain> in Resend and add its SPF/DKIM records`. |
| `notifier_rejected` | Any other 4xx: a bad recipient address, a validation error, or an idempotency key reused with a different email (409 `invalid_idempotent_request`, marked `detail: "idempotency_mismatch"`). | Not retried; the thread notes the developer was not emailed. The exception is `idempotency_mismatch` on a reply email (a retry after a timeout carries a new resume link): it is resent at once under a fresh key, so the worst case is a duplicate email, not a lost one. |
| `notifier_unavailable` | 429 (rate limit or quota), 5xx, a timeout (10 s), a network error, or 409 `concurrent_idempotent_requests` (the same email is still being sent). | Transient: the reply-email queue retries. `retry_after_s` is Resend's `retry-after` header when sent, else 30 s. |

Half a configuration is a setup error, not a connector error: `createResendNotifier` refuses `RESEND_API_KEY` without `EMAIL_FROM` (or the reverse), and an `EMAIL_FROM` without an `@domain`, with a message naming the missing var.

Retries never deliver twice: every send carries Resend's `Idempotency-Key` header, set to a key that stays the same across retries of one email, and Resend answers a repeat with the original result without sending again.

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `RESEND_API_KEY` | unset | Your own Resend API key (`re_...`), **Sending access** is enough. Secret. |
| `EMAIL_FROM` | unset | The From header, an address on your Resend-verified domain, e.g. `Acme support <support@acme.dev>`. |

Set both or neither. Neither means no reply emails (session-only delivery).

## Tests

`test/resend.test.ts` runs against a scripted fake of the Resend API (an injected `fetch` with a route table for `POST /emails` and `GET /domains`); it never calls the live API. It covers a successful send (bearer key, `User-Agent`, `Idempotency-Key`, body), the same key on a retry, every code in the table above, `retry_after_s` from `retry-after`, the startup check for a verified, pending and missing domain and for a sending-only key, and the factory's not-configured and half-configured cases.

API facts were checked against Resend's docs on 2026-10-19: [send email](https://resend.com/docs/api-reference/emails/send-email), [idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys), [errors](https://resend.com/docs/api-reference/errors), [list domains](https://resend.com/docs/api-reference/domains/list-domains), [domain statuses](https://resend.com/docs/dashboard/domains/manage-domains), [API key permissions](https://resend.com/docs/api-reference/api-keys/create-api-key), [rate limits](https://resend.com/docs/api-reference/rate-limit).
