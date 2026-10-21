# Contributing

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). AI-assisted contributions follow the [AI policy](AI_POLICY.md).

Just open a pull request. For anything larger than a small fix, open an issue first so we can agree on the approach; we do not assign issues, link yours in the PR.

## Scope

mudroom-support is deliberately small. Before proposing a feature, check it against the product rules in [CLAUDE.md](CLAUDE.md): agent-only with no human UI (no dashboard, form or web inbox), HTTP-only (no MCP server), nothing for developers to install, and free-text replies from support in their own channel. PRs that break one of these will be closed.

## Dev setup

Needs Node >= 22.13 and npm.

```bash
git clone https://github.com/mudroom-ai/mudroom-support.git && cd mudroom-support
npm ci
npm run build && npm run init   # prints the env vars to put in .env
npm run dev         # watch mode on src/server.ts
npm test            # vitest
npm run typecheck
npm run build
```

All configuration is env vars: [docs/configuration.md](docs/configuration.md). To run the server for real you need a Slack app ([docs/connectors/slack.md](docs/connectors/slack.md)); tests do not.

## Tests

Tests use vitest. They run against scripted fakes of Slack and Resend, never live APIs. From [CLAUDE.md](CLAUDE.md): connector tests cover "the changed behaviour against a scripted fake of the platform, never the live API. Every `ConnectorError` code the connector can throw has a test."

Keep tests light: cover the behaviour you changed.

Conventions:

- Errors share one shape across every HTTP route (`src/errors.ts`, [docs/errors.md](docs/errors.md), kept in step by `test/errors-docs.test.ts`). Connectors throw `ConnectorError` and never shape HTTP responses themselves.
- Every new env var is declared in `src/config.ts` with its default and documented in [docs/configuration.md](docs/configuration.md).
- If agents need to know about a change, update `llms.txt` (`src/adapters/agents.ts`) and `test/agents.test.ts` in the same PR.

## Adding or changing a connector

A connector change is not done until the checklist in [docs/connectors/README.md](docs/connectors/README.md) passes: docs, tests, use cases, onboarding. [CLAUDE.md](CLAUDE.md) has the short version. A new connector starts from [docs/connectors/_template.md](docs/connectors/_template.md).

`test/connectors-dx.test.ts` checks the mechanical parts and fails `npm test` when something is missing. Do not weaken it to make a change pass; finish the checklist.

## Pull requests

- One change per PR.
- Fill in the PR template.
- CI must pass: `npm run typecheck`, `npm run build` and `npm test` on Node 22 and 24. Run them locally first.
- Update the docs in the same PR as the behaviour they describe.
- Contributions are licensed under Apache-2.0, the same as the project ([LICENSE](LICENSE)).

## External PRs: what to expect

There is one maintainer. Reviews can take days to a couple of weeks. We may close PRs that are out of scope, add long-term maintenance burden, or go stale; you can reopen them. Keep changes focused, run tests locally and respond to review.

## Bugs

Open a GitHub issue with the version, connector, agent and steps to reproduce. For questions, see [SUPPORT.md](SUPPORT.md). Security issues do not go in issues; see [SECURITY.md](SECURITY.md).
