// Scripted spectators for the Tape on the live house pools (devnet base layer).
//
// For each recorded round (up to --rounds), three fresh burners call three different desks while calls are open.
// Each burner is funded from the given wallet with exactly what its call needs (the call amount, the Call account's
// rent and one fee) and holds nothing else. The house's sweep pays every claim (this script never sends claim_call);
// afterwards every burner's balance is checked against the parimutuel rule to the lamport and swept back to the wallet.
// Every transaction is sent with preflight on.
//
//   npx tsx scripts/tape-bettors.ts --pools 1,2 --rounds 20 --wallet <keypair.json>     env: OUT_DIR, KEYS_DIR
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { pda, PROGRAM_ID, send, loadKeypair, callPda, decodeTape, decodeCall } from "../tests/local/lib.ts";
import { disc } from "../tests/devnet/devnet.ts";
import { PHASE } from "../house/src/chain.ts";
import { DEV, Jsonl, TablePoll, account, iso } from "./f2-lib.ts";

function arg(name: string, d?: string) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; }
const pools = (arg("pools", "1,2") as string).split(",").map(Number);
const want = Number(arg("rounds", "20"));
const wallet = loadKeypair(arg("wallet", DEV.wallet) as string);
const outDir = process.env.OUT_DIR ?? path.resolve("f2-out");
const keysDir = process.env.KEYS_DIR ?? path.join(outDir, "keys");
const out = new Jsonl(path.join(outDir, "tape.jsonl"));
const base = new Connection(DEV.base, "confirmed");
const PLACE = disc("place_call");
const BETTORS = 3, FEE = 5000;
const CALL_LAMPORTS = 10_000_000;
const callRent = await base.getMinimumBalanceForRentExemption(112);
fs.mkdirSync(path.join(keysDir, "tape"), { recursive: true, mode: 0o700 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const busy = new Set<number>();
const tops = new Map<string, number>(); // "pool/round" -> Top Desk from the revealed public Table
let started = 0;
const jobs: Promise<void>[] = [];
const walletBefore = await base.getBalance(wallet.publicKey, "confirmed");
out.write("start", { pools, want, wallet: wallet.publicKey.toBase58(), walletLamports: walletBefore, callRent, callLamports: CALL_LAMPORTS });

async function bet(pool: number, round: number) {
  const tapePda = pda.tape(pool, round);
  const ta = await account(DEV.base, tapePda);
  if (!ta.data) { out.write("skip", { pool, round, why: "no Tape" }); return; }
  const tape0 = decodeTape(ta.data);
  const left = tape0.closeUnix - Math.floor(Date.now() / 1000);
  if (left < 10) { out.write("skip", { pool, round, why: "calls close too soon", left }); return; }
  started++;
  const desks: number[] = [];
  while (desks.length < BETTORS) { const d = Math.floor(Math.random() * 8); if (!desks.includes(d)) desks.push(d); }
  const kps = desks.map((d) => {
    const kp = Keypair.generate();
    fs.writeFileSync(path.join(keysDir, "tape", `t${pool}-r${round}-d${d}.json`), JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
    return kp;
  });
  const need = CALL_LAMPORTS + callRent + FEE;
  const fund = await send(base, kps.map((k) => SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: k.publicKey, lamports: need })), [wallet], { skipPreflight: false, timeoutMs: 60_000 });
  const v: any = { pool, round, desks, bettors: kps.map((k) => k.publicKey.toBase58()), fundSig: fund.sig, fundOk: fund.ok, need, calls: [] as any[] };
  if (!fund.ok) { v.fundErr = String(fund.err).slice(0, 200); out.write("tape_round", v); return; }
  await Promise.all(kps.map(async (k, i) => {
    const call = callPda(tapePda, k.publicKey);
    const ix = new TransactionInstruction({ programId: PROGRAM_ID, data: Buffer.concat([PLACE, Buffer.from([desks[i]])]), keys: [
      { pubkey: k.publicKey, isSigner: true, isWritable: true }, { pubkey: pda.config(), isSigner: false, isWritable: false },
      { pubkey: tapePda, isSigner: false, isWritable: true }, { pubkey: call, isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }] });
    const r = await send(base, [ix], [k], { skipPreflight: false, timeoutMs: 60_000 });
    v.calls[i] = { desk: desks[i], bettor: k.publicKey.toBase58(), sig: r.sig, ok: r.ok, err: r.ok ? undefined : String(r.err).slice(0, 200), ms: Math.round(r.ms) };
  }));
  out.write("placed", v);
  // follow the Tape until the house closes it (settle → claims → close), keeping the last view
  let last = null as ReturnType<typeof decodeTape> | null, settled = null as ReturnType<typeof decodeTape> | null;
  const t0 = Date.now();
  while (Date.now() - t0 < 20 * 60_000) {
    const a = await account(DEV.base, tapePda);
    if (!a.data) break;
    last = decodeTape(a.data);
    if (last.resolved && !settled) settled = last;
    await sleep(400);
  }
  v.tapeClosed = !(await account(DEV.base, tapePda)).data;
  v.tape = last ? { total: String(last.total), paid: String(last.paid), pool: last.pool.map(String), nCalls: last.nCalls, openCalls: last.openCalls, winner: last.winner, void: last.void, resolved: last.resolved } : null;
  // check every bettor's payout to the lamport, then sweep it back. Winner = the round's Top Desk (public Table at
  // the reveal); the Tape is void when nobody called it
  const top = tops.get(`${pool}/${round}`);
  v.topDesk = top ?? null;
  if (last && top !== undefined) { last.winner = top; last.void = last.pool[top] === 0n ? 1 : 0; }
  if (settled) v.settledView = { winner: settled.winner, void: settled.void, paid: String(settled.paid) };
  let sumPaid = 0n;
  for (let i = 0; i < kps.length; i++) {
    const c = v.calls[i];
    if (!c?.ok || !last) continue;
    const callAcc = await account(DEV.base, callPda(tapePda, kps[i].publicKey));
    const bal = BigInt(await base.getBalance(kps[i].publicKey, "confirmed"));
    const callOpen = !!callAcc.data;
    const amount = BigInt(CALL_LAMPORTS);
    const win = last.pool[last.winner] ?? 0n;
    const expected = last.void ? amount : desks[i] === last.winner && win > 0n ? (amount * last.total) / win : 0n;
    const payout = bal - (callOpen ? 0n : BigInt(callRent));
    c.balance = String(bal); c.callOpen = callOpen; c.owed = callAcc.data ? String(decodeCall(callAcc.data).owed) : null;
    c.expected = String(expected); c.payout = String(payout); c.exact = payout === expected;
    sumPaid += payout;
  }
  v.sumPaid = String(sumPaid);
  v.mineOnly = last ? last.nCalls === v.calls.filter((c: any) => c?.ok).length : null;
  // every lamport of the pool went to the bettors: all of it when refunded, all but the floor remainder (< 1 per winner) otherwise
  v.poolMatches = last && top !== undefined ? (last.void ? sumPaid === last.total : sumPaid <= last.total && last.total - sumPaid < BigInt(BETTORS)) : null;
  v.paidMatchesTape = settled && settled.openCalls === 0 ? sumPaid === settled.paid : null;
  v.kind = last ? (last.void ? "refund" : "payout") : null;
  v.pass = !!(v.tapeClosed && v.mineOnly && v.calls.every((c: any) => c?.ok && c.exact) && v.paidMatchesTape !== false && v.poolMatches);
  for (let i = 0; i < kps.length; i++) {
    const bal = await base.getBalance(kps[i].publicKey, "confirmed");
    if (bal > FEE) {
      const r = await send(base, [SystemProgram.transfer({ fromPubkey: kps[i].publicKey, toPubkey: wallet.publicKey, lamports: bal - FEE })], [kps[i]], { skipPreflight: false, timeoutMs: 60_000 });
      (v.sweep ??= []).push({ bettor: kps[i].publicKey.toBase58(), lamports: bal - FEE, ok: r.ok, sig: r.sig });
    }
    v.left = (v.left ?? 0) + (await base.getBalance(kps[i].publicKey, "confirmed"));
  }
  out.write("tape_round", v);
  console.log(`${v.pass ? "PASS" : "FAIL"} tape pool ${pool} round ${round} ${v.kind} desks ${desks} winner ${last?.winner} paid ${v.sumPaid}/${v.tape?.total}`);
}

// calls close at the round's planned start + 20 s, and a round may open later than planned: call on the Tape of the
// coming round as soon as its record exists (the house creates it during the round before)
for (const p of pools) {
  const poll = new TablePoll(p, pda.table(p), 250);
  const tried = new Set<number>();
  let checkAt = 0;
  poll.listeners.push((t) => {
    if (t.phase === PHASE.revealed) tops.set(`${p}/${t.round}`, t.topDesk);
    if (started >= want || busy.has(p)) return;
    const n = t.phase === PHASE.hide || t.phase === PHASE.live || t.phase === PHASE.bell ? t.round + 1 : t.round + 1;
    if (tried.has(n) || Date.now() < checkAt) return;
    checkAt = Date.now() + 2000;
    busy.add(p);
    (async () => {
      const a = await account(DEV.base, pda.tape(p, n));
      if (!a.data) return;
      tried.add(n);
      jobs.push(bet(p, n).catch((e) => out.write("error", { pool: p, round: n, err: String(e?.stack ?? e).slice(0, 400) })));
      await sleep(3000);
    })().finally(() => busy.delete(p));
  });
  poll.start();
}
while (started < want) await sleep(2000);
await Promise.all(jobs);
const walletAfter = await base.getBalance(wallet.publicKey, "confirmed");
out.write("end", { walletLamports: walletAfter, at: iso() });
process.exit(0);
