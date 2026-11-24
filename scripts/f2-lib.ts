// Shared helpers for the live devnet scripts (humans.ts, e2e-devnet.ts, measure-beat.ts):
// endpoints, an append-only JSON-lines writer, a rollup slot clock, a public Table poller and statistics.
import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { DEV } from "../tests/devnet/devnet.ts";
import { rpc } from "../tests/local/lib.ts";
import { decodeTable, type TableView } from "../house/src/chain.ts";

export { DEV };
export const now = () => Date.now();
export const iso = (t = Date.now()) => new Date(t).toISOString();

/** Append-only JSON lines (one synchronous write per line, so a crash loses at most the line being written). */
export class Jsonl {
  constructor(readonly file: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
  write(ev: string, data: Record<string, unknown>) {
    const line = JSON.stringify({ t: iso(), ev, ...data }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    fs.appendFileSync(this.file, line + "\n");
  }
  static read(file: string): any[] {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
}

/** HTTP 429 back-off shared by every caller in the process (counted for the report). */
export const http429 = { n: 0, until: 0 };
export async function call(url: string, method: string, params: unknown[] = []): Promise<{ http: number; body: any }> {
  for (let i = 0; ; i++) {
    const wait = http429.until - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const r = await rpc(url, method, params);
    if (r.http !== 429 || i >= 6) return r;
    http429.n++;
    http429.until = Date.now() + 500 * 2 ** i;
  }
}
export async function account(url: string, acc: PublicKey | string, commitment = "confirmed") {
  const r = await call(url, "getAccountInfo", [typeof acc === "string" ? acc : acc.toBase58(), { encoding: "base64", commitment }]);
  const v = r.body?.result?.value;
  return { data: v ? Buffer.from(v.data[0], "base64") : null, owner: v?.owner as string | undefined, lamports: v?.lamports as number | undefined, slot: r.body?.result?.context?.slot as number | undefined, http: r.http, error: r.body?.error };
}

/** Rollup slot → local wall time, fitted from getSlot samples (sample time = request midpoint; offset from the fastest half). */
export class SlotClock {
  private xs: { slot: number; at: number; rtt: number }[] = [];
  slotMs = 10;
  private offset: number | null = null;
  constructor(private url = DEV.er, private every = 1000) {}
  private timer: NodeJS.Timeout | null = null;
  start() {
    const tick = async () => {
      const t0 = Date.now();
      const r = await call(this.url, "getSlot", [{ commitment: "processed" }]);
      const t1 = Date.now();
      if (typeof r.body?.result === "number") this.add(r.body.result, t0, t1);
      this.timer = setTimeout(tick, this.every);
    };
    void tick();
    return this;
  }
  stop() { if (this.timer) clearTimeout(this.timer); }
  get fitted() { return this.xs.length >= 20 && this.xs[this.xs.length - 1].at - this.xs[0].at >= 20000; }
  /** slope from up to 10 min of samples; offset from the fastest half of the latest 30 */
  add(slot: number, t0: number, t1: number) {
    this.xs.push({ slot, at: (t0 + t1) / 2, rtt: t1 - t0 });
    if (this.xs.length > 600) this.xs.shift();
    const xs = this.xs;
    if (xs.length >= 8) {
      const n = xs.length, mx = xs.reduce((a, s) => a + s.slot, 0) / n, my = xs.reduce((a, s) => a + s.at, 0) / n;
      let num = 0, den = 0;
      for (const s of xs) { num += (s.slot - mx) * (s.at - my); den += (s.slot - mx) ** 2; }
      const k = den > 0 ? num / den : 10;
      if (k > 3 && k < 30) this.slotMs = k;
    }
    const recent = xs.slice(-30);
    const best = [...recent].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, Math.ceil(recent.length / 2)));
    const offs = best.map((s) => s.at - s.slot * this.slotMs).sort((a, b) => a - b);
    this.offset = offs[Math.floor(offs.length / 2)];
  }
  timeOf(slot: number): number | null { return this.offset === null ? null : this.offset + slot * this.slotMs; }
  slotAt(t = Date.now()): number | null { return this.offset === null ? null : (t - this.offset) / this.slotMs; }
}

/** Polls a public Table on the rollup (no token) and keeps the latest view. */
export class TablePoll {
  view: TableView | null = null;
  at = 0;
  slot = 0;
  private stopped = false;
  listeners: ((t: TableView, prev: TableView | null) => void)[] = [];
  constructor(readonly tableId: number, readonly table: PublicKey, private every = 120) {}
  start() {
    const loop = async () => {
      while (!this.stopped) {
        const t0 = Date.now();
        const a = await account(DEV.er, this.table, "processed").catch(() => null);
        if (a?.data) {
          const prev = this.view;
          this.view = decodeTable(a.data);
          this.at = Date.now();
          this.slot = a.slot ?? this.slot;
          for (const f of this.listeners) { try { f(this.view, prev); } catch (e) { console.error(e); } }
        }
        const left = this.every - (Date.now() - t0);
        if (left > 0) await new Promise((r) => setTimeout(r, left));
      }
    };
    void loop();
    return this;
  }
  stop() { this.stopped = true; }
}

// ------------------------------------------------------------------ statistics
export const pct = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
export const sd = (xs: number[]) => { const m = mean(xs); return xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)) : NaN; };
/** mean with a 95 % normal-approximation interval */
export const ci95 = (xs: number[]) => { const m = mean(xs), se = sd(xs) / Math.sqrt(xs.length); return { n: xs.length, mean: m, se, lo: m - 1.96 * se, hi: m + 1.96 * se }; };
/** share with a 95 % Wilson interval */
export const wilson = (k: number, n: number) => {
  if (!n) return { k, n, p: NaN, lo: NaN, hi: NaN };
  const z = 1.96, p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), w = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { k, n, p, lo: (c - w) / d, hi: (c + w) / d };
};
export const r3 = (x: number | null) => (x === null || Number.isNaN(x) ? null : Math.round(x * 1000) / 1000);
