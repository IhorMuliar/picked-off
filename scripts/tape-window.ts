// The Tape's call window on the live house pools, measured from the real open of each recorded round.
//
// Per recorded round: five fresh burners, each funded from the wallet with exactly one call's cost (the call, the
// Call account's rent, one fee). Four send place_call at 5, 10, 15 and 19 s after the round is seen open on the
// rollup (Table poll every 100 ms); the fifth only SIMULATES place_call at 20, 20.5 and 21 s (never sent) to find
// the edge. Every send has preflight on and no RPC-side retries, and the 19-s send goes out only while at least
// 0.7 s of base time is left by the Tape's close_unix (the base clock reaches a second ≈ 0.15-0.6 s after it), so a
// call can never land as a failed transaction. After the house closes the Tape every burner is swept back.
//
//   npx tsx scripts/tape-window.ts --pools 1,2 --rounds 10 --wallet <keypair.json>    env: OUT_DIR
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction, type Signer } from "@solana/web3.js";
import { pda, PROGRAM_ID, loadKeypair, callPda, decodeTape } from "../tests/local/lib.ts";
import { disc } from "../tests/devnet/devnet.ts";
import { PHASE } from "../house/src/chain.ts";
import { DEV, Jsonl, TablePoll, account, iso } from "./f2-lib.ts";

