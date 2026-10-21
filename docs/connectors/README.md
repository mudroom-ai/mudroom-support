# Connectors

A connector is the support door's adapter to one outside system. There are two kinds, each with its contract in `src/connectors/types.ts`:

- **Support channel** (`CommunicationConnector`): where the vendor's support team reads questions from agents and types replies (Slack). A thread-capable channel carries each question as a thread; its thread methods throw `channel_*` codes so the core can queue (transient) or refuse (permanent).
- **Requester notifier** (`RequesterNotifier`): how a reply reaches the developer by email when their agent session has closed. Its methods throw `notifier_*` codes. The vendor brings its own provider account and sending domain.

## Registry

| Name | Kind | Source | Doc | Tests | Status |
|---|---|---|---|---|---|
| `slack` | Support channel (`CommunicationConnector`, two-way threads) | `src/connectors/slack.ts` (+ `slack-socket.ts`) | [slack.md](slack.md) | `test/slack.test.ts` | Experimental |
| `resend` | Requester notifier (`RequesterNotifier`, email) | `src/connectors/resend.ts` | [resend.md](resend.md) | `test/resend.test.ts` | Experimental |

The README's *Connectors* table links each doc; this file is the full registry.

## Definition of done for a connector change

Every change that adds a connector or changes one must tick all of these. `test/connectors-dx.test.ts` enforces the mechanical items; the rest are reviewed by hand.

### 1. Documentation

- [ ] `docs/connectors/<name>.md` exists and has these headings, in this order: **Overview, Prerequisites, Setup, Use cases, Limitations, Errors, Env vars, Tests**.
- [ ] The README's *Connectors* table has a row linking `docs/connectors/<name>.md`.
- [ ] The README's *Self-host* section mentions anything a host needs (outbound access, secrets, DNS records).
- [ ] Every env var the connector reads is in the `docs/configuration.md` env table and in the doc's *Env vars* section.

### 2. Tests

- [ ] `test/<name>.test.ts` exists and runs against a scripted fake of the platform (route table or fake HTTP), never the live API.
- [ ] Every `ConnectorError` code the connector can throw has at least one test that triggers it.
- [ ] Retries never deliver twice (support channel: a dedupe key looked up before every re-send; notifier: a stable `idempotency_key`).
- [ ] `checkAccess` failure paths produce a fix hint a vendor can act on.

### 3. Use cases

- [ ] The doc's *Use cases* section says what an agent can do end to end through this connector (ask, wait, follow up, close, get the reply by email) and what it cannot (there is no find, quote, book, cancel or reschedule).
- [ ] Anything the agent must know is also in `llms.txt` (`src/adapters/agents.ts`).

### 4. Onboarding

- [ ] `npm run init` (`src/cli/init.ts`) has a step for the connector in `INIT_STEPS`, and `npm run init -- --help` names it and its env vars.
- [ ] The startup check (`checkAccess`) prints a fix hint a vendor can act on, and a missing required var stops startup naming it.
- [ ] A vendor can follow the *Setup* section alone. Steps name the exact menu labels of the platform.

## Adding a connector

1. Implement it in `src/connectors/<name>.ts` behind `CommunicationConnector` or `RequesterNotifier`.
2. Wire it in `src/server.ts`; its env vars are already declared in `src/config.ts` (add any new one there).
3. Add a step to `INIT_STEPS` in `src/cli/init.ts`.
4. Copy `_template.md` to `docs/connectors/<name>.md` and fill every section.
5. Add the README table row, the registry row above, the env vars to `docs/configuration.md`, and `test/<name>.test.ts`.
6. Add `<name>` to `CONNECTORS` in `test/connectors-dx.test.ts` and run `npm test`.
