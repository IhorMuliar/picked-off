// Program skeleton checks on the local MagicBlock stack.
//   make local-stack            (own terminal; loads target/deploy/ping.so)
//   make local-fund
//   npx tsx tests/local/a1-check.ts     (or: make local-check-a1)
// Prints one PASS/FAIL line per check and exits non-zero if any check fails.
//  1. sealed / re-sealed Book and Desk: null to a stranger, data to the desk's member
//  2. a Round record commits + undelegates alone (small diff; the full-size commit is a devnet check)
//  3. ScheduleCrankCpi at 250 ms from open_round, CancelCrankCpi from reveal / abort_round
//  4. permission create vs update (update path after create; permission accounts hold 0 lamports)
//  +  negative cases: stranger calls, wrong validator, committing a Round in play
import { SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import {
  LOCAL, PROGRAM_ID, KIND, PHASE, NDESK, BN, pda, sleep, loadKeypair, tokenFor, erUrl, erConn, readAccount, programOn, send,
  waitOwner, diffBytes, loadIdl, decodeTable, decodeDesk, decodeRound, predictableTaskId, Keypair, PublicKey, Connection, type SendResult,
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
const errCode = (r: SendResult) => (r.ok ? "ok" : JSON.stringify(r.err).slice(0, 80) + " " + ((r.logs ?? []).find((l) => /Error Code|failed:/.test(l)) ?? "").slice(0, 120));

// the local oracle queue account exists on the local rollup; VRF itself is disabled in the local Config
const LOCAL_ER_QUEUE = new PublicKey("Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT");
const house = loadKeypair(LOCAL.wallet);
const stranger = Keypair.generate();
const bots = Array.from({ length: NDESK }, () => Keypair.generate());
const base = new Connection(LOCAL.base, "confirmed");
const progBase = programOn(base, house);
const ix = (m: any) => m.instruction();
const T = Number(process.env.TABLE_ID ?? Math.floor(Date.now() / 1000));

async function main() {
  console.log(`table ${T}  program ${PROGRAM_ID.toBase58()}  house ${house.publicKey.toBase58()}`);
  const tH = await tokenFor(house);
  const tS = await tokenFor(stranger);
  const tB0 = await tokenFor(bots[0]);
  const er = erConn(tH);
  const progEr = programOn(er, house);
  const erS = erConn(tS);
  const progErS = programOn(erS, stranger);

  // ---------------------------------------------------------------- version on both layers
  for (const [name, conn] of [["base", base], ["rollup", er]] as const) {
    const sim = await (programOn(conn, house).methods.version().accountsPartial({ caller: house.publicKey }).simulate().catch((e: any) => ({ err: e })));
    const ret = sim?.raw?.find?.((l: string) => l.startsWith("Program return:")) ?? "";
    check(`version simulated on ${name}`, /AQAAAA==/.test(ret), ret || sim?.err?.message || "no return data");
  }

  // ---------------------------------------------------------------- config (local parameters)
  if (!(await base.getAccountInfo(pda.config()))) {
    const params = {
      house: house.publicKey, teeValidator: LOCAL.validator, vrfQueue: PublicKey.default,
      beatSlots: new BN(10), hideSlots: new BN(20), callLamports: new BN(10_000_000), lotLamports: new BN(1_000_000),
      crankIntervalMs: 250, crankIterations: 400, tickCuLimit: 400_000, actIntervalMs: 250, hideSecs: 1, tapeCloseSecs: 15,
      bellMin: 4, bellMax: 29, algoMemory: 4, tapeCloseBeat: 10,
    };
    must(await send(base, [await ix(progBase.methods.initConfig(params).accountsPartial({ admin: house.publicKey, config: pda.config() }))], [house]), "init_config");
  }

  // ---------------------------------------------------------------- pool on base + delegation
  const table = pda.table(T), book = pda.book(T), desks = Array.from({ length: NDESK }, (_, s) => pda.desk(T, s));
  const strangerFund = await send(base, [SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: stranger.publicKey, lamports: 1_000_000_000 })], [house]);
  must(strangerFund, "fund stranger");
  const sPool = await send(base, [await ix(programOn(base, stranger).methods.createPool(new BN(T + 1), 0, new BN(0)).accountsPartial({ house: stranger.publicKey, config: pda.config(), table: pda.table(T + 1), book: pda.book(T + 1), ledger: pda.ledger(T + 1) }))], [stranger]);
  check("stranger create_pool rejected", !sPool.ok, errCode(sPool));
  must(await send(base, [await ix(progBase.methods.createPool(new BN(T), 0, new BN(50_000_000)).accountsPartial({ house: house.publicKey, config: pda.config(), table, book, ledger: pda.ledger(T) }))], [house]), "create_pool");
  for (let s = 0; s < NDESK; s += 4) {
    const ixs = [];
    for (let j = s; j < s + 4; j++) ixs.push(await ix(progBase.methods.createDesk(new BN(T), j).accountsPartial({ house: house.publicKey, config: pda.config(), table, desk: desks[j] })));
    must(await send(base, ixs, [house]), `create_desk ${s}..${s + 3}`);
  }
  const wrongVal = await send(base, [await ix(progBase.methods.delegate(KIND.desk, new BN(T), new BN(0)).accountsPartial({ house: house.publicKey, config: pda.config(), pda: desks[0], validator: Keypair.generate().publicKey }))], [house]);
  check("delegate to a non-pinned validator rejected", !wrongVal.ok, errCode(wrongVal));
  const sDel = await send(base, [await ix(programOn(base, stranger).methods.delegate(KIND.desk, new BN(T), new BN(0)).accountsPartial({ house: stranger.publicKey, config: pda.config(), pda: desks[0], validator: LOCAL.validator }))], [stranger]);
  check("stranger delegate rejected", !sDel.ok, errCode(sDel));
  const targets: [number, number, PublicKey][] = [[KIND.table, 0, table], [KIND.book, 0, book], ...desks.map((d, s) => [KIND.desk, s, d] as [number, number, PublicKey])];
  const usable: number[] = [];
  for (const [kind, idx, acc] of targets) {
    must(await send(base, [await ix(progBase.methods.delegate(kind, new BN(T), new BN(idx)).accountsPartial({ house: house.publicKey, config: pda.config(), pda: acc, validator: LOCAL.validator }))], [house]), `delegate ${kind}/${idx}`);
    const ms = await waitOwner(erUrl(tH), acc);
    usable.push(ms ?? -1);
  }
  check("10 pool accounts delegated and visible on the rollup", usable.every((x) => x >= 0), { msAfterConfirm: usable });

  // ---------------------------------------------------------------- permissions: create path, then update path
  const before = await readAccount(erUrl(tS), desks[0]);
  console.log(`info  desk 0 before any permission, stranger read: ${before.data ? "data" : "null"}`);
  const sSetup = await send(er, [await ix(progErS.methods.setupPermissions(KIND.book, new BN(0)).accountsPartial({ house: stranger.publicKey, table, target: book, permission: pda.perm(book) }))], [stranger]);
  check("stranger setup_permissions rejected", !sSetup.ok, errCode(sSetup));
  const permIx = async (kind: number, idx: number, target: PublicKey | null) =>
    ix(progEr.methods.setupPermissions(kind, new BN(idx)).accountsPartial({ house: house.publicKey, table, target, permission: pda.perm(target ?? table) }));
  const setupItems: [number, number, PublicKey | null][] = [[KIND.table, 0, null], [KIND.book, 0, book], ...desks.map((d, s) => [KIND.desk, s, d] as [number, number, PublicKey])];
  for (let i = 0; i < setupItems.length; i += 3) {
    const r = must(await send(er, await Promise.all(setupItems.slice(i, i + 3).map(([k, s, t]) => permIx(k, s, t))), [house], { cu: 1_000_000 }), `setup_permissions ${i}`);
    console.log(`info  setup_permissions batch ${i / 3} (create path): ${r.cu} CU`);
  }
  const permBook = await readAccount(erUrl(tH), pda.perm(book));
  console.log(`info  Book permission account on the rollup: owner ${permBook.owner}, lamports ${permBook.lamports}, ${permBook.data?.length} bytes`);
  // seat the bots: each join_bot updates an existing Desk permission
  for (let s = 0; s < NDESK; s += 4) {
    const ixs = [];
    for (let j = s; j < s + 4; j++) {
      const name = Buffer.alloc(16); name.write(`bot${j}`);
      ixs.push(await ix(progEr.methods.joinBot(j, bots[j].publicKey, 2, Array.from(name)).accountsPartial({ house: house.publicKey, table, desk: desks[j], permission: pda.perm(desks[j]) })));
    }
    must(await send(er, ixs, [house], { cu: 1_000_000 }), `join_bot ${s}..${s + 3}`);
  }
  const upd = await send(er, [await permIx(KIND.book, 0, book), await permIx(KIND.desk, 0, desks[0])], [house], { cu: 1_000_000 });
  check("permission update path works after create (data/owner test, permission accounts hold 0 lamports)", upd.ok && permBook.lamports === 0, { updateOk: upd.ok, permissionLamports: permBook.lamports, updateCu: upd.cu, err: upd.ok ? undefined : errCode(upd) });

  const privacy = async (label: string, expectPublic: boolean) => {
    const sBook = await readAccount(erUrl(tS), book);
    const sDesk = await readAccount(erUrl(tS), desks[0]);
    const anonDesk = await readAccount(erUrl(), desks[0]);
    const mDesk = await readAccount(erUrl(tB0), desks[0]);
    const mOther = await readAccount(erUrl(tB0), desks[1]);
    const got = { strangerBook: !!sBook.data, strangerDesk0: !!sDesk.data, anonDesk0: !!anonDesk.data, memberDesk0: !!mDesk.data, memberDesk1: !!mOther.data };
    const ok = expectPublic
      ? got.strangerBook && got.strangerDesk0 && got.memberDesk0
      : !got.strangerBook && !got.strangerDesk0 && !got.anonDesk0 && got.memberDesk0 && !got.memberDesk1;
    check(label, ok, got);
    return mDesk.data ? decodeDesk(mDesk.data) : null;
  };
  await privacy("sealed after setup: Book/Desk 0 null to stranger and anon, Desk 0 data to its member, Desk 1 null to it", false);

  // ---------------------------------------------------------------- round 1, recorded
  const round1 = pda.round(T, 1);
  must(await send(base, [
    await ix(progBase.methods.createRecord(new BN(T), new BN(1), new BN(Math.floor(Date.now() / 1000) - 5)).accountsPartial({ house: house.publicKey, config: pda.config(), ledger: pda.ledger(T), round: round1, tape: pda.tape(T, 1) })),
    await ix(progBase.methods.delegate(KIND.round, new BN(T), new BN(1)).accountsPartial({ house: house.publicKey, config: pda.config(), pda: round1, validator: LOCAL.validator })),
  ], [house]), "create_record + delegate round 1");
  const roundBase0 = (await readAccount(LOCAL.base, round1)).data!;
  check("Round record visible on the rollup after create+delegate", (await waitOwner(erUrl(tH), round1)) !== null, "");
  const dupRec = await send(base, [await ix(progBase.methods.createRecord(new BN(T), new BN(1), new BN(0)).accountsPartial({ house: house.publicKey, config: pda.config(), ledger: pda.ledger(T), round: round1, tape: pda.tape(T, 1) }))], [house]);
  check("second create_record for the same round rejected", !dupRec.ok, errCode(dupRec));

  const openIx = async (prog: any, signer: PublicKey, n: number, round: PublicKey | null) =>
    ix(prog.methods.openRound(new BN(n)).accountsPartial({ house: signer, table, book, desk0: desks[0], desk1: desks[1], desk2: desks[2], desk3: desks[3], desk4: desks[4], desk5: desks[5], desk6: desks[6], desk7: desks[7], round, oracleQueue: LOCAL_ER_QUEUE }));
  const sOpen = await send(er, [await openIx(progErS, stranger.publicKey, 1, round1)], [stranger], { cu: 1_000_000 });
  check("stranger open_round rejected", !sOpen.ok, errCode(sOpen));
  const open1 = must(await send(er, [await openIx(progEr, house.publicKey, 1, round1)], [house], { cu: 1_000_000 }), "open_round 1");
  const t1 = decodeTable((await readAccount(erUrl(tH), table)).data!);
  check("open_round 1: phase HIDE, task id from the slot hash", t1.phase === PHASE.hide && t1.round === 1 && t1.taskId !== 0n && t1.taskId !== predictableTaskId(T, 1) && t1.recorded === 1,
    { phase: t1.phase, round: t1.round, taskId: t1.taskId, predictable: predictableTaskId(T, 1), cu: open1.cu });
  const inPlay = await send(er, [await ix(progEr.methods.commitRound(new BN(1)).accountsPartial({ house: house.publicKey, table, round: round1, magicFeeVault: pda.feeVault() }))], [house]);
  check("commit_round of a Round in play rejected", !inPlay.ok, errCode(inPlay));
  const sCommit = await send(er, [await ix(progErS.methods.commitRound(new BN(1)).accountsPartial({ house: stranger.publicKey, table, round: round1, magicFeeVault: pda.feeVault() }))], [stranger]);
  check("stranger commit_round rejected", !sCommit.ok, errCode(sCommit));

  // crank rate
  const c0 = decodeTable((await readAccount(erUrl(tH), table)).data!);
  const w0 = performance.now();
  await sleep(2000);
  const c1 = decodeTable((await readAccount(erUrl(tH), table)).data!);
  const rate = (c1.tickCalls - c0.tickCalls) / ((performance.now() - w0) / 1000);
  check("ScheduleCrankCpi crank runs tick at ~250 ms", rate >= 3 && rate <= 5, { ticksPerSecond: Number(rate.toFixed(2)), tickCalls: c1.tickCalls, resolves: c1.resolves, beat: c1.beat, phase: c1.phase });
  await privacy("mid-round: Book/Desk 0 null to stranger and anon, Desk 0 data to its member, Desk 1 null to it", false);

  // the engine rings the bell after live beat 20..29; reveal cancels the crank
  let tb = c1;
  for (let i = 0; i < 1200 && tb.phase !== PHASE.bell; i++) { await sleep(100); tb = decodeTable((await readAccount(erUrl(tH), table)).data!); }
  check("crank resolved the round to the bell (one deadline per beat)", tb.phase === PHASE.bell && tb.beat >= 20 && tb.beat <= 29 && tb.resolves === tb.beat + 1,
    { beat: tb.beat, resolves: tb.resolves, tickCalls: tb.tickCalls });
  const revealIx = await ix(progEr.methods.reveal().accountsPartial({ caller: house.publicKey, table, book, round: round1 }));
  const rev = must(await send(er, [revealIx], [house], { cu: 400_000 }), "reveal 1");
  const tr0 = decodeTable((await readAccount(erUrl(tH), table)).data!);
  await sleep(2000);
  const tr1 = decodeTable((await readAccount(erUrl(tH), table)).data!);
  check("CancelCrankCpi in reveal: 0 ticks after the cancel", tr1.tickCalls === tr0.tickCalls && tr0.phase === PHASE.revealed, { tickCallsAtReveal: tr0.tickCalls, after2s: tr1.tickCalls, revealCu: rev.cu });

  // compute units of the round's crank ticks, read from the raw local rollup (no privacy filter; local only)
  {
    const raw = process.env.ER_RAW ?? "http://127.0.0.1:7799";
    const call = async (method: string, params: unknown[]) =>
      ((await (await fetch(raw, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as any).result;
    const tickDisc = Buffer.from(loadIdl().instructions.find((i: any) => i.name === "tick").discriminator);
    const sigs: any[] = (await call("getSignaturesForAddress", [table.toBase58(), { limit: 500 }])) ?? [];
    const ticks: { slot: number; cu: number; logs: number }[] = [];
    for (const x of sigs) {
      if (x.slot < t1.openSlot || x.slot > tr0.revealSlot) continue;
      const tx = await call("getTransaction", [x.signature, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
      const logs: string[] = tx?.meta?.logMessages ?? [];
      const msg = tx?.transaction?.message;
      const keys: string[] = msg?.accountKeys ?? [];
      // scheduled ticks run as a top-level Crank program instruction that invokes tick; fallback ticks are top-level
      const viaCrank = logs.some((l) => l.startsWith("Program Crank11111111111111111111111111111111111111 invoke [1]"));
      const direct = (msg?.instructions ?? []).some((i: any) => keys[i.programIdIndex] === PROGRAM_ID.toBase58() && Buffer.from(bs58.decode(i.data)).subarray(0, 8).equals(tickDisc));
      if (!viaCrank && !direct) continue;
      const m = logs.map((l) => l.match(new RegExp(`^Program ${PROGRAM_ID.toBase58()} consumed (\\d+) of`))).find(Boolean);
      ticks.push({ slot: x.slot, cu: Number(m?.[1] ?? -1), logs: logs.filter((l) => l.startsWith("Program log:") || l.startsWith("Program data:")).length });
    }
    ticks.sort((p, q) => p.slot - q.slot);
    const resolving = ticks.filter((k) => k.cu > 50_000);
    const label = resolving.map((k, i) => `${i === 0 ? "hide-end" : i === resolving.length - 1 ? "bell" : "live"}:${k.cu}`);
    const hist = (xs: number[]) => xs.reduce((h: Record<string, number>, c) => ((h[c] = (h[c] ?? 0) + 1), h), {});
    console.log(`info  crank ticks ${ticks.length}: resolving ${JSON.stringify(hist(resolving.map((k) => k.cu)))}, no-op ${JSON.stringify(hist(ticks.filter((k) => k.cu <= 50_000).map((k) => k.cu)))}`);
    console.log(`info  resolving ticks in order: ${label.join(" ")}`);
    check("resolving tick under 300k CU, ticks print no program logs", resolving.length > 0 && Math.max(...resolving.map((k) => k.cu)) < 300_000 && ticks.every((k) => k.logs === 0),
      { resolving: resolving.length, maxCu: Math.max(...resolving.map((k) => k.cu)), programLogLines: ticks.reduce((a, k) => a + k.logs, 0) });
  }

  // unseal (public), then re-seal
  const unsealIx = async (kind: number, idx: number, target: PublicKey) => ix(progEr.methods.unseal(kind, new BN(idx)).accountsPartial({ house: house.publicKey, table, target, permission: pda.perm(target) }));
  const pubItems: [number, number, PublicKey][] = [[KIND.book, 0, book], ...desks.map((d, s) => [KIND.desk, s, d] as [number, number, PublicKey])];
  for (let i = 0; i < pubItems.length; i += 3) must(await send(er, await Promise.all(pubItems.slice(i, i + 3).map(([k, s, t]) => unsealIx(k, s, t))), [house], { cu: 1_000_000 }), `unseal ${i}`);
  await privacy("after unseal: Book and Desk 0 readable by a stranger", true);

  // commit + undelegate the Round alone
  const com = must(await send(er, [await ix(progEr.methods.commitRound(new BN(1)).accountsPartial({ house: house.publicKey, table, round: round1, magicFeeVault: pda.feeVault() }))], [house]), "commit_round 1");
  const backMs = await waitOwner(LOCAL.base, round1, PROGRAM_ID, 30_000);
  const roundBase1 = (await readAccount(LOCAL.base, round1)).data;
  const rb = roundBase1 ? decodeRound(roundBase1) : null;
  const changed = roundBase1 ? diffBytes(roundBase0, roundBase1) : null;
  check("Round committed + undelegated alone, owned by the program on base", backMs !== null && rb?.status === 2 && changed !== null && changed <= 640,
    { msToBase: backMs, status: rb?.status, changedBytes: changed, size: roundBase1?.length });
  if (roundBase1) {
    // replay the committed record with the TypeScript engine and check the commit hash (path computed: app/ is its own TS project)
    const corePath = new URL("../../app/src/core/index.ts", import.meta.url).href;
    const core: any = await import(corePath);
    const record = roundBase1.subarray(160, 160 + 522);
    const commit = roundBase1.subarray(96, 128);
    const v = core.verify(new Uint8Array(record), new Uint8Array(commit));
    const totals = Array.from({ length: NDESK }, (_, s) => roundBase1.readUInt16LE(128 + 2 * s));
    check("committed record replays to its commit hash and totals (TS engine)", v.ok && JSON.stringify(v.verdict.totals) === JSON.stringify(totals) && v.verdict.topDesk === roundBase1[146],
      { ok: v.ok, error: v.ok ? undefined : v.error, totals, replayTotals: v.ok ? v.verdict.totals : null, topDesk: roundBase1[146], sum: totals.reduce((a, b) => a + b, 0) });
  }

  // re-seal for round 2
  for (let i = 0; i < pubItems.length; i += 3) must(await send(er, await Promise.all(pubItems.slice(i, i + 3).map(([k, s, t]) => permIx(k, s, t))), [house], { cu: 1_000_000 }), `re-seal ${i}`);
  const sOpenEarly = decodeTable((await readAccount(erUrl(tH), table)).data!);
  check("re-seal sets all sealed bits", sOpenEarly.sealed === 0x1ff, { sealed: sOpenEarly.sealed.toString(16) });
  await privacy("re-sealed: Book/Desk 0 null to stranger and anon again, Desk 0 data to its member, Desk 1 null to it", false);

  // ---------------------------------------------------------------- round 2, unrecorded: reset, harmless ticks, abort cancels
  must(await send(er, [await openIx(progEr, house.publicKey, 2, null)], [house], { cu: 1_000_000 }), "open_round 2");
  const t2 = decodeTable((await readAccount(erUrl(tH), table)).data!);
  const d0 = decodeDesk((await readAccount(erUrl(tB0), desks[0])).data!);
  check("open_round 2 resets Desks and uses a fresh task id", t2.round === 2 && t2.phase === PHASE.hide && d0.round === 2 && d0.resting === 100 && d0.phase === PHASE.hide && t2.taskId !== t1.taskId && t2.recorded === 0,
    { taskId1: t1.taskId, taskId2: t2.taskId, desk0: d0 });
  const tickIx = await ix(progEr.methods.tick().accountsPartial({ table, book, desk0: desks[0], desk1: desks[1], desk2: desks[2], desk3: desks[3], desk4: desks[4], desk5: desks[5], desk6: desks[6], desk7: desks[7] }));
  const early = await send(erS, [tickIx, tickIx, tickIx, tickIx, tickIx], [stranger]);
  const t2b = decodeTable((await readAccount(erUrl(tH), table)).data!);
  check("5 early ticks from a stranger in one tx: no deadline resolved, no error", early.ok && t2b.resolves === 0 && t2b.phase === PHASE.hide, { ok: early.ok, resolves: t2b.resolves, err: early.ok ? undefined : errCode(early) });
  const sAbort = await send(er, [await ix(progErS.methods.abortRound().accountsPartial({ house: stranger.publicKey, table, book, round: null }))], [stranger]);
  check("stranger abort_round rejected", !sAbort.ok, errCode(sAbort));
  must(await send(er, [await ix(progEr.methods.abortRound().accountsPartial({ house: house.publicKey, table, book, round: null }))], [house]), "abort_round 2");
  const ta0 = decodeTable((await readAccount(erUrl(tH), table)).data!);
  await sleep(1500);
  const ta1 = decodeTable((await readAccount(erUrl(tH), table)).data!);
  check("CancelCrankCpi in abort_round: 0 ticks after the cancel", ta0.phase === PHASE.aborted && ta1.tickCalls === ta0.tickCalls, { tickCallsAtAbort: ta0.tickCalls, after: ta1.tickCalls });
  await privacy("aborted round stays sealed", false);

  // ---------------------------------------------------------------- summary
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
