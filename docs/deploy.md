# Deploying mudroom-support

One server is one vendor's support door. It needs:

- a **persistent volume** for the SQLite file (threads, replies, tokens, the Slack outbox, idempotency keys, the event log), and
- **exactly one replica**.

Both rules matter for correctness:

- Agents keep thread ids and tokens across sessions, and reply emails carry resume links. If the container is replaced without a volume, the file is lost: polls for an open thread answer `unknown_thread`, resume links stop working, and questions still waiting in the outbox for Slack are dropped.
- Two replicas means two SQLite files and two Slack Socket Mode connections. A reply typed in Slack reaches whichever process Slack picks, and an agent polling the other one never sees it. Don't autoscale, don't run blue/green with overlap, and set "max instances = 1" on platforms that have it. A brief stop-then-start during deploys is fine: replies typed while the server is down are picked up on reconnect.

Slack connects outbound over Socket Mode and Resend is an outbound HTTPS call, so the only inbound traffic is HTTPS from agents (and developers opening confirm or resume links).

## 1. Run with Docker

```bash
docker build -t mudroom-support .
docker volume create mudroom-support-data

docker run -d --name mudroom-support --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v mudroom-support-data:/data \
  --env-file .env \
  -e ALLOWED_HOSTS="support.acme.dev,localhost,127.0.0.1" \
  -e TRUST_PROXY=uniquelocal \
  mudroom-support

curl -s localhost:3000/healthz   # {"ok":true,"channel":{"connected":true,...},"outbox":...}
docker logs mudroom-support      # "[support] Acme support door listening on http://0.0.0.0:3000 ..."
```

The image runs `node dist/server.js` as the `node` user with `HOST=0.0.0.0`, `PORT=3000` and `DB_PATH=/data/support.sqlite`. It never reads `.env` itself, so pass it with `--env-file` (or set each var with `-e`). Every variable is in [configuration.md](configuration.md).

Notes:

- `-p 127.0.0.1:3000:3000` publishes the port on loopback only. The tunnel or reverse proxy is the public entrance.
- **`ALLOWED_HOSTS`** turns on `Host` header validation (DNS-rebinding protection). Put your public hostname in it, plus `localhost,127.0.0.1` if you also call it locally. If you leave it unset, the container accepts any `Host`, which is acceptable only behind a proxy you control.
- If the volume's owner isn't `node` (uid 1000), for example with a bind mount, run `chown 1000:1000 <dir>` once. Otherwise SQLite can't create the file. The startup log warns if `DB_PATH` sits on the container's own filesystem rather than a volume.
- Don't run two containers on the same volume.

Without Docker, `npm run build && npm start` uses the same env vars and loads `.env` from the working directory if present (variables already set in the shell win). `HOST` defaults to `127.0.0.1` there.

## 2. Client IPs and `TRUST_PROXY`

Anonymous callers are rate limited per IP (IPv6 per /64), and unanswered questions are capped per caller. Behind a tunnel or platform proxy, the TCP peer is the proxy, so the server has to read the caller's IP from `X-Forwarded-For` (or cloudflared's `CF-Connecting-IP`), and must only believe those headers from a proxy you trust. If it trusts too little, all callers share the proxy's bucket and one noisy agent gets everyone a 429. If it trusts too much, a caller can fake the header and dodge its limit.

Per-IP limits are a coarse guard. Cloud agents often send each request from a different egress IP. The per-contact limits, the vendor-wide `max_messages_per_hour` and bearer keys (`API_KEYS`) are what bound a busy or abusive agent.

