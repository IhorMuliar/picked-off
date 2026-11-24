// One house pool: one-time setup, then rounds back to back on the rollup, driven only from chain
// state (so a restart continues from whatever phase the pool is in):
//   [record: create_record + delegate on base, pipelined during the previous round] → re-seal →
//   open_round → crank ticks to the bell (liveness: reschedule a stalled crank, abort a stuck round) →
//   reveal → unseal → LIGHTS ON → next round; recorded rounds go on to commit → settle → claims → close.
import bs58 from "bs58";
import { Chain, BN, PublicKey, rpc, ACT_DISC, KIND, PHASE, SEAT, SEAL_ALL, NDESK, ROUND_STATUS, decodeTable, decodeConfig, decodeRound, decodeDesk, errText, must, sleep, type TableView } from "./chain.ts";
import { Bot, PERSONALITIES, SEAT_MIX, SEND_TIMEOUT_MS, seatName, type PoolView, type Snapshot, type SendTrack } from "./bots.ts";
import { Records } from "./records.ts";
import { log } from "./log.ts";

export interface PoolHealth { pool: number; round: number; phase: number; lastRoundAt: number; lastRoundAgeSec: number | null; stuck: boolean; rounds: number; aborts: number; reschedules: number; records: { outstanding: number[]; committed: number; closed: number; stranded: number; failedCommits: number }; bots: number; lateActs: Record<string, number>; sendsInflight: number; sendsAborted: number }

// earliest next open = HIDE 5 s + the earliest bell after 20 beats of 1.5 s + LIGHTS ON; a pipelined record's
// planned start is set to it, so its Tape calls close during the next round's live play
const MIN_ROUND_SECS = 35;
// a round's unseal waits for every bot send to settle; past this time after the bell it unseals anyway (and says so)
const UNSEAL_HARD_BOUND_MS = 6 * SEND_TIMEOUT_MS;

export class Pool implements PoolView {
  snap: Snapshot | null = null;
  /** bots stop sending from the moment the house sees the bell (set before the reveal) until the next open */
  sendClosed = false;
  readonly table: PublicKey;
  readonly book: PublicKey;
  readonly desks: PublicKey[];
  private bots: (Bot | null)[] = new Array(NDESK).fill(null);
  private botKeys: string[] = [];
  private bh: { hash: string; at: number } | null = null;
  readonly records: Records;
  private stopped = false;
  private slotMs: number; // rollup slot duration, measured (prior: the cluster's nominal rate)
  private slotMsMeasured = false;
  private slotRef: { slot: number; at: number } | null = null;
  // liveness of the current round
  private progress = { round: -1, resolves: -1, at: 0, rescheduledDeadline: -1, reschedules: 0 };
  // per-round bookkeeping
  private unsealed = new Set<number>();
  private bellSeenAt = new Map<number, number>();
  private openInfo = new Map<number, { at: number; openMs: number; resealMs: number; gapMs: number | null; recordSig?: string }>();
  private lastBellAt = 0;
  // players seated when a round opened (round → seat → key), and seats to hand back to a bot
  private humansAtOpen = new Map<number, Map<number, string>>();
  private reclaim = new Map<number, Set<number>>();
  private refilled = new Set<number>();
  rounds = 0;
  aborts = 0;
  reschedules = 0;
  lastRoundAt = 0;
  private roundDurations: number[] = [];

  constructor(private chain: Chain, readonly tableId: number) {
    this.slotMs = chain.cfg.cluster === "local" ? 50 : 10;
    this.table = chain.pda.table(tableId);
    this.book = chain.pda.book(tableId);
    this.desks = Array.from({ length: NDESK }, (_, s) => chain.pda.desk(tableId, s));
    this.records = new Records(chain, tableId, () => this.snap?.table.round ?? 0, chain.cfg.botKeysDir);
  }

  blockhash() { return this.bh?.hash ?? null; }
  private deskAccs() { return Object.fromEntries(this.desks.map((d, s) => [`desk${s}`, d])); }
  private get cfg() { return this.chain.cfg; }

  health(): PoolHealth {
    const t = this.snap?.table;
    const stuckFor = t && this.snap && (t.phase === PHASE.hide || t.phase === PHASE.live) ? this.nowSlotAge(this.snap, t.nextDeadlineSlot) : 0;
    const age = this.lastRoundAt ? Math.round((Date.now() - this.lastRoundAt) / 1000) : null;
    return { pool: this.tableId, round: t?.round ?? -1, phase: t?.phase ?? -1, lastRoundAt: this.lastRoundAt, lastRoundAgeSec: age, stuck: stuckFor > this.cfg.stallMs || (age !== null && age > 180),
      rounds: this.rounds, aborts: this.aborts, reschedules: this.reschedules,
      records: { outstanding: this.records.outstanding, committed: this.records.committed, closed: this.records.closed, stranded: this.records.stranded, failedCommits: this.records.failedCommits },
      bots: this.bots.filter((b) => b?.running).length, lateActs: this.lateTotals, sendsInflight: this.sends.inflight, sendsAborted: this.sends.aborted };
  }

