// Live end-to-end check of the house pools on devnet, from the outside (no keys, no seats, no transactions).
//
// For every round of every watched pool it logs the public lifecycle seen on the rollup (open, HIDE end, bell,
// reveal, the next open; totals, Top Desk, seat kinds), and for every recorded round it follows the base layer:
//   Round committed and owned by the program on Solana → its record re-verified with the TypeScript replay verifier
//   against the committed hash (totals and Top Desk must match the Table) → `settle_round` (Tape resolved) →
//   every call paid or refunded (Σ payouts = pool less the floor remainder; refunds = pool when void) →
//   `close_round` (Round and Tape closed) → none of the Round's or Tape's base transactions failed.
// A recorded round PASSes when every step holds; the run PASSes when N consecutive recorded rounds per pool pass.
//
//   npx tsx scripts/e2e-devnet.ts [--pools 1,2] [--records 10] [--minutes 0 (= until N records per pool)]
//   env: OUT_DIR (JSON lines, default ./f2-out), BASE_RPC, ER_RPC
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { pathToFileURL } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { pda, REPO, PROGRAM_ID } from "../tests/local/lib.ts";
import { decodeRound, decodeTape, PHASE, ROUND_STATUS, SEAT, type TableView } from "../house/src/chain.ts";
import { DEV, Jsonl, TablePoll, account, call, http429, pct, iso, r3 } from "./f2-lib.ts";

const RECORD_OFF = 160, RECORD_LEN = 522;
const LIGHTS_ON_MS = 8000;

function arg(name: string, d?: string) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; }
const pools = (arg("pools", "1,2") as string).split(",").map(Number);
const need = Number(arg("records", "10"));
const minutes = Number(arg("minutes", "0"));
const outDir = process.env.OUT_DIR ?? path.resolve("f2-out");
const out = new Jsonl(path.join(outDir, `e2e-devnet.jsonl`));
const idlJson = JSON.parse(fs.readFileSync(path.join(REPO, "target", "idl", "ping.json"), "utf8"));
const IX_NAME = new Map<string, string>(idlJson.instructions.map((i: any) => [Buffer.from(i.discriminator).toString("hex"), i.name]));
const core: any = await import(pathToFileURL(path.join(REPO, "app", "src", "core", "index.ts")).href);

interface Seen { round: number; openAt: number; openSlot: number; hideEndSlot: number; hideEndAt?: number; bellAt?: number; bellSlot?: number; revealAt?: number; t?: TableView; recorded: number; seatKinds: number[]; names: string[] }
const results = new Map<number, any[]>(); // pool -> per-record verdicts in round order
const started = Date.now();

async function baseSigs(acc: PublicKey) {
  const r = await call(DEV.base, "getSignaturesForAddress", [acc.toBase58(), { limit: 100, commitment: "confirmed" }]);
  return (r.body?.result ?? []) as { signature: string; err: any; slot: number; blockTime: number }[];
}

