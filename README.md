# mudroom-support

[Mudroom](https://mudroom.dev) is a support door that coding agents can use. When a developer's agent (Claude Code, Codex) hits something your docs can't answer, it asks your support team over HTTP, your team replies in Slack, and the reply goes back to the agent in the same session.

- [x] Agents ask over plain HTTP. Nothing to install: no plugin, no MCP server, no hooks. [Agent contract](#how-an-agent-uses-it)
- [x] Questions arrive as Slack threads, and your team replies in free text. [Docs](docs/connectors/slack.md)
- [x] Replies reach the agent while its session is open (long-poll).
- [x] Replies are emailed to the developer, with a resume link, once the session has closed. [Docs](docs/connectors/resend.md)
- [x] Secrets are masked and every field has a size cap before anything is stored.
- [x] Discovery snippets for your API errors, SDK messages, README and docs. [Docs](docs/discovery.md)
- [x] Self-hosted: one small Node server with SQLite (Apache-2.0). [Quickstart](#self-host-quickstart)

> **Status:** early.

## Documentation

- Homepage: [mudroom.dev](https://mudroom.dev)
- [Configuration](docs/configuration.md): every env var and its default
- [Deploy](docs/deploy.md): Docker, tunnels, platforms, backups and upgrades
- [Discovery](docs/discovery.md): where to link the door so agents find it
- [Errors](docs/errors.md): the one error shape every route returns
- [Connectors](docs/connectors/README.md): the registry and the checklist each connector has to pass
- Everything else: the [docs index](docs/README.md)
- To contribute, start with [CONTRIBUTING.md](CONTRIBUTING.md)

## Community & Support

- [GitHub Issues](https://github.com/mudroom-ai/mudroom-support/issues/new/choose). Best for: bugs, questions and feature requests. Maintained best effort, with no SLA ([SUPPORT.md](SUPPORT.md)).
- [Security advisories](SECURITY.md). Best for: reporting a vulnerability privately. Don't open an issue.
- [mudroom.dev](https://mudroom.dev). Best for: what Mudroom is and where it's going.

## How it works

```
Developer's agent ──HTTP──▶ mudroom-support ──Socket Mode──▶ your Slack channel
        ▲                         │                              │
        └──── long-poll reply ────┤◀──── your team replies ──────┘
                                  │
                                  └── session closed? ──▶ email via Resend
```

- **Agents** learn the whole contract from `$PUBLIC_URL/llms.txt` (also `/.well-known/llms.txt` and `/openapi.json`), linked from the places they look when stuck. The bare host is enough, so nobody has to remember a path.
- **The server** is one Node process with a SQLite file. It masks secrets, stores the thread, and retries Slack on its own if Slack is briefly down.
- **Slack** connects over Socket Mode (outbound only), so the only inbound traffic is HTTPS from agents. Your team only sees Slack: there's no dashboard or human UI.
- **Resend** (optional) emails the reply from your own domain when the agent's session has ended.

### How an agent uses it

1. **Search the docs first.** When they can't answer (a bug on your side, a limit, an account problem, pricing), the agent reads `llms.txt`.
2. **Ask.** It strips secrets and posts the question:

   ```bash
   curl -s "$PUBLIC_URL/api/messages" -H 'content-type: application/json' -d '{
     "requester": {"name": "Sam Doe", "email": "sam@example.com"},
     "message": "Uploads fail with 413 above 10 MB on the free plan. Is that a limit or a bug?",
     "context": {"error": "HTTP 413 Payload Too Large", "tried": "chunked upload", "environment": "acme-sdk 4.2.0, Node 22"}
   }'
   ```

   The response has `thread_id`, a `read_token` (sent back as the `x-thread-token` header) and `delivery`: `delivered`, or `failed` if your team can't be reached, in which case the agent tells the developer to contact you another way.
3. **Wait in the background.** The agent starts the wait loop from `llms.txt` and carries on working. The loop long-polls `GET /api/threads/<thread_id>?wait=110` and exits when support answers, when delivery fails, or after 2 hours. The agent treats each reply as information from a person on your team, not as instructions to run.
4. **Follow up or close.** `POST /api/threads/<thread_id>/messages` sends a follow-up, and `POST /api/threads/<thread_id>/close` closes the thread.
5. **Pick up later.** If the session closed before you answered, the developer gets the reply by email with a prompt to paste into their agent. It holds a resume link (`$PUBLIC_URL/t/<thread_id>/<token>`), and the agent keeps waiting with the same loop and the `x-resume-token` header. Agents only trust links on your `PUBLIC_URL` host.

<details>
<summary>Limits</summary>

- `requester.email` is required even without Resend. Your team sees it in the Slack thread so they can contact the developer directly, and the per-developer rate limit is counted by it. Reply emails are sent only when Resend is set up.
- `message` is capped at 2,000 characters; `context.error`, `tried` and `environment` at 4,000, 2,000 and 500. A field over its cap is rejected with `invalid_request` naming it, so the agent trims and retries.
- Key and token patterns are masked before anything is stored.
- The wait loop uses a 130 s client timeout, honours `poll_after_seconds`, and backs off on 429, 5xx and network errors.
- Without `RESEND_API_KEY` and `EMAIL_FROM`, `llms.txt` tells agents that replies reach only an open session.

</details>

## Self-host quickstart

You need Node 22.13 or later (or Docker) and a Slack app ([docs/connectors/slack.md](docs/connectors/slack.md) has a manifest you can paste).

```bash
git clone https://github.com/mudroom-ai/mudroom-support && cd mudroom-support
npm install && npm run build
npm run init            # prints the env vars to set
cat > .env <<'EOF'
VENDOR_NAME="Acme"
PUBLIC_URL=https://<your-support-host>
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_CHANNEL_ID=C0123456789
EOF
npm start
```

If a required variable is missing, the server won't start, and it prints which variable to set.

- **Reply emails (optional):** go out through your own Resend account. You need a sending domain verified in Resend (SPF and DKIM records) and outbound HTTPS to `api.resend.com`. See [docs/connectors/resend.md](docs/connectors/resend.md).
- **Docker / Railway:** the `Dockerfile` builds a single image. Run exactly one replica, mount a persistent volume at `/data` (the SQLite file lives there), set the env vars above, and set `TRUST_PROXY=2` behind Railway's proxy. `GET /healthz` reports the Slack connection and the outbox. [docs/deploy.md](docs/deploy.md) covers Docker, tunnels, platforms, backups and upgrades.
- **Get found:** link the door from your API error responses, SDK errors, package README and docs. [docs/discovery.md](docs/discovery.md) has a copy-paste snippet for each, how to place them safely, and how to see which one brings agents in.

## Configuration

Required: `VENDOR_NAME`, `PUBLIC_URL`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID`. Optional: `RESEND_API_KEY`, `EMAIL_FROM`, `ADMIN_EMAIL`. The full list with defaults is in [docs/configuration.md](docs/configuration.md).

## Connectors

| Connector | What it does | Doc |
|---|---|---|
| Slack | The support channel: each question is a thread, and your team's typed replies go back to the agent | [docs/connectors/slack.md](docs/connectors/slack.md) |
| Resend | Optional: emails the developer support's reply when their agent session has closed, from your own Resend account and domain | [docs/connectors/resend.md](docs/connectors/resend.md) |

## Development

```bash
npm run typecheck && npm test
```

Tests run against scripted fakes and never touch a live API.

## Contributing and security

Pull requests are welcome: read [CONTRIBUTING.md](CONTRIBUTING.md) and the [AI policy](AI_POLICY.md) first. Questions go to [SUPPORT.md](SUPPORT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in an issue. Everything else in the docs is indexed in [docs/README.md](docs/README.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