function arg(name: string, d?: string) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; }
const pools = (arg("pools", "1,2") as string).split(",").map(Number);
const want = Number(arg("rounds", "10"));
const wallet = loadKeypair(arg("wallet", DEV.wallet) as string);
const outDir = process.env.OUT_DIR ?? path.resolve("tape-window-out");
fs.mkdirSync(path.join(outDir, "keys"), { recursive: true, mode: 0o700 });
const out = new Jsonl(path.join(outDir, "tape-window.jsonl"));
const base = new Connection(DEV.base, "confirmed");
const PLACE = disc("place_call");
const FEE = 5000, CALL_LAMPORTS = 10_000_000;
const SEND_AT = [5_000, 10_000, 15_000, 19_000];
const SIM_AT = [20_000, 20_500, 21_000];
const MIN_LEFT_MS = 700; // the last send goes out only with this much base time left
const MAX_JOBS = 3; // at most 3 rounds' burners funded at once (≤ 0.18 SOL out)
const callRent = await base.getMinimumBalanceForRentExemption(112);
const need = CALL_LAMPORTS + callRent + FEE;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const placeIx = (pool: number, round: number, k: PublicKey, desk: number) => {
  const tape = pda.tape(pool, round);
  return new TransactionInstruction({ programId: PROGRAM_ID, data: Buffer.concat([PLACE, Buffer.from([desk])]), keys: [
    { pubkey: k, isSigner: true, isWritable: true }, { pubkey: pda.config(), isSigner: false, isWritable: false },
    { pubkey: tape, isSigner: false, isWritable: true }, { pubkey: callPda(tape, k), isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }] });
};
async function signed(ixs: TransactionInstruction[], signers: Signer[]) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await base.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(...signers);
  return tx;
}
/** preflight on, maxRetries 0: refused → never lands */
async function send(tx: Transaction) {
  const t0 = Date.now();
  let sig = "";
  try { sig = await base.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "processed", maxRetries: 0 }); }
  catch (e: any) { return { ok: false, refused: true, err: String(e?.message ?? e).slice(0, 160), ms: Date.now() - t0, sig }; }
  for (let i = 0; i < 120; i++) {
    const v = (await base.getSignatureStatuses([sig]).catch(() => null))?.value?.[0];
    if (v?.err) return { ok: false, failedOnChain: true, err: JSON.stringify(v.err), ms: Date.now() - t0, sig };
    if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) return { ok: true, ms: Date.now() - t0, sig };
    await sleep(250);
  }
  return { ok: false, err: "not confirmed", ms: Date.now() - t0, sig };
}
async function simulate(tx: Transaction) {
  const v = new VersionedTransaction(tx.compileMessage());
  const r = await base.simulateTransaction(v, { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" });
  const logs = r.value.logs ?? [];
  return { ok: !r.value.err, err: r.value.err ? JSON.stringify(r.value.err) : undefined, callsClosed: logs.some((l) => /CallsClosed|0x1781/.test(l)) || /6017/.test(JSON.stringify(r.value.err ?? "")) };
}

let started = 0, jobs = 0;
const all: Promise<void>[] = [];
const walletBefore = await base.getBalance(wallet.publicKey, "confirmed");
out.write("start", { pools, want, wallet: wallet.publicKey.toBase58(), walletLamports: walletBefore, need });

async function round(pool: number, n: number, seenOpenAt: number) {
  const tapePda = pda.tape(pool, n);
  const ta = await account(DEV.base, tapePda, "processed");
  if (!ta.data) { out.write("skip", { pool, round: n, why: "no Tape" }); return; }
  const closeUnix = Number(decodeTape(ta.data).closeUnix);
  const kps = Array.from({ length: 5 }, () => Keypair.generate());
  kps.forEach((k, i) => fs.writeFileSync(path.join(outDir, "keys", `t${pool}-r${n}-${i}.json`), JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 }));
  const fund = await send(await signed(kps.map((k) => SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: k.publicKey, lamports: need })), [wallet]));
  const v: any = { pool, round: n, closeUnix, closeMinusSeenOpenMs: closeUnix * 1000 - seenOpenAt, fund: { ok: fund.ok, ms: fund.ms, sig: fund.sig }, sends: [], sims: [] };
  if (!fund.ok) { out.write("tape_window", { ...v, fundErr: fund.err }); return; }
  const desks = [0, 1, 2, 3].map(() => Math.floor(Math.random() * 8));
  const prebuilt = await Promise.all(SEND_AT.map((_, i) => signed([placeIx(pool, n, kps[i].publicKey, desks[i])], [kps[i]])));
  await Promise.all(SEND_AT.map(async (at, i) => {
    await sleep(Math.max(0, seenOpenAt + at - Date.now()));
    const leftMs = closeUnix * 1000 + 150 - Date.now();
    if (leftMs < MIN_LEFT_MS) { v.sends[i] = { at, sent: false, why: `only ${leftMs} ms of base time left`, sim: await simulate(prebuilt[i]) }; return; }
    const r = await send(prebuilt[i]);
    v.sends[i] = { at, sent: true, sentAtMs: Date.now() - seenOpenAt - r.ms, leftMsAtSend: leftMs, ...r };
  }));
  const simTx = await signed([placeIx(pool, n, kps[4].publicKey, 7)], [kps[4]]);
  for (const at of SIM_AT) {
    await sleep(Math.max(0, seenOpenAt + at - Date.now()));
    v.sims.push({ at, ...(await simulate(simTx)) });
  }
  v.pass = v.sends.every((s: any) => s.ok) && v.sims.at(-1).ok === false && v.sims.at(-1).callsClosed;
  out.write("placed", v);
  console.log(`${v.pass ? "PASS" : "FAIL"} pool ${pool} round ${n}: sends ${v.sends.map((s: any) => `${s.at / 1000}s:${s.ok ? "ok" : s.sent ? s.err : "not sent"}`).join(" ")} | sims ${v.sims.map((s: any) => `${s.at / 1000}s:${s.ok ? "accepted" : s.callsClosed ? "CallsClosed" : s.err}`).join(" ")} | close − seen open ${v.closeMinusSeenOpenMs} ms`);
  // sweep back once the house has closed the Tape (settle → claims → close), at most 10 minutes
  for (let i = 0; i < 600 && (await account(DEV.base, tapePda)).data; i++) await sleep(1000);
  v.sweep = [];
  for (const k of kps) {
    const bal = await base.getBalance(k.publicKey, "confirmed");
    if (bal > FEE) { const r = await send(await signed([SystemProgram.transfer({ fromPubkey: k.publicKey, toPubkey: wallet.publicKey, lamports: bal - FEE })], [k])); v.sweep.push({ lamports: bal - FEE, ok: r.ok }); }
  }
  out.write("tape_window", v);
}

for (const p of pools) {
  const poll = new TablePoll(p, pda.table(p), 100);
  let seen = -1;
  poll.listeners.push((t, prev) => {
    if (!prev) { seen = t.round; return; } // a round already under way when the script started: not timed from its open
    if (t.phase !== PHASE.hide || t.round === seen) return;
    seen = t.round;
    if (!t.recorded || started >= want || jobs >= MAX_JOBS) return;
    started++; jobs++;
    all.push(round(p, t.round, poll.at).catch((e) => out.write("error", { pool: p, round: t.round, err: String(e?.stack ?? e).slice(0, 400) })).finally(() => { jobs--; }));
  });
  poll.start();
}
while (started < want) await sleep(1000);
await Promise.all(all);
out.write("end", { walletLamports: await base.getBalance(wallet.publicKey, "confirmed"), walletBefore, at: iso() });
process.exit(0);
