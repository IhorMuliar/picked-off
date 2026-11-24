// Offline checks of when a recorded round opens against its record's planned start (no cluster needed; the chain is
// faked: base accounts in a map, sends confirm after a set delay, both chain clocks = this process's clock floored):
//  1. the pure rule (src/schedule.ts): planned start from the bell, the late-create planned start, the open wait,
//     the lead estimator ignoring outliers, the Tape window error;
//  2. pipelined: the record of round n+1 is created at the bell of round n with a planned start ≈ when the round
//     opens; the round opens at the planned start (not before, ≤ 1.5 s after) and its Tape closes within 1.5 s of
//     live beat 10;
//  3. late record: a create that is not confirmed within RECORD_WAIT_MS → the round opens unrecorded (bounded wait);
//  4. restart mid-cycle: a runner resumed late in LIGHTS ON creates the record at the due time with a planned start
//     in the near future and still opens at it; a record left by an earlier process with a planned start in the past
//     opens at once and is reported (open_after_planned).
//   npx tsx house/test/schedule.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { loadConfig } from "../src/config.ts";
import { Chain, PHASE, SEAT, SEAL_ALL, ROUND_STATUS } from "../src/chain.ts";
import { Pool } from "../src/pool.ts";
import { log } from "../src/log.ts";
import { LeadEstimator, OPEN_MARGIN_MS, LATE_CREATE_LEAD_MS, openTiming, openWaitMs, plannedFromBell, plannedLate } from "../src/schedule.ts";
import { check, summary } from "./harness.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "house-schedule-"));
const keyFile = path.join(dir, "house.json");
fs.writeFileSync(keyFile, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
const LIGHTS = 4_000;
const cfg = loadConfig({ CLUSTER: "devnet", HOUSE_KEYPAIR: keyFile, STATE_DIR: dir, BOT_KEYS_DIR: path.join(dir, "bots"), BOTS: "0", LIGHTS_ON_MS: String(LIGHTS), RECORD_EVERY_SEC: "1", HOUSE_RPC_LOG: "off" });

// ---------------------------------------------------------------- captured log events
const events: { ev: string; [k: string]: any }[] = [];
for (const lvl of ["info", "warn", "error"] as const) {
  const orig = log[lvl];
  (log as any)[lvl] = (ev: string, data: Record<string, unknown> = {}) => { events.push({ ev, level: lvl, at: Date.now(), ...data }); if (lvl !== "info") orig(ev, data); };
}
const evs = (ev: string, pred: (e: any) => boolean = () => true) => events.filter((e) => e.ev === ev && pred(e));

// ---------------------------------------------------------------- fake chain
const DELEGATED = "delegated";
const chain = new Chain(cfg);
chain.balanceLamports = 20e9;
chain.progEr = chain.program(chain.base, chain.house);
const base = new Map<string, { data: Buffer; owner: string }>();
let confirmMs = 800;
const sent: { kind: string; at: number; planned?: number; round?: number; recorded?: boolean }[] = [];
const roundBytes = (t: number, n: number, planned: number) => {
  const b = Buffer.alloc(816);
  b.writeBigUInt64LE(BigInt(t), 8); b.writeBigUInt64LE(BigInt(n), 16); b.writeBigInt64LE(BigInt(planned), 24); b[144] = ROUND_STATUS.created;
  return b;
};
const reader = { account: async (k: any) => { const a = base.get(k.toBase58()); return a ? { data: a.data, owner: a.owner, slot: 1 } : { data: null }; } };
(chain as any).baseRead = reader;
(chain as any).erRead = reader;
(chain as any).ensureHouseToken = async () => {};
(chain as any).waitOwner = async () => 1;
(chain as any).isDelegatedOwner = (o?: string) => o === DELEGATED;
(chain as any).erUnix = async () => Math.floor(Date.now() / 1000);
let tableId = 0;
(chain as any).sendBase = async (ixs: any[]) => {
  const d: Buffer = ixs[0].data;
  const n = Number(d.readBigUInt64LE(16)), planned = Number(d.readBigInt64LE(24));
  sent.push({ kind: "create_record", at: Date.now(), planned, round: n });
  const delay = confirmMs;
  await sleep(delay);
  base.set(chain.pda.round(tableId, n).toBase58(), { data: roundBytes(tableId, n, planned), owner: DELEGATED });
  return { ok: true, sig: `create${n}`, ms: delay, err: null };
};
(chain as any).sendEr = async (ixs: any[]) => {
  // open_round: the round account is passed when the round is recorded (it is not the program id placeholder)
  const ix = ixs[0];
  const roundKey = ix.keys[11]?.pubkey?.toBase58();
  const recorded = !!roundKey && roundKey !== chain.programId.toBase58();
  sent.push({ kind: "open_round", at: Date.now(), recorded });
  await sleep(500);
  return { ok: true, sig: "open", ms: 500, err: null };
};

const seats = () => Array.from({ length: 8 }, () => ({ key: "", name: "", kind: SEAT.bot, personality: 1 }));
const tableAt = (round: number, phase: number) => ({ round, phase, seats: seats(), sealed: SEAL_ALL, recorded: 0, vrfQueue: chain.house.publicKey, beat: 21, bellSlot: 0, openSlot: 0 }) as any;

function newPool(t: number) {
  tableId = t;
  const p = new Pool(chain, t) as any;
  p.records.lastRecordAt = 0;
  return p;
}
/** Plays the house's step loop for `next()` from the end of LIGHTS ON until open_round has been sent once. */
async function openNext(p: any, t: any, timeoutMs = 30_000) {
  const before = sent.filter((x) => x.kind === "open_round").length;
  const t0 = Date.now();
  while (sent.filter((x) => x.kind === "open_round").length === before && Date.now() - t0 < timeoutMs) { await p.next(t); await sleep(20); }
  return sent.filter((x) => x.kind === "open_round").at(-1)!;
}

async function main() {
  // 1. the rule
  check("planned start from the bell = round((bell + LIGHTS ON + lead) / 1 s)", plannedFromBell(1_000_000_400, 8_000, 2_700) === 1_000_011 && plannedFromBell(1_000_000_000, 8_000, 2_400) === 1_000_010, null);
  check("late create: planned start = ceil((now + lead) / 1 s), in the future", plannedLate(1_000_000_100) === Math.ceil((1_000_000_100 + LATE_CREATE_LEAD_MS) / 1000) && plannedLate(1_000_000_100) * 1000 > 1_000_000_100, null);
  check("open wait: until planned + margin; 0 after", openWaitMs(1000, 999_500) === 500 + OPEN_MARGIN_MS && openWaitMs(1000, 1_000_000 + OPEN_MARGIN_MS) === 0 && openWaitMs(1000, 1_005_000) === 0, null);
  const le = new LeadEstimator(2_700);
  for (const x of [2_300, 2_500, 99_000, -5, 2_400]) le.observe(x);
  check("lead estimator: average of sane samples, outliers ignored", le.n === 3 && le.value > 2_300 && le.value < 2_500, { value: le.value, n: le.n });
  const ot = openTiming(1_000, 1_000_700, 20);
  check("Tape window error = close_unix − (open + 20 s)", ot.openLateMs === 700 && ot.tapeWindowErrMs === -700 && ot.closeUnix === 1_020, null);

  // 2. pipelined at the bell (3 rounds)
  for (let k = 0; k < 3; k++) {
    const p = newPool(700 + k);
    const bellAt = Date.now();
    p.pipelineRecord(tableAt(5, PHASE.bell), bellAt);
    await sleep(50);
    const create = sent.filter((x) => x.kind === "create_record").at(-1)!;
    const createdAtBell = create && create.round === 6 && create.at - bellAt < 200;
    p.lastBellAt = bellAt;
    await sleep(bellAt + LIGHTS - Date.now());
    const open = await openNext(p, tableAt(5, PHASE.revealed));
    const lateMs = open.at - create.planned! * 1000;
    const roundOpen = evs("round_open", (e) => e.pool === 700 + k).at(-1);
    check(`pipelined record ${k + 1}: created at the bell, round opens recorded at its planned start (0-1.5 s after)`,
      !!createdAtBell && open.recorded && lateMs >= OPEN_MARGIN_MS - 5 && lateMs <= 1_500 && roundOpen?.openLateMs !== undefined && Math.abs(roundOpen.tapeWindowErrMs) <= 1_500,
      { createdMsAfterBell: create.at - bellAt, planned: create.planned, sendLateMs: lateMs, openLateMs: roundOpen?.openLateMs, tapeWindowErrMs: roundOpen?.tapeWindowErrMs, leadEst: Math.round(p.lead.value) });
  }

  // 3. late record: the create is not confirmed within RECORD_WAIT_MS (6 s) → opens unrecorded
  {
    const p = newPool(710);
    confirmMs = 9_000;
    const due = Date.now();
    const open = await openNext(p, tableAt(9, PHASE.revealed));
    const late = evs("record_late", (e) => e.pool === 710);
    check("late record: the round opens unrecorded after the bounded wait", !open.recorded && late.length === 1 && open.at - due >= cfg.recordWaitMs && open.at - due < cfg.recordWaitMs + 2_000,
      { waitedMs: open.at - due, boundMs: cfg.recordWaitMs, recordLate: late.length });
    confirmMs = 800;
    await sleep(3_500); // let the late create land (tracked; the record pass settles it void)
  }

  // 4a. restart late in LIGHTS ON: too little lead for a pipelined record → created at the due time, opened at its plan
  {
    const p = newPool(720);
    const bellAt = Date.now() - LIGHTS + 1_000; // resumed 1 s before LIGHTS ON ends
    const nCreates = sent.filter((x) => x.kind === "create_record").length;
    p.pipelineRecord(tableAt(12, PHASE.revealed), bellAt);
    await sleep(50);
    const skipped = sent.filter((x) => x.kind === "create_record").length === nCreates;
    p.lastBellAt = bellAt;
    await sleep(Math.max(0, bellAt + LIGHTS - Date.now()));
    const open = await openNext(p, tableAt(12, PHASE.revealed));
    const create = sent.filter((x) => x.kind === "create_record").at(-1)!;
    const lateMs = open.at - create.planned! * 1000;
    check("restart late in LIGHTS ON: no pipelined create, due-time create with a future planned start, opened at it",
      skipped && create.round === 13 && open.recorded && lateMs >= OPEN_MARGIN_MS - 5 && lateMs <= 1_500, { skipped, planned: create.planned, createdAt: create.at, sendLateMs: lateMs });
  }

  // 4b. restart with a record from the earlier process whose planned start has passed: opens at once, reported
  {
    const p = newPool(730);
    const planned = Math.floor(Date.now() / 1000) - 5;
    base.set(chain.pda.round(730, 21).toBase58(), { data: roundBytes(730, 21, planned), owner: DELEGATED });
    const t0 = Date.now();
    const open = await openNext(p, tableAt(20, PHASE.revealed));
    const warn = evs("open_after_planned", (e) => e.pool === 730);
    check("restart with a past planned start: opens at once (no wait), open_after_planned logged", open.recorded && open.at - t0 < 500 && warn.length === 1 && warn[0].openLateMs >= 5_000,
      { msToOpen: open.at - t0, openLateMs: warn[0]?.openLateMs });
  }
  process.exit(summary());
}
main().catch((e) => { console.error(e); process.exit(2); });