  stop() {
    this.stopped = true;
    for (const b of this.bots) b?.stop("runner stopping");
  }

  // ---------------------------------------------------------------- background: Table poll, blockhash, records
  private async poll() {
    while (!this.stopped) {
      try {
        await this.chain.ensureHouseToken();
        const a = await this.chain.erRead.account(this.table);
        if (a.http === 401) await this.chain.ensureHouseToken(true);
        if (a.data) {
          let slot = a.slot;
          if (slot === undefined) slot = await this.chain.er.getSlot("confirmed");
          const now = Date.now();
          if (!this.slotRef) this.slotRef = { slot, at: now };
          else if (now - this.slotRef.at > 5_000 && slot > this.slotRef.slot) {
            const ms = (now - this.slotRef.at) / (slot - this.slotRef.slot);
            this.slotMs = this.slotMsMeasured ? this.slotMs * 0.7 + ms * 0.3 : ms;
            this.slotMsMeasured = true;
            this.slotRef = { slot, at: now };
          }
          this.snap = { table: decodeTable(a.data), slot, at: now, slotMs: this.slotMs };
          this.syncBots();
        }
      } catch (e: any) {
        log.warn("poll_error", { pool: this.tableId, err: String(e?.message ?? e) });
      }
      await sleep(250);
    }
  }
  private async blockhashLoop() {
    while (!this.stopped) {
      try {
        await this.chain.ensureHouseToken();
        this.bh = { hash: (await this.chain.er.getLatestBlockhash("confirmed")).blockhash, at: Date.now() };
      } catch (e: any) { log.warn("blockhash_error", { pool: this.tableId, err: String(e?.message ?? e) }); }
      await sleep(10_000);
    }
  }
  private async recordsLoop() {
    while (!this.stopped) {
      await this.records.pass().catch((e) => log.warn("records_pass_error", { pool: this.tableId, err: String(e?.message ?? e) }));
      await sleep(1_500);
    }
  }

  // ---------------------------------------------------------------- bots: start for our seats, stop when a player takes one
  private syncBots() {
    if (!this.cfg.bots || !this.snap) return;
    const t = this.snap.table;
    for (let s = 0; s < NDESK; s++) {
      const seat = t.seats[s];
      const b = this.bots[s];
      if (seat.kind === SEAT.bot && seat.key === this.botKeys[s] && !b?.alive) {
        const nb = new Bot(this.chain, this, s, PERSONALITIES[SEAT_MIX[s]], this.cfg.botKeysDir);
        this.bots[s] = nb;
        nb.onRoundDone = (st) => this.botRound.push({ seat: s, name: nb.name, kind: SEAT_MIX[s], ...st });
        nb.start().catch((e) => { log.warn("bot_start_error", { pool: this.tableId, seat: s, err: String(e?.message ?? e) }); nb.stop("start failed"); });
        log.info("bot_started", { pool: this.tableId, seat: s, name: nb.name, key: nb.key.publicKey.toBase58() });
      }
    }
  }
  private botRound: any[] = [];

