// Small helpers for scripts/leak-probe.ts: result bookkeeping, websocket subscriptions,
// transaction-view shapes and statistics.
import WebSocket from "ws";

export type Status = "PASS" | "FAIL" | "SKIP" | "LOCAL-EXPECTED" | "INFO";
export interface Result { id: string; status: Status; title: string; evidence: string }

const jsonish = (v: unknown) =>
  typeof v === "string" ? v : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export class Report {
  results: Result[] = [];
  lines: string[] = [];
  private secrets: string[] = [];
  /** Values that must never appear in the output (auth tokens). */
  addSecret(s: string) { if (s) this.secrets.push(s); }
  log(line: string) {
    const stamp = new Date().toISOString().slice(11, 23);
    const out = `${stamp} ${line}`;
    this.lines.push(out);
    console.log(out);
  }
  add(id: string, status: Status, title: string, evidence: unknown) {
    const r = { id, status, title, evidence: jsonish(evidence) };
    this.results.push(r);
    this.log(`${status.padEnd(14)} ${id.padEnd(10)} ${title}: ${r.evidence}`);
  }
  check(id: string, pass: boolean, title: string, evidence: unknown) { this.add(id, pass ? "PASS" : "FAIL", title, evidence); }
  /** True when no line written so far contains any registered secret. */
  leakedSecrets(): number {
    let n = 0;
    for (const l of this.lines) for (const s of this.secrets) if (l.includes(s)) n++;
    return n;
  }
}

/** One websocket subscription; collects notifications until closed. */
export class Sub {
  notes: any[] = [];
  reply: any = null;
  error: string | null = null;
  private ws: WebSocket;
  constructor(public label: string, url: string, method: string, params: unknown[]) {
    this.ws = new WebSocket(url);
    this.ws.on("open", () => this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
    this.ws.on("message", (raw: any) => {
      let m: any;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.id === 1) { this.reply = m; if (m.error) this.error = jsonish(m.error).slice(0, 160); }
      else if (m.method) this.notes.push({ t: Date.now(), v: m.params?.result });
    });
    this.ws.on("error", (e: any) => { this.error = String(e?.message ?? e).slice(0, 160); });
    this.ws.on("unexpected-response", (_req: any, res: any) => { this.error = `HTTP ${res.statusCode}`; });
  }
  get subscribed() { return this.reply && this.reply.result !== undefined && !this.reply.error; }
  close() { try { this.ws.close(); } catch { /* closed */ } }
  summary() { return { subscribed: !!this.subscribed, error: this.error, notifications: this.notes.length }; }
}

/** What a getTransaction answer shows: counts of keys, instructions, logs, and whether meta exists. */
export function txShape(body: any) {
  const r = body?.result;
  if (body?.error) return { kind: "error", error: jsonish(body.error).slice(0, 100), keys: 0, ixs: 0, logs: 0, meta: false, ixData: 0 };
  if (!r) return { kind: "null", keys: 0, ixs: 0, logs: 0, meta: false, ixData: 0 };
  const msg = r.transaction?.message ?? {};
  const keys = (msg.accountKeys ?? []).length;
  const ixs = (msg.instructions ?? []).length;
  const ixData = (msg.instructions ?? []).reduce((a: number, i: any) => a + String(i.data ?? "").length, 0);
  const logs = (r.meta?.logMessages ?? []).length;
  return { kind: keys || ixs ? "full" : "shell", keys, ixs, logs, meta: !!r.meta, ixData, slot: r.slot };
}
export const redacted = (s: ReturnType<typeof txShape>) => s.keys === 0 && s.ixs === 0 && s.logs === 0 && s.ixData === 0;

export function hist(xs: (number | string)[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const x of xs) h[String(x)] = (h[String(x)] ?? 0) + 1;
  return h;
}
export const spread = (xs: number[]) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);

/** Runs `fn` over `items` with at most `n` in flight. */
export async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}
