// Entry point: one Express app. /api (HTTP/JSON message routes) plus the agent discovery
// pages (/, /llms.txt, /openapi.json, /robots.txt) and /healthz, with auth, rate limits and
// the shared error body. One server is one vendor's support door; there is no mode switch.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Server } from "node:net";
import { fileURLToPath } from "node:url";
import express from "express";
import { ZodError } from "zod";
import { loadStartup, type Config, type RuntimeSettings } from "./config.js";
import { accessLog, agentInstructionsHandler, homeHandler, openApiHandler, robotsHandler } from "./adapters/agents.js";
import { apiRouter, jsonErrorHandler, sendError, type Ops } from "./adapters/http.js";
import { authMiddleware } from "./middleware/auth.js";
import { hostValidation } from "./middleware/hosts.js";
import { callerKey, requestRateLimit } from "./middleware/ratelimit.js";
import { confirmPageHandler, confirmSubmitHandler } from "./adapters/confirm.js";
import { createResendNotifier } from "./connectors/resend.js";
import { createSupportEmails, type ResumeMinter } from "./emails.js";
import { createSlackChannel } from "./connectors/slack.js";
import { ConnectorError, type CommunicationConnector, type RequesterNotifier } from "./connectors/types.js";
import { openStore, type Store } from "./store/sqlite.js";
import { createMessageOps, type MessageDeps, type MessageOps } from "./messages.js";
import { createResumeTokens, resumePageHandler } from "./resume.js";

export { createSlackChannel };

/**
 * Optional hooks into message delivery. `notifier` (Resend) sends admin alerts and every requester email (confirm,
 * reply, delivery failed); `onDeliveryFailed` overrides the default (the "didn't reach <vendor>" email).
 * `resume` mints the resume link of each reply email; `now` is the clock (tests).
 */
export type DeliveryHooks = { notifier?: RequesterNotifier | undefined; onDeliveryFailed?: MessageDeps["onDeliveryFailed"]; resume?: ResumeMinter; now?: () => Date };


/** Message ops bound to their dependencies; served by the HTTP adapter. `owner` undefined means no routes (tests). */
export function buildOps(config: Config, settings: RuntimeSettings, store: Store, owner: CommunicationConnector | undefined, hooks: DeliveryHooks = {}): Ops {
  const nowMs = () => (hooks.now ? hooks.now().getTime() : Date.now());
  const emails = hooks.notifier
    ? createSupportEmails({ config, store, notifier: hooks.notifier, channel: owner, resume: hooks.resume ?? createResumeTokens(store, nowMs), now: nowMs })
    : undefined;
  const onDeliveryFailed = hooks.onDeliveryFailed ?? emails?.onDeliveryFailed;
  const messages = createMessageOps({
    ...(onDeliveryFailed ? { onDeliveryFailed } : {}),
    config,
    store,
    channel: owner,
    settings,
    ...(hooks.notifier ? { notifier: hooks.notifier } : {}),
    ...(hooks.now ? { now: hooks.now } : {}),
    ...(emails ? { emails } : {}),
  });
  return messages ? { messages, ...(emails ? { emails } : {}) } : {};
}

/**
 * The support channel: Slack. Throws when it is only partly configured or a token has the
 * wrong prefix, so a typo never silently runs a door nobody reads.
 */
export function createOwnerChannel(settings: RuntimeSettings): CommunicationConnector | undefined {
  return createSlackChannel(settings);
}

/**
 * Startup check of the support channel. A setup error (channel_auth_failed,
 * channel_rejected) throws so main() prints its fix hint and exits 1; a
 * transient outage only warns, because the outbox and socket retry on their own.
 */
export async function checkOwnerChannel(owner: CommunicationConnector | undefined, warn: (m: string) => void = (m) => console.warn(m)): Promise<void> {
  try {
    await owner?.checkAccess?.();
  } catch (e) {
    if (e instanceof ConnectorError && e.code === "channel_unavailable") {
      warn(`[support] support channel not reachable at startup, continuing (messages queue until it is): ${e.message}`);
      return;
    }
    throw e;
  }
}

/**
 * Startup check of the email notifier: a bad key or an unverified domain throws its fix hint (main() exits 1, like a
 * Slack setup error); a Resend outage only warns, because reply emails retry on their own.
 */
