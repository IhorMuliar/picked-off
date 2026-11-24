// Offline checks of the runner's send guards (no cluster needed):
//  1. low balance: below MIN_BALANCE_SOL no record is created and nothing is sent;
//  2. one create_record per round at a time (a pipelined create and a direct one share the send);
//  3. one commit_round per record at a time (the post-reveal commit and the background pass);
//  4. config: devnet defaults (base endpoint, guard, drop timeout) and STATE_DIR-relative logs;
//  5. log rotation by size;
//  6. soft balance rule: below SOFT_BALANCE_SOL a seated player makes a round recorded at most every
//     LOW_RECORD_EVERY_SEC; above it every such round is recorded;
//  7. bots never send once the house has seen the bell, or on a stale Table view;
//  8. the unseal gate fails closed: no unseal while a bot send is in flight or settled within the quiet
//     window; past the hard bound it unseals (forced) so a round cannot wedge.
//   npx tsx house/test/guards.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { loadConfig } from "../src/config.ts";
import { Chain } from "../src/chain.ts";
import { Records } from "../src/records.ts";
import { Pool } from "../src/pool.ts";
import { Bot, PERSONALITIES, SEAT_MIX } from "../src/bots.ts";
import { PHASE, SEAT } from "../src/chain.ts";
import { RotatingFile } from "../src/log.ts";
import { check, summary } from "./harness.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "house-guards-"));
const keyFile = path.join(dir, "house.json");
fs.writeFileSync(keyFile, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });

