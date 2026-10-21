# Configuration

Everything comes from environment variables; there is no config file. `npm start` loads `.env` if present (`node --env-file-if-exists`), and `npm run init` prints the variables to set. The server refuses to start when a required variable is missing and names each one with a fix hint.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `VENDOR_NAME` | **required** | Your name as developers know it (`Acme`). Shown in `/llms.txt`, `/openapi.json`, Slack and emails |
| `PUBLIC_URL` | **required** | This door's public base URL (`https://support.acme.dev`), used in every link agents and emails get. A trailing slash is dropped |
| `SLACK_BOT_TOKEN` | **required** | Slack support channel: Bot User OAuth Token (`xoxb-...`). See [connectors/slack.md](connectors/slack.md) |
| `SLACK_APP_TOKEN` | **required** | Slack: app-level token (`xapp-...`) with `connections:write`, for Socket Mode |
| `SLACK_CHANNEL_ID` | **required** | Slack: the channel (`C...`) the app is invited to. A partial set, or the two tokens swapped, stops startup |
| `SLACK_OWNER_USER_IDS` | unset | Slack: optional comma list of user ids (`U...`) whose thread replies count as support's. Unset means anyone in the channel |
| `RESEND_API_KEY` | unset | Optional email notifier: your own Resend API key with sending access. Without it (and `EMAIL_FROM`) replies reach only open agent sessions, and startup logs a warning naming both vars. See [connectors/resend.md](connectors/resend.md). Set both or neither |
| `EMAIL_FROM` | unset | Optional: the From address on your Resend-verified domain (SPF/DKIM set up), e.g. `Acme support <support@acme.dev>`. Your domain, not Mudroom's |
| `ADMIN_EMAIL` | unset | Optional: who is emailed at once when Slack delivery fails for good (bot removed, token revoked, channel gone). Needs the Resend notifier (`RESEND_API_KEY`, `EMAIL_FROM`) |
| `PORT` | `3000` | |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Bind address |
| `ALLOWED_HOSTS` | unset | Comma list of public/tunnel hostnames accepted in `Host`. **Required behind a tunnel** when `HOST` is loopback |
| `DB_PATH` | `support.sqlite` (`/data/support.sqlite` in Docker) | SQLite file (threads, replies, outbox, idempotency keys, event log). Must be on persistent storage: agents keep thread ids across sessions |
| `MESSAGES_ENABLED` | `true` | Kill switch: `false` answers the message routes with `messages_disabled` |
| `API_KEYS` | unset | Optional comma list of bearer keys (higher limits; when set, any other `Authorization` value gets 401; when unset the header is ignored) |
| `TRUST_PROXY` | `loopback` | Which peers may set the client IP (`X-Forwarded-For`/`CF-Connecting-IP`) for per-IP limits: hop count, IP/CIDR list, or `false`. **Set it behind Docker or a PaaS** (Railway: `2`). See [deploy.md](deploy.md#2-client-ips-and-trust_proxy) |
| `TRUST_PROXY_DEBUG` | `false` | Log how each anonymous caller's IP was resolved, to check `TRUST_PROXY` |
| `TRUST_CF_CONNECTING_IP` | `false` | Also honor `CF-Connecting-IP` from trusted peers. Only when the trusted proxy is cloudflared/Cloudflare |

## Built-in defaults

These are settings in `src/config.ts` (`limits` and `support`), not env vars yet. The `support` values are the approved defaults from the design's eng review (R3).

| Setting | Default | Meaning |
|---|---|---|
| `limits.per_ip_per_min` / `per_key_per_min` | 60 / 600 | Request limits for anonymous callers (per IP, IPv6 by /64) and keyed agents |
| `limits.per_contact_per_hour` | 10 | New questions per requester email per hour, counting only questions the requester confirmed by email (so nobody can spend someone else's quota); unconfirmed ones are bounded by `max_unconfirmed_threads_per_caller` and the request limits |
| `limits.max_messages_per_hour` | 30 | Vendor-wide cap on new questions and follow-ups |
| `limits.max_open_threads_per_contact` | 3 | Open questions per requester email, counting only questions the requester confirmed by email (so nobody can lock out someone else's address) |
| `limits.max_unconfirmed_threads_per_caller` | 5 | Questions still waiting for support's first answer and not confirmed by email, per caller (IP, IPv6 by /64, or API key). Answered questions don't count |
| `limits.thread_close_after_reply_hours` | 168 (7 days) | An answered thread closes this long after support's last reply when the agent sends nothing more |
| `limits.thread_close_unanswered_days` | 7 | A thread still waiting for support closes this long after the last agent message |
| `limits.thread_wait_max_seconds` | 120 | Longest hold for `GET /api/threads/:id?wait=N` (0 to 240; 0 turns long-polling off) |
| `limits.max_waiting_requests` | 200 | Held long-polls across all threads; over it a request answers at once |
| `support.field_caps` | message 2000, error 4000, tried 2000, environment 500 | Character caps on a question's fields; over a cap is rejected, never truncated (T4a) |
| `support.reply_email_grace_min` | 5 | A reply email waits this long after a support reply (T5b) |
| `support.reply_email_spacing_min` | 15 | At most one reply email per thread per this many minutes (T5b) |
| `support.verified_address_days` | 90 | How long a confirmed address is remembered as verified (T5b). It does not decide email sending: reply and delivery-failed emails go only for a question its requester confirmed |
| `support.require_confirm` | `false` | Off: a reply the agent missed is emailed straight to the requester's address. On: the developer must first click a confirm email (sent when the agent stops listening); per-contact limits count confirmed questions only. Anyone can name any address, so turn it on if unwanted reply emails become a problem |
| `support.agent_gone_after_min` | 6 | With `require_confirm` on: no read from the agent for this long, before it received support's answer, means its session ended. Only then is the confirm email sent. Keep it above the wait loop's 5-minute back-off |
| `support.confirm_emails_per_address_per_day` / `per_vendor_per_day` | 3 / 50 | Caps on confirm emails (T5b) |
| `support.confirm_link_hours` | 24 | A confirm link works this long, once, by POST (T5b) |
| `support.slack_retry_window_hours` | 24 | A Slack post keeps retrying this long before the thread's delivery becomes `failed` (T3) |
| `support.slack_retry_max_backoff_min` | 30 | Longest wait between Slack retries (T3) |
