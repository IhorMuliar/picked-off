// I13 check over the runner's account-read log: on the rollup, each bot read only its own Desk, the
// house read only public accounts (Table, Round records, permission metadata), nobody read the Book,
// and nobody read another seat's Desk. On base, Desks and the Book were only checked for existence
// (owner only, no data requested), on the rollup likewise while delegating. Prints PASS/FAIL with counts; exits non-zero on any violation.
//   npx tsx house/src/i13-check.ts <rpc.jsonl> [pools comma-separated]   (or: make house-i13)
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { PublicKey } from "@solana/web3.js";
import { loadConfig } from "./config.ts";
import { loadKeypair } from "./chain.ts";

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error("usage: i13-check.ts <rpc.jsonl> [pools]"); process.exit(2); }
const cfg = loadConfig();
const program = new PublicKey(cfg.programId);
const le8 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[0].toBase58();

interface Line { t: number; who: string; layer: "base" | "er"; m: string; a: string[] }

async function main() {
  const lines: Line[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  for await (const l of rl) { if (l.trim()) try { lines.push(JSON.parse(l)); } catch {} }

  // pools: from the argument, else every table whose Table PDA appears in the log among the configured ones and 1..5000
  const poolArg = process.argv[3];
  const seen = new Set(lines.flatMap((l) => l.a));
  const pools = poolArg ? poolArg.split(",").map(Number) : Array.from({ length: 5000 }, (_, i) => i + 1).concat(cfg.pools).filter((t) => seen.has(pda([Buffer.from("table"), le8(t)])));
  const books = new Map<string, number>(), desks = new Map<string, { t: number; s: number }>(), tables = new Map<string, number>();
  const ownerOfDesk = new Map<string, string>(); // desk → bot key that may read it
  for (const t of new Set(pools)) {
    tables.set(pda([Buffer.from("table"), le8(t)]), t);
    books.set(pda([Buffer.from("book"), le8(t)]), t);
    for (let s = 0; s < 8; s++) {
      const d = pda([Buffer.from("desk"), le8(t), Buffer.from([s])]);
      desks.set(d, { t, s });
      const kf = path.join(cfg.botKeysDir, `t${t}-s${s}.json`);
      if (fs.existsSync(kf)) ownerOfDesk.set(d, loadKeypair(kf).publicKey.toBase58());
    }
  }

  const violations: string[] = [];
  const perWho = new Map<string, { reads: number; accounts: Set<string> }>();
  let erReads = 0, baseReads = 0, revealedReads = 0;
  for (const l of lines) {
    const w = perWho.get(l.who) ?? { reads: 0, accounts: new Set<string>() };
    perWho.set(l.who, w);
    w.reads++;
    if (l.layer === "er") erReads++; else baseReads++;
    const accs = l.m === "getProgramAccounts" ? [] : l.a;
    for (const a of accs) {
      w.accounts.add(a);
      const isBook = books.has(a), desk = desks.get(a);
      if (l.layer === "base") {
        if ((isBook || desk) && l.m !== "getMultipleAccounts:meta") violations.push(`${l.who} read ${isBook ? "the Book" : `desk ${desk!.t}/${desk!.s}`} on base with data (${l.m})`);
        continue;
      }
      if ((isBook || desk) && l.m === "getMultipleAccounts:meta") continue; // existence and owner only
      if (isBook) { violations.push(`${l.who} read the Book of table ${books.get(a)} on the rollup`); continue; }
      if (l.who.startsWith("bot:")) {
        const key = l.who.slice(4);
        if (!desk || ownerOfDesk.get(a) !== key) violations.push(`bot ${key.slice(0, 8)} read ${desk ? `desk ${desk.t}/${desk.s}` : a} (not its own Desk)`);
      } else if (desk) {
        // the house reads a Desk only once its round is revealed and public (idle-player check)
        if (l.m !== "getAccountInfo:revealed" || (l as any).phase !== 4) violations.push(`${l.who} read desk ${desk.t}/${desk.s} on the rollup (${l.m})`);
        else revealedReads++;
      }
      // the house also reads public accounts: the Table, Round records, permission metadata
    }
  }
  const span = lines.length ? (lines[lines.length - 1].t - lines[0].t) / 3_600_000 : 0;
  const bots = [...perWho.entries()].filter(([k]) => k.startsWith("bot:"));
  console.log(`log ${file}: ${lines.length} reads over ${span.toFixed(2)} h (rollup ${erReads}, base ${baseReads}); pools ${[...new Set(pools)].join(",")}`);
  console.log(`identities: house ${perWho.get("house")?.reads ?? 0} reads (${revealedReads} of a revealed, public Desk); ${bots.length} bots, each reading ${[...new Set(bots.map(([, v]) => v.accounts.size))].join("/")} distinct account(s)`);
  const ok = violations.length === 0 && bots.length > 0;
  for (const v of violations.slice(0, 20)) console.log(`  violation: ${v}`);
  console.log(`${ok ? "PASS" : "FAIL"}  I13: bots read only their own Desk, nobody read the Book or another Desk (${violations.length} violations)`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