export async function checkNotifier(n: RequesterNotifier, warn: (m: string) => void = (m) => console.warn(m)): Promise<void> {
  try {
    await n.checkAccess();
  } catch (e) {
    if (e instanceof ConnectorError && e.code === "notifier_unavailable") {
      warn(`[support] email notifier not reachable at startup, continuing (emails retry): ${e.message}`);
      return;
    }
    throw e;
  }
}

/** The startup warning when no email notifier is configured (design section 1): replies then reach only open agent sessions. */
export function emailWarning(settings: RuntimeSettings): string | null {
  if (settings.resend_api_key && settings.email_from) return null;
  return "[support] no email notifier: set RESEND_API_KEY and EMAIL_FROM to email replies to developers whose agent session closed; until then replies reach only open agent sessions";
}

/**
 * Filesystem type of the mount that holds `path`, from /proc/self/mountinfo
 * text (Linux). Returns null when no mount covers it.
 */
export function mountFsType(mountinfo: string, path: string): string | null {
  let best: { point: string; fstype: string } | null = null;
  for (const line of mountinfo.split("\n")) {
    const [pre, post] = line.split(" - ");
    const point = pre?.split(" ")[4]?.replace(/\\040/g, " ");
    const fstype = post?.split(" ")[0];
    if (!point || !fstype) continue;
    const covers = point === "/" || path === point || path.startsWith(point + "/");
    if (covers && (!best || point.length > best.point.length)) best = { point, fstype };
  }
  return best?.fstype ?? null;
}

/** Warn when the SQLite file lives on a container's throwaway overlay layer (no volume mounted). */
function warnIfEphemeralDb(dbPath: string): void {
  let mountinfo: string;
  try {
    mountinfo = readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return; // not Linux: nothing to check
  }
  if (mountFsType(mountinfo, dirname(resolve(dbPath))) === "overlay") {
    console.warn(
      `[support] WARNING: ${dbPath} is on the container's own filesystem, not a volume. ` +
        "Threads, replies and idempotency keys will be lost when the container is replaced. Mount a volume at /data.",
    );
  }
}

/** One-line summary of the effective TRUST_PROXY setting, for the startup log. */
export function describeTrustProxy(t: RuntimeSettings["trust_proxy"], cf = false): string {
  if (t === false) return "trust proxy: none (client IP = socket peer; X-Forwarded-For and CF-Connecting-IP ignored)";
  if (typeof t === "number") return `trust proxy: ${t} hop(s) (client IP from X-Forwarded-For; CF-Connecting-IP ignored)`;
  const via = cf ? "X-Forwarded-For and CF-Connecting-IP" : "X-Forwarded-For (CF-Connecting-IP ignored)";
  return `trust proxy: ${t.join(",")} (${via} honored only from these peers)`;
}

export function createApp(config: Config, settings: RuntimeSettings, deps: { store?: Store; owner?: CommunicationConnector | null } & DeliveryHooks = {}) {
  const store = deps.store ?? openStore(settings.db_path);
  const app = express();
  // Throws at startup on an invalid TRUST_PROXY address/CIDR.
  app.set("trust proxy", settings.trust_proxy);
  const ipOpts = { trustCfHeader: settings.trust_cf_connecting_ip && Array.isArray(settings.trust_proxy), debug: settings.trust_proxy_debug };
  app.use(hostValidation(settings.host, settings.allowed_hosts, sendError));
  const owner = deps.owner === undefined ? createOwnerChannel(settings) : (deps.owner ?? undefined);
  app.use(express.json());

  app.use(accessLog());

  const ops = buildOps(config, settings, store, owner, { notifier: deps.notifier, onDeliveryFailed: deps.onDeliveryFailed, resume: deps.resume, now: deps.now });
  const messages = ops.messages;
  // main() starts and stops the channel and outbox through this (start after listen, stop on SIGTERM).
  app.locals.messages = messages;

  app.get("/healthz", (_req, res) => {
    if (!messages) return void res.json({ ok: true });
    const h = messages.health();
    res.json({
      ok: true,
      channel: {
        mode: h.mode,
        enabled: h.enabled,
        connected: h.connected,
        ...(h.last_error ? { last_error: h.last_error } : {}),
        ...(h.permanent_error ? { permanent_error: h.permanent_error } : {}),
      },
      outbox: h.outbox,
    });
  });

  const guard = [authMiddleware(settings.api_keys, sendError), requestRateLimit(config.limits, sendError, ipOpts)];

  // Rate-limited like the API: an agent may fetch these on every task.
  const discoveryLimit = requestRateLimit(config.limits, sendError, ipOpts);
  const msgMode = messages?.enabled ? messages.mode : undefined;
  const discovery = { messages: msgMode, email: Boolean(settings.resend_api_key && settings.email_from) };
  app.get("/", discoveryLimit, homeHandler(config, discovery));
  app.get(["/llms.txt", "/.well-known/llms.txt"], discoveryLimit, agentInstructionsHandler(config, discovery));
  app.get("/openapi.json", discoveryLimit, openApiHandler(config, discovery));
  app.get("/robots.txt", discoveryLimit, robotsHandler(config.public_url));
  // T6: emailed resume links; read-only plain text, same per-IP limiter as llms.txt (R3).
  app.get("/t/:threadId/:token", discoveryLimit, resumePageHandler(config, store, !emailWarning(settings), messages));

  app.use("/api", ...guard, apiRouter(ops, { caller: (req, res) => callerKey(req, res, ipOpts), config, store, email: !emailWarning(settings) }));
  // T5b: the confirm link of each question's confirm email; GET shows one button, only the POST confirms (R5).
  if (ops.emails) {
    const clock = () => (deps.now ? deps.now().getTime() : Date.now());
    app.get("/v/:token", discoveryLimit, confirmPageHandler(config.vendor_name, ops.emails, clock));
    app.post("/v/:token", discoveryLimit, confirmSubmitHandler(config.vendor_name, ops.emails, clock));
  }
  app.use(jsonErrorHandler());

  return app;
}

