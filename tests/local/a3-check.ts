// Base-layer money path checks on the local MagicBlock stack: records, the Tape, settle, claims, close.
//   make local-stack            (own terminal; loads target/deploy/ping.so)
//   make local-fund
//   npx tsx tests/local/a3-check.ts     (or: make local-check-a3)
// Prints one PASS/FAIL line per check and exits non-zero if any check fails.
//  1. settle_round only once the Round is back on base and finished; idempotent
//  2. parimutuel payouts: sum of claims + floor remainder = pool, several bettors on every desk
//  3. refunds: nobody called the Top Desk; aborted round; record never played
//  4. one call per bettor per round; no call after the close
//  5. a payout below the rent minimum to a 0-lamport bettor stays owed, then pays once funded
//  6. double claim, redirected claim, stranger close, early close
import { SystemProgram } from "@solana/web3.js";
import {
  LOCAL, PROGRAM_ID, KIND, PHASE, NDESK, BN, pda, sleep, loadKeypair, tokenFor, erUrl, erConn, readAccount, programOn, send,
  waitOwner, decodeTable, decodeRound, decodeTape, decodeCall, callPda, Keypair, PublicKey, Connection, type SendResult,
} from "./lib.ts";

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: unknown) {
  const d = typeof detail === "string" ? detail : JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  results.push({ name, pass, detail: d });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}: ${d}`);
}
function must(r: SendResult, label: string) {
  if (!r.ok) {
    console.log(`tx failed: ${label}`, r.err, (r.logs ?? []).slice(-8));
    throw new Error(`${label} failed`);
  }
  return r;
}
const errCode = (r: SendResult) => (r.ok ? "ok" : ((r.logs ?? []).find((l) => /Error Code|failed:/.test(l)) ?? JSON.stringify(r.err)).slice(0, 140));

const LOCAL_ER_QUEUE = new PublicKey("Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT");
const house = loadKeypair(LOCAL.wallet);
const stranger = Keypair.generate();
const bots = Array.from({ length: NDESK }, () => Keypair.generate());
const base = new Connection(LOCAL.base, "confirmed");
const progBase = programOn(base, house);
const ix = (m: any) => m.instruction();
const T = Number(process.env.TABLE_ID ?? Math.floor(Date.now() / 1000) + 7);
const table = pda.table(T), book = pda.book(T), desks = Array.from({ length: NDESK }, (_, s) => pda.desk(T, s));
const deskAccs = Object.fromEntries(desks.map((d, s) => [`desk${s}`, d]));

const lamports = async (k: PublicKey) => BigInt(await base.getBalance(k, "confirmed"));
const baseNow = async () => (await base.getBlockTime(await base.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000);
async function waitBaseTime(unix: number) {
  while ((await baseNow()) <= unix) await sleep(300);
}
const tapeOf = async (n: number) => decodeTape((await readAccount(LOCAL.base, pda.tape(T, n))).data!);

// ------------------------------------------------------------------ config
async function readConfig() {
  const b = (await readAccount(LOCAL.base, pda.config())).data!;
  return {
    house: new PublicKey(b.subarray(96, 128)), teeValidator: new PublicKey(b.subarray(128, 160)), vrfQueue: new PublicKey(b.subarray(160, 192)),
    beatSlots: new BN(b.readBigUInt64LE(8).toString()), hideSlots: new BN(b.readBigUInt64LE(16).toString()),
    callLamports: new BN(b.readBigUInt64LE(24).toString()), lotLamports: new BN(b.readBigUInt64LE(32).toString()),
    crankIntervalMs: b.readUInt32LE(40), crankIterations: b.readUInt32LE(44), tickCuLimit: b.readUInt32LE(48), actIntervalMs: b.readUInt32LE(52),
    hideSecs: b.readUInt32LE(56), tapeCloseSecs: b.readUInt32LE(60), bellMin: b[195], bellMax: b[196], algoMemory: b[197], tapeCloseBeat: b[198],
  };
}
async function setCallLamports(x: number) {
  const p = await readConfig();
  p.callLamports = new BN(x);
  must(await send(base, [await ix(progBase.methods.updateConfig(p).accountsPartial({ admin: house.publicKey, config: pda.config() }))], [house]), `update_config call=${x}`);
}

// ------------------------------------------------------------------ instructions
const createRecordIx = async (n: number, planned: number) =>
  ix(progBase.methods.createRecord(new BN(T), new BN(n), new BN(planned)).accountsPartial({ house: house.publicKey, config: pda.config(), ledger: pda.ledger(T), round: pda.round(T, n), tape: pda.tape(T, n) }));
const delegateRoundIx = async (n: number) =>
  ix(progBase.methods.delegate(KIND.round, new BN(T), new BN(n)).accountsPartial({ house: house.publicKey, config: pda.config(), pda: pda.round(T, n), validator: LOCAL.validator }));
const placeCall = async (bettor: Keypair, n: number, desk: number) => {
  const tape = pda.tape(T, n);
  return send(base, [await ix(programOn(base, bettor).methods.placeCall(desk).accountsPartial({ bettor: bettor.publicKey, config: pda.config(), tape, call: callPda(tape, bettor.publicKey) }))], [bettor]);
};
const settle = async (signer: Keypair, n: number) =>
  send(base, [await ix(programOn(base, signer).methods.settleRound().accountsPartial({ caller: signer.publicKey, round: pda.round(T, n), tape: pda.tape(T, n) }))], [signer]);
const claimIx = async (caller: Keypair, n: number, callOf: PublicKey, bettor: PublicKey) => {
  const tape = pda.tape(T, n);
  return ix(programOn(base, caller).methods.claimCall().accountsPartial({ caller: caller.publicKey, tape, call: callPda(tape, callOf), bettor }));
};
const claim = async (caller: Keypair, n: number, bettor: PublicKey, passAs = bettor) => send(base, [await claimIx(caller, n, bettor, passAs)], [caller]);
const closeRound = async (signer: Keypair, n: number) =>
  send(base, [await ix(programOn(base, signer).methods.closeRound().accountsPartial({ house: signer.publicKey, config: pda.config(), round: pda.round(T, n), tape: pda.tape(T, n) }))], [signer]);

async function fund(keys: PublicKey[], each: number) {
  for (let i = 0; i < keys.length; i += 10)
    must(await send(base, keys.slice(i, i + 10).map((k) => SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: k, lamports: each })), [house]), "fund");
}

/** floor(amount * total / pool[winner]) for winners, amount if void, else 0 (the program's formula). */
function expectedPayout(tp: ReturnType<typeof decodeTape>, desk: number, amount: bigint) {
  if (tp.void) return amount;
  if (desk !== tp.winner) return 0n;
  return (amount * tp.total) / tp.pool[tp.winner];
}

// ------------------------------------------------------------------ rollup side (pool, rounds)
let progEr: any, tH = "";
async function setupPool() {
  tH = await tokenFor(house);
  progEr = programOn(erConn(tH), house);
  must(await send(base, [await ix(progBase.methods.createPool(new BN(T), 0, new BN(50_000_000)).accountsPartial({ house: house.publicKey, config: pda.config(), table, book, ledger: pda.ledger(T) }))], [house]), "create_pool");
  for (let s = 0; s < NDESK; s += 4) {
    const ixs = [];
    for (let j = s; j < s + 4; j++) ixs.push(await ix(progBase.methods.createDesk(new BN(T), j).accountsPartial({ house: house.publicKey, config: pda.config(), table, desk: desks[j] })));
    must(await send(base, ixs, [house]), `create_desk ${s}`);
  }
  const targets: [number, number, PublicKey][] = [[KIND.table, 0, table], [KIND.book, 0, book], ...desks.map((d, s) => [KIND.desk, s, d] as [number, number, PublicKey])];
  for (const [kind, idx, acc] of targets) {
    must(await send(base, [await ix(progBase.methods.delegate(kind, new BN(T), new BN(idx)).accountsPartial({ house: house.publicKey, config: pda.config(), pda: acc, validator: LOCAL.validator }))], [house]), `delegate ${kind}/${idx}`);
    if ((await waitOwner(erUrl(tH), acc)) === null) throw new Error(`delegated account ${kind}/${idx} not visible on the rollup`);
  }
  await reseal(true);
  for (let s = 0; s < NDESK; s += 4) {
    const ixs = [];
    for (let j = s; j < s + 4; j++) {
      const name = Buffer.alloc(16); name.write(`bot${j}`);
      ixs.push(await ix(progEr.methods.joinBot(j, bots[j].publicKey, 2, Array.from(name)).accountsPartial({ house: house.publicKey, table, desk: desks[j], permission: pda.perm(desks[j]) })));
    }
    must(await send(erConn(tH), ixs, [house], { cu: 1_000_000 }), `join_bot ${s}`);
  }
}
async function reseal(withTable = false) {
  const items: [number, number, PublicKey | null][] = [...(withTable ? [[KIND.table, 0, null] as [number, number, null]] : []), [KIND.book, 0, book], ...desks.map((d, s) => [KIND.desk, s, d] as [number, number, PublicKey])];
  for (let i = 0; i < items.length; i += 3) {
    const ixs = await Promise.all(items.slice(i, i + 3).map(([k, s, t]) => ix(progEr.methods.setupPermissions(k, new BN(s)).accountsPartial({ house: house.publicKey, table, target: t, permission: pda.perm(t ?? table) }))));
    must(await send(erConn(tH), ixs, [house], { cu: 1_000_000 }), `setup_permissions ${i}`);
  }
}
const readTable = async () => decodeTable((await readAccount(erUrl(tH), table)).data!);
async function openRound(n: number) {
  const o = await ix(progEr.methods.openRound(new BN(n)).accountsPartial({ house: house.publicKey, table, book, ...deskAccs, round: pda.round(T, n), oracleQueue: LOCAL_ER_QUEUE }));
  for (let i = 0; i < 40; i++) {
    const r = await send(erConn(tH), [o], [house], { cu: 1_000_000 });
    if (r.ok) return;
    if (!/TooEarly|6010|0x177a/.test(JSON.stringify(r.err) + (r.logs ?? []).join())) must(r, `open_round ${n}`);
    await sleep(500);
  }
  throw new Error(`open_round ${n}: planned start never reached`);
}
async function playToReveal(n: number) {
  let tb = await readTable();
  for (let i = 0; i < 1200 && tb.phase !== PHASE.bell; i++) { await sleep(100); tb = await readTable(); }
  if (tb.phase !== PHASE.bell) throw new Error(`round ${n} never reached the bell (phase ${tb.phase}, beat ${tb.beat})`);
  must(await send(erConn(tH), [await ix(progEr.methods.reveal().accountsPartial({ caller: house.publicKey, table, book, round: pda.round(T, n) }))], [house], { cu: 400_000 }), `reveal ${n}`);
}
async function commitRound(n: number) {
  must(await send(erConn(tH), [await ix(progEr.methods.commitRound(new BN(n)).accountsPartial({ house: house.publicKey, table, round: pda.round(T, n), magicFeeVault: pda.feeVault() }))], [house]), `commit_round ${n}`);
  const ms = await waitOwner(LOCAL.base, pda.round(T, n), PROGRAM_ID, 30_000);
  if (ms === null) throw new Error(`round ${n} not back on base`);
  return ms;
}

/** Claims every call (house as the sweeper unless `by` says otherwise); returns per-bettor payout seen on chain. */
async function claimAll(n: number, bettors: { kp: Keypair; desk: number }[], tp: ReturnType<typeof decodeTape>) {
  const out: { desk: number; amount: bigint; expected: bigint; got: bigint }[] = [];
  for (const b of bettors) {
    const callAcc = await readAccount(LOCAL.base, callPda(pda.tape(T, n), b.kp.publicKey));
    if (!callAcc.data) continue; // already claimed by an earlier check
    const c = decodeCall(callAcc.data);
    const before = await lamports(b.kp.publicKey);
    must(await claim(house, n, b.kp.publicKey), `claim ${b.kp.publicKey.toBase58().slice(0, 6)}`);
    const delta = (await lamports(b.kp.publicKey)) - before - BigInt(callAcc.lamports!);
    out.push({ desk: c.desk, amount: c.amount, expected: expectedPayout(tp, c.desk, c.amount), got: delta });
  }
  return out;
}

// ------------------------------------------------------------------ main
async function main() {
  console.log(`table ${T}  program ${PROGRAM_ID.toBase58()}  house ${house.publicKey.toBase58()}`);
  if (!(await base.getAccountInfo(pda.config()))) {
    const params = {
      house: house.publicKey, teeValidator: LOCAL.validator, vrfQueue: PublicKey.default,
      beatSlots: new BN(10), hideSlots: new BN(20), callLamports: new BN(10_000_000), lotLamports: new BN(1_000_000),
      crankIntervalMs: 250, crankIterations: 400, tickCuLimit: 400_000, actIntervalMs: 250, hideSecs: 1, tapeCloseSecs: 15,
      bellMin: 4, bellMax: 29, algoMemory: 4, tapeCloseBeat: 10,
    };
    must(await send(base, [await ix(progBase.methods.initConfig(params).accountsPartial({ admin: house.publicKey, config: pda.config() }))], [house]), "init_config");
  }
  const cfg0 = await readConfig();
  const callA = 10_000_000, callB = 7_000_003;
  await setCallLamports(callA);
  const rentMin0 = BigInt(await base.getMinimumBalanceForRentExemption(0));
  console.log(`info  rent-exempt minimum of a 0-data account (runtime): ${rentMin0}`);
  await fund([stranger.publicKey], 1_000_000_000);
  await setupPool();

  // ================================================================ round 1: real round, 20 bettors on all 8 desks
  const lead = (await readConfig()).hideSecs + (await readConfig()).tapeCloseSecs;
  let planned = (await baseNow()) + 3;
  must(await send(base, [await createRecordIx(1, planned), await delegateRoundIx(1)], [house]), "create_record + delegate 1");
  const tp1a = await tapeOf(1);
  check("create_record: Tape.close_unix = planned + hide_secs + tape_close_secs", tp1a.closeUnix === planned + lead && tp1a.winner === 255 && tp1a.resolved === 0, { closeUnix: tp1a.closeUnix, planned, lead });
  const b1 = Array.from({ length: 20 }, (_, i) => ({ kp: Keypair.generate(), desk: i % NDESK }));
  await fund(b1.map((b) => b.kp.publicKey), 30_000_000);
  // first 10 calls at callA, the next 10 at callB (the amount is read from Config at call time)
  const p1 = await Promise.all(b1.slice(0, 10).map((b) => placeCall(b.kp, 1, b.desk)));
  await setCallLamports(callB);
  const p2 = await Promise.all(b1.slice(10).map((b) => placeCall(b.kp, 1, b.desk)));
  await setCallLamports(callA);
  check("20 calls placed on 8 desks before the close", [...p1, ...p2].every((r) => r.ok), { failed: [...p1, ...p2].filter((r) => !r.ok).map(errCode) });
  const dup = await placeCall(b1[0].kp, 1, 3);
  check("second call by the same bettor in one round rejected", !dup.ok, errCode(dup));
  const badDesk = await placeCall(stranger, 1, 8);
  check("call on desk 8 rejected", !badDesk.ok, errCode(badDesk));
  const tp1b = await tapeOf(1);
  const tapeLam1 = await lamports(pda.tape(T, 1));
  const tapeRent = BigInt(await base.getMinimumBalanceForRentExemption(160));
  check("Tape holds rent + every call; pools add up", tp1b.nCalls === 20 && tp1b.openCalls === 20 && tp1b.total === tp1b.pool.reduce((a, b) => a + b, 0n) && tp1b.total === 10n * BigInt(callA + callB) && tapeLam1 === tapeRent + tp1b.total,
    { pool: tp1b.pool, total: tp1b.total, tapeLamports: tapeLam1, tapeRent });

  const sCreated = await settle(stranger, 1);
  check("settle while the Round is delegated (CREATED, before open) rejected", !sCreated.ok, errCode(sCreated));
  const early = await claim(house, 1, b1[0].kp.publicKey);
  check("claim before settle rejected", !early.ok, errCode(early));
  await openRound(1);
  const sOpen = await settle(stranger, 1);
  check("settle on an OPEN round (still delegated) rejected", !sOpen.ok, errCode(sOpen));
  await playToReveal(1);
  const sRevealed = await settle(stranger, 1);
  check("settle after reveal but before commit rejected", !sRevealed.ok, errCode(sRevealed));
  const msBack = await commitRound(1);
  const r1 = decodeRound((await readAccount(LOCAL.base, pda.round(T, 1))).data!);
  const top1 = (await readAccount(LOCAL.base, pda.round(T, 1))).data![146];
  await waitBaseTime(tp1b.closeUnix);
  const lateKp = Keypair.generate();
  await fund([lateKp.publicKey], 30_000_000);
  const lateR = await placeCall(lateKp, 1, top1);
  check("call at/after Tape.close_unix rejected", !lateR.ok, errCode(lateR));
  const st1 = await settle(stranger, 1);
  const tp1 = await tapeOf(1);
  check("settle after commit (Round owned by the program, REVEALED) by a stranger", st1.ok && tp1.resolved === 1 && tp1.void === 0 && tp1.winner === top1 && r1.status === 2,
    { ok: st1.ok, err: st1.ok ? undefined : errCode(st1), msToBase: msBack, winner: tp1.winner, topDesk: top1, status: r1.status, poolOfWinner: tp1.pool[tp1.winner] });
  const st1b = await settle(house, 1);
  const tp1x = await tapeOf(1);
  check("settle is idempotent (second call ok, Tape unchanged)", st1b.ok && JSON.stringify(tp1x, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) === JSON.stringify(tp1, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), { ok: st1b.ok });
  const lam1 = await lamports(pda.tape(T, 1));
  check("settle moved no lamports", lam1 === tapeLam1, { before: tapeLam1, after: lam1 });

  const earlyClose = await closeRound(house, 1);
  check("close_round before every call is claimed rejected", !earlyClose.ok, errCode(earlyClose));
  const sClose = await closeRound(stranger, 1);
  check("close_round by a stranger rejected", !sClose.ok, errCode(sClose));

  // a winning bettor: a stranger tries to redirect, then claims for them (pays the bettor only)
  const win = b1.find((b) => b.desk === tp1.winner)!;
  const redirect = await claim(stranger, 1, win.kp.publicKey, stranger.publicKey);
  check("claim with the stranger as bettor for someone else's Call rejected", !redirect.ok, errCode(redirect));
  const sBefore = await lamports(stranger.publicKey), wBefore = await lamports(win.kp.publicKey);
  const winCall = await readAccount(LOCAL.base, callPda(pda.tape(T, 1), win.kp.publicKey));
  const forOther = await claim(stranger, 1, win.kp.publicKey);
  const wGot = (await lamports(win.kp.publicKey)) - wBefore - BigInt(winCall.lamports!);
  const sDelta = (await lamports(stranger.publicKey)) - sBefore;
  const wExp = expectedPayout(tp1, win.desk, decodeCall(winCall.data!).amount);
  check("a stranger's claim pays the bettor, not the stranger", forOther.ok && wGot === wExp && sDelta <= 0n, { paidToBettor: wGot, expected: wExp, strangerDelta: sDelta });
  const again = await claim(stranger, 1, win.kp.publicKey);
  const wAfter2 = await lamports(win.kp.publicKey);
  check("double claim fails and pays nothing more", !again.ok && wAfter2 === wBefore + wGot + BigInt(winCall.lamports!), { err: errCode(again), balance: wAfter2 });

  const rest = await claimAll(1, b1, tp1);
  const all = [{ desk: win.desk, amount: decodeCall(winCall.data!).amount, expected: wExp, got: wGot }, ...rest];
  const sumPaid = all.reduce((a, x) => a + x.got, 0n);
  const winners = all.filter((x) => x.desk === tp1.winner);
  const tpEnd = await tapeOf(1);
  const dust = tp1.total - sumPaid;
  const tapeLeft = await lamports(pda.tape(T, 1));
  check("parimutuel: every claim = floor(amount*total/pool[winner]), losers 0", all.every((x) => x.got === x.expected) && all.length === 20,
    { winner: tp1.winner, winners: winners.map((w) => `${w.amount}->${w.got}`), losers: all.length - winners.length });
  check("sum of claims + floor remainder = pool; remainder < winning calls; remainder left in the Tape", tpEnd.paid === sumPaid && dust >= 0n && dust < BigInt(winners.length) && tapeLeft === tapeRent + dust && tpEnd.openCalls === 0,
    { total: tp1.total, sumClaims: sumPaid, remainder: dust, tapePaid: tpEnd.paid, tapeLamports: tapeLeft, tapeRent });
  const hBefore = await lamports(house.publicKey);
  const roundLam = await lamports(pda.round(T, 1));
  const cl1 = await closeRound(house, 1);
  const hDelta = (await lamports(house.publicKey)) - hBefore;
  check("close_round after all claims: Round + Tape rent and the remainder go to the house", cl1.ok && hDelta === tapeLeft + roundLam - 5000n && !(await base.getAccountInfo(pda.tape(T, 1))) && !(await base.getAccountInfo(pda.round(T, 1))),
    { ok: cl1.ok, err: cl1.ok ? undefined : errCode(cl1), houseDelta: hDelta, tapeLamports: tapeLeft, roundLamports: roundLam });
  const reRec = await send(base, [await createRecordIx(1, planned)], [house]);
  check("a closed (table, round) cannot be recreated", !reRec.ok, errCode(reRec));

  // ================================================================ rounds 2..: nobody called the Top Desk -> refunds
  let n = 2, refundDone = false, lastTop = top1;
  for (; n <= 5 && !refundDone; n++) {
    await reseal();
    planned = (await baseNow()) + 3;
    must(await send(base, [await createRecordIx(n, planned), await delegateRoundIx(n)], [house]), `create_record + delegate ${n}`);
    const desk = (lastTop + 1) % NDESK;
    const bs = Array.from({ length: 3 }, () => ({ kp: Keypair.generate(), desk }));
    await fund(bs.map((b) => b.kp.publicKey), 30_000_000);
    const pr = await Promise.all(bs.map((b) => placeCall(b.kp, n, b.desk)));
    if (!pr.every((r) => r.ok)) throw new Error(`round ${n} calls failed: ${pr.map(errCode)}`);
    await openRound(n);
    await playToReveal(n);
    await commitRound(n);
    const top = (await readAccount(LOCAL.base, pda.round(T, n))).data![146];
    const tpc = await tapeOf(n);
    await waitBaseTime(tpc.closeUnix);
    must(await settle(stranger, n), `settle ${n}`);
    const tp = await tapeOf(n);
    lastTop = top;
    if (top === desk) {
      console.log(`info  round ${n}: Top Desk ${top} was the called desk; trying another round`);
      await claimAll(n, bs, tp);
      must(await closeRound(house, n), `close ${n}`);
      continue;
    }
    const got = await claimAll(n, bs, tp);
    check("nobody called the Top Desk: Tape void, every call refunded exactly", tp.void === 1 && tp.winner === top && got.length === 3 && got.every((x) => x.got === x.amount),
      { round: n, topDesk: top, calledDesk: desk, void: tp.void, refunds: got.map((x) => x.got) });
    must(await closeRound(house, n), `close ${n}`);
    refundDone = true;
  }
  if (!refundDone) check("nobody called the Top Desk: refund path reached", false, "Top Desk equalled the called desk in every attempt");

  // ================================================================ aborted round -> void
  await reseal();
  const na = n;
  planned = (await baseNow()) + 3;
  must(await send(base, [await createRecordIx(na, planned), await delegateRoundIx(na)], [house]), `create_record + delegate ${na}`);
  const ba = [0, 5].map((desk) => ({ kp: Keypair.generate(), desk }));
  await fund(ba.map((b) => b.kp.publicKey), 30_000_000);
  if (!(await Promise.all(ba.map((b) => placeCall(b.kp, na, b.desk)))).every((r) => r.ok)) throw new Error("abort round calls failed");
  await openRound(na);
  await sleep(1500);
  must(await send(erConn(tH), [await ix(progEr.methods.abortRound().accountsPartial({ house: house.publicKey, table, book, round: pda.round(T, na) }))], [house]), "abort_round");
  await commitRound(na);
  const ra = decodeRound((await readAccount(LOCAL.base, pda.round(T, na))).data!);
  const sta = await settle(stranger, na);
  const tpa = await tapeOf(na);
  const gotA = await claimAll(na, ba, tpa);
  check("aborted round: settle (no wait for the close) makes the Tape void, every call refunded", ra.status === 3 && sta.ok && tpa.void === 1 && gotA.every((x) => x.got === x.amount) && gotA.length === 2,
    { status: ra.status, settleOk: sta.ok, void: tpa.void, refunds: gotA.map((x) => x.got) });
  check("close_round of the aborted round after its refunds", (await closeRound(house, na)).ok, "");

  // ================================================================ record never played + sub-minimum payout to a 0-lamport bettor
  const ns = 100;
  const small = 100_000;
  await setCallLamports(small);
  planned = (await baseNow()) - lead + 6; // calls close ~6 s from now; never opened, never delegated
  must(await send(base, [await createRecordIx(ns, planned)], [house]), "create_record 100");
  const poor = Keypair.generate();
  const callRent = BigInt(await base.getMinimumBalanceForRentExemption(112));
  await fund([poor.publicKey], Number(BigInt(small) + callRent + 5000n + 1_000_000n));
  must(await placeCall(poor, ns, 2), "place_call (sub-minimum bettor)");
  // empty the bettor: its whole remaining balance goes back to the house (house pays the fee)
  const left = await lamports(poor.publicKey);
  must(await send(base, [SystemProgram.transfer({ fromPubkey: poor.publicKey, toPubkey: house.publicKey, lamports: Number(left) })], [house, poor]), "drain bettor");
  await setCallLamports(cfg0.callLamports.toNumber());
  const tooEarly = await settle(stranger, ns);
  check("settle of a never-played record before its close rejected", !tooEarly.ok, errCode(tooEarly));
  await waitBaseTime((await tapeOf(ns)).closeUnix);
  const stS = await settle(stranger, ns);
  const tps = await tapeOf(ns);
  check("settle of a never-played (CREATED) record after the close: void", stS.ok && tps.void === 1 && tps.resolved === 1, { ok: stS.ok, void: tps.void });
  const poor0 = await lamports(poor.publicKey);
  const owe = await claim(house, ns, poor.publicKey);
  const cOwed = await readAccount(LOCAL.base, callPda(pda.tape(T, ns), poor.publicKey));
  const owedCall = cOwed.data ? decodeCall(cOwed.data) : null;
  const tpo = await tapeOf(ns);
  check("payout below the runtime rent minimum to a 0-lamport bettor: tx succeeds, amount stays owed, nothing sent",
    owe.ok && poor0 === 0n && (await lamports(poor.publicKey)) === 0n && owedCall?.owed === BigInt(small) && owedCall?.claimed === 0 && tpo.paid === 0n && tpo.openCalls === 1,
    { ok: owe.ok, err: owe.ok ? undefined : errCode(owe), payout: small, rentMin: rentMin0, bettorBalance: poor0, owed: owedCall?.owed, tapePaid: tpo.paid });
  const earlyClose2 = await closeRound(house, ns);
  check("close_round while a call is owed rejected", !earlyClose2.ok, errCode(earlyClose2));
  await fund([poor.publicKey], 1_000_000_000);
  const pBefore = await lamports(poor.publicKey);
  const paid = await claim(house, ns, poor.publicKey);
  const pDelta = (await lamports(poor.publicKey)) - pBefore;
  check("once the bettor holds SOL the owed amount is claimed (plus the Call rent back)", paid.ok && pDelta === BigInt(small) + BigInt(cOwed.lamports!) && !(await base.getAccountInfo(callPda(pda.tape(T, ns), poor.publicKey))),
    { ok: paid.ok, received: pDelta, owed: small, callRent: cOwed.lamports });
  check("close_round of the never-played record", (await closeRound(house, ns)).ok, "");

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