  // ---------------------------------------------------------------- one-time setup (idempotent: finishes a half-done setup)
  async setup() {
    const c = this.chain, t = this.tableId;
    const cfgAcc = await c.baseRead.account(c.pda.config());
    if (!cfgAcc.data) {
      if (!this.cfg.initConfig) throw new Error("Config is missing on base (create it with the admin key first)");
      const params = {
        house: c.house.publicKey, teeValidator: c.validator, vrfQueue: PublicKey.default,
        beatSlots: new BN(30), hideSlots: new BN(100), callLamports: new BN(10_000_000), lotLamports: new BN(1_000_000),
        crankIntervalMs: 250, crankIterations: 240, tickCuLimit: 400_000, actIntervalMs: 250, hideSecs: 5, tapeCloseSecs: 15,
        bellMin: 20, bellMax: 29, algoMemory: 4, tapeCloseBeat: 10,
      };
      must(await c.sendBase([await c.progBase.methods.initConfig(params).accountsPartial({ admin: c.house.publicKey, config: c.pda.config() }).instruction()]), "init_config");
      log.info("config_initialised", { beatSlots: 30, hideSlots: 100, note: "local stack: 20 slots/s, so 1.5-s beats and a 5-s HIDE" });
    }
    const conf = decodeConfig((await c.baseRead.account(c.pda.config())).data!);
    if (conf.house !== c.house.publicKey.toBase58()) throw new Error(`Config.house ${conf.house} is not this runner's key ${c.house.publicKey.toBase58()}`);
    if (conf.teeValidator !== c.validator.toBase58()) throw new Error(`Config.tee_validator ${conf.teeValidator} differs from VALIDATOR ${c.validator.toBase58()}`);

    for (let s = 0; s < NDESK; s++) this.botKeys[s] = new Bot(c, this, s, PERSONALITIES[SEAT_MIX[s]], this.cfg.botKeysDir).key.publicKey.toBase58();

    if (!(await c.baseRead.accounts([this.table], true))[0].owner) {
      must(await c.sendBase([await c.progBase.methods.createPool(new BN(t), 0, new BN(this.cfg.tableFloatLamports)).accountsPartial({ house: c.house.publicKey, config: c.pda.config(), table: this.table, book: this.book, ledger: c.pda.ledger(t) }).instruction()]), "create_pool");
      log.info("pool_created", { pool: t });
    }
    const deskAccs = await c.baseRead.accounts(this.desks, true);
    const missing = deskAccs.map((a, s) => (a.owner ? -1 : s)).filter((s) => s >= 0);
    for (let i = 0; i < missing.length; i += 4) {
      const ixs = [];
      for (const s of missing.slice(i, i + 4)) ixs.push(await c.progBase.methods.createDesk(new BN(t), s).accountsPartial({ house: c.house.publicKey, config: c.pda.config(), table: this.table, desk: this.desks[s] }).instruction());
      must(await c.sendBase(ixs), `create_desk ${missing.slice(i, i + 4)}`);
    }
    await c.ensureHouseToken();
    const targets: [number, number, PublicKey][] = [[KIND.table, 0, this.table], [KIND.book, 0, this.book], ...this.desks.map((d, s) => [KIND.desk, s, d] as [number, number, PublicKey])];
    const baseOwners = await c.baseRead.accounts(targets.map((x) => x[2]), true);
    for (let i = 0; i < targets.length; i++) {
      const [kind, idx, acc] = targets[i];
      if (baseOwners[i].owner === c.programId.toBase58()) {
        must(await c.sendBase([await c.progBase.methods.delegate(kind, new BN(t), new BN(idx)).accountsPartial({ house: c.house.publicKey, config: c.pda.config(), pda: acc, validator: c.validator }).instruction()]), `delegate ${kind}/${idx}`);
        // the public Table is read back; the Book and Desks are never read (the permission step below
        // retries until the rollup has them)
        const ms = kind === KIND.table ? await c.waitOwner(c.erRead, acc, 15_000) : null;
        if (kind === KIND.table && ms === null) throw new Error("delegated Table not visible on the rollup");
        log.info("delegated", { pool: t, kind, index: idx, msVisible: ms });
      }
    }
    // permissions that do not exist yet (create path); later re-seals use the update path
    const perms = await c.erRead.accounts(targets.map((x) => c.pda.perm(x[2])), true);
    const todo = targets.filter((_, i) => !perms[i].owner);
    for (let i = 0; i < todo.length; i += 3) {
      const ixs = [];
      for (const [kind, idx, acc] of todo.slice(i, i + 3))
        ixs.push(await c.progEr.methods.setupPermissions(kind, new BN(idx)).accountsPartial({ house: c.house.publicKey, table: this.table, target: kind === KIND.table ? null : acc, permission: c.pda.perm(acc) }).instruction());
      for (let k = 0; ; k++) {
        const r = await c.sendEr(ixs, { cu: 1_000_000 });
        if (r.ok) break;
        if (k >= 30) must(r, "setup_permissions");
        await sleep(500);
      }
    }
    if (todo.length) log.info("permissions_created", { pool: t, count: todo.length });
    await this.records.discover();
    log.info("pool_ready", { pool: t, table: this.table.toBase58(), seats: SEAT_MIX.map((_, s) => `${s}:${seatName(s)}`) });
  }

  // ---------------------------------------------------------------- main loop
  async run() {
    await this.setup();
    void this.poll();
    void this.blockhashLoop();
    void this.recordsLoop();
    while (!this.snap && !this.stopped) await sleep(100);
    log.info("pool_resume", { pool: this.tableId, round: this.snap?.table.round, phase: this.snap?.table.phase, sealed: this.snap?.table.sealed });
    while (!this.stopped) {
      try {
        await this.step();
      } catch (e: any) {
        log.warn("step_error", { pool: this.tableId, err: String(e?.message ?? e) });
        await sleep(1_000);
      }
      if (this.cfg.maxRounds && this.rounds >= this.cfg.maxRounds && this.snap && this.snap.table.phase >= PHASE.revealed) {
        // let the records of the last rounds finish
        if (this.records.outstanding.filter((n) => n <= this.snap!.table.round).length === 0 || Date.now() - this.lastRoundAt > 90_000) break;
      }
      await sleep(200);
    }
    this.stop();
  }

