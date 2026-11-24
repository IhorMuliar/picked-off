// PICKED OFF house runner: keeps the house pools looping round after round, with labelled bots in
// every empty seat, and takes recorded rounds through to settlement on base. One process; restart
// at any time (it resumes from chain state). Configuration: see house/README.md.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { loadConfig } from "./config.ts";
import { Chain, openRpcLog } from "./chain.ts";
import { Pool } from "./pool.ts";
import { log, openLog, quietStdoutInfo } from "./log.ts";

const cfg = loadConfig();
fs.mkdirSync(cfg.stateDir, { recursive: true });
openLog(cfg.logFile, cfg.logMaxMb, cfg.logKeep);
openRpcLog(cfg.rpcLogFile, cfg.logMaxMb, cfg.logKeep);
quietStdoutInfo(!cfg.stdoutInfo);

// one runner per cluster and state dir: a second process would drive the same rounds twice
const lockFile = path.join(cfg.stateDir, `house-${cfg.cluster}.pid`);
function takeLock() {
  if (fs.existsSync(lockFile)) {
    const pid = Number(fs.readFileSync(lockFile, "utf8").trim());
    let alive = false;
    try { if (pid && pid !== process.pid) { process.kill(pid, 0); alive = true; } } catch { alive = false; }
    if (alive) { log.error("already_running", { pid, lockFile }); process.exit(3); }
  }
  fs.writeFileSync(lockFile, String(process.pid));
}
takeLock();

const chain = new Chain(cfg);
const pools = cfg.pools.map((t) => new Pool(chain, t));
const started = Date.now();

function diskFreeMb(): number | null {
  try { const st = fs.statfsSync(cfg.stateDir); return Math.round((st.bavail * st.bsize) / 1048576); } catch { return null; }
}
function health() {
  const ps = pools.map((p) => p.health());
  const bal = chain.balanceLamports;
  return { diskFreeMb: diskFreeMb(), ok: ps.every((p) => !p.stuck && (p.lastRoundAgeSec === null ? Date.now() - started < 180_000 : true)), cluster: cfg.cluster, house: chain.house.publicKey.toBase58(),
    uptimeSec: Math.round((Date.now() - started) / 1000), balanceSol: bal === null ? null : bal / 1e9, recording: chain.canRecord(), recordSpacing: chain.lowBalance() ? cfg.lowRecordEverySec : null, minBalanceSol: cfg.minBalanceSol, softBalanceSol: cfg.softBalanceSol, baseTxs: chain.baseTxs, pools: ps };
}
const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/healthz")) {
    const h = health();
    res.writeHead(h.ok ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify(h));
  } else { res.writeHead(404); res.end(); }
});
server.listen(cfg.healthPort, "127.0.0.1");

let exiting = false;
function shutdown(code: number, why: string) {
  if (exiting) return;
  exiting = true;
  log.info("house_stop", { why, code });
  for (const p of pools) p.stop();
  server.close();
  try { if (fs.readFileSync(lockFile, "utf8").trim() === String(process.pid)) fs.unlinkSync(lockFile); } catch {}
  setTimeout(() => process.exit(code), 300);
}
// low-balance guard: below minBalanceSol no new records are created (the pools keep playing unrecorded)
let softWas = false;
async function balanceTick() {
  const was = chain.canRecord();
  await chain.refreshBalance().catch(() => null);
  const bal = chain.balanceLamports;
  if (!chain.canRecord()) log.error("low_balance", { balanceSol: (bal ?? 0) / 1e9, minSol: cfg.minBalanceSol, house: chain.house.publicKey.toBase58(), note: "LOW HOUSE BALANCE: new records stopped; top up the house wallet" });
  else if (!was) log.warn("balance_ok_again", { balanceSol: (bal ?? 0) / 1e9 });
  if (chain.canRecord() && chain.lowBalance() !== softWas) log.warn(chain.lowBalance() ? "balance_soft_low" : "balance_soft_ok", { balanceSol: (bal ?? 0) / 1e9, softSol: cfg.softBalanceSol, recordEverySecWithPlayers: chain.lowBalance() ? cfg.lowRecordEverySec : 0 });
  softWas = chain.lowBalance();
}
void balanceTick();
setInterval(() => void balanceTick(), 60_000).unref();
setInterval(() => { const mb = diskFreeMb(); if (mb !== null && mb < 2048) log.warn("disk_low", { freeMb: mb, stateDir: cfg.stateDir }); }, 60_000).unref();
process.on("SIGTERM", () => shutdown(0, "SIGTERM"));
process.on("SIGINT", () => shutdown(0, "SIGINT"));
process.on("uncaughtException", (e) => { log.error("uncaught", { err: String(e?.stack ?? e) }); shutdown(1, "uncaughtException"); });
process.on("unhandledRejection", (e: any) => log.warn("unhandled_rejection", { err: String(e?.stack ?? e) }));

log.info("house_start", { cluster: cfg.cluster, base: cfg.baseRpc, er: cfg.erRpc, program: cfg.programId, house: chain.house.publicKey.toBase58(), pools: cfg.pools,
  recordEverySec: cfg.recordEverySec, stallMs: cfg.stallMs, testCalls: cfg.testCalls, healthPort: cfg.healthPort, pid: process.pid });

async function runPool(p: Pool) {
  for (;;) {
    try {
      await p.run();
      return;
    } catch (e: any) {
      log.error("pool_failed", { pool: p.tableId, err: String(e?.message ?? e) });
      if (exiting) return;
      p.stop();
      await new Promise((r) => setTimeout(r, 5_000));
      const i = pools.indexOf(p);
      pools[i] = new Pool(chain, p.tableId);
      p = pools[i];
    }
  }
}

Promise.all(pools.map((p) => runPool(p))).then(() => {
  const d = pools.flatMap((p) => p.durations()).sort((a, b) => a - b);
  log.info("house_done", { rounds: pools.map((p) => p.rounds), p50Ms: d[Math.floor(d.length / 2)] ?? null, maxMs: d[d.length - 1] ?? null, health: health() });
  shutdown(0, "max rounds reached");
});
