import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { watchAccount } from "./watch";
import type { AccountSource } from "./link";
import { BURNER_KEY, loadOrCreateBurner, login, TokenStore, type KV } from "./burner";
import { SlotClock } from "./slotclock";
import { makeConfig, parseTableIds, withToken } from "./config";

class FakeSource implements AccountSource {
  epoch = 0;
  data: Uint8Array | null = Uint8Array.of(1);
  gets = 0;
  subs = 0;
  live: ((d: Uint8Array) => void) | null = null;
  fail = false;
  private rep = new Set<() => void>();
  async get() {
    this.gets++;
    if (this.fail) throw new Error("down");
    return this.data;
  }
  subscribe(_k: unknown, cb: (d: Uint8Array) => void) {
    this.subs++;
    this.live = cb;
    return () => {
      if (this.live === cb) this.live = null;
    };
  }
  onReplaced(fn: () => void) {
    this.rep.add(fn);
    return () => void this.rep.delete(fn);
  }
  replace() {
    this.epoch++;
    this.live = null; // the old socket is gone
    for (const f of this.rep) f();
  }
}

const key = Keypair.generate().publicKey;

describe("watchAccount", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("delivers pushes, polls over HTTP when the socket goes quiet, re-subscribes after 3x, and on a replaced connection", async () => {
    const src = new FakeSource();
    const seen: [number, string][] = [];
    const w = watchAccount(src, key, (d, via) => seen.push([d?.[0] ?? -1, via]), { expectEveryMs: 500, now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([[1, "poll"]]);
    expect(src.subs).toBe(1);
    // live pushes keep polling off
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(250);
      src.live!(Uint8Array.of(2));
    }
    const pollsBefore = src.gets;
    expect(pollsBefore).toBe(1);
    // the websocket dies silently
    src.live = null;
    src.data = Uint8Array.of(3);
    await vi.advanceTimersByTimeAsync(3000);
    expect(src.gets).toBeGreaterThan(pollsBefore); // fallback polling
    expect(seen.at(-1)).toEqual([3, "poll"]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(src.subs).toBeGreaterThan(1); // re-subscribed
    // token replaced -> new connection -> immediate re-subscribe + poll
    const subs = src.subs;
    const gets = src.gets;
    src.data = Uint8Array.of(4);
    src.replace();
    await vi.advanceTimersByTimeAsync(0);
    expect(src.subs).toBe(subs + 1);
    expect(src.gets).toBe(gets + 1);
    expect(seen.at(-1)).toEqual([4, "poll"]);
    src.live!(Uint8Array.of(5));
    expect(seen.at(-1)).toEqual([5, "push"]);
    w.stop();
    const n = src.gets;
    await vi.advanceTimersByTimeAsync(5000);
    expect(src.gets).toBe(n);
  });

  it("reports null for unreadable accounts and survives transport errors", async () => {
    const src = new FakeSource();
    src.data = null;
    const seen: (Uint8Array | null)[] = [];
    const errors: unknown[] = [];
    const w = watchAccount(src, key, (d) => seen.push(d), { expectEveryMs: 400, subscribe: false, onError: (e) => errors.push(e) });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([null]);
    src.fail = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(errors.length).toBeGreaterThan(0);
    src.fail = false;
    src.data = Uint8Array.of(9);
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen.at(-1)).toEqual(Uint8Array.of(9));
    expect(src.subs).toBe(0); // poll-only mode
    w.stop();
  });

  it("does not poll while not live", async () => {
    const src = new FakeSource();
    let live = false;
    const w = watchAccount(src, key, () => {}, { expectEveryMs: 300, isLive: () => live });
    await vi.advanceTimersByTimeAsync(3000);
    expect(src.gets).toBe(1);
    live = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(src.gets).toBeGreaterThan(1);
    w.stop();
  });
});

const memKV = (): KV & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