  private async step() {
    const s = this.snap;
    if (!s) return;
    const t = s.table;
    switch (t.phase) {
      case PHASE.hide:
      case PHASE.live:
        return this.liveness(s);
      case PHASE.bell:
        return this.reveal(t);
      case PHASE.revealed:
        return this.afterReveal(s);
      default:
        if (this.cfg.maxRounds && this.rounds >= this.cfg.maxRounds) return;
        return this.next(t);
    }
  }

  private nowSlotAge(s: Snapshot, slot: number) { return (s.slot - slot) * s.slotMs + (Date.now() - s.at); }

  // ---------------------------------------------------------------- liveness: reschedule a stalled crank, abort a stuck round
  private async liveness(s: Snapshot) {
    const t = s.table, c = this.chain;
    if (!this.slotMsMeasured) return; // slot ages are only trusted once the slot rate is measured (≈ 5 s after a start)
    if (this.progress.round !== t.round || this.progress.resolves !== t.resolves) {
      this.progress = { ...this.progress, round: t.round, resolves: t.resolves, at: Date.now(), ...(this.progress.round !== t.round ? { rescheduledDeadline: -1, reschedules: 0 } : {}) };
      return;
    }
    const overdue = this.nowSlotAge(s, t.nextDeadlineSlot);
    const programMin = (2 * t.beatSlots + 2) * s.slotMs; // the program accepts a reschedule only two beats past the deadline
    const threshold = Math.max(this.cfg.stallMs, programMin);
    const age = this.nowSlotAge(s, t.openSlot);
    const stalledFor = Date.now() - this.progress.at;
    if ((this.progress.reschedules > 0 && stalledFor > this.cfg.hardStallMs) || age > this.cfg.maxRoundMs) {
      const recorded = t.recorded === 1;
      const ix = await c.progEr.methods.abortRound().accountsPartial({ house: c.house.publicKey, table: this.table, book: this.book, round: recorded ? c.pda.round(this.tableId, t.round) : null }).instruction();
      const r = await c.sendEr([ix]);
      if (r.ok) { this.aborts++; this.rounds++; this.lastRoundAt = Date.now(); }
      log.warn("round_aborted", { pool: this.tableId, round: t.round, recorded: t.recorded, beat: t.beat, stalledMs: stalledFor, ageMs: Math.round(age), reschedules: this.progress.reschedules, ok: r.ok, sig: r.sig, err: r.ok ? undefined : errText(r) });
      this.lastBellAt = Date.now();
      await this.fresh((x) => x.phase !== PHASE.hide && x.phase !== PHASE.live);
      return;
    }
    if (overdue >= threshold && this.progress.rescheduledDeadline !== t.nextDeadlineSlot) {
      const ix = await c.progEr.methods.rescheduleCrank().accountsPartial({ house: c.house.publicKey, table: this.table, book: this.book, ...this.deskAccs() }).instruction();
      const r = await c.sendEr([ix], { cu: 400_000 });
      log.warn("crank_rescheduled", { pool: this.tableId, round: t.round, beat: t.beat, deadline: t.nextDeadlineSlot, overdueMs: Math.round(overdue), thresholdMs: Math.round(threshold), ok: r.ok, sig: r.sig, err: r.ok ? undefined : errText(r) });
      if (r.ok) { this.progress.rescheduledDeadline = t.nextDeadlineSlot; this.progress.reschedules++; this.reschedules++; }
      else await sleep(500);
    }
  }

  // ---------------------------------------------------------------- bell → reveal → commit → (quiet) → unseal
  private revealInfo = new Map<number, { revealMs: number; commitMs?: number; revealedAt: number }>();
  private async reveal(t: TableView) {
    const c = this.chain;
    this.sendClosed = true;
    if (!this.bellSeenAt.has(t.round)) this.bellSeenAt.set(t.round, Date.now() - Math.max(0, this.nowSlotAge(this.snap!, t.bellSlot || this.snap!.slot)));
    const ix = await c.progEr.methods.reveal().accountsPartial({ caller: c.house.publicKey, table: this.table, book: this.book, round: t.recorded ? c.pda.round(this.tableId, t.round) : null }).instruction();
    const t0 = performance.now();
    const r = await c.sendEr([ix], { cu: 400_000 });
    if (!r.ok) { log.warn("reveal_failed", { pool: this.tableId, round: t.round, err: errText(r) }); await sleep(500); return; }
    const revealMs = Math.round(performance.now() - t0);
    // a recorded round is committed at once, before the unseal (bell → Round on base is then ≈ 3 s, not 6-14 s)
    let commitMs: number | undefined;
    if (t.recorded) {
      const t2 = performance.now();
      await this.records.commit(t.round, this.bellSeenAt.get(t.round)).catch((e) => log.warn("commit_error", { pool: this.tableId, round: t.round, err: String(e?.message ?? e) }));
      commitMs = Math.round(performance.now() - t2);
    }
    this.revealInfo.set(t.round, { revealMs, commitMs, revealedAt: Date.now() });
    // the unseal follows from afterReveal once every bot send has settled (fail closed)
    await this.fresh((x) => x.phase !== PHASE.bell || x.round !== t.round);
  }

