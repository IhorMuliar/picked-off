// Restart test on the local stack: the runner is killed (SIGKILL, no clean-up) mid-round, right
// after a reveal, and right after a commit; each restart must resume from chain state with no manual
// step, finish the interrupted round, and take every recorded round through settle and close.
//   npx tsx house/test/restart.ts        (after make local-stack + make local-fund)
import { Runner, tempState, check, summary } from "./harness.ts";
import { loadConfig } from "../src/config.ts";
import { Chain, decodeTable, PHASE } from "../src/chain.ts";

const T = Number(process.env.TABLE_ID ?? 20_000 + (Math.floor(Date.now() / 1000) % 100_000));
const env = { CLUSTER: "local", POOLS: String(T), RECORD_EVERY_SEC: "1", TEST_CALLS: "1", HEALTH_PORT: "8791", ...tempState("restart") };
const chain = new Chain(loadConfig({ ...process.env, ...env }));

async function table() {
  await chain.ensureHouseToken();
  const a = await chain.erRead.account(chain.pda.table(T));
  return a.data ? decodeTable(a.data) : null;
}
const roundOnBase = async (n: number) => !!(await chain.baseRead.account(chain.pda.round(T, n))).data;

async function main() {
  console.log(`restart test on table ${T}`);
  // 1. kill mid-round (LIVE, some beats in)
  let r = new Runner(env, "run1").start();
  await r.wait((e) => e.ev === "round_open" && e.round === 1, 90_000, "round 1 open");
  for (;;) { const t = await table(); if (t && t.phase === PHASE.live && t.beat >= 5) break; await new Promise((x) => setTimeout(x, 300)); }
  await r.kill();
  const tKill1 = await table();
  check("killed mid-round", tKill1?.phase === PHASE.live && tKill1.round === 1, { round: tKill1?.round, phase: tKill1?.phase, beat: tKill1?.beat });

  r = new Runner(env, "run2").start();
  const resume1 = await r.wait((e) => e.ev === "pool_resume", 60_000, "resume");
  const round1 = await r.wait((e) => e.ev === "round" && e.round === 1, 90_000, "round 1 finished");
  check("restart mid-round: resumes in LIVE and finishes the same round (reveal + unseal)", resume1.phase === PHASE.live && round1.beats >= 20, { resumedPhase: resume1.phase, beats: round1.beats, revealMs: round1.revealMs });
  // 2. kill right after the reveal of round 2 (before its record is committed)
  await r.wait((e) => e.ev === "round_open" && e.round === 2, 60_000, "round 2 open");
  await r.waitNext((e) => e.ev === "round" && e.round === 2, 90_000, "round 2 revealed");
  await r.kill();
  const tKill2 = await table();
  check("killed right after a reveal", tKill2?.phase === PHASE.revealed && tKill2.round === 2, { round: tKill2?.round, phase: tKill2?.phase });

  r = new Runner(env, "run3").start();
  const resume2 = await r.wait((e) => e.ev === "pool_resume", 60_000, "resume");
  const rec2 = await r.wait((e) => e.ev === "record" && e.round === 2, 120_000, "record 2 closed");
  const open3 = await r.wait((e) => e.ev === "round_open" && e.round === 3, 60_000, "round 3 open");
  check("restart after a reveal: record 2 committed, settled, swept and closed; round 3 opens", resume2.phase === PHASE.revealed && !!rec2.commitSig && !!rec2.settleSig && !!rec2.closeSig && !!open3,
    { resumedPhase: resume2.phase, commit: !!rec2.commitSig, settle: !!rec2.settleSig, calls: rec2.calls, claims: rec2.claims, close: !!rec2.closeSig });
  // 3. kill right after the commit of round 3 (committed, not yet settled)
  await r.waitNext((e) => e.ev === "record_commit" && e.round === 3 && e.ok, 120_000, "record 3 commit");
  await r.kill();
  r = new Runner(env, "run4").start();
  const rec3 = await r.wait((e) => e.ev === "record" && e.round === 3, 120_000, "record 3 closed");
  check("restart after a commit: record 3 settled and closed by the new process", !!rec3.settleSig && !!rec3.closeSig, { settle: !!rec3.settleSig, closeSig: !!rec3.closeSig, calls: rec3.calls, claims: rec3.claims });
  // nothing left behind for rounds 1-3
  const left = [];
  for (const n of [1, 2, 3]) if (await roundOnBase(n)) left.push(n);
  check("no recorded round of 1-3 left unsettled or unclosed on base", left.length === 0, { stillOnBase: left });
  await r.kill("SIGTERM");
  process.exit(summary());
}
main().catch((e) => { console.error(e); process.exit(2); });
