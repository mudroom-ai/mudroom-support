# Security policy

A mudroom-support server holds a vendor's Slack bot and app tokens and, optionally, a Resend API key that sends mail from the vendor's own domain. It also exposes a public API: anyone can post a question into the vendor's support channel, read a thread with its token, and cause reply and confirm emails to be sent. A vulnerability here can reach all of that, so reports matter.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: <https://github.com/mudroom-ai/mudroom-support/security/advisories/new>.

Do not post vulnerabilities in public issues or pull requests. Include the version or commit, the connector involved, and steps to reproduce.

## What to expect

- We acknowledge a report within 3 business days.
- Fix timelines are best-effort, and we will keep you updated.
- We credit reporters in the advisory if you ask.
- There is no bug bounty.

## Supported versions

Only the latest release gets fixes.

## Scope

Self-hosted deployments are the operator's responsibility: the host, the reverse proxy or tunnel, secrets storage, access to `.env`, and who can read the Slack channel. For hardening (`ALLOWED_HOSTS`, `TRUST_PROXY`, rate limits, `API_KEYS` bearer keys, `support.require_confirm`) see [docs/deploy.md](docs/deploy.md) and [docs/configuration.md](docs/configuration.md).

A bug in the server's own code is in scope, for example:

- reading or posting to a thread without its `x-thread-token` or resume token, or a token leaking into logs, Slack or email;
- a secret pattern getting past masking and being stored or posted to Slack;
- text from a question that pings people or breaks formatting in Slack (`@channel`, mentions, links that look like the vendor's);
- sending emails past the documented caps, or to an address in a way the confirm step should prevent;
- bypassing a rate limit or per-contact limit, or locking out someone else's address;
- injection through a connector.

Test only against your own deployment, never someone else's live server: it posts into a real support team's Slack and sends real email.
