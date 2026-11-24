// Log-stream timing on the live house pools: anonymous `logsSubscribe` streams on the rollup, every delivery
// timestamped and classified against the round it belongs to (before the bell / between the bell and the unseal /
// after the unseal). A private transaction (an `act` or a crank `tick`) delivered before its round is unsealed would
// be a leak; acts that land after an unseal are public transactions.
//
//   npx tsx scripts/log-stream-timing.ts [--pools 1,2] [--minutes 25]      env: OUT_DIR (default ./f2-out)
// Streams: mentions [program id], mentions [each Table], mentions [each Book], and "all" (kept only when the
// delivery invokes the program). Kinds come from the compute units in the logs (constant per class) and, when the
// transaction is still public, from its accounts.
import path from "node:path";
import WebSocket from "ws";
import { pda, PROGRAM_ID } from "../tests/local/lib.ts";
import { PHASE } from "../house/src/chain.ts";
import { DEV, Jsonl, TablePoll, account, call, iso } from "./f2-lib.ts";

function arg(name: string, d?: string) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; }
const pools = (arg("pools", "1,2") as string).split(",").map(Number);
const minutes = Number(arg("minutes", "25"));
const outDir = process.env.OUT_DIR ?? path.resolve("f2-out");
const stamp = iso().replace(/[:.]/g, "-");
const out = new Jsonl(path.join(outDir, `logstream-${stamp}.jsonl`));
const PID = PROGRAM_ID.toBase58();
const CU_CLASS: Record<number, string> = { 4767: "act", 75881: "tick_resolve", 27658: "tick_noop" };

interface RoundT { pool: number; round: number; openSlot: number; hideEndSlot: number; openAt: number; bellAt?: number; bellSlot?: number; unsealAt?: number; unsealSlot?: number; nextOpenSlot?: number; nextOpenAt?: number }
const rounds: RoundT[] = [];
const deliveries: any[] = [];
const accountPool = new Map<string, { pool: number; what: string }>();
for (const p of pools) {
  accountPool.set(pda.table(p).toBase58(), { pool: p, what: "table" });
  accountPool.set(pda.book(p).toBase58(), { pool: p, what: "book" });
  for (let s = 0; s < 8; s++) accountPool.set(pda.desk(p, s).toBase58(), { pool: p, what: `desk${s}` });
}

// ---------------------------------------------------------------- rounds of each pool (public Table + anon Book reads)
for (const p of pools) {
  const poll = new TablePoll(p, pda.table(p), 100);
  let cur: RoundT | null = null;
  let bookPolling = false;
  poll.listeners.push((t) => {
    if (!cur || t.round !== cur.round) {
      if (t.phase !== PHASE.hide && t.phase !== PHASE.live) return;
      if (cur) { cur.nextOpenSlot = t.openSlot; cur.nextOpenAt = poll.at; out.write("round", cur as any); }
      cur = { pool: p, round: t.round, openSlot: t.openSlot, hideEndSlot: t.hideEndSlot, openAt: poll.at };
      rounds.push(cur);
    }
    if (t.phase >= PHASE.bell && !cur.bellAt) { cur.bellAt = poll.at; cur.bellSlot = t.bellSlot; }
    if (t.phase >= PHASE.bell && !cur.unsealAt && !bookPolling) {
      bookPolling = true;
      const r = cur;
      (async () => {
        for (let i = 0; i < 200 && !r.unsealAt; i++) {
          const a = await account(DEV.er, pda.book(p), "processed");
          if (a.data && Number(a.data.readBigUInt64LE(16)) === r.round) { r.unsealAt = Date.now(); r.unsealSlot = a.slot; break; }
          await new Promise((res) => setTimeout(res, 100));
        }
        bookPolling = false;
      })();
    }
  });
  poll.start();
}

