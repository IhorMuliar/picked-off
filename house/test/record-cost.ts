// Base-layer cost of recorded rounds, from the runner's log: for each closed record, the house
// wallet's balance change over its own transactions (create + delegate, settle, claims, close).
//   npx tsx house/test/record-cost.ts <house log> [base rpc]
import fs from "node:fs";
import { Connection } from "@solana/web3.js";

const [file, baseRpc = "http://127.0.0.1:8899"] = process.argv.slice(2);
const base = new Connection(baseRpc, "confirmed");
const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
const house = lines.find((l) => l.ev === "house_start")?.house;
const claims = new Map<string, string[]>();
for (const l of lines) if (l.ev === "claim" && l.ok) claims.set(`${l.pool}/${l.round}`, [...(claims.get(`${l.pool}/${l.round}`) ?? []), l.sig]);
const recs = lines.filter((l) => l.ev === "record");
async function delta(sig: string): Promise<number> {
  const t = await base.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!t?.meta) return NaN;
  const keys = t.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
  const i = keys.indexOf(house);
  return i < 0 ? 0 : t.meta.postBalances[i] - t.meta.preBalances[i];
}
const out: number[] = [];
for (const r of recs) {
  const sigs = [r.createSig, r.settleSig, r.closeSig, ...(claims.get(`${r.pool}/${r.round}`) ?? [])].filter(Boolean);
  let sum = 0;
  for (const s of sigs) sum += await delta(s);
  out.push(-sum);
}
const ok = out.filter((x) => Number.isFinite(x));
ok.sort((a, b) => a - b);
console.log(`records ${recs.length}, measured ${ok.length}; house lamports per record: median ${ok[Math.floor(ok.length / 2)]}, min ${ok[0]}, max ${ok[ok.length - 1]} (= ${(ok[Math.floor(ok.length / 2)] / 1e9).toFixed(6)} SOL)`);