  /** Bot act sends of this pool (all bots, also ones stopped or replaced during the round). */
  readonly sends: SendTrack = { inflight: 0, lastSettledAt: 0, aborted: 0 };
  /** Fail closed: the round may become public only when no bot send is in flight and none settled (answered, failed or
   *  aborted) within `unsealQuietMs`, and the bell is at least that long ago. Past the hard bound it unseals anyway,
   *  loudly, so a round can never wedge. */
  private unsealGate(n: number): { ok: boolean; forced: boolean; quietMs: number | null; inflight: number } {
    this.sendClosed = true;
    const now = Date.now();
    const bell = this.bellSeenAt.get(n) ?? 0;
    const last = Math.max(this.sends.lastSettledAt, bell);
    const quiet = this.sends.inflight === 0 && now - last >= this.cfg.unsealQuietMs;
    const forced = !quiet && bell > 0 && now - bell > UNSEAL_HARD_BOUND_MS;
    return { ok: quiet || forced, forced, quietMs: this.sends.lastSettledAt ? now - this.sends.lastSettledAt : null, inflight: this.sends.inflight };
  }

  private lastQuiet: { quietMs: number | null; inflight: number; forced: boolean; aborted: number } | null = null;
  /** Unseals round n if the gate allows; returns the unseal time in ms, or null when it has to wait (retried next tick). */
  private async tryUnseal(n: number): Promise<number | null> {
    const g = this.unsealGate(n);
    if (!g.ok) return null;
    if (g.forced) log.error("unseal_forced", { pool: this.tableId, round: n, inflight: g.inflight, quietMs: g.quietMs, boundMs: UNSEAL_HARD_BOUND_MS, note: "bot sends still unsettled at the hard bound: unsealing anyway" });
    this.lastQuiet = { quietMs: g.quietMs, inflight: g.inflight, forced: g.forced, aborted: this.sends.aborted };
    const c = this.chain, t0 = performance.now();
    const items: [number, number, PublicKey][] = [[KIND.book, 0, this.book], ...this.desks.map((d, s) => [KIND.desk, s, d] as [number, number, PublicKey])];
    let firstSig = "";
    for (let i = 0; i < items.length; i += 3) {
      const ixs = [];
      for (const [kind, idx, acc] of items.slice(i, i + 3)) ixs.push(await c.progEr.methods.unseal(kind, new BN(idx)).accountsPartial({ house: c.house.publicKey, table: this.table, target: acc, permission: c.pda.perm(acc) }).instruction());
      const r = must(await c.sendEr(ixs, { cu: 1_000_000 }), `unseal ${i}`);
      if (!firstSig) firstSig = r.sig;
    }
    this.unsealed.add(n);
    const ms = Math.round(performance.now() - t0);
    await this.idleHumans(n).catch((e) => log.warn("idle_check_error", { pool: this.tableId, round: n, err: String(e?.message ?? e) }));
    const bellSlot = this.snap?.table.round === n ? this.snap.table.bellSlot : 0;
    setTimeout(() => this.lateActs(n, bellSlot, firstSig).catch((e) => log.warn("late_acts_error", { pool: this.tableId, round: n, err: String(e?.message ?? e) })), 1_000);
    return ms;
  }

