// DNS rebinding protection. A web page can point its own domain at 127.0.0.1
// and have the visitor's browser call a local gateway; checking Host (and, on
// loopback, Origin) stops that.
//   ALLOWED_HOSTS set        -> Host hostname (port ignored) must be in the list
//   bound to loopback        -> Host must be localhost / 127.0.0.1 / [::1] (or the
//                               bind address), and a browser Origin, when sent,
//                               must be one of those too
//   bound to another address -> Host must be the bind address or a localhost name
//   bound to 0.0.0.0 or ::   -> no check; warn at startup
// A rejected request gets invalid_request with the shared GatewayError body.

import { isIP } from "node:net";
import type { NextFunction, Request, Response } from "express";
import { err, type GatewayError } from "../errors.js";

const LOCALHOST_NAMES = ["localhost", "127.0.0.1", "[::1]"];

/** localhost, any 127.0.0.0/8 address, or ::1. */
function isLoopback(bindHost: string): boolean {
  return bindHost === "localhost" || bindHost === "::1" || (isIP(bindHost) === 4 && bindHost.startsWith("127."));
}

/** The bind address as it appears in a Host header (IPv6 in brackets). */
function asHostName(bindHost: string): string {
  return isIP(bindHost) === 6 ? `[${bindHost}]` : bindHost;
}

/** Hostname of a Host header value (port dropped, IPv6 kept in brackets), or null when it does not parse. */
function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

/** Why the Host header is refused, or null when it is allowed. */
export function checkHost(host: string | undefined, allowed: string[]): string | null {
  if (!host) return "Missing Host header";
  const name = hostnameOf(host);
  if (name === null) return `Invalid Host header: ${host}`;
  return allowed.includes(name) ? null : `Host not allowed: ${name}`;
}

/** Why the Origin header is refused, or null when it is absent or allowed. Non-browser clients send none. */
export function checkOrigin(origin: string | undefined, allowed: string[]): string | null {
  if (!origin) return null;
  let name: string;
  try {
    name = new URL(origin).hostname;
  } catch {
    return `Invalid Origin header: ${origin}`;
  }
  return name && allowed.includes(name) ? null : `Origin not allowed: ${name || origin}`;
}

export function hostValidation(
  bindHost: string,
  allowedHosts: string[],
  onError: (res: Response, e: GatewayError) => void,
  warn: (m: string) => void = (m) => console.warn(m),
) {
  const loopback = isLoopback(bindHost);
  const wildcard = bindHost === "0.0.0.0" || bindHost === "::";
  const local = [...new Set([...LOCALHOST_NAMES, asHostName(bindHost)])];
  // Fail closed: with no ALLOWED_HOSTS, only a wildcard bind skips the check.
  const hosts = allowedHosts.length ? allowedHosts : wildcard ? null : local;
  const origins = loopback ? local : null;
  if (!hosts) {
    warn(`[support] WARNING: binding to ${bindHost} without DNS rebinding protection. Set ALLOWED_HOSTS to the hostnames agents use.`);
  }
  return (req: Request, res: Response, next: NextFunction) => {
    const why = (hosts && checkHost(req.headers.host, hosts)) || (origins ? checkOrigin(req.headers.origin, origins) : null);
    if (why) return onError(res, err("invalid_request", why).error);
    next();
  };
}