/**
 * One readable line for a startup failure (bad or missing env, unreachable Slack).
 * Zod issues are listed one per line; everything else is the error's own message.
 * No stack: these are the vendor's errors to fix.
 */
export function describeStartupError(e: unknown): string {
  if (e instanceof ZodError) {
    const issues = e.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    return `Invalid environment:\n${issues}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** One line for a failed listen (EADDRINUSE, EACCES, ...): problem plus fix, no stack trace. */
export function describeListenError(host: string, port: number, e: NodeJS.ErrnoException): string {
  return `cannot listen on ${host}:${port} (${e.code ?? e.message}): stop the other process or set PORT in .env`;
}

/** Listens, and on a listen error prints describeListenError and exits 1. `exit` is injectable for tests. */
export function listenOrExit(
  app: { listen(port: number, host: string, cb: () => void): Server },
  host: string,
  port: number,
  onListening: () => void,
  exit: (code: number) => void = (code) => process.exit(code),
): Server {
  const server = app.listen(port, host, onListening);
  server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(`[support] ${describeListenError(host, port, e)}`);
    exit(1);
  });
  return server;
}

async function main() {
  try {
    const { config, settings } = loadStartup(process.env);
    warnIfEphemeralDb(settings.db_path);
    // Created here (not inside createApp) so its startup check fails the boot with a fix hint.
    const owner = createOwnerChannel(settings);
    if (settings.messages_enabled) await checkOwnerChannel(owner);
    const noEmail = emailWarning(settings);
    if (noEmail) console.warn(noEmail);
    // The vendor's own Resend (R8): admin alerts and every requester email. Half-configured throws a fix hint.
    const notifier = createResendNotifier(settings);
    if (notifier) await checkNotifier(notifier);
    const app = createApp(config, settings, { owner: owner ?? null, notifier });
    const messages = app.locals.messages as MessageOps | undefined;
    console.log(`[support] ${describeTrustProxy(settings.trust_proxy, settings.trust_cf_connecting_ip)}`);
    const server = listenOrExit(app, settings.host, settings.port, () => {
      console.log(`[support] ${config.vendor_name} support door listening on http://${settings.host}:${settings.port} (/api, /llms.txt; public ${config.public_url})`);
      if (messages?.enabled) void messages.start();
    });
    process.once("SIGTERM", () => {
      // Answer every held get_thread and stop the sweep and the channel's socket first, then let
      // in-flight requests finish, so a deploy cuts no response. Bounded at 10 s.
      void (async () => {
        try {
          await messages?.stop();
        } catch (e) {
          console.error(`[support] stop failed: ${(e as Error)?.message ?? e}`);
        }
        await new Promise<void>((resolve) => {
          const deadline = setTimeout(resolve, 10_000);
          deadline.unref();
          server.close(() => {
            clearTimeout(deadline);
            resolve();
          });
        });
        process.exit(0);
      })();
    });
  } catch (e) {
    console.error(`[support] ${describeStartupError(e)}`);
    process.exit(1);
  }
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