  /** Audit while the round is public (before the re-seal): transactions on the Book after the bell / after the unseal
   *  that are not the house's, i.e. acts that landed late, split into this pool's bots and other signers. */
  lateTotals = { rounds: 0, afterBellBot: 0, afterBellOther: 0, afterUnsealBot: 0, afterUnsealOther: 0 };
  private async lateActs(n: number, bellSlot: number, unsealSig: string) {
    const c = this.chain;
    await c.ensureHouseToken();
    const url = c.erUrl(c.houseToken);
    const st = (await rpc(url, "getSignatureStatuses", [[unsealSig]])).body?.result?.value?.[0];
    const unsealSlot: number = st?.slot ?? 0;
    const list: any[] = (await rpc(url, "getSignaturesForAddress", [this.book.toBase58(), { limit: 200 }])).body?.result ?? [];
    if (!unsealSlot || !bellSlot || !list.length) return;
    const house = c.house.publicKey.toBase58();
    const bots = new Set(this.botKeys);
    const out = { afterBellBot: 0, afterBellOther: 0, afterUnsealBot: 0, afterUnsealOther: 0 };
    const samples: any[] = [];
    for (const x of list) {
      if (x.slot < bellSlot) continue;
      const tx = (await rpc(url, "getTransaction", [x.signature, { encoding: "json", maxSupportedTransactionVersion: 0 }])).body?.result;
      const msg = tx?.transaction?.message;
      const signer: string | undefined = msg?.accountKeys?.[0];
      if (!signer || signer === house) continue;
      const prog = c.programId.toBase58();
      const isAct = (msg.instructions ?? []).some((ix: any) => msg.accountKeys[ix.programIdIndex] === prog && Buffer.from(bs58.decode(ix.data)).subarray(0, 8).equals(ACT_DISC));
      if (!isAct) continue;
      const bot = bots.has(signer);
      const after = x.slot >= unsealSlot;
      if (bot) out.afterBellBot++; else out.afterBellOther++;
      if (after) { if (bot) out.afterUnsealBot++; else out.afterUnsealOther++; }
      if (samples.length < 5) samples.push({ sig: x.signature.slice(0, 8), slot: x.slot, bot, afterUnseal: after });
    }
    this.lateTotals.rounds++;
    for (const k of Object.keys(out) as (keyof typeof out)[]) this.lateTotals[k] += out[k];
    const any = out.afterBellBot + out.afterBellOther > 0;
    (any ? log.warn : log.info)("late_acts", { pool: this.tableId, round: n, bellSlot, unsealSlot, ...out, samples: any ? samples : undefined });
  }

  /** After the reveal (every Desk public): a player seated for the whole round whose Desk accepted no act in it gets its seat back to a bot. */
  private async idleHumans(n: number) {
    const seated = this.humansAtOpen.get(n);
    this.humansAtOpen.delete(n);
    const t = this.snap?.table;
    if (!seated || !t) return;
    const out = new Set<number>();
    for (const [s, key] of seated) {
      if (t.seats[s].kind !== SEAT.human || t.seats[s].key !== key) continue;
      const a = await this.chain.erRead.account(this.desks[s], { round: n, phase: PHASE.revealed });
      if (!a.data) continue;
      const d = decodeDesk(a.data);
      if (d.round === n && d.key === key && d.acts === 0) out.add(s);
      log.info("player_seat", { pool: this.tableId, round: n, seat: s, key, acts: d.acts, reclaim: out.has(s) });
    }
    if (out.size) this.reclaim.set(n, out);
  }

  private finishRound(t: TableView, revealMs: number, unsealMs: number, commitMs?: number) {
    const bellAt = this.bellSeenAt.get(t.round) ?? Date.now();
    this.lastBellAt = bellAt;
    const oi = this.openInfo.get(t.round);
    const roundMs = oi ? Math.round(bellAt - oi.at) : null;
    if (roundMs) this.roundDurations.push(roundMs);
    this.rounds++;
    this.lastRoundAt = Date.now();
    log.info("round", { pool: this.tableId, round: t.round, recorded: t.recorded, beats: t.beat, bellSlot: t.bellSlot, openSlot: t.openSlot,
      liveSlots: t.bellSlot && t.openSlot ? t.bellSlot - t.openSlot : null, fallbackSeed: t.fallbackSeed, tickCalls: t.tickCalls, resolves: t.resolves,
      roundMs, openMs: oi?.openMs, resealMs: oi?.resealMs, gapMs: oi?.gapMs, revealMs, commitMs, unsealMs,
      botsQuietMs: this.lastQuiet?.quietMs, botsInflightAtUnseal: this.lastQuiet?.inflight, unsealForced: this.lastQuiet?.forced || undefined, sendsAborted: this.lastQuiet?.aborted, recordSig: oi?.recordSig, picked: t.picked,
      reschedules: this.progress.round === t.round ? this.progress.reschedules : 0, n: this.rounds });
    this.openInfo.delete(t.round);
    this.bellSeenAt.delete(t.round);
  }

  private async afterReveal(s: Snapshot) {
    const t = s.table;
    if (!this.unsealed.has(t.round)) {
      const ri = this.revealInfo.get(t.round);
      if (!this.bellSeenAt.has(t.round)) this.bellSeenAt.set(t.round, Date.now() - Math.max(0, this.nowSlotAge(s, t.bellSlot)));
      const unsealMs = await this.tryUnseal(t.round); // idempotent on a resumed, already public round
      if (unsealMs === null) { await sleep(100); return; } // a bot send still unsettled: try again on the next tick
      if (ri) { this.revealInfo.delete(t.round); this.finishRound(t, ri.revealMs, unsealMs, ri.commitMs); }
      else {
        // resumed after a reveal
        log.info("resume_unsealed", { pool: this.tableId, round: t.round, unsealMs });
        if (!this.lastBellAt) this.lastBellAt = this.bellSeenAt.get(t.round) ?? Date.now();
        this.bellSeenAt.delete(t.round);
      }
    }
    // LIGHTS ON: the revealed round stays public for the replay before the next round opens
    const wait = (this.lastBellAt || Date.now()) + this.cfg.lightsOnMs - Date.now();
    if (wait > 0) { await sleep(Math.min(wait, 500)); return; }
    await this.next(t);
  }

