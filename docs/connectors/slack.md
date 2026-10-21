# Slack connector (support channel with replies)

## Overview

A **Communication** connector: a `CommunicationConnector` with every thread member (`src/connectors/slack.ts`, Socket Mode client in `src/connectors/slack-socket.ts`). It is the support door's required channel: one Slack channel the vendor's support team watches.

- **Each question is a thread.** When a developer's coding agent asks a question (`POST /api/messages`), the server posts it to the channel. Support answers by **typing a reply in that message's thread**; the server stores the reply, adds a ✅ reaction so support knows it arrived, and the agent reads it with `GET /api/threads/:id`. Support never has to end a conversation: the agent closes the thread when the developer has what they need, and an answered thread closes by itself after 7 quiet days.

Inbound replies arrive over Slack **Socket Mode**: the server opens an outbound WebSocket to Slack, so it needs no public URL, no tunnel route and no signing secret. It uses Node's built-in `WebSocket`; there is no Slack SDK dependency.

Delivery survives restarts in both directions, with the six bot scopes from the manifest below:

- **Replies typed while the server was down are picked up.** Socket Mode does not replay events, so on every connect (start, redeploy, reconnect) the server reads each open thread since the last message it handled (`conversations.replies`) and treats what it finds like a live reply: stored once, ✅ added, the agent's `get_thread` answers.
- **Questions survive a Slack outage.** When a post fails, the question is kept and retried for up to 24 hours (`support.slack_retry_window_hours`), waiting 30 s, then twice as long each time, never more than 30 minutes (`support.slack_retry_max_backoff_min`; a longer Slack `Retry-After` wins). Every Socket Mode connect also sends whatever is waiting at once. Meanwhile the agent sees `delivery: "delivered"`: the question is accepted and the server gets it to the channel by itself. Only when the 24 hours run out does the agent see `delivery: "failed"`.
- **A message is posted once.** Every agent message carries an invisible key as Slack message metadata. Before any retry (after a timeout, a Slack error or a crash mid-send) the server looks for that key in the channel (`conversations.history`) or thread and posts only if the message is not already there.

## Prerequisites

- A Slack workspace where the vendor (or whoever runs the server) may **create and install apps**.
- A channel for agent questions. A **private channel** with only the support team and the app is the safest choice (see *Limitations*).
- The host needs outbound HTTPS and WSS to `slack.com` and `*.slack.com`; no inbound URL.
- Node >= 22.4 (built-in `WebSocket`); the server already requires 22.13.

## Setup

