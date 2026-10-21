# mudroom-support docs

- [configuration.md](configuration.md): every environment variable and the built-in defaults
- [deploy.md](deploy.md): Docker, client IPs and `TRUST_PROXY`, HTTPS tunnels, platform hosting, operations
- [discovery.md](discovery.md): where to link the door (API errors, SDK messages, README, docs) so agents find it
- [errors.md](errors.md): the one error shape and every code
- [connectors/README.md](connectors/README.md): the two connector kinds (support channel, requester notifier), the registry, and the definition of done for adding one
- [connectors/slack.md](connectors/slack.md): Slack support channel with two-way threads; Socket Mode, no inbound URL
- [connectors/resend.md](connectors/resend.md): optional Resend notifier that emails a reply when the agent session has closed

The agent-facing contract is served by the running server itself, at `/llms.txt` and `/openapi.json`.
