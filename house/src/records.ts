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
  committing?: boolean;
  bellAt?: number;
}

const OWED_RETRY_MS = 30 * 60_000;
const TAPE_REFUND_AFTER_S = 30 * 60;
const TAPE_CLOSE_AFTER_S = 24 * 3600;
const CLAIMS_PER_TX = 4; // settle_round + up to 4 claim_call fit one transaction

export class Records {
  private recs = new Map<number, Rec>();
  /** records being driven right now (round → since): each record has its own pass, so one waiting on a slow base
   *  transaction holds up no other record */
  private driving = new Map<number, number>();
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

  private creating = new Map<number, Promise<boolean>>();
  private abandonedCreates = new Set<number>();
  /** Resolves once no create_record for round n is in flight. */
  async pendingCreate(n: number) { await this.creating.get(n)?.catch(() => false); }
  /** A create_record for round n is in flight. */
  isCreating(n: number) { return this.creating.has(n); }
  /** Round n opened without its record: stop rebroadcasting the create (a copy already out may still land; it is
   *  then tracked like any record and committed, settled void and closed by the pass). */
  abandonCreate(n: number) {
    if (!this.creating.has(n)) return;
    this.abandonedCreates.add(n);
    for (const x of [...this.abandonedCreates]) if (x < n - 20) this.abandonedCreates.delete(x);
  }
  /** Age in seconds of the longest-running record drive (0 when none). */
  get driveAgeSec() { let m = 0; const now = Date.now(); for (const t of this.driving.values()) m = Math.max(m, now - t); return Math.round(m / 1000); }
  private lowBalanceLoggedAt = 0;
  /** Creates (and delegates, same tx) the record for round n; optional test call on its Tape. One send per round at a time. */
  create(n: number, plannedUnix: number): Promise<boolean> {
    const pending = this.creating.get(n);
    if (pending) return pending;
    if (!this.chain.canRecord()) {
      if (Date.now() - this.lowBalanceLoggedAt > 60_000) {
        this.lowBalanceLoggedAt = Date.now();
        log.error("low_balance_no_records", { pool: this.t, round: n, balanceSol: (this.chain.balanceLamports ?? 0) / 1e9, minSol: this.chain.cfg.minBalanceSol, note: "LOW HOUSE BALANCE: no new records; rounds keep playing unrecorded until the wallet is topped up" });
      }
      return Promise.resolve(false);
    }
    const p = this.doCreate(n, plannedUnix).finally(() => this.creating.delete(n));
    this.creating.set(n, p);
    return p;
  }
  private async doCreate(n: number, plannedUnix: number): Promise<boolean> {
    const c = this.chain;
    const ixs = [
      await c.progBase.methods.createRecord(new BN(this.t), new BN(n), new BN(plannedUnix)).accountsPartial({ house: c.house.publicKey, config: c.pda.config(), ledger: c.pda.ledger(this.t), round: c.pda.round(this.t, n), tape: c.pda.tape(this.t, n) }).instruction(),
      await c.progBase.methods.delegate(3, new BN(this.t), new BN(n)).accountsPartial({ house: c.house.publicKey, config: c.pda.config(), pda: c.pda.round(this.t, n), validator: c.validator }).instruction(),
    ];
    const roundPda = c.pda.round(this.t, n);
    const r = await c.sendBase(ixs, {
      label: `create_record ${this.t}/${n}`,
      abandoned: () => this.abandonedCreates.has(n),
      // rebuilt after an expiry only while the record does not exist and its round has not opened yet
      stillNeeded: async () => !this.abandonedCreates.has(n) && this.currentRound() < n && !(await c.baseRead.account(roundPda)).data,
    });
    if (!r.ok && r.err === "obsolete" && (await c.baseRead.account(roundPda)).data) { this.track(n); return true; }
    if (!r.ok) { log.warn("record_create_failed", { pool: this.t, round: n, err: errText(r), abandoned: this.abandonedCreates.has(n) || undefined }); return false; }
    if (this.abandonedCreates.has(n)) log.warn("record_created_late", { pool: this.t, round: n, sig: r.sig, note: "its round opened unrecorded; the record pass commits, settles (void) and closes it" });
    this.track(n, r.sig);
    this.lastRecordAt = Date.now();
    log.info("record_created", { pool: this.t, round: n, planned: plannedUnix, sig: r.sig, ms: Math.round(r.ms) });
    if (this.tester) this.testCall(n).catch((e) => log.warn("test_call_error", { pool: this.t, round: n, err: String(e?.message ?? e) }));
    return true;
  }

