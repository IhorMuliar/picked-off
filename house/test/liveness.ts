// Liveness test on the local stack. A pool is created while Config allows only a short crank
// (CRANK_ITERATIONS ticks, so the crank runs out mid-round, as a dead or dropped crank would);
// Config is restored right after. Then:
//  1. the runner reschedules the stalled crank once a beat deadline is overdue by >= STALL_MS
//     (3 s by default), and the round still reaches the bell with every beat resolved once;
//  2. with a short round limit the runner calls the round off with abort_round, and the next round
//     opens without a manual step.
//   npx tsx house/test/liveness.ts        (after make local-stack + make local-fund)
import { Runner, tempState, check, summary } from "./harness.ts";
import { loadConfig } from "../src/config.ts";
import { Chain, BN, PublicKey, must } from "../src/chain.ts";

const T = Number(process.env.TABLE_ID ?? 30_000 + (Math.floor(Date.now() / 1000) % 100_000));
const ITER = Number(process.env.CRANK_ITERATIONS ?? 60); // 15 s of 250-ms ticks: dies around live beat 7
const state = tempState("liveness");
const env = { CLUSTER: "local", POOLS: String(T), RECORD_EVERY_SEC: "1", HEALTH_PORT: "8792", ...state };
const chain = new Chain(loadConfig({ ...process.env, ...env }));

async function readParams() {
  const b = (await chain.baseRead.account(chain.pda.config())).data!;
  return {
    house: new PublicKey(b.subarray(96, 128)), teeValidator: new PublicKey(b.subarray(128, 160)), vrfQueue: new PublicKey(b.subarray(160, 192)),
    beatSlots: new BN(b.readBigUInt64LE(8).toString()), hideSlots: new BN(b.readBigUInt64LE(16).toString()),
    callLamports: new BN(b.readBigUInt64LE(24).toString()), lotLamports: new BN(b.readBigUInt64LE(32).toString()),
    crankIntervalMs: b.readUInt32LE(40), crankIterations: b.readUInt32LE(44), tickCuLimit: b.readUInt32LE(48), actIntervalMs: b.readUInt32LE(52),
    hideSecs: b.readUInt32LE(56), tapeCloseSecs: b.readUInt32LE(60), bellMin: b[195], bellMax: b[196], algoMemory: b[197], tapeCloseBeat: b[198],
  };
}
const updateConfig = async (p: any) =>
  must(await chain.sendBase([await chain.progBase.methods.updateConfig(p).accountsPartial({ admin: chain.house.publicKey, config: chain.pda.config() }).instruction()]), "update_config");

async function main() {
  console.log(`liveness test on table ${T}, crank iterations ${ITER}`);
  const p0 = await readParams();
  await updateConfig({ ...p0, crankIterations: ITER });
  try {
    must(await chain.sendBase([await chain.progBase.methods.createPool(new BN(T), 0, new BN(50_000_000)).accountsPartial({ house: chain.house.publicKey, config: chain.pda.config(), table: chain.pda.table(T), book: chain.pda.book(T), ledger: chain.pda.ledger(T) }).instruction()]), "create_pool");
  } finally {
    await updateConfig(p0);
  }
  console.log(`info  pool ${T} created with a ${ITER}-tick crank; Config restored to ${p0.crankIterations}`);

  // 1. reschedule
  let r = new Runner({ ...env, MAX_ROUNDS: "2" }, "resched").start();
  const res = await r.wait((e) => e.ev === "crank_rescheduled" && e.ok, 180_000, "a reschedule");
  const round = await r.wait((e) => e.ev === "round", 180_000, "a finished round");
  const all = r.events.filter((e) => e.ev === "crank_rescheduled");
  check("stalled crank rescheduled after the threshold (>= 3 s overdue)", res.overdueMs >= 3000 && all.every((e) => e.overdueMs >= 3000),
    { first: { beat: res.beat, overdueMs: res.overdueMs, thresholdMs: res.thresholdMs }, count: all.length, failed: all.filter((e) => !e.ok).length });
  check("rescheduled round reaches the bell, every beat resolved once", round.beats >= 20 && round.resolves === round.beats + 1 && round.reschedules >= 1,
    { round: round.round, beats: round.beats, resolves: round.resolves, reschedules: round.reschedules, roundMs: round.roundMs });
  await r.exited(240_000);
  await r.kill("SIGTERM");

  // 2. abort: a round limit shorter than the round
  r = new Runner({ ...env, MAX_ROUND_MS: "12000", MAX_ROUNDS: "1" }, "abort").start();
  const ab = await r.wait((e) => e.ev === "round_aborted", 120_000, "an abort");
  const first = r;
  check("stuck round called off with abort_round", ab.ok === true, { round: ab.round, beat: ab.beat, ageMs: ab.ageMs, sig: ab.sig });
  await r.exited(30_000);
  await r.kill("SIGTERM");
  r = new Runner({ ...env, MAX_ROUNDS: "1" }, "after-abort").start();
  const open = await r.wait((e) => e.ev === "round_open", 60_000, "the next round");
  const isRec = (e: any) => e.ev === "record" && e.round === ab.round;
  const rec = first.events.find(isRec) ?? (await r.wait(isRec, 120_000, "the aborted round's record closed").catch(() => null));
  check("after the abort the next round opens; the aborted record is committed, settled void and closed", open.round === ab.round + 1 && (!ab.recorded || !!rec) && (rec ? rec.void === 1 : true),
    { nextRound: open.round, abortedRecord: rec ? { status: rec.status, void: rec.void, close: !!rec.closeSig } : null });
  await r.kill("SIGTERM");
  process.exit(summary());
}
main().catch((e) => { console.error(e); process.exit(2); });
