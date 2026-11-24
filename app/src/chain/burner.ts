/**
 * The browser's burner key and the TEE login, with no wallet popup: the key lives in
 * localStorage and signs the rollup's auth challenge itself.
 */
import nacl from "tweetnacl";
import bs58 from "bs58";

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** localStorage when usable, otherwise an in-memory map (private mode). */
export function storage(): KV {
  try {
    const ls = globalThis.localStorage;
    const probe = "ping-probe";
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return ls;
  } catch {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
  }
}

export const BURNER_KEY = "ping-burner-v1";

export interface Burner {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  address: string;
  /** true when created by this call (first visit, or storage unavailable) */
  fresh: boolean;
}

export function loadOrCreateBurner(kv: KV = storage()): Burner {
  try {
    const raw = kv.getItem(BURNER_KEY);
    if (raw) {
      const sk = Uint8Array.from(JSON.parse(raw) as number[]);
      if (sk.length === 64) {
        const kp = nacl.sign.keyPair.fromSecretKey(sk);
        return { secretKey: kp.secretKey, publicKey: kp.publicKey, address: bs58.encode(kp.publicKey), fresh: false };
      }
    }
  } catch {
    /* corrupt entry: replace it */
  }
  const kp = nacl.sign.keyPair();
  try {
    kv.setItem(BURNER_KEY, JSON.stringify(Array.from(kp.secretKey)));
  } catch {
    /* storage full or blocked: the key lives for this tab only */
  }
  return { secretKey: kp.secretKey, publicKey: kp.publicKey, address: bs58.encode(kp.publicKey), fresh: true };
}

/** The secret key as a base58 string, for the "export key" menu item. */
export const exportBurner = (b: Burner) => bs58.encode(b.secretKey);

/* ------------------------------------------------------------------ TEE login */

export interface Token { token: string; expiresAt: number }
export const SESSION_MS = 30 * 24 * 3600 * 1000;
export const REFRESH_MARGIN_MS = 60_000;
const expMs = (x: number) => (x > 1e12 ? x : x * 1000);

export class AuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** The rollup's login text: "Login to Query Filtering Service\nTimestamp: <unix>\nUser: <base58 key>". */
export const isLoginChallenge = (c: string, address: string) =>
  c.length <= 160 && /^Login to Query Filtering Service\nTimestamp: \d{1,13}\nUser: [1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c) && c.endsWith(`\nUser: ${address}`);

/** challenge -> ed25519 signature -> token (the rollup's query-filtering login). */
export async function login(endpoint: string, b: Burner, fetchImpl: typeof fetch = fetch): Promise<Token> {
  const ch = await fetchImpl(`${endpoint}/auth/challenge?pubkey=${b.address}`);
  const cj = (await ch.json().catch(() => ({}))) as { challenge?: string; error?: string };
  if (!ch.ok || typeof cj.challenge !== "string" || !cj.challenge) throw new AuthError(`challenge failed: ${cj.error ?? ch.status}`, ch.status);
  // Sign only the login text in its exact known shape, naming this key. A serialized
  // transaction message starts with a non-printable byte, so the endpoint can never
  // obtain a transaction signature this way.
  if (!isLoginChallenge(cj.challenge, b.address)) throw new AuthError("challenge rejected: unexpected format", 0);
  const sig = nacl.sign.detached(new TextEncoder().encode(cj.challenge), b.secretKey);
  const lr = await fetchImpl(`${endpoint}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: b.address, challenge: cj.challenge, signature: bs58.encode(sig) }),
  });
  const lj = (await lr.json().catch(() => ({}))) as { token?: string; expiresAt?: number; error?: string };
  if (lr.status !== 200 || typeof lj.token !== "string" || !lj.token) throw new AuthError(`login failed: ${lj.error ?? lr.status}`, lr.status);
  return { token: lj.token, expiresAt: expMs(lj.expiresAt ?? Date.now() + SESSION_MS) };
}

/** Cached token per endpoint and key; refreshed when < 60 s remain or after `invalidate()`. */
export class TokenStore {
  private inflight: Promise<Token> | null = null;
  private mem: Token | null = null;
  constructor(
    private endpoint: string,
    private burner: Burner,
    private kv: KV = storage(),
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
    private now: () => number = Date.now,
  ) {}
  get cacheKey() {
    return `ping-tee-token-v1:${this.endpoint}:${this.burner.address}`;
  }
  private read(): Token | null {
    if (this.mem) return this.mem;
    try {
      const raw = this.kv.getItem(this.cacheKey);
      if (!raw) return null;
      const t = JSON.parse(raw) as Token;
      return typeof t.token === "string" && t.token ? { token: t.token, expiresAt: expMs(Number(t.expiresAt) || 0) } : null;
    } catch {
      return null;
    }
  }
  /** A valid token, logging in only when none is cached or it is about to expire. */
  async get(): Promise<Token> {
    const t = this.read();
    if (t && t.expiresAt - this.now() > REFRESH_MARGIN_MS) return (this.mem = t);
    return this.refresh();
  }
  refresh(): Promise<Token> {
    if (!this.inflight) {
      this.inflight = login(this.endpoint, this.burner, this.fetchImpl)
        .then((t) => {
          this.mem = t;
          try {
            this.kv.setItem(this.cacheKey, JSON.stringify(t));
          } catch {
            /* memory only */
          }
          return t;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }
  /** Drop the cached token (after a 401). */
  invalidate(bad?: string) {
    const t = this.read();
    if (bad && t && t.token !== bad) return; // already replaced
    this.mem = null;
    try {
      this.kv.removeItem(this.cacheKey);
    } catch {
      /* ignore */
    }
  }
}