describe("burner and rollup login", () => {
  it("creates the burner once and reloads the same key", () => {
    const kv = memKV();
    const a = loadOrCreateBurner(kv);
    expect(a.fresh).toBe(true);
    const b = loadOrCreateBurner(kv);
    expect(b.fresh).toBe(false);
    expect(b.address).toBe(a.address);
    expect(JSON.parse(kv.m.get(BURNER_KEY)!)).toHaveLength(64);
    kv.m.set(BURNER_KEY, "junk");
    expect(loadOrCreateBurner(kv).address).not.toBe(a.address);
  });

  const fakeTee = () => {
    let n = 0;
    const log: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      log.push(url);
      if (url.includes("/auth/challenge")) return Response.json({ challenge: "Login to Query Filtering Service / Timestamp 1 / User x" });
      const body = JSON.parse(String(init!.body));
      const ok = nacl.sign.detached.verify(new TextEncoder().encode(body.challenge), bs58.decode(body.signature), bs58.decode(body.pubkey));
      if (!ok) return Response.json({ error: "bad signature" }, { status: 401 });
      return Response.json({ token: `tok${++n}` });
    }) as unknown as typeof fetch;
    return { f, log };
  };

  it("signs the challenge itself (no wallet) and caches the token across reloads", async () => {
    const kv = memKV();
    const b = loadOrCreateBurner(kv);
    const tee = fakeTee();
    const t = await login("http://tee", b, tee.f);
    expect(t.token).toBe("tok1");
    expect(t.expiresAt).toBeGreaterThan(Date.now() + 29 * 24 * 3600e3);
    const s1 = new TokenStore("http://tee", b, kv, tee.f);
    expect((await s1.get()).token).toBe("tok2");
    // reload: a new store reads the cached token, no login
    const s2 = new TokenStore("http://tee", b, kv, tee.f);
    const before = tee.log.length;
    expect((await s2.get()).token).toBe("tok2");
    expect(tee.log.length).toBe(before);
    // 401 -> invalidate -> a fresh login
    s2.invalidate("tok2");
    expect((await s2.get()).token).toBe("tok3");
    // wiping the stored token makes the next store log in again
    kv.m.delete(s2.cacheKey);
    expect((await new TokenStore("http://tee", b, kv, tee.f).get()).token).toBe("tok4");
    // concurrent refreshes share one login
    const s3 = new TokenStore("http://tee", b, kv, tee.f);
    const [x, y] = await Promise.all([s3.refresh(), s3.refresh()]);
    expect(x.token).toBe(y.token);
  });

  it("refreshes a token about to expire", async () => {
    const kv = memKV();
    const b = loadOrCreateBurner(kv);
    const tee = fakeTee();
    const s = new TokenStore("http://tee", b, kv, tee.f);
    kv.setItem(s.cacheKey, JSON.stringify({ token: "old", expiresAt: Date.now() + 30_000 }));
    expect((await s.get()).token).toBe("tok1");
  });
});

describe("config and slot clock", () => {
  it("reads VITE_* env with local/devnet defaults", () => {
    const d = makeConfig({});
    expect(d.cluster).toBe("devnet");
    expect(d.teeRpc).toBe("https://devnet-tee.magicblock.app");
    expect(makeConfig({ DEV: true }).cluster).toBe("local");
    const c = makeConfig({ VITE_CLUSTER: "local", VITE_TABLE_IDS: "3, 4,x", VITE_TEE_RPC: "http://h:1/", VITE_SLOT_MS: "10" });
    expect(c.tableIds).toEqual([3n, 4n]);
    expect(c.teeRpc).toBe("http://h:1");
    expect(c.slotMs).toBe(10);
    expect(parseTableIds("")).toEqual([]);
    expect(withToken("https://x", "a.b")).toBe("https://x?token=a.b");
    expect(withToken("https://x", null)).toBe("https://x");
  });

  it("maps slots to local time and fits the slot rate", () => {
    const c = new SlotClock(10);
    expect(c.timeOf(5)).toBeNull();
    // true clock: slot s at 1000 + 9.5 s ms; rtt 40 ms
    for (let i = 0; i < 10; i++) {
      const slot = 100 + i * 100;
      const at = 1000 + slot * 9.5;
      c.add(slot, at - 20, at + 20);
    }
    expect(c.slotMs).toBeCloseTo(9.5, 3);
    expect(c.timeOf(2000)!).toBeCloseTo(1000 + 2000 * 9.5, 0);
    expect(c.slotAt(1000 + 500 * 9.5)!).toBeCloseTo(500, 1);
  });
});
