// Base-layer records of one pool: drives every recorded round from "revealed on the rollup" to
// "closed on base": commit_round (the Round alone) → wait until it is owned by the program on base →
// settle_round → claim sweep → close_round. Everything is re-derived from chain state on each pass,
// so a restart resumes wherever each record stands.
import { Chain, PublicKey, decodeCall, decodeRound, decodeTape, errText, BN, ROUND_STATUS, NDESK, SystemProgram, loadOrCreateKeypair, type TapeView } from "./chain.ts";
import { log } from "./log.ts";
import path from "node:path";
import base58 from "bs58";

interface Rec {
  n: number;
  createSig?: string;
  commitSig?: string;
  commitAttempts: number;
  commitAt: number;
  backMs?: number;
  settleSig?: string;
  claims: number;
  claimAttemptAt: Map<string, number>;
  stranded: boolean;
  testCall?: string;
}

const OWED_RETRY_MS = 30 * 60_000;
const TAPE_REFUND_AFTER_S = 30 * 60;
const TAPE_CLOSE_AFTER_S = 24 * 3600;

export class Records {
  private recs = new Map<number, Rec>();
  private busy = false;
  private callDisc: Buffer;
  stranded = 0;
  committed = 0;
  closed = 0;
  failedCommits = 0;
  lastRecordAt = 0;
  private tester: ReturnType<typeof loadOrCreateKeypair> | null = null;

  constructor(private chain: Chain, private t: number, private currentRound: () => number, private keysDir: string) {
    this.callDisc = Buffer.from(chain.idl.accounts.find((a: any) => a.name === "Call").discriminator);
    if (chain.cfg.testCalls) this.tester = loadOrCreateKeypair(path.join(keysDir, `tape-tester.json`));
  }

  get outstanding() { return [...this.recs.keys()].sort((a, b) => a - b); }
  has(n: number) { return this.recs.has(n); }
  createSig(n: number) { return this.recs.get(n)?.createSig; }
  track(n: number, createSig?: string) {
    if (!this.recs.has(n)) this.recs.set(n, { n, createSig, commitAttempts: 0, commitAt: 0, claims: 0, claimAttemptAt: new Map(), stranded: false });
  }

  /** Finds every record of this table that is not closed yet: recent ones by PDA, older undelegated ones by program scan. */
  async discover() {
    const ledger = await this.chain.baseRead.account(this.chain.pda.ledger(this.t));
    if (!ledger.data) return;
    const last = Number(ledger.data.readBigUInt64LE(16));
    const from = Math.max(1, last - 300);
    const ns = Array.from({ length: last - from + 2 }, (_, i) => from + i);
    const accs = await this.chain.baseRead.accounts(ns.map((n) => this.chain.pda.round(this.t, n)));
    accs.forEach((a, i) => { if (a.data) this.track(ns[i]); });
    const roundDisc = Buffer.from(this.chain.idl.accounts.find((a: any) => a.name === "Round").discriminator);
    const le = Buffer.alloc(8); le.writeBigUInt64LE(BigInt(this.t));
    const old = await this.chain.baseRead.programAccounts(this.chain.programId, [{ memcmp: { offset: 0, bytes: bs58(roundDisc) } }, { memcmp: { offset: 8, bytes: bs58(le) } }]).catch(() => []);
    for (const o of old) this.track(Number(o.data.readBigUInt64LE(16)));
    log.info("records_discovered", { pool: this.t, lastRecord: last, outstanding: this.outstanding });
  }

  /** Creates (and delegates, same tx) the record for round n; optional test call on its Tape. */
  async create(n: number, plannedUnix: number): Promise<boolean> {
    const c = this.chain;
    const ixs = [
      await c.progBase.methods.createRecord(new BN(this.t), new BN(n), new BN(plannedUnix)).accountsPartial({ house: c.house.publicKey, config: c.pda.config(), ledger: c.pda.ledger(this.t), round: c.pda.round(this.t, n), tape: c.pda.tape(this.t, n) }).instruction(),
      await c.progBase.methods.delegate(3, new BN(this.t), new BN(n)).accountsPartial({ house: c.house.publicKey, config: c.pda.config(), pda: c.pda.round(this.t, n), validator: c.validator }).instruction(),
    ];
    const r = await c.sendBase(ixs);
    if (!r.ok) { log.warn("record_create_failed", { pool: this.t, round: n, err: errText(r) }); return false; }
    this.track(n, r.sig);
    this.lastRecordAt = Date.now();
    log.info("record_created", { pool: this.t, round: n, planned: plannedUnix, sig: r.sig, ms: Math.round(r.ms) });
    if (this.tester) this.testCall(n).catch((e) => log.warn("test_call_error", { pool: this.t, round: n, err: String(e?.message ?? e) }));
    return true;
  }