async function followRecord(pool: number, s: Seen) {
  const n = s.round, t = s.t!;
  const roundPda = pda.round(pool, n), tapePda = pda.tape(pool, n);
  const v: any = { pool, round: n, bellAt: s.bellAt ? iso(s.bellAt) : null, steps: {} };
  const deadline = Date.now() + 15 * 60_000;
  const step = (k: string, d: any) => { v.steps[k] = d; };
  // 1. Round owned by the program on base (committed + undelegated)
  let roundData: Buffer | null = null, tape: any = null, tapeAtSettle: any = null;
  while (Date.now() < deadline) {
    const a = await account(DEV.base, roundPda);
    if (a.data && a.owner === PROGRAM_ID.toBase58()) { roundData = a.data; step("committed", { ok: true, bellToBaseMs: s.bellAt ? Date.now() - s.bellAt : null }); break; }
    if (!a.data && v.steps.committed === undefined && Date.now() - (s.bellAt ?? Date.now()) > 120_000) { step("committed", { ok: false, why: "Round not on base 120 s after the bell" }); break; }
    await sleep(1000);
  }
  if (roundData) {
    // 2. the committed record re-verified
    const r = decodeRound(roundData);
    const rec = roundData.subarray(RECORD_OFF, RECORD_OFF + RECORD_LEN), commit = roundData.subarray(96, 128);
    const vr = core.verify(new Uint8Array(rec), new Uint8Array(commit));
    const okV = vr.ok && r.status === ROUND_STATUS.revealed && vr.verdict.totals.every((x: number, i: number) => x === t.totals[i] && x === r.totals[i]) && vr.verdict.topDesk === t.topDesk && r.topDesk === t.topDesk;
    step("verified", { ok: okV, status: r.status, replay: vr.ok ? "ok" : vr.error, totals: r.totals, topDesk: r.topDesk, nBeats: r.nBeats, tableBeat: t.beat });
    // 3. settle_round, 4. claims, 5. close
    let closedAt = 0;
    while (Date.now() < deadline) {
      const [ta, ra] = await Promise.all([account(DEV.base, tapePda), account(DEV.base, roundPda)]);
      if (ta.data) {
        tape = decodeTape(ta.data);
        if (tape.resolved && !tapeAtSettle) { tapeAtSettle = tape; step("settled", { ok: true, winner: tape.winner, void: tape.void, nCalls: tape.nCalls, total: String(tape.total) }); }
      }
      if (!ta.data && !ra.data) { closedAt = Date.now(); break; }
      await sleep(400);
    }
    // what the base layer recorded for this Round and Tape, by instruction (the house settles and closes in seconds)
    const sigs = [...(await baseSigs(roundPda)), ...(await baseSigs(tapePda))];
    const uniq = new Map(sigs.map((x) => [x.signature, x]));
    const ixs: { sig: string; err: any; names: string[] }[] = [];
    for (const x of uniq.values()) {
      const r = await call(DEV.base, "getTransaction", [x.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      const m = r.body?.result?.transaction?.message;
      const keys: string[] = [...(m?.accountKeys ?? []), ...(r.body?.result?.meta?.loadedAddresses?.writable ?? []), ...(r.body?.result?.meta?.loadedAddresses?.readonly ?? [])];
      const names = (m?.instructions ?? []).filter((i: any) => keys[i.programIdIndex] === PROGRAM_ID.toBase58()).map((i: any) => IX_NAME.get(Buffer.from(bs58dec(i.data)).subarray(0, 8).toString("hex")) ?? "?");
      if (!names.length && keys.includes("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh")) names.push("validator_commit_undelegate");
      ixs.push({ sig: x.signature, err: x.err, names });
    }
    const all = ixs.flatMap((x) => x.names);
    const nClaims = all.filter((n) => n === "claim_call").length;
    const settleTx = ixs.find((x) => x.names.includes("settle_round"));
    step("settled", { ok: !!(settleTx && !settleTx.err) || !!tapeAtSettle, winner: tapeAtSettle?.winner ?? tape?.winner, void: tapeAtSettle?.void ?? tape?.void, sig: settleTx?.sig });
    const nPlace = all.filter((n) => n === "place_call").length;
    let okPaid = true, view: any = null;
    if (tape) {
      const total = BigInt(tape.total), paid = BigInt(tape.paid);
      // the last view before the close: every call claimed (payouts floor-rounded: remainder < 1 lamport per call)
      if (tape.openCalls === 0 && tape.resolved) okPaid = tape.void ? paid === total : paid <= total && total - paid < BigInt(Math.max(1, tape.nCalls));
      view = { nCalls: tape.nCalls, openCalls: tape.openCalls, total: String(total), paid: String(paid), void: tape.void, resolved: tape.resolved };
    }
    step("claims", { ok: okPaid && nClaims === nPlace, placeCalls: nPlace, claimCalls: nClaims, lastTapeView: view });
    step("baseTxs", { ok: ixs.every((x) => !x.err), n: ixs.length, kinds: all, failed: ixs.filter((x) => x.err).map((x) => x.sig) });
    step("closed", { ok: closedAt > 0, afterBellMs: closedAt && s.bellAt ? closedAt - s.bellAt : null });
  }
  v.pass = Object.values(v.steps).length >= 6 && Object.values(v.steps).every((x: any) => x.ok);
  out.write("record", v);
  console.log(`${v.pass ? "PASS" : "FAIL"} pool ${pool} round ${n} ${JSON.stringify(v.steps).slice(0, 400)}`);
  const arr = results.get(pool) ?? []; arr.push(v); arr.sort((a, b) => a.round - b.round); results.set(pool, arr);
}

function watch(pool: number) {
  const poll = new TablePoll(pool, pda.table(pool), 150);
  let cur: Seen | null = null;
  const follows: Promise<void>[] = [];
  poll.listeners.push((t) => {
    const at = poll.at;
    if (!cur || t.round !== cur.round) {
      if (t.phase !== PHASE.hide) return; // a round counts from the first view of its HIDE
      if (cur) {
        const len = at - cur.openAt;
        const tl = cur.t;
        out.write("table_round", { pool, round: cur.round, openAt: iso(cur.openAt), nextOpenAt: iso(at), openToNextOpenMs: len, consecutive: t.round === cur.round + 1,
          openToBellMs: cur.bellAt ? cur.bellAt - cur.openAt : null, bellToRevealMs: cur.bellAt && cur.revealAt ? cur.revealAt - cur.bellAt : null,
          slotLenMs: tl?.bellSlot ? (tl.bellSlot - cur.openSlot) * 10 + LIGHTS_ON_MS : null,
          beats: tl?.beat ?? null, totals: tl?.totals ?? null, topDesk: tl?.topDesk ?? null, recorded: cur.recorded, seatKinds: cur.seatKinds, names: cur.names,
          topMargin: tl ? (() => { const s = [...tl.totals].sort((a, b) => b - a); return s[0] - s[1]; })() : null, phaseAtEnd: tl?.phase });
      }
      cur = { round: t.round, openAt: at, openSlot: t.openSlot, hideEndSlot: t.hideEndSlot, recorded: t.recorded, seatKinds: t.seats.map((x) => x.kind), names: t.seats.map((x) => x.name) };
    }
    if (t.phase === PHASE.live && !cur.hideEndAt) cur.hideEndAt = at;
    if (t.phase >= PHASE.bell && !cur.bellAt) { cur.bellAt = at; cur.bellSlot = t.bellSlot; }
    if (t.phase === PHASE.revealed && !cur.revealAt) {
      cur.revealAt = at; cur.t = t;
      cur.seatKinds = t.seats.map((x) => x.kind); cur.names = t.seats.map((x) => x.name);
      if (t.recorded) follows.push(followRecord(pool, { ...cur }).catch((e) => { out.write("record_error", { pool, round: cur!.round, err: String(e?.message ?? e) }); }));
    }
  });
  poll.start();
  return { poll, follows };
}

function consecutivePass(pool: number) {
  const arr = results.get(pool) ?? [];
  let best = 0, run = 0;
  for (const v of arr) { run = v.pass ? run + 1 : 0; best = Math.max(best, run); }
  return { checked: arr.length, passed: arr.filter((v) => v.pass).length, bestRun: best };
}

out.write("start", { pools, need, minutes, base: DEV.base, er: DEV.er });
const ws = pools.map(watch);
for (;;) {
  await sleep(5000);
  const done = minutes > 0 ? Date.now() - started > minutes * 60_000 : pools.every((p) => consecutivePass(p).checked >= need);
  if (done) break;
}
for (const w of ws) w.poll.stop();
await Promise.race([Promise.all(ws.flatMap((w) => w.follows)), sleep(16 * 60_000)]);
const summary: any = { at: iso(), http429: http429.n, pools: {} };
for (const p of pools) {
  const c = consecutivePass(p);
  const recs = results.get(p) ?? [];
  const b2b = recs.map((v) => v.steps.committed?.bellToBaseMs).filter((x) => typeof x === "number");
  summary.pools[p] = { ...c, pass: c.bestRun >= Math.min(need, c.checked) && c.checked >= need, bellToBaseP50: pct(b2b, 50), bellToBaseMax: b2b.length ? Math.max(...b2b) : null, failedRounds: recs.filter((v) => !v.pass).map((v) => v.round) };
}
summary.pass = pools.every((p) => summary.pools[p].pass);
out.write("summary", summary);
console.log(`${summary.pass ? "PASS" : "FAIL"} e2e-devnet ${JSON.stringify(summary)}`);
void SEAT; void r3;
process.exit(summary.pass ? 0 : 1);

function bs58dec(s: string): Uint8Array { return bs58.decode(s); }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
