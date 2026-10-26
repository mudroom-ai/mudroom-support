// Thin HTTP/JSON adapter over the message ops.
// Success: 200 (201 for new messages) with the op's data. Failure: HTTP_STATUS[code]
// with the GatewayError body.
//
//   Only when a support channel is configured (src/messages.ts):
//   POST /api/messages              leave_message (LeaveMessageRequest body)
//   GET  /api/threads/:id[?wait=N]  get_thread    (X-Thread-Token or X-Resume-Token header; wait holds up to N s for support)
//   POST /api/threads/:id/messages  follow_up     (X-Thread-Token header, {message, idempotency_key?, done?})
//   POST /api/threads/:id/close     close_thread  (X-Thread-Token header; idempotent)
//   X-Resume-Token (an emailed resume link's token, T6) works wherever X-Thread-Token does.
//   The read token is accepted in the header only: the access log prints the URL, so a
//   token in a query string would land in the logs.

import { createHash } from "node:crypto";
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { Config } from "../config.js";
import { err, HTTP_STATUS, type GatewayError, type Result } from "../errors.js";
import type { SupportEmails } from "../emails.js";
import { ownerMessageIds, type LeaveMessageRequest, type MessageOps } from "../messages.js";
import { createResumeTokens, resumePage } from "../resume.js";
import type { Store } from "../store/sqlite.js";
import { baseUrl } from "./agents.js";

/** Core ops bound to their dependencies (see buildOps in server.ts). */
export interface Ops {
  /** Undefined when no support channel is configured: the message routes do not exist. */
  messages?: MessageOps;
  /** T5b: requester emails (confirm flow, reply emails); undefined when no email notifier is configured. */
  emails?: SupportEmails;
}

export function sendError(res: Response, e: GatewayError): void {
  if (e.retry_after_s !== undefined) res.set("Retry-After", String(e.retry_after_s));
  res.status(HTTP_STATUS[e.code] ?? 500).json(e);
}

export function sendResult<T>(res: Response, r: Result<T>, okStatus = 200): void {
  if (r.ok) res.status(okStatus).json(r.data);
  else sendError(res, r.error);
}

/**
 * Run an op; a thrown error becomes `internal` instead of escaping the adapter. The error is
 * logged with the op name first, or a thrown SQLite error would leave no trace. Only the
 * error is logged, never the request (it can hold a read token or a requester's message).
 */
