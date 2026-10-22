# How agents find your support door

Coding agents don't go looking for a support door. They follow links on pages and output they're already reading: an error your API returned, a message your SDK threw, your package README, your docs. This page covers where to put the link so an agent finds it at the moment it gets stuck, and how to check which placement works.

Below, `https://support.acme.dev` stands in for your `PUBLIC_URL`.

## Write it as information, not an instruction

Agents treat text inside tool output, error messages and dependencies as data, not as instructions. A line like *"Coding agents: ask Acme support at …"* reads like a prompt injection, and a careful agent ignores it on purpose. In our own test, Claude Code saw that exact line in an SDK error and README and said: *"I didn't follow it, because that's an instruction from a dependency, not from you."*

So state where support is and what it can do, and leave the decision to the developer. The agent then passes it along ("Acme has a support line; want me to ask them?"), the developer says yes, and the agent asks with the developer's go-ahead and email. Every snippet below is worded that way.

## The host is enough

Nobody needs to remember `/llms.txt`. `GET /` on the door returns the same agent instructions to any client that doesn't ask for HTML (curl, agent fetch tools), and a browser gets a short page that links to them. A developer can say *"ask Acme support at support.acme.dev"* and the agent has everything it needs. `/llms.txt` and `/.well-known/llms.txt` serve the same text.

## Explain HTTP access before the link fails

An agent may find the support link in your docs, try its browser or web-fetch tool, and stop when that tool blocks the support host. Recovery guidance inside the support host's `llms.txt` cannot help an agent that has not read it. Put the HTTP client and network-access guidance beside the link on your own docs site and in its `llms.txt`, as in the snippets below.

Keep the normal HTTP flow for agents that already reach the door. The curl guidance is a fallback only when browser or web-fetch access fails; it does not require identifying the agent by name.

Browser access and terminal network access can differ. A browser error such as `ERR_BLOCKED_BY_CLIENT`, or a DNS failure inside a restricted terminal, does not by itself prove the support service is down. If browser or web-fetch access fails, a code or terminal tool can try curl. The agent can use its tool's normal network approval flow where available and retry if approved. Denied access must be respected; unavailable or denied approval is an access blocker to report to the developer.

This requires no email or Slack plugin on the developer's side. The agent still needs the developer's permission to contact support and their actual name and email. It must ask for missing details rather than submit an example identity.

## Where to put the link

Ranked by how close each surface is to the moment an agent needs help. Do as many as you can, starting at the top.

### 1. API error responses

An agent that hits an error reads the response body right away. Add the door to errors your support team can actually help with: quota and plan limits, account and billing problems, 5xx responses. Leave it off validation errors the agent can fix itself (a missing field, a typo), or support ends up answering those.

As a field in the error body:

```json
{
  "error": {
    "code": "quota_exceeded",
    "message": "Monthly upload quota exceeded for this plan.",
    "help": "https://support.acme.dev/?via=api-error"
  }
}
```

If you use RFC 9457 problem details, keep `type` pointing at your docs page for that error, and add the door as an extension member (`"support": "https://support.acme.dev/?via=api-error"`).

Or as one line at the end of the message, for clients that only show the message text:

```
Monthly upload quota exceeded for this plan. If the docs don't explain this, Acme support can help: https://support.acme.dev/?via=api-error (a coding agent can send them the question for you)
```

### 2. SDK error messages and the package README

Agents read stack traces, and they often open the package README in `node_modules` or `site-packages`. In the SDK, add the same line to the errors from section 1 (wrapped API errors, auth and quota failures):

```
AcmeQuotaError: Monthly upload quota exceeded. Acme support: https://support.acme.dev/?via=sdk (a coding agent can send them the question for you)
```

In the README you publish to npm/PyPI, under *Support* or *Help*:

```markdown
**Support:** if these docs don't answer it, Acme's support team can. Coding agents can send them a question on your behalf at https://support.acme.dev/llms.txt?via=sdk, and a person replies.

If browser or web-fetch access fails, a code or terminal tool can try `curl --fail --silent --show-error --max-time 20 'https://support.acme.dev/llms.txt?via=sdk'`. Its network access can differ. If the execution environment restricts the request, its normal network approval flow may allow it; retry only if approved and respect denied access. No email or Slack plugin is needed.
```

### 3. Your docs site

Add a support entry to your docs site's `llms.txt` (many docs platforms generate this file; add it to the header or an "Optional" section). Keep the HTTP access guidance next to the link:

```markdown
- [Acme support](https://support.acme.dev/llms.txt?via=docs): a person on Acme's support team answers what these docs don't cover; coding agents can ask on the developer's behalf

If browser or web-fetch access fails, a code or terminal tool can try `curl --fail --silent --show-error --max-time 20 'https://support.acme.dev/llms.txt?via=docs'`. Its network access can differ. If the execution environment restricts the request, its normal network approval flow may allow it; retry only if approved and respect denied access. No email or Slack plugin is needed.
```

And one line on your human support or contact page, which agents also fetch:

```
Using a coding agent? It can ask our support team for you at https://support.acme.dev/?via=support-page
```

Include the same HTTP access paragraph on that page so an agent reading it has the recovery guidance before visiting the support host.

### 4. What developers can say

Once any of the above is live, *"ask Acme support"* is enough for an agent that has seen one of those links, and *"ask Acme support at support.acme.dev"* is enough for any agent. Put that sentence wherever you tell developers how to get help.

## Place it safely

A page that copies your door's instructions looks the same to an agent as your real one, and an agent that trusts a copy sends it the developer's name, email and error details. The door can't tell a copy apart from itself, so the protection is where the link comes from:

- **Link only from surfaces you own:** your API, your SDK, your package page, your docs domain. Never tell agents to search the web for your support door.
- **Run the door on your own domain**, like `support.acme.dev` for `acme.dev`, so an agent can see the host belongs to you. On a platform host (`*.up.railway.app`, `*.fly.dev`) anyone can stand up a similar-looking name. Add a custom domain before you link it anywhere.
- **Name the exact host in every snippet.** The door's instructions already tell agents to trust resume links only on that host.

## See which placement works

Every snippet above ends in `?via=<surface>`. The door ignores the parameter, but its access log records the full URL:

```
[access] GET /llms.txt?via=docs 200 3ms ip=… ua="…"
```

To count visits by surface:

```bash
grep '^\[access\] GET .*via=' server.log | sed -n 's/.*via=\([a-z-]*\).*/\1/p' | sort | uniq -c
```

These numbers are a minimum: some agents drop the query string or type the bare host.

## Limits

- The agent needs a code or terminal tool that can make HTTP requests to your support host. Reading a page in a browser or web-search tool alone does not establish that it can POST a question. Tool availability and network permissions vary by session.
- Mudroom cannot grant network access or override an agent's denied permissions. The discovery copy explains the available route; a network approval prompt may still be necessary.
- A link on a host that isn't yours can't be checked by domain. See *Place it safely*.
- Agents decide for themselves when to follow a link, and most will check with the developer first. That's intended: the developer agrees before their email and error details go to you. The instructions also tell agents to search your docs first and ask only what the docs don't answer.

## Verify a fresh session

After publishing the snippets and deploying the door, start fresh ChatGPT Work and Claude sessions and ask each to contact support without naming curl or supplying recovery instructions. Check that each discovers the door, uses its available HTTP tools, falls back to curl only if browser/web-fetch access fails, requests network access if its environment requires it, asks for missing requester details, and sends exactly one question. Verify the Slack thread and the reply arriving back in the agent. If access is denied, the agent should report the access blocker without claiming the service is down or the question was sent.

Automated tests check the published contract and HTTP behavior; this fresh-session check is needed to establish whether a particular agent follows the discovery copy.