// ---------------------------------------------------------------- streams
function stream(label: string, filter: unknown, keep: (logs: string[]) => boolean) {
  const ws = new WebSocket(DEV.erWs);
  let n = 0;
  ws.on("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [filter, { commitment: "processed" }] })));
  ws.on("message", (raw: any) => {
    const at = Date.now();
    let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.id === 1) { out.write("subscribed", { label, ok: m.result !== undefined, err: m.error ?? null }); return; }
    const v = m.params?.result?.value; if (!v) return;
    const logs: string[] = v.logs ?? [];
    if (!keep(logs)) return;
    const cuLine = logs.find((l) => l.startsWith(`Program ${PID} consumed`));
    const cu = cuLine ? Number(/consumed (\d+)/.exec(cuLine)?.[1]) : null;
    const d = { label, at, slot: m.params.result.context?.slot, sig: v.signature, err: v.err, cu, cls: cu !== null ? CU_CLASS[cu] ?? "other" : "nocu", logLines: logs.length,
      programLogLines: logs.filter((l) => l.startsWith("Program log:")).length };
    deliveries.push(d); n++;
    // read it back at once: still public (replay of a revealed round) or a shell (private)?
    void (async () => {
      const r = await call(DEV.er, "getTransaction", [v.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      const tx = r.body?.result;
      const keys: string[] = tx?.transaction?.message?.accountKeys ?? [];
      (d as any).readback = { at: Date.now(), shell: !keys.length, nKeys: keys.length, slot: tx?.slot ?? null };
      const hit = keys.map((k) => accountPool.get(k)).filter(Boolean) as { pool: number; what: string }[];
      if (hit.length) { (d as any).pool = hit[0].pool; (d as any).touches = [...new Set(hit.map((h) => h.what))]; }
      out.write("raw", d); // raw data survives a crash; the classification is written at the end
    })();
  });
  ws.on("error", (e: any) => out.write("ws_error", { label, err: String(e?.message ?? e) }));
  ws.on("close", () => out.write("ws_closed", { label, n }));
  return ws;
}
const invokes = (logs: string[]) => logs.some((l) => l.includes(PID));
const subs = [stream("program", { mentions: [PID] }, () => true), stream("all", "all", invokes)];
for (const p of pools) { subs.push(stream(`table${p}`, { mentions: [pda.table(p).toBase58()] }, () => true)); subs.push(stream(`book${p}`, { mentions: [pda.book(p).toBase58()] }, () => true)); }
out.write("start", { pools, minutes });

await new Promise((r) => setTimeout(r, minutes * 60_000));
for (const s of subs) s.close();
await new Promise((r) => setTimeout(r, 15_000)); // last readbacks and unseals

// ---------------------------------------------------------------- classify
function roundOf(pool: number, slot: number) { return rounds.find((r) => r.pool === pool && slot >= r.openSlot && (r.nextOpenSlot === undefined || slot < r.nextOpenSlot)); }
const summary: any = { pools, minutes, from: rounds[0] ? iso(rounds[0].openAt) : null, to: iso(), rounds: rounds.filter((r) => r.unsealAt).length, byStream: {}, leaks: [], actsAfterUnseal: 0, unattributedPrivateEarly: [] };
for (const d of deliveries) {
  const priv = d.cls === "act" || d.cls === "tick_resolve" || d.cls === "tick_noop" || (d.touches ?? []).some((w: string) => w !== "table");
  const cand = d.pool !== undefined ? [d.pool] : pools;
  const phases: string[] = [];
  for (const p of cand) {
    const r = roundOf(p, d.slot);
    if (!r) { phases.push("noround"); continue; }
    const ph = !r.bellAt || d.at < r.bellAt ? "beforeBell" : !r.unsealAt || d.at < r.unsealAt ? "bellToUnseal" : "afterUnseal";
    const landedAfterUnseal = r.unsealSlot !== undefined && d.slot >= r.unsealSlot && (r.nextOpenSlot === undefined || d.slot < r.nextOpenSlot);
    phases.push(ph);
    if (d.pool !== undefined && d.cls === "act" && landedAfterUnseal) summary.actsAfterUnseal++;
    if (d.pool !== undefined) { d.round = r.round; d.phase = ph; d.landedAfterUnseal = landedAfterUnseal; d.msAfterBell = r.bellAt ? d.at - r.bellAt : null; d.msAfterUnseal = r.unsealAt ? d.at - r.unsealAt : null; }
  }
  const k = summary.byStream[d.label] ??= { deliveries: 0, private: 0, beforeBell: 0, bellToUnseal: 0, afterUnseal: 0, unattributed: 0, classes: {} };
  k.deliveries++; k.classes[d.cls] = (k.classes[d.cls] ?? 0) + 1;
  if (!priv) continue;
  k.private++;
  if (d.pool !== undefined) {
    k[d.phase]++;
    if (d.phase !== "afterUnseal") summary.leaks.push({ label: d.label, sig: d.sig, pool: d.pool, round: d.round, phase: d.phase, cls: d.cls, msAfterBell: d.msAfterBell });
  } else {
    k.unattributed++;
    // unknown pool (a shell when read back): early for every pool it could belong to?
    if (phases.every((x) => x !== "afterUnseal")) summary.unattributedPrivateEarly.push({ label: d.label, sig: d.sig, slot: d.slot, cls: d.cls, phases });
  }
}
for (const d of deliveries) out.write("delivery", d);
out.write("summary", summary);
console.log(JSON.stringify(summary, null, 1));
process.exit(0);
