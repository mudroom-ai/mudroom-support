# Errors

Every route returns the same error body:

```json
{ "code": "rate_limited", "message": "...", "retryable": true, "retry_after_s": 30 }
```

`retry_after_s` appears only when it applies. Over HTTP the status matches the code and a `Retry-After` header is sent when `retry_after_s` is set. The list below is the contract: adding a code is fine, renaming one or changing its status or retryability is a breaking change (`src/errors.ts`).

## Codes

| Code | HTTP | Retryable | Meaning |
|---|---|---|---|
| `invalid_request` | 400 | no | Malformed arguments, malformed JSON, an unknown endpoint, or a field over its cap (the message names the field and the cap) |
| `invalid_customer` | 400 | no | `requester` is missing its name or a valid email, or the name has a line break, control character or text-direction override |
| `invalid_message` | 400 | no | New question / follow-up: message empty or containing control characters |
| `unauthorized` | 401 | no | A bearer key was sent but is not in `API_KEYS` |
| `unknown_thread` | 404 | no | No such `thread_id`, or the `read_token` is missing or wrong (the body is identical in all three cases) |
| `idempotency_conflict` | 409 | no | Same `idempotency_key`, different payload |
| `thread_closed` | 409 | no | Follow-up on a closed thread (closed by the agent, by support, or after going quiet), or a thread that reached 20 agent messages; ask a new question. Closing a closed thread is not an error |
| `thread_limit_reached` | 409 | no | The requester has `max_open_threads_per_contact` open confirmed questions, or this caller has `max_unconfirmed_threads_per_caller` unanswered unconfirmed ones; closing one, support answering one, or confirming by email clears it |
| `message_in_progress` | 409 | yes | Same `idempotency_key` while the first request is still being delivered; retry with the same key to get its result |
| `rate_limited` | 429 | yes | Per-IP or per-key limit, a contact's hourly limit, or the vendor-wide `max_messages_per_hour`; wait `retry_after_s` |
| `messages_disabled` | 503 | no | `MESSAGES_ENABLED=false` kill switch |
| `channel_unavailable` | 503 | no | The support channel refused this message itself (for example, too long); nothing was stored. Tell the user to reach the vendor another way. Channel outages and setup errors are not errors here: the question is accepted with `delivery: "delivered"` and the server retries it for up to 24 h |
| `internal` | 500 | yes | Unexpected failure |

## Connector errors

Connectors never shape responses. They throw `ConnectorError` and the core decides what the agent sees.

The support channel (`CommunicationConnector`, Slack) throws three codes. `channel_unavailable` (429, 5xx, timeout) is transient and `channel_auth_failed` (bot removed, token revoked, channel archived) heals once the vendor fixes the app: for both, the message is stored and retried for up to `support.slack_retry_window_hours` (24), and the agent sees `delivery: "delivered"`; a setup error also emails `ADMIN_EMAIL` once and shows on `/healthz`. `channel_rejected` means the channel refused this message itself: on the first post nothing is stored and the agent gets 503 `channel_unavailable` with `retryable: false`; on a retry the message ends failed.

`delivery` on a thread has two values: `delivered` (accepted; the server gets it to the support channel, retrying by itself) and `failed` (the retry window ran out, or the channel refused the message for good). Tell the user to reach the vendor another way on `failed`.

The email notifier (`RequesterNotifier`) has four codes reserved in `src/connectors/types.ts`: `notifier_auth_failed`, `notifier_domain_unverified`, `notifier_rejected` and `notifier_unavailable`. They never reach an agent.
