/**
 * Beat -> private result latency from real browsers: fresh headless Chrome tabs, one at a time, each takes a seat
 * through the normal walletless join and stays for a while; the game's own measurement (scheduled beat close ->
 * own Desk result received over the live subscription) is collected sample by sample.
 *
 *   node tests/browser/lag.mjs <url>
 *   Env: TABS=5 · TAB_SEC=240 (seconds seated per tab) · GAP_SEC=75 (pause between tabs, so the house hands the
 *        previous desk back to a bot before the next tab joins) · OUT=<file for the JSON report>
 * Prints one line per tab and a pooled summary. Tabs run one after another, never in parallel (parallel tabs on
 * one machine measure CPU contention, not the network).
 */
import fs from "node:fs";
import { launch, sleep } from "./cdp.mjs";

const url = process.argv[2] ?? process.env.URL;
if (!url) {
  console.error("usage: node tests/browser/lag.mjs <url>");
  process.exit(2);
}
const env = (k, d) => process.env[k] ?? d;
const TABS = Number(env("TABS", 5)), TAB_SEC = Number(env("TAB_SEC", 240)), GAP_SEC = Number(env("GAP_SEC", 75));
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null;
};
const report = { url, at: new Date().toISOString(), tabs: [] };

for (let i = 0; i < TABS; i++) {
  const b = await launch();
  const tab = { i, start: new Date().toISOString(), samples: [], acks: null, table: null, seat: null, exceptions: 0 };
  try {
    await b.nav(url);
    let lastN = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < TAB_SEC * 1000) {
      await sleep(4000);
      const s = await b.status().catch(() => null);
      if (!s) continue;
      tab.table = s.tableId ?? tab.table;
      tab.seat = s.seat ?? tab.seat;
      const n = s.resultLagN ?? 0;
      if (n > lastN) {
        const fresh = (s.resultLags ?? []).slice(-Math.min(n - lastN, 60));
        tab.samples.push(...fresh);
        lastN = n;
      }
      tab.acks = { p50: s.ackP50, p95: s.ackP95, n: s.ackN };
    }
    tab.exceptions = b.errors().exceptions.length;
  } finally {
    b.close();
  }
  tab.end = new Date().toISOString();
  report.tabs.push(tab);
  console.log(`tab ${i}: table ${tab.table} seat ${tab.seat} n ${tab.samples.length} p50 ${pct(tab.samples, 0.5)} p95 ${pct(tab.samples, 0.95)} ack p50 ${tab.acks?.p50 ? Math.round(tab.acks.p50) : null}`);
  if (i < TABS - 1) await sleep(GAP_SEC * 1000);
}
const all = report.tabs.flatMap((t) => t.samples);
report.summary = { tabs: report.tabs.length, n: all.length, p50: pct(all, 0.5), p95: pct(all, 0.95), p99: pct(all, 0.99), max: all.length ? Math.max(...all) : null };
console.log(`browser beat -> private result: ${JSON.stringify(report.summary)}`);
if (env("OUT", "")) fs.writeFileSync(env("OUT", ""), JSON.stringify(report, null, 1));
