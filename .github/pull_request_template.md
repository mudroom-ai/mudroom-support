## What

## Why

<!-- Who is affected, and what breaks or what becomes possible. One line. -->

## How did you test this

<!-- Do not claim manual testing you did not do. -->

**Test rationale:** <!-- Name the regression this covers and the closest existing test, or say why no new test is needed. -->

## Connector checklist

Delete this section if the change does not touch `src/connectors/`. Otherwise, per `docs/connectors/README.md`:

- [ ] `docs/connectors/<name>.md` updated (all headings); README *Connectors* table row links it; env vars in `docs/configuration.md`
- [ ] `test/<name>.test.ts` covers the changed behaviour and every `ConnectorError` code
- [ ] *Use cases* section says what agents can and cannot do; `llms.txt` updated if agents must know
- [ ] `npm run init` handles it; `--help` names it; `checkAccess` gives a vendor-actionable hint
- [ ] `npm test` passes (`connectors-dx.test.ts` included)

## Agent context

<!-- Fill this in if an agent co-authored or authored this PR. Delete it otherwise. -->

- **Autonomy:** Human-driven (agent-assisted) | Fully autonomous
- **Agent:** tool, model

<!-- Any skills, prompts or decisions a reviewer should look at? -->
