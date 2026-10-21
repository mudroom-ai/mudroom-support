// Optional bearer keys. The gateway is public by default:
//   no Authorization header      -> anonymous (per-IP limits)
//   valid "Bearer <key>"         -> keyed agent (higher per-key limits)
//   any other Authorization value -> 401 unauthorized
// With no API_KEYS configured, the header is ignored (everyone is anonymous),
// so connectors that send a stray token still work.

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { err, type GatewayError } from "../errors.js";

export type Auth = { kind: "anonymous" } | { kind: "key"; key_id: string };

const sha256 = (s: string) => createHash("sha256").update(s).digest();

export function authenticate(
  header: string | undefined,
  apiKeys: string[],
): { ok: true; auth: Auth } | { ok: false; error: GatewayError } {
  if (!header || apiKeys.length === 0) return { ok: true, auth: { kind: "anonymous" } };
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (m) {
    const got = sha256(m[1]!);
    for (const k of apiKeys) {
      const want = sha256(k);
      if (timingSafeEqual(got, want)) return { ok: true, auth: { kind: "key", key_id: want.toString("hex").slice(0, 12) } };
    }
  }
  return err("unauthorized", "Invalid API key. Omit the Authorization header to use the public tier.");
}

/** Sets res.locals.auth, or answers 401 with the GatewayError body. */
export function authMiddleware(apiKeys: string[], onError: (res: Response, e: GatewayError) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    const r = authenticate(req.get("authorization"), apiKeys);
    if (!r.ok) return onError(res, r.error);
    res.locals.auth = r.auth;
    next();
  };
}

export function getAuth(res: Response): Auth {
  return (res.locals.auth as Auth | undefined) ?? { kind: "anonymous" };
}