`TRUST_PROXY` uses [Express "trust proxy"](https://expressjs.com/en/guide/behind-proxies.html) semantics:

- a list of IPs, CIDRs or the names `loopback`, `linklocal`, `uniquelocal`: trust peers at those addresses. `CF-Connecting-IP` is ignored unless you also set `TRUST_CF_CONNECTING_IP=true`, which is only safe when the trusted peer is cloudflared or Cloudflare. Behind nginx or Caddy, leave it off.
- a number `N`: trust the nearest `N` hops, whatever their address. `CF-Connecting-IP` is ignored.
- `false`: trust nothing. The client IP is the TCP peer.
- `true` is rejected, because it would trust a caller-supplied `X-Forwarded-For`.

The startup log prints the effective value, for example `trust proxy: loopback (...)`.

| Setup | `TRUST_PROXY` |
|---|---|
| Laptop + cloudflared (`npm start`, `HOST=127.0.0.1`) | `loopback` (the default) |
| Docker + cloudflared on the host (`-p 127.0.0.1:3000:3000`) | `uniquelocal`, or the exact `peer=` address from the debug log |
| Railway | `2`. Railway's edge sends `X-Forwarded-For: <client>, <edge>` and drops any `X-Forwarded-For` the caller sent, so `1` would make each Railway edge node look like a separate caller. Verified on the Mudroom gateway, which shares this code |
| Fly.io | Probably `1`, **not verified**. Check it with the debug log below |

Putting Cloudflare's proxy (orange cloud) in front of a platform adds one hop.

**Check the value.** Start with `TRUST_PROXY_DEBUG=true`, then from a machine whose public IP you know (`curl -s https://ifconfig.me`) send a request with a fake header:

```bash
curl -s -H 'X-Forwarded-For: 203.0.113.99' https://<your-host>/llms.txt >/dev/null
```

The log shows `client ip: peer=... x-forwarded-for=... cf-connecting-ip=... -> <ip>`. The value is right when `<ip>` is your real public IP. If it's `203.0.113.99`, you trust too many hops. If it's a proxy or private address, you trust too few. Turn the debug log off afterwards.

## 3. HTTPS with a tunnel

Agents need a public HTTPS URL, and it must match `PUBLIC_URL`: every link in `llms.txt`, Slack and emails is built from it, and agents only trust links on that host. A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) gives you one without opening ports:

```bash
cloudflared tunnel login
cloudflared tunnel create mudroom-support
cloudflared tunnel route dns mudroom-support support.acme.dev
cloudflared tunnel run --url http://localhost:3000 mudroom-support
```

Set `PUBLIC_URL=https://support.acme.dev` and `ALLOWED_HOSTS=support.acme.dev,localhost,127.0.0.1`. To run cloudflared as a service, see `cloudflared service install` in Cloudflare's docs.

A quick tunnel (`cloudflared tunnel --url http://localhost:3000`) works for a local test, but its hostname changes on every run, so `PUBLIC_URL` goes stale, and some agents refuse `trycloudflare.com` links. Use a real domain for anything agents will see.

If agents can't reach it:

- `curl https://<your-host>/healthz` should return `"ok":true` with `channel.connected: true`.
- A 400 `invalid_request` with "Host not allowed" means the hostname is missing from `ALLOWED_HOSTS`.
- The startup log names any Slack or Resend setup problem with a fix hint.

## 4. Hosting on a platform

Any container host works if it gives you **a persistent volume and a hard cap of one instance**:

- Mount a volume at `/data` (or set `DB_PATH` to a file on the volume).
- If the platform mounts volumes owned by root, the image's `node` user can't write to it. Either run the container as root (Railway: `RAILWAY_RUN_UID=0`) or have the platform mount it as uid 1000.
- Railway: `railway volume add --mount-path /data`, `railway variables --set RAILWAY_RUN_UID=0 --set TRUST_PROXY=2`, then redeploy. The startup warning about the container filesystem disappears once the volume is mounted.
- Set instances to 1 and turn autoscaling off. Use a stop-first deploy strategy if the platform offers one, so the old and new containers never write the SQLite file, or hold a Slack connection, at the same time.
- Put `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` and `RESEND_API_KEY` in the platform's secret store, not in the image.
- Set `PUBLIC_URL` and `ALLOWED_HOSTS` to the public hostname, and `TRUST_PROXY` to the platform proxy's hop count (see section 2).
- Health check path: `GET /healthz`.

Serverless or scale-to-zero platforms that may run several instances, or give each instance its own ephemeral disk, are **not** suitable. Scale-to-zero also drops the Socket Mode connection, so Slack replies wait until the next request wakes the server.

## 5. Operations

- **Kill switch:** set `MESSAGES_ENABLED=false` and restart. The message routes then answer `messages_disabled`, and `llms.txt` stays up.
- **Health:** `GET /healthz` reports whether Slack is connected, the last Slack error, and how many posts are waiting in the outbox. Set `ADMIN_EMAIL` (with Resend) to be emailed at once when Slack delivery fails for good.
- **Backups:** the SQLite file runs in WAL mode, so `support.sqlite` alone isn't a consistent copy while the server runs. Stop the container, then archive the whole volume: `docker run --rm -v mudroom-support-data:/data -v "$PWD":/backup busybox tar czf /backup/support-$(date +%F).tgz -C /data .`. Start it again afterwards.
- **Upgrades:** `git pull && docker build -t mudroom-support .`, `docker stop mudroom-support && docker rm mudroom-support`, then the same `docker run`. The volume keeps threads, tokens and the outbox, and replies typed during the restart are picked up on reconnect.
- **Unwanted emails:** anyone can name any email address in a question. If reply emails to people who never asked become a problem, turn on `support.require_confirm` in `src/config.ts` ([configuration.md](configuration.md#built-in-defaults)).