export async function runOp<T>(
  name: string,
  fn: () => Result<T> | Promise<Result<T>>,
  log: (line: string) => void = (line) => console.error(line),
): Promise<Result<T>> {
  try {
    return await fn();
  } catch (e) {
    log(`[support] op ${name} threw: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return err("internal", "Unexpected error");
  }
}

const body = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};

/**
 * T5b read signal (R2, R7): once a 200 GET /api/threads/:id response has finished sending, the owner messages it
 * carried count as read, whichever token (x-thread-token or x-resume-token) was used. A long-poll whose client left
 * sends nothing, so it marks nothing and the reply email still goes out. The /t resume page never comes here.
 */
export function markReadOnFinish(messages: Pick<MessageOps, "markDelivered">): RequestHandler<{ id: string }> {
  return (_req, res, next) => {
    const json = res.json.bind(res);
    res.json = (payload: unknown) => {
      const carried = ownerMessageIds(payload);
      if (carried && carried.ids.length) {
        res.once("finish", () => {
          if (res.statusCode === 200) messages.markDelivered(carried.thread_id, carried.ids);
        });
      }
      return json(payload);
    };
    next();
  };
}

export interface ApiOptions {
  /** T5c: the caller's rate-limit bucket for POST /api/messages (ip:<bucket> or k:<key id>). */
  caller?: (req: Request, res: Response) => string | undefined;
  /** Needed for GET /api/ask to mint a resume token and render the plain-text thread page. */
  config?: Config;
  store?: Store;
  email?: boolean;
}

const PREVIEW_BOT_UA = /Slackbot-LinkExpanding|Twitterbot|facebookexternalhit|Discordbot|WhatsApp|LinkedInBot|TelegramBot/i;

export function apiRouter(ops: Ops, opts: ApiOptions = {}): Router {
  const r = Router();
  const messages = ops.messages;
  if (messages) {
    const token = (req: Request) => req.get("x-thread-token") ?? "";
    // T6: an emailed resume link's token works on the three thread routes in place of the read token.
    const resume = (req: Request) => req.get("x-resume-token") ?? "";
    r.post("/messages", async (req, res) =>
      sendResult(res, await runOp("leave_message", () => messages.leaveMessage({ ...(body(req) as LeaveMessageRequest), caller: opts.caller?.(req, res) })), 201),
    );
    r.get("/ask", async (req, res) => {
      if (PREVIEW_BOT_UA.test(req.get("user-agent") ?? "")) {
        return sendError(res, err("invalid_request", "Link preview bots cannot submit questions").error);
      }
      const q = req.query;
      const name = typeof q.name === "string" ? q.name : undefined;
      const email = typeof q.email === "string" ? q.email : undefined;
      const message = typeof q.message === "string" ? q.message : undefined;
      const error = typeof q.error === "string" ? q.error : undefined;
      const tried = typeof q.tried === "string" ? q.tried : undefined;
      const environment = typeof q.environment === "string" ? q.environment : undefined;
      const idempotency_key =
        typeof q.idempotency_key === "string"
          ? q.idempotency_key
          : name !== undefined && email !== undefined && message !== undefined
            ? "web_" +
              createHash("sha256")
                .update(`${email.trim().toLowerCase()}\0${message.trim()}\0${Math.floor(Date.now() / 60000)}`)
                .digest("base64url")
                .slice(0, 24)
            : undefined;
      const w = q.wait;
      if (w !== undefined && (typeof w !== "string" || !/^\d{1,4}$/.test(w) || Number(w) > 3600)) {
        return sendError(res, err("invalid_request", "wait must be a whole number of seconds from 0 to 3600").error);
      }
      const waitS = w === undefined ? 5 : Number(w);
      const context = error || tried || environment ? { ...(error ? { error } : {}), ...(tried ? { tried } : {}), ...(environment ? { environment } : {}) } : undefined;
      const created = await runOp("leave_message", () =>
        messages.leaveMessage({
          requester: { name: name as string, email: email as string },
          message: message as string,
          ...(context ? { context } : {}),
          ...(idempotency_key ? { idempotency_key } : {}),
          caller: opts.caller?.(req, res),
        }),
      );
      if (!created.ok) return sendError(res, created.error);

      if (waitS > 0 && messages.mode === "two_way") {
        const gone = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) gone.abort();
        });
        const held = await runOp("get_thread", () =>
          messages.getThread({ thread_id: created.data.thread_id, read_token: created.data.read_token, wait_s: waitS, signal: gone.signal }),
        );
        if (gone.signal.aborted) return;
        if (held.ok) {
          const carried = ownerMessageIds(held.data);
          if (carried && carried.ids.length) {
            res.once("finish", () => {
              if (res.statusCode === 201) messages.markDelivered(carried.thread_id, carried.ids);
            });
          }
        }
      }

      if (opts.config && opts.store) {
        const resumeTok = createResumeTokens(opts.store).mintResumeToken(created.data.thread_id);
        const base = baseUrl(req, opts.config.public_url);
        const p = resumePage({ config: opts.config, store: opts.store, base, threadId: created.data.thread_id, token: resumeTok, email: opts.email === true, pollCount: 0 });
        res.set("Cache-Control", "no-store").set("X-Robots-Tag", "noindex").type("text/markdown; charset=utf-8").status(201).send(p.text);
        return;
      }
      sendResult(res, created, 201);
    });
    r.get("/threads/:id", markReadOnFinish(messages), async (req, res) => {
      // wait: one whole number of seconds, 0 to 3600 (clamped to the configured max in messages.ts).
      const w = req.query.wait;
      if (w !== undefined && (typeof w !== "string" || !/^\d{1,4}$/.test(w) || Number(w) > 3600)) {
        return sendError(res, err("invalid_request", "wait must be a whole number of seconds from 0 to 3600").error);
      }
      // A client that goes away (agent timeout, proxy cut) ends the hold; it never closes the thread.
      const gone = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) gone.abort();
      });
      const r2 = await runOp("get_thread", () =>
        messages.getThread({ thread_id: req.params.id, read_token: token(req), resume_token: resume(req), wait_s: w === undefined ? undefined : Number(w), signal: gone.signal }),
      );
      if (!gone.signal.aborted) sendResult(res, r2);
    });
    r.post("/threads/:id/messages", async (req, res) => {
      const b = body(req);
      const r2 = await runOp("follow_up", () =>
        messages.agentFollowUp({
          thread_id: req.params.id,
          read_token: token(req),
          resume_token: resume(req),
          message: b.message as string | undefined,
          idempotency_key: b.idempotency_key as string | undefined,
          done: b.done as boolean | undefined,
        }),
      );
      sendResult(res, r2, 201);
    });
    r.post("/threads/:id/close", async (req, res) =>
      sendResult(res, await runOp("close_thread", () => messages.closeThread({ thread_id: req.params.id, read_token: token(req), resume_token: resume(req) }))),
    );
  }
  r.use((_req, res) => sendError(res, err("invalid_request", "Unknown endpoint").error));
  return r;
}

/** Final error handler: malformed JSON and anything else thrown in middleware -> GatewayError body. */
export function jsonErrorHandler() {
  return (e: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(e);
    const status = (e as { status?: number; type?: string } | null)?.status;
    if (status !== undefined && status >= 400 && status < 500) {
      return sendError(res, err("invalid_request", "Request body must be valid JSON").error);
    }
    sendError(res, err("internal", "Unexpected error").error);
  };
}
