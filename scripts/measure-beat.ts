// Beat deadline -> own private result, measured from a seated client (and send -> ack).
//
// Definition (the same as the game's header number): a beat's scheduled close is the wall time of its deadline slot
// (hide_end_slot + beat x beat_slots, mapped to local time by a slot clock fitted from getSlot samples); the sample
// is the arrival of the own Desk update carrying that beat's result over the live subscription minus that close.
// Only results delivered by the subscription count (no catch-up polls). send -> ack = an act's send time to the
// first own-Desk update whose last_seq covers it.
//
//   npx tsx scripts/measure-beat.ts --pool 2 --beats 500            seat a Node player (information behaviour) and measure
//   npx tsx scripts/measure-beat.ts --from f2-out/humans-t1.jsonl,…  summarise the samples of earlier scripted rounds
//   npx tsx scripts/measure-beat.ts --browser <url> [--tabs 5]       the same number from fresh headless Chrome tabs,
//                                                                   one after another (tests/browser/lag.mjs)
//   env: OUT_DIR (default ./f2-out), REGION (a label for where this machine is)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Player } from "./humans.ts";
import { Jsonl, pct, iso } from "./f2-lib.ts";

function arg(name: string, d?: string) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; }
const outDir = process.env.OUT_DIR ?? path.resolve("f2-out");
const region = process.env.REGION ?? "unlabelled";
const out = new Jsonl(path.join(outDir, "measure-beat.jsonl"));
const stats = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: xs.length ? Math.max(...xs) : null });

function fromRounds(files: string[], key?: string) {
  const rounds = files.flatMap((f) => Jsonl.read(f)).filter((x) => x.ev === "round" && !x.silent && (!key || x.key === key));
  const lags = rounds.flatMap((r) => r.lags ?? []), acks = rounds.flatMap((r) => r.acks ?? []);
  const ts = rounds.map((r) => r.t).sort();
  return { source: "node", rounds: rounds.length, from: ts[0], to: ts.at(-1), result: stats(lags), ack: stats(acks) };
}

let report: any;
if (arg("browser")) {
  const url = arg("browser") as string;
  const file = path.join(outDir, `browser-lag-${iso().replace(/[:.]/g, "-")}.json`);
  const r = spawnSync("node", [path.resolve("tests/browser/lag.mjs"), url], { stdio: "inherit", env: { ...process.env, TABS: arg("tabs", "5"), OUT: file } });
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  report = { source: "browser", url, tabs: j.tabs.map((t: any) => ({ table: t.table, seat: t.seat, n: t.samples.length, p50: pct(t.samples, 50), p95: pct(t.samples, 95), ack: t.acks })),
    result: stats(j.tabs.flatMap((t: any) => t.samples)), exit: r.status, raw: file };
} else if (arg("from")) {
  report = fromRounds((arg("from") as string).split(","));
} else {
  const pool = Number(arg("pool", "1")), beats = Number(arg("beats", "500"));
  const p = new Player({ tableId: pool, strategies: ["typical"], rounds: Math.ceil(beats / 24) + 1, outDir, keysDir: process.env.KEYS_DIR ?? path.join(outDir, "keys"), tag: `beat-${Date.now()}` });
  process.on("SIGTERM", () => p.stop()); process.on("SIGINT", () => p.stop());
  await p.start();
  report = fromRounds([path.join(outDir, `humans-t${pool}.jsonl`)], p.me);
}
report = { ...report, at: iso(), region, host: `${os.cpus().length} cores` };
out.write("report", report);
console.log(JSON.stringify(report, null, 1));
process.exit(0);
