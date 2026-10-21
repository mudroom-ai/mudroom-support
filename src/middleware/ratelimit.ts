// Rate limits, in memory, TTL-bounded maps (one replica):
//   - per request: anonymous per IP (per_ip_per_min) or per bearer key (per_key_per_min)
//   - new questions / follow-ups: a vendor-wide hourly cap, plus per contact per hour for new questions, counting only
//     questions the requester confirmed by email (messageRateLimit; the message core calls it after validation, so junk
//     never spends quota)

import { isIP, isIPv4, isIPv6 } from "node:net";
import type { NextFunction, Request, Response } from "express";
import type { Limits } from "../config.js";
import { err, type GatewayError } from "../errors.js";
import { getAuth } from "./auth.js";

/** Fixed-window counters with expiry; bounded to `maxKeys` entries. */
export class TtlCounter {
  private readonly m = new Map<string, { count: number; reset_at: number }>();

  constructor(
    readonly windowMs: number,
    readonly maxKeys = 10_000,
  ) {}

  get size(): number {
    return this.m.size;
  }

  /** Count a hit. Returns null if allowed, else seconds until the window resets. */
  hit(key: string, limit: number, nowMs: number): number | null {
    let e = this.m.get(key);
    if (!e || e.reset_at <= nowMs) {
      this.m.delete(key);
      e = { count: 0, reset_at: nowMs + this.windowMs };
      this.prune(nowMs);
      this.m.set(key, e);
    }
    if (e.count >= limit) return Math.max(1, Math.ceil((e.reset_at - nowMs) / 1000));
    e.count++;
    return null;
  }

  /** Seconds until `key` may hit again, or null if a hit now would be allowed. Counts nothing. */
  peek(key: string, limit: number, nowMs: number): number | null {
    const e = this.m.get(key);
    if (!e || e.reset_at <= nowMs || e.count < limit) return null;
    return Math.max(1, Math.ceil((e.reset_at - nowMs) / 1000));
  }

  private prune(nowMs: number): void {
    if (this.m.size < this.maxKeys) return;
    for (const [k, v] of this.m) if (v.reset_at <= nowMs) this.m.delete(k);
    // Still full: drop the oldest entries (Map keeps insertion order).
    for (const k of this.m.keys()) {
      if (this.m.size < this.maxKeys) break;
      this.m.delete(k);
    }
  }
}

export interface ClientIpOptions {
  /** Honor CF-Connecting-IP from a trusted peer (TRUST_CF_CONNECTING_IP and an address-list TRUST_PROXY). */
  trustCfHeader?: boolean;
  /** Log how the IP was resolved (TRUST_PROXY_DEBUG). */
  debug?: boolean;
}

type TrustFn = (addr: string, i: number) => boolean;

/**
 * Caller IP, resolved by Express's "trust proxy" setting (TRUST_PROXY, default loopback):
 * req.ip walks X-Forwarded-For from the right and stops at the first untrusted hop.
 * CF-Connecting-IP is used only when opted in and the immediate peer is a trusted proxy: a non-Cloudflare
 * local proxy (nginx, Caddy) passes a client-supplied CF-Connecting-IP straight through.
 */
export function clientIp(req: Request, opts: ClientIpOptions = {}): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  const trust = req.app.get("trust proxy fn") as TrustFn | undefined;
  const cf = req.get("cf-connecting-ip")?.trim();
  const ip = opts.trustCfHeader && cf && isIP(cf) && trust?.(peer, 0) ? cf : (req.ip ?? peer);
  if (opts.debug) {
    console.log(
      `[support] client ip: peer=${peer} x-forwarded-for=${JSON.stringify(req.get("x-forwarded-for") ?? null)} cf-connecting-ip=${JSON.stringify(cf ?? null)} -> ${ip}`,
    );
  }
  return ip;
}

