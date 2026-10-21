// Slack Socket Mode client on Node's built-in WebSocket (no `ws`, no Bolt).
// Socket Mode means Slack pushes events over an outbound connection, so the
// server needs no public inbound URL (README.md, Self-host). Protocol:
//   apps.connections.open (app token) -> wss url -> {type:"hello"}
//   <- {type:"events_api", envelope_id, payload}  -> {envelope_id} once handled
//   <- {type:"disconnect"}                        -> reconnect with a fresh url
// A helper of the Slack connector (slack.ts), not a connector by itself.

import { ConnectorError } from "./types.js";

/** The slice of the WHATWG WebSocket the client uses; tests inject a fake constructor. */
export interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface SocketEnvelope {
  type: string;
  envelope_id?: string;
  payload?: unknown;
  reason?: string;
}

export interface SocketModeOptions {
  /** Calls apps.connections.open; throws ConnectorError (channel_auth_failed is fatal, anything else is retried). */
  openUrl: () => Promise<string>;
  /**
   * Handles one events_api envelope. Resolve to ack it; throw to leave it
   * un-acked so Slack redelivers (the owner reply was not persisted).
   */
  onEvent: (payload: unknown) => Promise<void>;
  /** Called on every hello (first connect and each reconnect): Socket Mode does not replay what was sent meanwhile, so the caller fetches it. */
  onConnected?: () => void;
  WebSocket?: WebSocketCtor;
  warn?: (m: string) => void;
  /** Reconnect backoff grows from 1 s to a 60 s cap. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** How long start() waits for hello before giving up on that attempt. */
  helloTimeoutMs?: number;
}

export class SocketModeClient {
  private readonly WS: WebSocketCtor;
  private readonly warn: (m: string) => void;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;
  private readonly helloTimeout: number;
  private ws: WebSocketLike | undefined;
  private connected = false;
  private stopped = true;
  private fatal = false;
  private attempt = 0;
  private lastError: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Reconnects scheduled so far; tests read it to see the backoff path ran. */
  reconnects = 0;

  constructor(private readonly opts: SocketModeOptions) {
    const ctor = opts.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!ctor) throw new Error("this Node has no built-in WebSocket; Slack Socket Mode needs Node >= 22.4");
    this.WS = ctor;
    this.warn = opts.warn ?? ((m) => console.warn(m));
    this.minBackoff = opts.minBackoffMs ?? 1000;
    this.maxBackoff = opts.maxBackoffMs ?? 60_000;
    this.helloTimeout = opts.helloTimeoutMs ?? 10_000;
  }

  /**
   * Opens the first connection and resolves on hello. Rejects when that first
   * attempt fails, so the caller can log it; a transient failure still leaves
   * the client reconnecting in the background, an auth failure does not.
   */
  start(): Promise<void> {
    this.stopped = false;
    this.fatal = false;
    return this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.connected = false;
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.close(1000, "server stopping");
    } catch {
      // already closed
    }
  }

  status(): { connected: boolean; last_error?: string } {
    return this.lastError && !this.connected ? { connected: false, last_error: this.lastError } : { connected: this.connected };
  }

  private connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      this.opts
        .openUrl()
        .then((url) => {
          if (this.stopped) return settle();
          const ws = new this.WS(url);
          this.ws = ws;
          const helloTimer = setTimeout(() => {
            const err = new ConnectorError("channel_unavailable", `Slack Socket Mode sent no hello within ${this.helloTimeout} ms`);
            this.lastError = err.message;
            settle(err);
            try {
              ws.close(4000, "no hello");
            } catch {
              // onclose drives the reconnect either way
            }
          }, this.helloTimeout);
          helloTimer.unref?.();
          ws.onmessage = (ev) => {
            let env: SocketEnvelope;
            try {
              env = JSON.parse(String(ev.data)) as SocketEnvelope;
            } catch {
              return; // not a Socket Mode frame; nothing to ack
            }
            if (env.type === "hello") {
              clearTimeout(helloTimer);
              this.connected = true;
              this.attempt = 0;
              this.lastError = undefined;
              try {
                this.opts.onConnected?.();
              } catch (e) {
                this.warn(`[support] Slack connect hook failed: ${(e as Error)?.message ?? e}`);
              }
              settle();
            } else if (env.type === "disconnect") {
              // Slack rotates connections (refresh_requested, warning); a fresh url is the only way back.
              try {
                ws.close(1000, "disconnect requested");
              } catch {
                // onclose reconnects
              }
            } else if (env.envelope_id) {
              void this.handle(ws, env);
            }
          };
          ws.onerror = () => {
            this.lastError = "Slack Socket Mode connection error";
          };
          ws.onclose = () => {
            clearTimeout(helloTimer);
            if (this.ws === ws) this.ws = undefined;
            this.connected = false;
            if (!settled) settle(new ConnectorError("channel_unavailable", "Slack Socket Mode closed before hello"));
            if (!this.stopped) this.scheduleReconnect();
          };
        })
        .catch((e: unknown) => {
          const err = e instanceof Error ? e : new Error(String(e));
          this.lastError = err.message;
          if (e instanceof ConnectorError && e.code === "channel_auth_failed") {
            // A wrong app token will not fix itself; retrying would only spam Slack and the log.
            this.fatal = true;
            this.warn(`[support] Slack Socket Mode stopped: ${err.message}`);
          } else if (!this.stopped) {
            this.scheduleReconnect();
          }
          settle(err);
        });
    });
  }

  private async handle(ws: WebSocketLike, env: SocketEnvelope): Promise<void> {
    if (env.type === "events_api") {
      try {
        await this.opts.onEvent(env.payload);
      } catch (e) {
        // No ack: Slack redelivers, and the owner sees no reaction meanwhile.
        this.warn(`[support] Slack event not acknowledged (will be redelivered): ${(e as Error)?.message ?? e}`);
        return;
      }
    }
    // Other envelope types (slash commands, interactivity) are unused; ack so Slack stops retrying them.
    try {
      ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
    } catch (e) {
      this.warn(`[support] Slack ack failed: ${(e as Error)?.message ?? e}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.fatal || this.timer) return;
    const delay = Math.min(this.maxBackoff, this.minBackoff * 2 ** this.attempt);
    this.attempt++;
    this.reconnects++;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped) return;
      this.connect().catch(() => {
        // connect() already logged or scheduled the next attempt
      });
    }, delay);
    this.timer.unref?.();
  }
}