  private emitBotLine(n: number) {
    const rows = this.botRound.filter((r) => r.round === n);
    this.botRound = this.botRound.filter((r) => r.round > n);
    if (!rows.length) return;
    log.info("bots", { pool: this.tableId, round: n, bots: rows.map((r) => {
      const secs = r.lastSend > r.firstSend ? (r.lastSend - r.firstSend) / 1000 : 0;
      return { seat: r.seat, name: r.name, sent: r.sent, sendErr: r.sendErr, acked: r.final?.acts ?? null, ackPerSec: r.final && secs ? +(r.final.acts / secs).toFixed(2) : null,
        place: r.place, pings: r.pings, requotes: r.requotes, present: r.present, absent: r.absent, algo: r.algo, fills: r.fills,
        rtMs: r.rtN ? Math.round(r.rtSum / r.rtN) : null, total: r.final ? r.final.resting + r.final.picked : null };
    }) });
  }

  // ---------------------------------------------------------------- next round: seats, record, re-seal, open, pipeline
  /** Record cadence: every round with a player seated, otherwise one round per `recordEverySec` (`aheadMs`: evaluated that far ahead). */
  private shouldRecord(t: TableView, aheadMs = 0) {
    if (!this.chain.canRecord()) return false;
    const human = t.seats.some((x) => x.kind === SEAT.human);
    const since = Date.now() + aheadMs - this.records.lastRecordAt;
    // below the soft balance threshold a seated player no longer makes every round recorded
    if (human) return !this.chain.lowBalance() || since >= this.cfg.lowRecordEverySec * 1000;
    return since >= this.cfg.recordEverySec * 1000;
  }
  /** Waits until the Table poll is newer than now (or `pred` holds). */
  private async fresh(pred: (t: TableView) => boolean = () => true, ms = 3_000) {
    const since = Date.now();
    for (let i = 0; i < ms / 50; i++) {
      if (this.snap && this.snap.at > since && pred(this.snap.table)) return;
      await sleep(50);
    }
  }

  /** join_bot for every empty seat, every bot seat not held by our key, and idle players' seats; once per round. Returns seats filled. */
  private async refillSeats(t: TableView) {
    if (this.refilled.has(t.round)) return 0;
    this.refilled.add(t.round);
    for (const r of [...this.refilled]) if (r < t.round - 5) this.refilled.delete(r);
    const c = this.chain, ixs = [];
    const reclaim = this.reclaim.get(t.round) ?? new Set<number>();
    this.reclaim.delete(t.round);
    for (let s = 0; s < NDESK; s++) {
      const seat = t.seats[s];
      if (seat.key === this.botKeys[s] && seat.kind === SEAT.bot) continue;
      if (seat.kind === SEAT.human && !reclaim.has(s)) continue;
      const name = Buffer.alloc(16); name.write(seatName(s));
      ixs.push({ s, ix: await c.progEr.methods.joinBot(s, new PublicKey(this.botKeys[s]), PERSONALITIES[SEAT_MIX[s]].code, Array.from(name)).accountsPartial({ house: c.house.publicKey, table: this.table, desk: this.desks[s], permission: c.pda.perm(this.desks[s]) }).instruction() });
    }
    let filled = 0;
    for (let i = 0; i < ixs.length; i += 4) {
      const chunk = ixs.slice(i, i + 4);
      const r = await c.sendEr(chunk.map((x) => x.ix), { cu: 1_000_000 });
      if (r.ok) filled += chunk.length;
      log.info("bots_seated", { pool: this.tableId, round: t.round, seats: chunk.map((x) => `${x.s}:${seatName(x.s)}${t.seats[x.s].kind === SEAT.human ? "(idle player)" : ""}`), ok: r.ok, err: r.ok ? undefined : errText(r) });
    }
    return filled;
  }

