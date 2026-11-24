// Summary of a house runner log: rounds, durations, warnings, records, and bot behaviour per personality.
//   npx tsx house/test/run-report.ts <house log>
import fs from "node:fs";

const file = process.argv[2];
const ev = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
const rounds = ev.filter((e) => e.ev === "round");
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const dur = rounds.map((r) => r.roundMs).filter((x) => typeof x === "number");
const gaps = rounds.map((r) => r.gapMs).filter((x) => typeof x === "number");
const cycle = rounds.map((r) => (typeof r.roundMs === "number" && typeof r.gapMs === "number" ? r.roundMs + r.gapMs : null)).filter((x): x is number => x !== null);
console.log(`rounds ${rounds.length} (${rounds[0]?.round}..${rounds[rounds.length - 1]?.round}), recorded ${rounds.filter((r) => r.recorded).length}, beats ${pct(rounds.map((r) => r.beats), 0)}..${pct(rounds.map((r) => r.beats), 0.999)}`);
console.log(`open→bell ms p50 ${pct(dur, 0.5)} max ${pct(dur, 1)}; bell→next open ms p50 ${pct(gaps, 0.5)} max ${pct(gaps, 1)}; full cycle p50 ${pct(cycle, 0.5)} max ${pct(cycle, 1)}`);
console.log(`resolves = beats + 1 in ${rounds.filter((r) => r.resolves === r.beats + 1).length}/${rounds.length}; fallback seed ${rounds.filter((r) => r.fallbackSeed).length}/${rounds.length}; reschedules ${ev.filter((e) => e.ev === "crank_rescheduled").length}; aborts ${ev.filter((e) => e.ev === "round_aborted").length}`);
const warn = ev.filter((e) => e.level !== "info");
const byEv: Record<string, number> = {};
for (const w of warn) byEv[w.ev] = (byEv[w.ev] ?? 0) + 1;
console.log(`warnings/errors: ${warn.length} ${JSON.stringify(byEv)}`);
const recs = ev.filter((e) => e.ev === "record");
const commits = ev.filter((e) => e.ev === "record_commit");
console.log(`records closed ${recs.length}; commits sent ${commits.length} (ok ${commits.filter((c) => c.ok).length}, retries ${commits.filter((c) => c.attempt > 1).length}); stranded ${ev.filter((e) => e.ev === "record_stranded").length}; commit→base ms p50 ${pct(recs.map((r) => r.msToBase).filter(Boolean), 0.5)} max ${pct(recs.map((r) => r.msToBase).filter(Boolean), 1)}`);
console.log(`test calls ${ev.filter((e) => e.ev === "test_call" && e.ok).length}; claims ok ${ev.filter((e) => e.ev === "claim" && e.ok).length} failed ${ev.filter((e) => e.ev === "claim" && !e.ok).length}; settled void ${recs.filter((r) => r.void).length}/${recs.length}`);
const bots = ev.filter((e) => e.ev === "bots").flatMap((e) => e.bots);
const kinds = ["SHARK", "GHOST", "MINNOW"];
for (const k of kinds) {
  const b = bots.filter((x) => x.name.startsWith(k));
  if (!b.length) continue;
  const avg = (f: (x: any) => number) => (b.reduce((a, x) => a + (f(x) ?? 0), 0) / b.length).toFixed(2);
  const presence = b.reduce((a, x) => a + x.present, 0) / b.reduce((a, x) => a + x.present + x.absent, 0);
  console.log(`${k.padEnd(6)} n=${b.length} acts/s ${avg((x) => x.ackPerSec)} sent ${avg((x) => x.sent)} acked ${avg((x) => x.acked)} sendErr ${b.reduce((a, x) => a + x.sendErr, 0)} | pings ${avg((x) => x.pings)} requotes ${avg((x) => x.requotes)} algo ${avg((x) => x.algo)} fills ${avg((x) => x.fills)} | present ${(100 * presence).toFixed(1)}% rt ${avg((x) => x.rtMs)} ms | total ${avg((x) => x.total / 10)} lots`);
}
const missed = bots.filter((x) => x.acked !== null && x.acked < x.sent);
console.log(`bot-rounds ${bots.length}; acked < sent in ${missed.length} (sum missing ${missed.reduce((a, x) => a + x.sent - x.acked, 0)} of ${bots.reduce((a, x) => a + x.sent, 0)} sent)`);