async function main() {
  const cfg = loadConfig({ CLUSTER: "devnet", HOUSE_KEYPAIR: keyFile, STATE_DIR: dir, BOT_KEYS_DIR: path.join(dir, "bots") });
  check("devnet defaults", cfg.baseRpc === "https://rpc.magicblock.app/devnet" && cfg.minBalanceSol === 6 && cfg.baseDropMs === 90_000 && cfg.logFile === path.join(dir, "house-devnet.log"),
    { baseRpc: cfg.baseRpc, minBalanceSol: cfg.minBalanceSol, baseDropMs: cfg.baseDropMs, logFile: cfg.logFile });

  const chain = new Chain(cfg);
  let sends = 0;
  (chain as any).send = async () => { sends++; await new Promise((r) => setTimeout(r, 200)); return { sig: `s${sends}`, ms: 200, err: null, ok: true }; };
  (chain as any).ensureHouseToken = async () => {};
  chain.progEr = chain.program(chain.base, chain.house);

  // 1. low balance
  chain.balanceLamports = 5.9e9;
  const recs = new Records(chain, 999, () => 0, cfg.botKeysDir);
  const created = await recs.create(1, 0);
  check("below the guard: no record created, nothing sent", created === false && sends === 0 && !chain.canRecord(), { created, sends });
  chain.balanceLamports = 6.1e9;
  check("above the guard: records allowed", chain.canRecord(), { balanceSol: 6.1 });

  // 2. two creates of one round at once → one send
  const [a, b] = await Promise.all([recs.create(2, 0), recs.create(2, 0)]);
  check("concurrent create_record of one round: one send", a && b && sends === 1, { sends });

  // 3. two commits of one record at once → one send; a third inside commitWaitMs → none
  sends = 0;
  const [c1, c2] = await Promise.all([recs.commit(2, Date.now()), recs.commit(2)]);
  const c3 = await recs.commit(2);
  check("concurrent commit_round of one record: one send, none again within the wait", c1 === true && c2 === false && c3 === false && sends === 1, { c1, c2, c3, sends });

  // 5. rotation
  const f = path.join(dir, "rot.log");
  const rf = new RotatingFile(f, 1000, 2, () => {});
  for (let i = 0; i < 50; i++) rf.write("x".repeat(99) + "\n");
  await new Promise((r) => setTimeout(r, 200));
  const files = fs.readdirSync(dir).filter((x) => x.startsWith("rot.log")).sort();
  check("log rotates by size, keeps 2 old files", files.join(",") === "rot.log,rot.log.1,rot.log.2" && fs.statSync(f).size <= 1000, { files });

  // 6. soft balance rule
  const pool = new Pool(chain, 998) as any;
  const seats = (human: boolean) => Array.from({ length: 8 }, (_, i) => ({ key: "", name: "", kind: human && i === 0 ? SEAT.human : SEAT.bot, personality: 1 }));
  pool.records.lastRecordAt = Date.now() - 60_000; // last record 60 s ago
  chain.balanceLamports = 12e9;
  const r1 = pool.shouldRecord({ seats: seats(true) });
  const r2 = pool.shouldRecord({ seats: seats(false) });
  chain.balanceLamports = 9e9;
  const r3 = pool.shouldRecord({ seats: seats(true) });
  pool.records.lastRecordAt = Date.now() - 121_000;
  const r4 = pool.shouldRecord({ seats: seats(true) });
  chain.balanceLamports = 5e9;
  const r5 = pool.shouldRecord({ seats: seats(true) });
  check("record cadence: player seated ≥ 10 SOL every round; < 10 SOL one per 120 s; < 6 SOL none; bots only every 300 s",
    r1 === true && r2 === false && r3 === false && r4 === true && r5 === false, { r1, r2, r3, r4, r5 });

  // 7. bot send gate
  chain.balanceLamports = 12e9;
  const bot = new Bot(chain, pool, 0, PERSONALITIES[SEAT_MIX[0]], cfg.botKeysDir) as any;
  let sent = 0;
  bot.sendAct = () => { sent++; };
  bot.ready = true; bot.round = 5; bot.stats = { round: 5 };
  const tbl = (phase: number) => ({ round: 5, phase, beat: 3, seats: Array.from({ length: 8 }, (_, i) => ({ key: i === 0 ? bot.key.publicKey.toBase58() : "", kind: SEAT.bot })) });
  pool.blockhash = () => "11111111111111111111111111111111";
  pool.snap = { table: tbl(PHASE.live), slot: 0, at: Date.now(), slotMs: 10 };
  await bot.slot(); const live = sent;
  pool.snap = { table: tbl(PHASE.live), slot: 0, at: Date.now() - 2_000, slotMs: 10 };
  await bot.slot(); const stale = sent - live;
  pool.snap = { table: tbl(PHASE.live), slot: 0, at: Date.now(), slotMs: 10 };
  pool.sendClosed = true;
  await bot.slot(); const closed = sent - live - stale;
  pool.sendClosed = false;
  pool.snap = { table: tbl(PHASE.bell), slot: 0, at: Date.now(), slotMs: 10 };
  bot.stats.final = {}; // no final read in this offline check
  await bot.slot(); const bell = sent - live - stale - closed;
  check("bot sends in LIVE only on a fresh view and before the house sees the bell", live === 1 && stale === 0 && closed === 0 && bell === 0, { live, stale, closed, bell });

  // 8. unseal gate
  const now = Date.now();
  pool.bellSeenAt.set(7, now - 5_000);
  pool.sends.inflight = 1; pool.sends.lastSettledAt = now - 10_000;
  const g1 = pool.unsealGate(7);
  pool.sends.inflight = 0; pool.sends.lastSettledAt = now - 500;
  const g2 = pool.unsealGate(7);
  pool.sends.lastSettledAt = now - 3_000;
  const g3 = pool.unsealGate(7);
  pool.sends.inflight = 2; pool.bellSeenAt.set(7, now - 13_000);
  const g4 = pool.unsealGate(7);
  check("unseal gate: in flight → wait; settled 0.5 s ago → wait; quiet 3 s → unseal; still in flight 13 s after the bell → forced",
    !g1.ok && !g2.ok && g3.ok && !g3.forced && g4.ok && g4.forced, { g1, g2, g3, g4 });

  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(summary());
}
main().catch((e) => { console.error(e); process.exit(2); });