  /** commit_round for record n (the Round alone). Never two commits of one record in flight; called right after
   *  the reveal (before the unseal) and from the background pass as a fallback. */
  async commit(n: number, bellAt?: number): Promise<boolean> {
    this.track(n);
    const rec = this.recs.get(n)!;
    if (bellAt && !rec.bellAt) rec.bellAt = bellAt;
    if (rec.committing || rec.stranded) return false;
    if (rec.commitAttempts > 0 && Date.now() - rec.commitAt < this.chain.cfg.commitWaitMs) return false;
    rec.committing = true;
    try {
      const c = this.chain;
      if (rec.commitAttempts === 1) this.failedCommits++;
      const ix = await c.progEr.methods.commitRound(new BN(n)).accountsPartial({ house: c.house.publicKey, table: c.pda.table(this.t), round: c.pda.round(this.t, n), magicFeeVault: c.pda.feeVault() }).instruction();
      const res = await c.sendEr([ix]);
      rec.commitAttempts++;
      rec.commitAt = Date.now();
      if (res.ok) rec.commitSig = res.sig;
      log.info("record_commit", { pool: this.t, round: n, attempt: rec.commitAttempts, ok: res.ok, sig: res.sig, msAfterBell: rec.bellAt ? rec.commitAt - rec.bellAt : undefined, err: res.ok ? undefined : errText(res) });
      return res.ok;
    } finally {
      rec.committing = false;
    }
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

  /** Starts a drive of every outstanding record that is not being driven already (never two drives of one record
   *  at once); does not wait for them. */
  async pass() {
    for (const n of this.outstanding) {
      const rec = this.recs.get(n);
      if (!rec || this.driving.has(n)) continue;
      this.driving.set(n, Date.now());
      void this.drive(rec)
        .catch((e: any) => log.warn("record_error", { pool: this.t, round: n, err: String(e?.message ?? e) }))
        .finally(() => this.driving.delete(n));
    }
  }
  /** Resolves once no record drive is running (tests). */
  async idle() { while (this.driving.size) await new Promise((r) => setTimeout(r, 20)); }

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
      if (rec.committing || (rec.commitAttempts > 0 && now - rec.commitAt < c.cfg.commitWaitMs)) return; // waiting for it to land on base
      if (rec.commitAttempts >= 2 && now - rec.commitAt >= c.cfg.commitWaitMs) {
        rec.stranded = true;
        this.stranded++;
        log.warn("record_stranded", { pool: this.t, round: n, status: r.status, nBeats: r.nBeats, commitSig: rec.commitSig, note: "commit never reached base; the Tape refunds its calls after the timeout" });
        return;
      }
      await this.commit(n);
      return;
    }
    // owned by the program on base: the Round is back (or was never delegated)
    if (rec.commitAt && rec.backMs === undefined) {
      rec.backMs = Date.now() - rec.commitAt;
      this.committed++;
      log.info("record_on_base", { pool: this.t, round: n, msAfterCommit: rec.backMs, msAfterBell: rec.bellAt ? Date.now() - rec.bellAt : undefined });
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
      // settle_round and the first claims go in one transaction (a claim must never run on an unsettled Tape)
      const settleIx = await c.progBase.methods.settleRound().accountsPartial({ caller: c.house.publicKey, round: roundPda, tape: tapePda }).instruction();
      const open = tape.openCalls > 0 ? await this.openCalls(tapePda) : [];
      const first = open.slice(0, CLAIMS_PER_TX);
      const ixs = [settleIx];
      for (const k of first) ixs.push(await this.claimIx(tapePda, k));
      // after an expiry: rebuilt only while the Tape is still unresolved
      const unresolved = async () => { const x = await c.baseRead.account(tapePda); return !!x.data && !decodeTape(x.data).resolved; };
      let res = await c.sendBase(ixs, { label: `settle_round ${this.t}/${n}`, stillNeeded: unresolved });
      if (!res.ok && first.length) {
        // a claim the program refuses must not hold the settlement up: settle alone (claims follow, each with a settle)
        log.warn("record_settle_failed", { pool: this.t, round: n, claims: first.length, err: errText(res), next: "settle alone" });
        first.length = 0;
        res = await c.sendBase([settleIx], { label: `settle_round ${this.t}/${n}`, stillNeeded: unresolved });
      }
      if (!res.ok && res.err === "obsolete") return; // settled meanwhile: the next pass goes on from chain state
      if (!res.ok) { log.warn("record_settle_failed", { pool: this.t, round: n, claims: first.length, err: errText(res) }); return; }
      rec.settleSig = res.sig;
      tape = decodeTape((await c.baseRead.account(tapePda)).data!);
      for (const k of first) { rec.claimAttemptAt.set(k.pubkey, Date.now()); rec.claims++; log.info("claim", { pool: this.t, round: n, bettor: k.call.bettor, desk: k.call.desk, amount: k.call.amount, ok: true, sig: res.sig, withSettle: true, void: tape.void }); }
      log.info("record_settled", { pool: this.t, round: n, sig: res.sig, winner: tape.winner, void: tape.void, calls: tape.nCalls, claimsInTx: first.length, total: tape.total });
    }
    if (tape.openCalls > 0) await this.sweep(rec, tapePda, tape);
    tape = decodeTape((await c.baseRead.account(tapePda)).data!);
    if (tape.openCalls === 0 || nowS >= tape.closeUnix + TAPE_CLOSE_AFTER_S) {
      const ix = await c.progBase.methods.closeRound().accountsPartial({ house: c.house.publicKey, config: c.pda.config(), round: roundPda, tape: tapePda }).instruction();
      const res = await c.sendBase([ix], { label: `close_round ${this.t}/${n}`, stillNeeded: async () => !!(await c.baseRead.account(roundPda)).data });
      if (!res.ok && res.err === "obsolete") return; // closed meanwhile: the next pass drops the record
      if (!res.ok) { log.warn("record_close_failed", { pool: this.t, round: n, err: errText(res) }); return; }
      this.closed++;
      this.recs.delete(n);
      log.info("record", { pool: this.t, round: n, status: round.status, nBeats: round.nBeats, topDesk: round.topDesk, createSig: rec.createSig, commitSig: rec.commitSig,
        msToBase: rec.backMs, settleSig: rec.settleSig, winner: tape.winner, void: tape.void, calls: tape.nCalls, claims: rec.claims, testCall: rec.testCall, closeSig: res.sig });
    }
  }

  private async openCalls(tapePda: PublicKey) {
    const calls = await this.chain.baseRead.programAccounts(this.chain.programId, [{ memcmp: { offset: 0, bytes: bs58(this.callDisc) } }, { memcmp: { offset: 24, bytes: tapePda.toBase58() } }]);
    return calls.map((k) => ({ pubkey: k.pubkey, call: decodeCall(k.data) })).filter((k) => !k.call.claimed);
  }
  private claimIx(tapePda: PublicKey, k: { pubkey: string; call: ReturnType<typeof decodeCall> }) {
    const c = this.chain;
    return c.progBase.methods.claimCall().accountsPartial({ caller: c.house.publicKey, tape: tapePda, call: new PublicKey(k.pubkey), bettor: new PublicKey(k.call.bettor) }).instruction();
  }

  /** Claims every open call of a resolved (or timed-out) Tape for its bettor; sub-minimum payouts stay owed and are retried later.
   *  On a resolved Tape each claim tx also carries settle_round (idempotent), so no claim can ever meet an unsettled Tape. */
  private async sweep(rec: Rec, tapePda: PublicKey, tape: TapeView) {
    const c = this.chain;
    const due = (await this.openCalls(tapePda)).filter((k) => {
      const since = Date.now() - (rec.claimAttemptAt.get(k.pubkey) ?? 0);
      return since >= 60_000 && !(k.call.owed > 0n && since < OWED_RETRY_MS);
    });
    const roundPda = c.pda.round(this.t, rec.n);
    for (let i = 0; i < due.length; i += CLAIMS_PER_TX) {
      const chunk = due.slice(i, i + CLAIMS_PER_TX);
      const ixs = [];
      if (tape.resolved && !rec.stranded) ixs.push(await c.progBase.methods.settleRound().accountsPartial({ caller: c.house.publicKey, round: roundPda, tape: tapePda }).instruction());
      for (const k of chunk) { rec.claimAttemptAt.set(k.pubkey, Date.now()); ixs.push(await this.claimIx(tapePda, k)); }
      const first = new PublicKey(chunk[0].pubkey);
      const res = await c.sendBase(ixs, { label: `claim_call ${this.t}/${rec.n}`, stillNeeded: async () => { const x = await c.baseRead.account(first); return !!x.data && !decodeCall(x.data).claimed; } });
      if (res.ok) rec.claims += chunk.length;
      for (const k of chunk) log.info("claim", { pool: this.t, round: rec.n, bettor: k.call.bettor, desk: k.call.desk, amount: k.call.amount, owedBefore: k.call.owed, ok: res.ok, sig: res.sig, err: res.ok ? undefined : errText(res), void: tape.void });
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
