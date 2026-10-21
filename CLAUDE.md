# mudroom-support: working rules

A support door for developer-facing SaaS: a developer's coding agent asks a question over HTTP, the vendor's support team replies in a Slack thread, and the reply goes back to the agent (long-poll) or, when the session has closed, by email. Copied from mudroom-ai/gateway with booking stripped out. Task and decision ids in code comments (T1-T8, R1-R10) refer to the maintainer's design notes, which are not published.

## Product rules

- **Agent-only, no human UI.** Never add a booking form, dashboard or web inbox. Support staff work in their own channel (Slack). Developers work in their coding agent. A browser hitting `/` gets only pointers to `/llms.txt`.
- **HTTP-only.** No MCP server. Agents use plain HTTP and learn the door from `llms.txt` / `openapi.json`.
- **Zero install on the developer side.** No plugin, hooks or local config. Anything the agent needs has to be in `llms.txt`, with the vendor's docs linking to it.
- **Support types free-text replies** in its own channel. No buttons, forms or reply codes.
- **Safe defaults on day one.** The repo becomes public at some point, so the shipped wording and defaults have to be safe without a vendor tuning them.

## Connector developer-experience rule

A connector is any file under `src/connectors/` that implements one of the connector interfaces in `src/connectors/types.ts` (`CommunicationConnector`, `RequesterNotifier`). The current list is the registry table in `docs/connectors/README.md`.

**Whenever a connector is added or its behaviour changes, the change isn't done until the connector checklist in `docs/connectors/README.md` passes.** In the same change, that means:

1. **Documentation**: `docs/connectors/<name>.md` is current and has every required heading (Overview, Prerequisites, Setup, Use cases, Limitations, Errors, Env vars, Tests). The README's *Connectors* table links to it, and every env var it reads is listed in `docs/configuration.md`.
2. **Tests**: `test/<name>.test.ts` covers the changed behaviour against a scripted fake of the platform, never the live API. Every `ConnectorError` code the connector can throw has a test.
3. **Use cases**: the doc's *Use cases* section lists what an agent can do through this connector end to end (ask, wait for the reply, follow up, close, get the reply by email) and what it can't (there is no find, quote, book, cancel or reschedule).
4. **Onboarding**: `npm run init` (`src/cli/init.ts`, `INIT_STEPS`) covers the connector, its `--help` text names it and its env vars, and the startup check (`checkAccess`) prints a fix hint a vendor can act on.

`test/connectors-dx.test.ts` checks the mechanical parts of this list. `npm test` fails when a connector is missing a doc, a heading, a test file, a README link, an init step or `--help` mention, a registry row, or an env var in `docs/configuration.md`. Don't weaken that test to get a change through. Finish the checklist instead.

New connector: copy `docs/connectors/_template.md` to `docs/connectors/<name>.md`, add its row to the registry table in `docs/connectors/README.md`, add a step to `INIT_STEPS`, and add `<name>` to `CONNECTORS` in `test/connectors-dx.test.ts`.

## Other conventions

- Config comes only from env vars (`src/config.ts`). Every new key is declared there with its default and documented in `docs/configuration.md`. Missing required vars stop startup with a fix hint.
- Example phone numbers in docs and tests use `+1 202 555 0199`, a real area code with a reserved 555-01xx number (the convention is carried over from the gateway).
- Every HTTP route returns errors in one shape (`src/errors.ts`, `docs/errors.md`, kept in step by `test/errors-docs.test.ts`). Connectors throw `ConnectorError` and never build HTTP responses themselves.
- Tests stay light: they prove the approved behaviour, with no depth for its own sake.