/** Rate-limit bucket for an IP: IPv4 as is, IPv6 by /64 (one host typically owns a whole /64). */
export function ipBucket(ip: string): string {
  if (isIPv4(ip)) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped && isIPv4(mapped[1]!)) return mapped[1]!;
  if (!isIPv6(ip)) return ip;
  const groups = (part: string) => (part ? part.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g])) : []);
  const [head = "", tail] = ip.toLowerCase().split("%")[0]!.split("::");
  const h = groups(head);
  const full = tail === undefined ? h : [...h, ...Array(8 - h.length - groups(tail).length).fill("0"), ...groups(tail)];
  return `${full.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

/** The caller's bucket: `k:<key id>` for a keyed agent, else `ip:<ip bucket>`. Must run after authMiddleware. */
export function callerKey(req: Request, res: Response, opts: ClientIpOptions = {}): string {
  const auth = getAuth(res);
  return auth.kind === "key" ? `k:${auth.key_id}` : `ip:${ipBucket(clientIp(req, opts))}`;
}

/** Per-IP (anonymous) or per-key request limit. Must run after authMiddleware. */
export function requestRateLimit(
  limits: Limits,
  onError: (res: Response, e: GatewayError) => void,
  opts: { counter?: TtlCounter; now?: () => number } & ClientIpOptions = {},
) {
  const counter = opts.counter ?? new TtlCounter(60_000);
  const now = opts.now ?? Date.now;
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = getAuth(res);
    const [key, limit] =
      auth.kind === "key" ? [`k:${auth.key_id}`, limits.per_key_per_min] : [`ip:${ipBucket(clientIp(req, opts))}`, limits.per_ip_per_min];
    const wait = counter.hit(key, limit, now());
    if (wait !== null) {
      return onError(res, err("rate_limited", `Too many requests; retry in ${wait}s`, { retry_after_s: wait }).error);
    }
    next();
  };
}

/** Normalized contact keys for a customer: lowercased email, phone digits. */
export function contactKeys(customer: unknown): string[] {
  const c = (customer && typeof customer === "object" ? customer : {}) as Record<string, unknown>;
  const keys: string[] = [];
  if (typeof c.email === "string" && c.email.trim()) keys.push(`e:${c.email.trim().toLowerCase()}`);
  if (typeof c.phone === "string") {
    const d = c.phone.replace(/\D/g, "");
    if (d) keys.push(`p:${d}`);
  }
  return keys;
}

export interface MessageRateLimitOptions {
  vendor?: TtlCounter;
  /**
   * When this contact's CONFIRMED questions (any of `keys`) asked at or after `sinceMs` were asked, in ms. Unconfirmed
   * questions do not count, so naming someone else's address cannot spend their hourly quota; those are bounded by
   * limits.max_unconfirmed_threads_per_caller and the per-request limits instead. Omitted = no per-contact cap.
   */
  confirmedSince?: (keys: string[], sinceMs: number) => number[];
}

const HOUR_MS = 3_600_000;

/**
 * Hourly limits for messages to support. Returns null when allowed, else the rate_limited
 * error. Called by the message core only for well-formed requests, so a junk request
 * naming a victim's contact spends nothing.
 * `keys` empty = a follow-up: only the vendor-wide cap applies.
 */
export function messageRateLimit(limits: Limits, opts: MessageRateLimitOptions = {}) {
  const vendor = opts.vendor ?? new TtlCounter(HOUR_MS);
  return (keys: string[], nowMs: number): GatewayError | null => {
    // Check every cap before counting any, so a request refused by one cap spends nothing on the others.
    if (keys.length && opts.confirmedSince) {
      const times = opts.confirmedSince(keys, nowMs - HOUR_MS).sort((a, b) => a - b);
      const over = times.length - limits.per_contact_per_hour;
      if (over >= 0) {
        // Allowed again once enough of these questions leave the window to drop below the limit.
        const wait = Math.max(1, Math.ceil((times[over]! + HOUR_MS - nowMs) / 1000));
        return err("rate_limited", `Too many messages for this contact; retry in ${wait}s`, { retry_after_s: wait }).error;
      }
    }
    const wait = vendor.peek("vendor", limits.max_messages_per_hour, nowMs);
    if (wait !== null) {
      return err("rate_limited", `Support is receiving too many messages right now; retry in ${wait}s`, { retry_after_s: wait }).error;
    }
    vendor.hit("vendor", limits.max_messages_per_hour, nowMs);
    return null;
  };
}