  private async testCall(n: number) {
    const c = this.chain, kp = this.tester!;
    const bal = await c.base.getBalance(kp.publicKey, "confirmed");
    if (bal < 50_000_000) {
      const f = await c.sendBase([SystemProgram.transfer({ fromPubkey: c.house.publicKey, toPubkey: kp.publicKey, lamports: 200_000_000 })]);
      if (!f.ok) return;
    }
    const tape = c.pda.tape(this.t, n);
    const desk = Math.floor(Math.random() * NDESK);
    const prog = c.program(c.base, kp);
    const ix = await prog.methods.placeCall(desk).accountsPartial({ bettor: kp.publicKey, config: c.pda.config(), tape, call: c.pda.call(tape, kp.publicKey) }).instruction();
    const r = await c.sendBase([ix], { signers: [kp] });
    const rec = this.recs.get(n);
    if (rec && r.ok) rec.testCall = r.sig;
    log.info("test_call", { pool: this.t, round: n, desk, ok: r.ok, sig: r.sig, err: r.ok ? undefined : errText(r) });
  }

  /** One pass over every outstanding record (never two passes at once). */
  async pass() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const n of this.outstanding) {
        try { await this.drive(this.recs.get(n)!); }
        catch (e: any) { log.warn("record_error", { pool: this.t, round: n, err: String(e?.message ?? e) }); }
      }
    } finally {
      this.busy = false;
    }
  }

  private async drive(rec: Rec) {
    const c = this.chain, n = rec.n;
    const roundPda = c.pda.round(this.t, n);
    const rb = await c.baseRead.account(roundPda);
    if (!rb.data) { this.recs.delete(n); return; } // closed
    if (c.isDelegatedOwner(rb.owner)) {
      await c.ensureHouseToken();
      const re = await c.erRead.account(roundPda);
      if (!re.data) return; // not visible on the rollup yet
      const r = decodeRound(re.data);
      if (r.status === ROUND_STATUS.open) return; // in play
      if (r.status === ROUND_STATUS.created && n > this.currentRound()) return; // pipelined for a coming round
      if (rec.stranded) return this.strandedSweep(rec);
      const now = Date.now();
      if (rec.commitAttempts > 0 && now - rec.commitAt < c.cfg.commitWaitMs) return; // waiting for it to land on base
      if (rec.commitAttempts >= 2) {
        rec.stranded = true;
        this.stranded++;
        log.warn("record_stranded", { pool: this.t, round: n, status: r.status, nBeats: r.nBeats, commitSig: rec.commitSig, note: "commit never reached base; the Tape refunds its calls after the timeout" });
        return;
      }
      if (rec.commitAttempts === 1) this.failedCommits++;
      const ix = await c.progEr.methods.commitRound(new BN(n)).accountsPartial({ house: c.house.publicKey, table: c.pda.table(this.t), round: roundPda, magicFeeVault: c.pda.feeVault() }).instruction();
      const res = await c.sendEr([ix]);
      rec.commitAttempts++;
      rec.commitAt = Date.now();
      if (res.ok) rec.commitSig = res.sig;
      log.info("record_commit", { pool: this.t, round: n, attempt: rec.commitAttempts, status: r.status, nBeats: r.nBeats, ok: res.ok, sig: res.sig, err: res.ok ? undefined : errText(res) });
      return;
    }
    // owned by the program on base: the Round is back (or was never delegated)
    if (rec.commitAt && rec.backMs === undefined) {
      rec.backMs = Date.now() - rec.commitAt;
      this.committed++;
      log.info("record_on_base", { pool: this.t, round: n, msAfterCommit: rec.backMs });
    }
    const round = decodeRound(rb.data);
    const tapePda = c.pda.tape(this.t, n);
    const tb = await c.baseRead.account(tapePda);
    if (!tb.data) return;
    let tape = decodeTape(tb.data);
    const nowS = Math.floor(Date.now() / 1000);
    if (!tape.resolved) {
      if (round.status === ROUND_STATUS.open) return;
      if (round.status === ROUND_STATUS.created && nowS < tape.closeUnix + 2) return;
      const ix = await c.progBase.methods.settleRound().accountsPartial({ caller: c.house.publicKey, round: roundPda, tape: tapePda }).instruction();
      const res = await c.sendBase([ix]);
      if (!res.ok) { log.warn("record_settle_failed", { pool: this.t, round: n, err: errText(res) }); return; }
      rec.settleSig = res.sig;
      tape = decodeTape((await c.baseRead.account(tapePda)).data!);
      log.info("record_settled", { pool: this.t, round: n, sig: res.sig, winner: tape.winner, void: tape.void, calls: tape.nCalls, total: tape.total });
    }
    if (tape.openCalls > 0) await this.sweep(rec, tapePda, tape);
    tape = decodeTape((await c.baseRead.account(tapePda)).data!);
    if (tape.openCalls === 0 || nowS >= tape.closeUnix + TAPE_CLOSE_AFTER_S) {
      const ix = await c.progBase.methods.closeRound().accountsPartial({ house: c.house.publicKey, config: c.pda.config(), round: roundPda, tape: tapePda }).instruction();
      const res = await c.sendBase([ix]);
      if (!res.ok) { log.warn("record_close_failed", { pool: this.t, round: n, err: errText(res) }); return; }
      this.closed++;
      this.recs.delete(n);
      log.info("record", { pool: this.t, round: n, status: round.status, nBeats: round.nBeats, topDesk: round.topDesk, createSig: rec.createSig, commitSig: rec.commitSig,
        msToBase: rec.backMs, settleSig: rec.settleSig, winner: tape.winner, void: tape.void, calls: tape.nCalls, claims: rec.claims, testCall: rec.testCall, closeSig: res.sig });
    }
  }

  /** Claims every open call of a resolved (or timed-out) Tape for its bettor; sub-minimum payouts stay owed and are retried later. */
  private async sweep(rec: Rec, tapePda: PublicKey, tape: TapeView) {
    const c = this.chain;
    const calls = await c.baseRead.programAccounts(c.programId, [{ memcmp: { offset: 0, bytes: bs58(this.callDisc) } }, { memcmp: { offset: 24, bytes: tapePda.toBase58() } }]);
    for (const k of calls) {
      const call = decodeCall(k.data);
      if (call.claimed) continue;
      const lastTry = rec.claimAttemptAt.get(k.pubkey) ?? 0;
      if (call.owed > 0n && Date.now() - lastTry < OWED_RETRY_MS) continue;
      rec.claimAttemptAt.set(k.pubkey, Date.now());
      const ix = await c.progBase.methods.claimCall().accountsPartial({ caller: c.house.publicKey, tape: tapePda, call: new PublicKey(k.pubkey), bettor: new PublicKey(call.bettor) }).instruction();
      const res = await c.sendBase([ix]);
      if (res.ok) rec.claims++;
      log.info("claim", { pool: this.t, round: rec.n, bettor: call.bettor, desk: call.desk, amount: call.amount, ok: res.ok, sig: res.sig, err: res.ok ? undefined : errText(res), void: tape.void });
    }
  }

  /** A record whose commit never reached base: its Tape cannot settle, so calls are refunded once the program's refund timeout passes. */
  private async strandedSweep(rec: Rec) {
    const c = this.chain;
    const tapePda = c.pda.tape(this.t, rec.n);
    const tb = await c.baseRead.account(tapePda);
    if (!tb.data) return;
    const tape = decodeTape(tb.data);
    if (tape.openCalls === 0) { this.recs.delete(rec.n); return; }
    if (Math.floor(Date.now() / 1000) < tape.closeUnix + TAPE_REFUND_AFTER_S + 5) return;
    await this.sweep(rec, tapePda, tape);
  }
}

function bs58(buf: Buffer): string {
  return base58.encode(buf);
}