  private async next(t: TableView) {
    const c = this.chain, n = t.round + 1;
    this.emitBotLine(t.round);
    if (this.cfg.maxRounds && this.rounds >= this.cfg.maxRounds) return;
    if (this.cfg.bots && (await this.refillSeats(t))) { await this.fresh(); return; } // re-read the Table before going on
    const roundPda = c.pda.round(this.tableId, n);
    // record: pipelined during the previous round, or created now (a player sat down, or the cadence is due)
    await this.records.pendingCreate(n); // a record for n still being sent (pipelined): wait for it, never open past it
    let rb = await c.baseRead.account(roundPda);
    if (!rb.data && this.shouldRecord(t)) {
      if (!(await this.records.create(n, Math.floor(Date.now() / 1000) - 2))) return;
      rb = await c.baseRead.account(roundPda);
    }
    let recorded = false;
    if (rb.data) {
      if (!c.isDelegatedOwner(rb.owner)) { log.warn("record_not_delegated", { pool: this.tableId, round: n }); return; }
      this.records.track(n);
      if ((await c.waitOwner(c.erRead, roundPda, 10_000)) === null) { log.warn("record_not_visible", { pool: this.tableId, round: n }); return; }
      const re = decodeRound((await c.erRead.account(roundPda)).data!);
      if (re.status !== ROUND_STATUS.created) { log.warn("record_not_fresh", { pool: this.tableId, round: n, status: re.status }); return; }
      const wait = re.plannedStartUnix * 1000 - Date.now() + 1_000;
      if (wait > 0) { await sleep(Math.min(wait, 1_000)); return; }
      // open_round checks the planned start against the rollup's clock (within about a second of ours)
      const erNow = await c.erUnix().catch(() => null);
      if (erNow !== null && erNow < re.plannedStartUnix) { await sleep(300); return; }
      recorded = true;
    }
    // re-seal (setup_permissions, update path) every desk and the Book
    const t0 = performance.now();
    if (t.sealed !== SEAL_ALL) {
      const all: [number, number, PublicKey][] = [[KIND.book, 0, this.book], ...this.desks.map((d, s) => [KIND.desk, s, d] as [number, number, PublicKey])];
      const items = all.filter(([kind, idx]) => !(t.sealed & (kind === KIND.book ? 0x100 : 1 << idx)));
      for (let i = 0; i < items.length; i += 3) {
        const ixs = [];
        for (const [kind, idx, acc] of items.slice(i, i + 3)) ixs.push(await c.progEr.methods.setupPermissions(kind, new BN(idx)).accountsPartial({ house: c.house.publicKey, table: this.table, target: acc, permission: c.pda.perm(acc) }).instruction());
        must(await c.sendEr(ixs, { cu: 1_000_000 }), "re-seal");
      }
    }
    const resealMs = Math.round(performance.now() - t0);
    const queue = t.vrfQueue.equals(PublicKey.default) ? new PublicKey(this.cfg.oracleQueueFallback) : t.vrfQueue;
    const ix = await c.progEr.methods.openRound(new BN(n)).accountsPartial({ house: c.house.publicKey, table: this.table, book: this.book, ...this.deskAccs(), round: recorded ? roundPda : null, oracleQueue: queue }).instruction();
    const t1 = performance.now();
    const r = await c.sendEr([ix], { cu: 1_000_000 });
    if (!r.ok) { log.warn("open_failed", { pool: this.tableId, round: n, err: errText(r) }); await sleep(500); return; }
    const openAt = Date.now();
    this.sendClosed = false;
    const humans = new Map<number, string>();
    t.seats.forEach((x, s) => { if (x.kind === SEAT.human) humans.set(s, x.key); });
    if (humans.size) this.humansAtOpen.set(n, humans);
    for (const r of [...this.humansAtOpen.keys()]) if (r < n - 3) this.humansAtOpen.delete(r);
    this.openInfo.set(n, { at: openAt, openMs: Math.round(performance.now() - t1), resealMs, gapMs: this.lastBellAt ? Math.round(openAt - this.lastBellAt) : null, recordSig: recorded ? this.records.createSig(n) : undefined });
    this.progress = { round: n, resolves: 0, at: Date.now(), rescheduledDeadline: -1, reschedules: 0 };
    log.info("round_open", { pool: this.tableId, round: n, recorded, sig: r.sig, resealMs });
    // pipeline the next record so it is delegated and visible before its round opens
    const tNow = this.snap?.table ?? t;
    if (!(await c.baseRead.account(c.pda.round(this.tableId, n + 1))).data && this.shouldRecord(tNow, 50_000))
      this.records.create(n + 1, Math.floor(openAt / 1000) + MIN_ROUND_SECS + Math.floor(this.cfg.lightsOnMs / 1000)).catch((e) => log.warn("record_pipeline_error", { pool: this.tableId, round: n + 1, err: String(e?.message ?? e) }));
    // wait until the poller has seen the new round
    for (let i = 0; i < 40 && (this.snap?.table.round ?? 0) < n; i++) await sleep(50);
  }

  durations() { return this.roundDurations.slice(); }
}
