// Base-layer activity of the program and the house wallet on devnet: every signature of the program (paged back to
// the first), successful ones in total and per UTC hour, and the latest 100 of each address with their failures.
//
//   npx tsx scripts/base-counts.ts [--house <address>]     env: OUT_DIR (default ./f2-out), BASE_RPC
import path from "node:path";
import { PROGRAM_ID } from "../tests/local/lib.ts";
import { DEV, Jsonl, call, http429, iso } from "./f2-lib.ts";

function arg(name: string, d?: string) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; }
const house = arg("house", "2PgaD2rF6U4a7urZ43GWMkKdhchjqqSmVgcX54GLRAYQ") as string;
const out = new Jsonl(path.join(process.env.OUT_DIR ?? path.resolve("f2-out"), "base-counts.jsonl"));

async function all(addr: string, max = 100_000) {
  const sigs: { signature: string; err: any; blockTime: number | null; slot: number }[] = [];
  let before: string | undefined;
  while (sigs.length < max) {
    const r = await call(DEV.base, "getSignaturesForAddress", [addr, { limit: 1000, commitment: "confirmed", ...(before ? { before } : {}) }]);
    const page: any[] = r.body?.result ?? [];
    if (!page.length) break;
    sigs.push(...page);
    before = page[page.length - 1].signature;
    if (page.length < 1000) break;
  }
  return sigs;
}
const latest = (xs: any[]) => xs.slice(0, 100).map((x, i) => ({ i: i + 1, sig: x.signature, err: x.err, at: x.blockTime ? iso(x.blockTime * 1000) : null }));

const prog = await all(PROGRAM_ID.toBase58());
const ok = prog.filter((x) => !x.err);
const perHour: Record<string, number> = {};
for (const x of ok) if (x.blockTime) { const h = iso(x.blockTime * 1000).slice(0, 13); perHour[h] = (perHour[h] ?? 0) + 1; }
const houseLatest = (await call(DEV.base, "getSignaturesForAddress", [house, { limit: 100, commitment: "confirmed" }])).body?.result ?? [];
const pl = latest(prog), hl = latest(houseLatest);
const rep = {
  at: iso(), program: PROGRAM_ID.toBase58(), house,
  programTotal: prog.length, programSuccessful: ok.length, programFailed: prog.length - ok.length,
  first: prog.length ? iso((prog[prog.length - 1].blockTime ?? 0) * 1000) : null, last: prog.length ? iso((prog[0].blockTime ?? 0) * 1000) : null,
  perHour, programLatest100Failed: pl.filter((x) => x.err).map((x) => ({ position: x.i, sig: x.sig, at: x.at })),
  houseLatest100Failed: hl.filter((x) => x.err).map((x) => ({ position: x.i, sig: x.sig, at: x.at })),
  programLatest100Span: pl.length ? [pl[pl.length - 1].at, pl[0].at] : null, houseLatest100Span: hl.length ? [hl[hl.length - 1].at, hl[0].at] : null,
  allFailed: prog.map((x, k) => ({ x, k })).filter(({ x }) => x.err).map(({ x, k }) => ({ sig: x.signature, at: x.blockTime ? iso(x.blockTime * 1000) : null, position: k + 1,
    // it left the latest 100 when the 100th newer signature landed
    leftLatest100At: k >= 100 && prog[k - 100].blockTime ? iso(prog[k - 100].blockTime! * 1000) : null })), http429: http429.n,
};
out.write("counts", rep);
console.log(JSON.stringify(rep, null, 1));
process.exit(0);
