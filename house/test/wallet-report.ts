// House wallet activity since a time: base transactions (and how many failed), the balance change,
// and how much of it came from transactions in a runner log (the rest: other users of the same key).
//   npx tsx house/test/wallet-report.ts <since ISO time> [house log] [base rpc]
import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../src/config.ts";
import { loadKeypair, rpc } from "../src/chain.ts";

async function main() {
  const [sinceIso, logFile, rpcArg] = process.argv.slice(2);
  if (!sinceIso) { console.error("usage: wallet-report.ts <since ISO time> [house log] [base rpc]"); process.exit(2); }
  const cfg = loadConfig({ CLUSTER: "devnet", ...process.env });
  const c = new Connection(rpcArg ?? cfg.baseRpc, "confirmed");
  const house = loadKeypair(cfg.houseKeypair).publicKey;
  const since = Math.floor(Date.parse(sinceIso) / 1000);
  const mine = new Set(logFile ? fs.readFileSync(logFile, "utf8").match(/[1-9A-HJ-NP-Za-km-z]{80,90}/g) ?? [] : []);
  const sigs: { signature: string; blockTime?: number | null; err: unknown }[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await c.getSignaturesForAddress(house, { limit: 1000, before });
    sigs.push(...page.filter((s) => (s.blockTime ?? 0) >= since));
    if (page.length < 1000 || (page[page.length - 1].blockTime ?? 0) < since) break;
    before = page[page.length - 1].signature;
  }
  const out = { txs: sigs.length, failed: sigs.filter((s) => s.err).length, runnerTxs: 0, runnerFailed: 0, runnerSol: 0, otherTxs: 0, otherSol: 0, balanceSol: (await c.getBalance(house, "confirmed")) / 1e9 };
  for (const s of sigs) {
    // raw JSON (any transaction version): the house is always a static key when it pays or signs
    const t = (await rpc(rpcArg ?? cfg.baseRpc, "getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }], 20_000)).body?.result;
    if (!t?.meta) continue;
    const i = (t.transaction.message.accountKeys as string[]).indexOf(house.toBase58());
    const d = i < 0 ? 0 : (t.meta.postBalances[i] - t.meta.preBalances[i]) / 1e9;
    if (mine.has(s.signature)) { out.runnerTxs++; out.runnerSol += d; if (s.err) out.runnerFailed++; }
    else { out.otherTxs++; out.otherSol += d; }
  }
  out.runnerSol = +out.runnerSol.toFixed(6); out.otherSol = +out.otherSol.toFixed(6);
  console.log(JSON.stringify(out));
}
main().catch((e) => { console.error(e); process.exit(1); });