1. **Create the app from a manifest.** Go to [api.slack.com/apps](https://api.slack.com/apps), click **Create New App**, choose **From a manifest**, pick your workspace, select **JSON** and paste this. It sets the bot scopes, the event subscriptions and Socket Mode in one step:

   ```json
   {
     "display_information": {
       "name": "Agent desk",
       "description": "Questions from developers' coding agents"
     },
     "features": {
       "bot_user": { "display_name": "Agent desk", "always_online": true }
     },
     "oauth_config": {
       "scopes": {
         "bot": ["chat:write", "channels:history", "groups:history", "channels:read", "groups:read", "reactions:write"]
       }
     },
     "settings": {
       "event_subscriptions": { "bot_events": ["message.channels", "message.groups"] },
       "socket_mode_enabled": true,
       "org_deploy_enabled": false,
       "token_rotation_enabled": false
     }
   }
   ```

   Click **Next**, then **Create**. (No Request URL is needed: Socket Mode delivers events over an outbound websocket.)
2. **Generate the app-level token.** A manifest cannot create tokens. Open **Basic Information**, scroll to **App-Level Tokens**, click **Generate Token and Scopes**, name it `support`, add the scope `connections:write` and click **Generate**. Copy the token that starts with `xapp-`: this is `SLACK_APP_TOKEN`.
3. **Check the manifest took** (optional). **OAuth & Permissions** lists the six bot scopes, **Event Subscriptions** the two bot events, and **Socket Mode** is on. To build the app by hand instead, pick **Blank app** and set those three screens yourself.
4. **Install it.** Open **Install App** and click **Install to Workspace**, then **Allow**. Copy the **Bot User OAuth Token** that starts with `xoxb-`: this is `SLACK_BOT_TOKEN`. If you change scopes later, click **Reinstall to Workspace**.
5. **Invite the app to the channel.** In Slack, open the channel and type `/invite @Agent desk` (your app's name).
6. **Copy the channel ID.** Click the channel name at the top; at the bottom of the **About** tab, copy the **Channel ID** (starts with `C`): this is `SLACK_CHANNEL_ID`.
7. **Optional: owner user IDs.** To make only certain people's replies count, open each person's profile, click **⋮** and **Copy member ID** (starts with `U`). Comma-separate them in `SLACK_OWNER_USER_IDS`.
8. **Set the env vars.** Put the bot token, the app token, the channel ID and (optionally) the owner IDs in `.env` or your host's environment (`npm run init` prints the list). See *Env vars*.

The access check (every `npm start`) calls `auth.test` (bot token), `conversations.info` (channel exists, app is a member, not archived) and `apps.connections.open` (app token and Socket Mode).

## Use cases

What an agent can do end to end through this channel:

- **Ask support a question** the docs cannot answer (a bug on the vendor's side, a limit, an account or pricing question), and **wait for the typed answer** with `GET /api/threads/:id?wait=N`. Follow-ups from the agent land in the same Slack thread.
- **Get the answer after a redeploy.** A reply support typed while the server was stopped or reconnecting arrives when it is back; the agent keeps polling the same thread.
- **Get the answer in plain words.** Support types free text; there are no buttons, forms or reply codes.
- **Ask while Slack is down.** The question is accepted (`delivery: "delivered"`) and posted when Slack is back, within 24 hours.
- **Close the thread when done.** The agent closes the thread (or follows up with `done: true`) once the developer has what they need, and support sees "Thanks, the assistant has what it needs." in the thread.

What it cannot do:

- **Find, quote, book, cancel or reschedule** anything: the support door has no booking.
- **Get an answer typed outside the thread.** Only replies inside a question's thread reach the developer. A top-level message in the channel is the team's own talk: it is never passed on, gets no ✅ and no notice.
- **Reach the developer directly.** Messages go to the vendor's channel only; the email notifier (planned, Resend) covers a closed agent session.
- **Push the reply to the agent.** The agent has to wait on `GET /api/threads/:id`; agents are told to ask the user to check back later.
- **Treat support's text as instructions.** Agents are told the reply is information from the vendor, not a command.

## Limitations

- **Replies during downtime arrive late.** A reply typed in a thread while the server is stopped, restarting or reconnecting gets its ✅ when the server is back. A reply in a thread that closed before the server came back is not picked up. If the catch-up read fails, the server retries every 30 seconds and `/healthz` shows `Slack catch-up failed` until it succeeds.
- **A retry never posts twice, and stops rather than guess.** If the server cannot check whether an earlier attempt reached Slack (a failed read, or more than 2,000 messages to look through), it does not post; only a message from this app's own bot counts as the earlier attempt; when the 24-hour window runs out the message is marked failed and the agent sees `delivery: "failed"`. The closing line is sent once without this check.
- **A broken setup waits for the fix, and the admin hears once.** When Slack refuses because of the app's setup (bot removed from the channel, token revoked, channel archived, missing scope), questions are kept and retried like an outage, so they go out on their own once the setup is fixed within 24 hours. The first such error emails `ADMIN_EMAIL` once (through the email notifier; a different error emails again, the same one does not, for any number of threads) and `/healthz` shows it as `channel.permanent_error` until a post succeeds. Without an email notifier or `ADMIN_EMAIL` the alert is only logged.
- **Anyone in the channel counts as support** unless `SLACK_OWNER_USER_IDS` is set. Use a private channel with only the support team, or set the allowlist; with it set, a reply from someone else gets one notice in the thread and is not passed on.
- **Threads close without support.** The agent closes a thread, or it closes by itself: `limits.thread_close_after_reply_hours` (default 168, 7 days) after support's last reply with no agent follow-up, or `limits.thread_close_unanswered_days` (default 7) while still waiting for the owner. A reply typed in a closed thread gets one notice that the agent will not see it. If an owner types `close`, `closed` or `done` as the whole reply, the thread closes quietly.
- **Only thread replies count.** The opener asks support to reply in the thread. A top-level message in the channel is ignored silently, whoever posts it and however many conversations are waiting, so an internal remark never reaches a developer. Edits, deleted messages and files without text are always ignored.
- **One channel per server.**
- **Plain text only.** Every message is escaped (`&`, `<`, `>`) before it is posted, so text from developers or agents cannot ping `@channel`, fake a mention or make a link; link previews are off.
- **No retry for notices.** A failed one-off notice (the closing line) is logged, never retried; agent messages that hit a Slack failure are kept and retried by the core.
- Slack's own limits apply: about one message per second per channel, and very long messages are refused (`msg_too_long`).

## Errors

Thread methods (`openThread`, `postToThread`) throw these `ConnectorError` codes; the core turns them into the shared error body. `notify` and the ✅ reaction never throw: failures are logged.

| Code | When | What happens |
|---|---|---|
| `channel_unavailable` | Slack answers HTTP 429 (uses `Retry-After`), 5xx, times out (10 s), or returns `fatal_error`, `internal_error`, `ratelimited`, `service_unavailable`, `request_timeout`. | Transient: the core stores the message and retries it for up to 24 hours; the agent gets `delivery: "delivered"`. `retry_after_s` is set (30 s when Slack gives none). |
| `channel_auth_failed` | `invalid_auth`, `not_authed`, `account_inactive`, `token_revoked`, `token_expired`, `not_in_channel`, `channel_not_found`, `is_archived`, `missing_scope`, `no_permission`; also a bad app token at `apps.connections.open`. | Setup error: fails every post until the vendor fixes the app. The core keeps the message and retries it like an outage (the agent gets `delivery: "delivered"`), emails `ADMIN_EMAIL` once per distinct error and shows it on `/healthz`. The message is `Slack: <error>: <fix below>`. |
| `channel_rejected` | Any other `ok:false` error (for example `msg_too_long`), or a response without JSON. | Slack refused this message itself; retrying cannot help. On the first post nothing is stored and the agent gets 503 `channel_unavailable`; on a retry the message is marked failed (`delivery: "failed"`). |

Fix hints (startup check and logs):

- `SLACK_BOT_TOKEN is wrong or revoked: copy the Bot User OAuth Token (xoxb-...) from OAuth & Permissions in your Slack app`
- `invite the app to the channel (type /invite @<your app> in it), then check SLACK_CHANNEL_ID is that channel's ID (C...)`
- `the channel in SLACK_CHANNEL_ID is archived: unarchive it or pick another channel`
- `the bot token lacks a scope (<scope>): add it under OAuth & Permissions, then click Reinstall to Workspace`
- `SLACK_APP_TOKEN must be an app-level token (xapp-...) with the connections:write scope, and Socket Mode must be turned on in your Slack app`

Startup also stops with a plain error when only some of the three required vars are set (`Slack is partly configured: set SLACK_APP_TOKEN, SLACK_CHANNEL_ID too, ...`) or when a token has the wrong prefix (the two tokens swapped). At startup a setup error (`channel_auth_failed`) stops the server with the hint above and exit code 1; a Slack outage (`channel_unavailable`) only logs a warning, the server boots, and the socket keeps reconnecting. A bad app token at runtime stops the Socket Mode client (no retry loop) and shows in `status()`; a dropped connection reconnects on its own with backoff from 1 s to 60 s.

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `SLACK_BOT_TOKEN` | unset | Bot User OAuth Token, `xoxb-...` (**OAuth & Permissions**). Secret. |
| `SLACK_APP_TOKEN` | unset | App-level token with `connections:write`, `xapp-...` (**Basic Information → App-Level Tokens**). Secret. |
| `SLACK_CHANNEL_ID` | unset | The channel the app is invited to, `C...` (channel **About** tab). |
| `SLACK_OWNER_USER_IDS` | unset | Optional comma list of member IDs (`U...`) whose thread replies count as support's. Unset means anyone in the channel. |
| `ADMIN_EMAIL` | unset | Optional: who is emailed once when a setup error (bot removed, token revoked, channel gone) stops posts. Needs the email notifier. |

The first three are required: the server does not start without them and names the missing ones. `MESSAGES_ENABLED=false` (see [configuration.md](../configuration.md)) answers the message routes with `messages_disabled`.

## Tests

`test/slack.test.ts` runs the connector against a scripted fake `fetch` for the Web API and an in-process fake Socket Mode server (a `WebSocket` constructor injected through the options), never the live Slack API. It covers: `chat.postMessage` returning the `ts` as the thread handle and thread replies; the dedupe key sent as message metadata and `findPosted` reading it back from the channel or the thread with `include_all_metadata`, another app's message with the same key not counting, and a failed or too-large read throwing `channel_unavailable`; the catch-up on `hello` (missed thread replies handed to the core once each, oldest first, before `start()` resolves, with no read of the channel's top-level history; the cursor moved by live events; a failed read retried and shown in `status()`; the stored cursor held at the start of the gap while catch-up is failing; a thread Slack no longer has skipped, any other thread read failure ending the pass with the cursor unmoved); escaping of `<!channel> <@U1> &` with unfurls off; 429 with `Retry-After`, 5xx, timeout and `internal_error` as `channel_unavailable`; `invalid_auth`, `not_in_channel`, `channel_not_found`, `is_archived` and `missing_scope` as `channel_auth_failed` with their hints; an unknown error as `channel_rejected`; `notify` and the reaction logging instead of throwing; the three `checkAccess` hints; `hello` before `start()` resolves; the envelope acked only after the reply handler resolves and never when it throws, with no ✅ unless the core calls `acknowledge`; Slack entities in support's text unescaped; messages with a subtype, a `bot_id` or another channel ignored, in a thread or top-level; a top-level human message, even from an allowlisted owner, never passed to the core and given no notice; the core's connect hook run on every `hello`; support's text passed through unchanged (the core decides what it means); the owner allowlist notice once per thread; the closed-thread notice and the generic notice for other rejections; a transient first connect failure rejecting `start()` while reconnecting in the background; reconnect after a `disconnect` envelope; no retry on a bad app token; and the env rules of `createSlackChannel`. `test/messages.test.ts` covers the core side of delivery against a fake channel: an outage shorter than 24 hours (backoff doubling to the 30-minute cap, `delivery` "delivered" throughout, the post landing on recovery); the window running out (the thread's `delivery` "failed", `onDeliveryFailed` called once); a socket reconnect sending a waiting question at once; a setup error emailing the admin once per distinct error, showing on health and clearing on recovery, and only logging without a notifier; a rejected first post storing nothing; a timed-out send found on the retry and not posted again, a follow-up left mid-send by a crash looked up in its thread, a retry that posts when nothing is found, a lookup that keeps failing ending in `failed` with nothing posted; and a top-level message while one thread waits being ignored, with nothing stored, acknowledged or posted. `test/connectors-dx.test.ts` checks that `npm run init` and its `--help` name the connector and its env vars, and `test/config.test.ts` the missing-var fix hint at startup.
