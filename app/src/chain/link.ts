/**
 * The two connections: the base layer (Tape, calls, committed Rounds) and the private
 * rollup with this burner's token (Table, own Desk, `act`, `join`; Book and Desks after
 * the bell). A 401 from the rollup drops the token, logs in again and replaces the
 * connection; watchers re-subscribe on the new one.
 */
import { Connection, PublicKey, type Commitment } from "@solana/web3.js";
import { withToken, type ChainConfig } from "./config";
import type { TokenStore } from "./burner";

/** What `watchAccount` needs from a connection. */
export interface AccountSource {
  /** Changes whenever the underlying connection is replaced. */
  readonly epoch: number;
  get(key: PublicKey): Promise<Uint8Array | null>;
  subscribe(key: PublicKey, cb: (data: Uint8Array) => void): () => void;
  onReplaced(fn: () => void): () => void;
}

export type LinkState = "connecting" | "ok" | "offline";

/**
 * Drop the raw websocket the way a network failure would (the client reconnects and
 * re-subscribes by itself). Test hook for the reconnect path.
 */
export function dropSocket(c: Connection | null) {
  const rpc = (c as unknown as { _rpcWebSocket?: { socket?: { socket?: { close?: () => void }; close?: () => void } } } | null)?._rpcWebSocket;
  const raw = rpc?.socket?.socket ?? rpc?.socket;
  try {
    raw?.close?.();
  } catch {
    /* already closed */
  }
}

/** Close a connection's websocket for good (only when the whole driver stops). */
export function closeSocket(c: Connection | null) {
  // web3.js 1.x keeps its websocket client private; close it so a replaced connection stops reconnecting
  const ws = (c as unknown as { _rpcWebSocket?: { close?: () => void } } | null)?._rpcWebSocket;
  try {
    ws?.close?.();
  } catch {
    /* already closed */
  }
}

export abstract class ConnSource implements AccountSource {
  epoch = 0;
  private listeners = new Set<() => void>();
  constructor(private commitment: Commitment = "processed") {}
  protected abstract conn(): Connection | null;
  async get(key: PublicKey) {
    const c = this.conn();
    if (!c) throw new Error("not connected");
    const a = await c.getAccountInfo(key, this.commitment);
    return a ? Uint8Array.from(a.data) : null;
  }
  subscribe(key: PublicKey, cb: (d: Uint8Array) => void) {
    const c = this.conn();
    if (!c) return () => {};
    const id = c.onAccountChange(key, (a) => cb(Uint8Array.from(a.data)), { commitment: this.commitment });
    return () => void c.removeAccountChangeListener(id).catch(() => {});
  }
  onReplaced(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  protected replaced() {
    this.epoch++;
    for (const f of [...this.listeners]) f();
  }
}

/** The rollup connection carrying this burner's token. */
export class TeeLink extends ConnSource {
  state: LinkState = "connecting";
  lastError: string | null = null;
  private c: Connection | null = null;
  private token: string | null = null;
  private stateListeners = new Set<(s: LinkState, err: string | null) => void>();
  private reauthing: Promise<void> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private cfg: ChainConfig, private tokens: TokenStore) {
    super("processed");
  }
  protected conn() {
    return this.c;
  }

  get connection() {
    return this.c;
  }
  /** The tokenized HTTP endpoint (for the act Worker), or null before login. */
  get url() {
    return this.token ? withToken(this.cfg.teeRpc, this.token) : null;
  }

  onState(fn: (s: LinkState, err: string | null) => void) {
    this.stateListeners.add(fn);
    return () => void this.stateListeners.delete(fn);
  }
  setState(s: LinkState, err: string | null = null) {
    if (s === this.state && err === this.lastError) return;
    this.state = s;
    this.lastError = err;
    for (const f of [...this.stateListeners]) f(s, err);
  }

  /** Log in (cached token if valid) and open the connection. */
  async connect(): Promise<void> {
    const t = await this.tokens.get();
    this.install(t.token, t.expiresAt);
  }

  private install(token: string, expiresAt: number) {
    this.token = token;
    const fetchWith401: typeof fetch = async (input, init) => {
      const r = await fetch(input, init);
      if (r.status === 401) void this.reauth(token);
      return r;
    };
    this.c = new Connection(withToken(this.cfg.teeRpc, token), {
      wsEndpoint: withToken(this.cfg.teeWs, token),
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
      fetch: fetchWith401,
    });
    // The old connection is not closed here: closing it while its subscriptions are still
    // being removed makes the client retry the unsubscribe forever. Watchers unsubscribe from
    // it on `replaced()` and the client closes an idle socket by itself.
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const ms = Math.min(2 ** 31 - 1, Math.max(5_000, expiresAt - Date.now() - 60_000));
    this.refreshTimer = setTimeout(() => void this.reauth(token), ms);
    this.replaced();
  }

  /** Drop `bad` (if it is still the current token), log in again and replace the connection. */
  reauth(bad: string | null = this.token): Promise<void> {
    if (bad !== this.token && this.token !== null) return Promise.resolve();
    if (!this.reauthing) {
      this.tokens.invalidate(bad ?? undefined);
      this.setState("connecting", "rollup token rejected, signing in again");
      this.reauthing = this.tokens
        .refresh()
        .then((t) => {
          this.install(t.token, t.expiresAt);
          this.setState("ok");
        })
        .catch((e) => this.setState("offline", (e as Error).message))
        .finally(() => {
          this.reauthing = null;
        });
    }
    return this.reauthing;
  }

  close() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    closeSocket(this.c);
    this.c = null;
  }
}

/** Base layer: polling only (no websocket needed for the Tape). */
export class BaseLink extends ConnSource {
  readonly connection: Connection;
  constructor(cfg: ChainConfig) {
    super("confirmed");
    this.connection = new Connection(cfg.baseRpc, { commitment: "confirmed", disableRetryOnRateLimit: true });
  }
  protected conn() {
    return this.connection;
  }
}

/** Raw JSON-RPC (the peek console shows exactly what came back). */
export async function rawRpc(url: string, method: string, params: unknown[] = []): Promise<{ http: number; body: { result?: unknown; error?: { code?: number; message?: string } } | null; ms: number }> {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const text = await r.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: { message: text.slice(0, 160) } };
    }
    return { http: r.status, body, ms: performance.now() - t0 };
  } catch (e) {
    return { http: 0, body: { error: { message: (e as Error).message } }, ms: performance.now() - t0 };
  }
}
