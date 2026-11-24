/**
 * Chain driver: the game screen on the real program.
 *
 * Reads the public Table and this burner's own private Desk from the rollup (token-bearing
 * connection), sends one `act` every 250 ms from a Worker while seated, takes a seat with
 * `join` (no wallet: the burner signs everything and holds 0 SOL on the rollup), reads the
 * Tape and sends calls on the base layer, and after the bell replays the committed round
 * record in the browser and checks it against the published commit hash.
 */
import { Keypair, PublicKey, Transaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import {
  BEAT_MS, DESKS, LEVELS, LIGHTS_MS, TAPE_CLOSE_BEAT,
  type GameActions, type GameDriver, type MyDesk, type PeekProbe, type Phase, type StoreWriter, type TapeView,
} from "../state/types";
import { chainConfig, type ChainConfig } from "./config";
import { loadOrCreateBurner, exportBurner, storage, TokenStore, type Burner } from "./burner";
import { BaseLink, TeeLink, dropSocket } from "./link";
import { watchAccount, type Watch } from "./watch";
import { SlotClock } from "./slotclock";
import { Pdas } from "./pda";
import {
  decodeBook, decodeCall, decodeConfig, decodeDesk, decodeRound, decodeTable, decodeTape, isAccount,
  PHASE, ROUND_STATUS, SEAT, TABLE_KIND, type Call, type Config, type Desk, type Table, type Tape,
} from "./layout";
import { joinIx, placeCallIx, claimCallIx, settleRoundIx } from "./ix";
import { ACT_PING, ACT_REQUOTE } from "./wire";
import { bellChance, buildReveal, printsOfBeat, recordFromBook, resultsOfBeat, seatsView, SKIM_STEP } from "./views";
import { runPeek } from "./peek";
import { StatusBanner, type Banner } from "./status";
import type { FromWorker, ToWorker } from "./actsender";
import type { CadenceStats, Plan } from "./scheduler";

const ADJ = ["bright", "quiet", "swift", "amber", "silver", "lucky", "steady", "keen", "calm", "bold"];
const ANIMAL = ["otter", "heron", "fox", "lynx", "wren", "marten", "kestrel", "hare", "owl", "stoat"];
const CALL_ACCOUNT_BYTES = 112;
const BASE_FEE_RESERVE = 20_000;
/** A client claim waits this long after its call (the house sweep claims right after the round). */
const CLAIM_AFTER_MS = 150_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const toEpoch = (perf: number) => performance.timeOrigin + perf;
const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

export interface ChainStatus {
  cluster: string;
  burner: string;
  link: string;
  linkError: string | null;
  tableId: string | null;
  round: string | null;
  seat: number | null;
  deskReadable: boolean;
  sending: boolean;
  cadence: CadenceStats | null;
  sendFailed: number;
  ackP50: number | null;
  ackP95: number | null;
  ackN: number;
  /** scheduled beat close (deadline slot) -> own Desk result received, ms */
  resultLagP50: number | null;
  resultLagP95: number | null;
  resultLagN: number;
  /** the latest genuine samples, ms */
  resultLags: number[];
  deskActs: number | null;
  deskLastSeq: number | null;
  lastSentSeq: number | null;
  joinErrors: string[];
  slotMs: number;
  needsFunding: boolean;
  watches: Record<string, { pushes: number; polls: number; resubscribes: number }>;
}

export function createChainDriver(): GameDriver {
  return new ChainDriver(chainConfig());
}

class ChainDriver implements GameDriver {
  readonly name = "chain";
  private w!: StoreWriter;
  private readonly pdas: Pdas;
  private readonly burner: Burner;
  private readonly me: PublicKey;
  private readonly tokens: TokenStore;
  private readonly tee: TeeLink;
  private readonly base: BaseLink;
  private readonly clock: SlotClock;
  private readonly banner = new StatusBanner();
  private readonly kv = storage();
  private stopped = false;
  private intervals: ReturnType<typeof setInterval>[] = [];
  private watches: Record<string, Watch> = {};

  private tableId: bigint | null = null;
  private table: Table | null = null;
  private round: bigint | null = null;
  private seat: number | null = null;
  private desk: Desk | null = null;
  private deskReadable = false;
  private seenTableBeat = 0;
  private seenDeskBeat = 0;
  private bellAt: number | null = null;
  private revealRound: bigint | null = null;
  private myDesk: MyDesk | null = null;
  private joining = false;
  private announceJoin = false;
  private slotFails = 0;

  private worker: Worker | null = null;
  private workerSetupFor: string | null = null;
  private plan: Plan = { phase: "off", deadline: 0, beatMs: BEAT_MS };
  private lastActSig: string | null = null;
  private sentAt = new Map<number, number>();
  private acks: number[] = [];
  private lags: number[] = [];
  private deskFirstPushAt: number | null = null;
  /** Every desk of every pool is held by a player: watching, and taking the first desk that frees up. */
  private waitingSeat = false;
  /** Test hook `?seatsfull=<seconds>`: treat every seat as a player's for that long after load. */
  private readonly pretendFullUntil = (() => {
    try {
      const v = Number(new URLSearchParams(location.search).get("seatsfull"));
      return Number.isFinite(v) && v > 0 ? now() + v * 1000 : 0;
    } catch {
      return 0;
    }
  })();
  private lastSentSeq: number | null = null;
  private joinErrors: string[] = [];
  private myCallDesk: number | null = null;
  private revealTop: number | null = null;
  private ackedSeq = 0;
  private cadence: CadenceStats | null = null;
  private sendFailed = 0;
  private seqSavedAt = 0;

  private config: Config | null = null;
  private tape: Tape | null = null;
  private call: Call | null = null;
  private needsFunding = false;
  private pendingClaims = new Map<string, { t: bigint; n: bigint; calledAt: number; tries: number }>();
  private claiming = false;
  private dripping = false;
  private note: { text: string; until: number } | null = null;
  private readonly playerLabel: string;
  /** Idle seat release: a round with no player input lets the seat go at the next round. */
  private keepSeat = false;
  private released = false;
  private seatedRound: bigint | null = null;

  readonly actions: GameActions = {
    place: (l) => this.place(l),
    ping: (l) => this.ping(l),
    requote: (l) => this.requote(l),
    tapeCall: (d) => void this.tapeCall(d).catch((e) => this.flash(`call failed: ${(e as Error).message}`)),
    join: () => this.join(),
  };

  readonly peek: PeekProbe = {
    run: (n) => {
      const t = this.tableId;
      const other = this.table?.seats.findIndex((_, i) => i !== this.seat) ?? -1;
      return runPeek(n, {
        teeAnon: this.cfg.teeRpc,
        teeToken: this.tee.url,
        base: this.cfg.baseRpc,
        program: this.cfg.programId,
        book: t === null ? null : this.pdas.book(t).toBase58(),
        myDesk: t === null || this.seat === null ? null : this.pdas.desk(t, this.seat).toBase58(),
        otherDesk: t === null || other < 0 ? null : { key: this.pdas.desk(t, other).toBase58(), label: this.table!.seats[other].name || `desk ${other + 1}` },
        lastActSig: this.lastActSig,
        who: this.seat === null ? "spectator" : this.playerLabel,
      });
    },
  };

  constructor(private readonly cfg: ChainConfig) {
    this.pdas = new Pdas(cfg.programId);
    this.burner = loadOrCreateBurner(this.kv);
    this.me = new PublicKey(this.burner.publicKey);
    this.tokens = new TokenStore(cfg.teeRpc, this.burner, this.kv);
    this.tee = new TeeLink(cfg, this.tokens);
    this.base = new BaseLink(cfg);
    this.clock = new SlotClock(cfg.slotMs);
    this.playerLabel = this.playerName();
  }

  /* ================================================================ lifecycle */

  start(w: StoreWriter) {
    this.w = w;
    w.set((s) => ({ table: { ...s.table, source: this.cfg.cluster }, error: null }));
    this.refreshBanner();
    this.tee.onState(() => this.refreshBanner());
    this.tee.onReplaced(() => {
      const url = this.tee.url;
      if (url) this.post({ type: "url", url });
    });
    (globalThis as unknown as { __poChain?: unknown }).__poChain = {
      status: () => this.status(),
      address: this.burner.address,
      exportKey: () => exportBurner(this.burner),
      wipeToken: () => {
        this.tokens.invalidate();
        void this.tee.reauth();
      },
      killWs: () => dropSocket(this.tee.connection),
    };
    void this.boot().catch((e) => this.fail(e));
  }

  stop() {
    this.stopped = true;
    for (const t of this.intervals) clearInterval(t);
    for (const k of Object.keys(this.watches)) this.unwatch(k);
    this.worker?.terminate();
    this.worker = null;
    this.tee.close();
    this.banner.remove();
  }

  private every(ms: number, f: () => void) {
    this.intervals.push(setInterval(() => !this.stopped && f(), ms));
  }

  private fail(e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    this.w.set({ error: msg });
    this.refreshBanner();
  }

  private async boot() {
    // 1. rollup login (no popup: the burner signs the challenge)
    for (let delay = 1000; !this.stopped; delay = Math.min(delay * 2, 10_000)) {
      try {
        this.tee.setState("connecting");
        await this.tee.connect();
        this.tee.setState("ok");
        break;
      } catch (e) {
        this.tee.setState("offline", `private rollup unreachable (${this.cfg.teeRpc}): ${(e as Error).message}`);
        this.w.set({ error: this.tee.lastError });
        await sleep(delay);
      }
    }
    if (this.stopped) return;
    this.w.set({ error: null });
    // 2. slot clock (beat deadlines are slots)
    for (let i = 0; i < 3; i++) await this.sampleSlot();
    this.every(2000, () => void this.sampleSlot());
    this.every(1000, () => this.refreshBanner());
    this.every(5000, () => void this.checkClaims());
    void this.loadConfig();
    // 3. find the pool
    while (!this.stopped && this.tableId === null) {
      await this.pickTable();
      if (this.tableId === null) await sleep(3000);
    }
  }

  private async sampleSlot() {
    const c = this.tee.connection;
    if (!c) return;
    const t0 = now();
    try {
      const slot = await c.getSlot("processed");
      this.clock.add(slot, t0, now());
      if (this.slotFails >= 3) this.tee.setState("ok");
      this.slotFails = 0;
    } catch (e) {
      if (++this.slotFails >= 3) this.tee.setState("offline", `lost the private rollup: ${(e as Error).message}`);
    }
  }

  private async loadConfig() {
    try {
      const d = await this.base.get(this.pdas.config());
      if (d && isAccount(d, "Config")) this.config = decodeConfig(d);
    } catch {
      /* the Tape check reads it again when needed */
    }
  }

  private async pickTable() {
    const found: Table[] = [];
    for (const id of this.cfg.tableIds) {
      try {
        const d = await this.tee.get(this.pdas.table(id));
        if (d && isAccount(d, "Table")) found.push(decodeTable(d));
      } catch {
        /* unreachable: retried */
      }
    }
    if (!found.length) {
      this.note = { text: `no pool found (table ids ${this.cfg.tableIds.join(", ")}) · retrying`, until: now() + 3500 };
      this.refreshBanner();
      return;
    }
    const mine = found.find((t) => t.seats.some((s) => s.key === this.burner.address));
    const humans = (t: Table) => t.seats.filter((s) => s.kind === SEAT.human).length;
    const open = (t: Table) => this.hasFreeSeat(t);
    const pick = mine ?? found.filter(open).sort((a, b) => humans(a) - humans(b))[0] ?? found[0];
    if (!mine && !open(pick)) this.waitingSeat = true;
    this.tableId = pick.tableId;
    this.watches.table = watchAccount(this.tee, this.pdas.table(pick.tableId), (d) => this.onTable(d), {
      expectEveryMs: 1000,
      onError: () => {},
    });
    this.onTable(pick);
    this.every(3000, () => void this.seekSeat());
    if (!mine && !this.waitingSeat) void this.joinFlow();
  }

  /** A seat a newcomer cannot take (a player holds it, or the test hook pretends so). */
  private heldByPlayer(t: Table, i: number): boolean {
    return now() < this.pretendFullUntil || t.seats[i].kind === SEAT.human;
  }

  private hasFreeSeat(t: Table): boolean {
    return t.kind === TABLE_KIND.house && t.seats.some((_, i) => !this.heldByPlayer(t, i));
  }

  /** While waiting for a desk: join here if one is free, else move to another pool that has one. */
  private async seekSeat() {
    if (!this.waitingSeat || this.seat !== null || this.joining || this.tableId === null) return;
    if (this.table && this.hasFreeSeat(this.table)) return void this.joinFlow();
    for (const id of this.cfg.tableIds) {
      if (id === this.tableId) continue;
      const d = await this.tee.get(this.pdas.table(id)).catch(() => null);
      if (!d || !isAccount(d, "Table")) continue;
      const t = decodeTable(d);
      if (!this.hasFreeSeat(t) || this.seat !== null || !this.waitingSeat) continue;
      // switch pools: a fresh view of the other table, then join there
      this.unwatch("table");
      this.round = null;
      this.table = null;
      this.tableId = id;
      this.watches.table = watchAccount(this.tee, this.pdas.table(id), (x) => this.onTable(x), { expectEveryMs: 1000, onError: () => {} });
      this.onTable(t);
      return void this.joinFlow();
    }
  }

  private unwatch(k: string) {
    this.watches[k]?.stop();
    delete this.watches[k];
  }

  /* ================================================================ Table */

  private onTable(raw: Uint8Array | Table | null) {
    if (raw === null) return;
    let t: Table;
    if (raw instanceof Uint8Array) {
      if (!isAccount(raw, "Table")) return;
      try {
        t = decodeTable(raw);
      } catch {
        return;
      }
    } else t = raw;
    const prev = this.table;
    this.table = t;
    if (this.round !== t.round) this.newRound(t, prev === null);

    // my seat
    const idx = t.seats.findIndex((s) => s.key === this.burner.address);
    if (idx >= 0 && idx !== this.seat) this.takeSeat(idx);
    if (idx < 0 && this.seat !== null) this.loseSeat();

    // bell / lights
    if (t.phase >= PHASE.bell && this.bellAt === null) this.bellAt = now();
    if (t.phase === PHASE.revealed && this.revealRound !== t.round) void this.loadReveal(t);

    // public beat results
    const resolved = t.phase === PHASE.live || t.phase >= PHASE.bell ? t.beat : 0;
    if (resolved > this.seenTableBeat) {
      const from = Math.max(this.seenTableBeat + 1, resolved - 2);
      for (let b = from; b <= resolved; b++) for (const p of printsOfBeat(t, b)) this.w.pushPrint(p);
      this.seenTableBeat = resolved;
      if (this.myDesk && this.myDesk.pending.kind !== "none") this.setMe({ pending: { kind: "none" } });
    }
    const counts = t.beatCounts[resolved] ?? [0, 0];
    this.w.set((s) => ({
      ready: true,
      table: {
        ...s.table, pool: String(t.tableId).padStart(4, "0"), round: Number(t.round), seats: seatsView(t), mySeat: this.released ? null : this.seat,
        lastPings: counts[0], lastFills: counts[1], source: this.cfg.cluster,
      },
      canJoin: (this.seat === null || this.released) && t.kind === TABLE_KIND.house,
      clock: this.clockOf(t),
    }));
    this.updatePlan();
    this.refreshBanner();
  }

  private timeOf(slot: bigint): number {
    return this.clock.timeOf(slot) ?? now();
  }

  private clockOf(t: Table) {
    const phase: Phase =
      t.phase === PHASE.hide ? "hide" : t.phase === PHASE.live ? "live" : t.phase >= PHASE.bell ? "lights" : "connecting";
    const beat = phase === "live" ? t.beat + 1 : phase === "lights" ? t.beat : 0;
    const liveStartedAt = this.timeOf(t.hideEndSlot);
    return {
      phase,
      beat,
      phaseEndsAt: phase === "hide" ? liveStartedAt : phase === "lights" ? (this.bellAt ?? now()) + LIGHTS_MS : 0,
      beatEndsAt: phase === "live" ? this.timeOf(t.nextDeadlineSlot) : 0,
      liveStartedAt,
      bellChance: phase === "live" ? bellChance(beat) : 0,
    };
  }

  private newRound(t: Table, first: boolean) {
    this.round = t.round;
    if (!first && this.seat !== null && !this.released && !this.keepSeat && this.seatedRound !== null && t.round - this.seatedRound >= 2n) {
      // nobody touched this desk for a whole round: stop acting so the house can give the seat back to a bot
      this.released = true;
      this.myDesk = null;
    }
    this.keepSeat = false;
    // joining mid-round: do not replay old beats as fresh results
    this.seenTableBeat = first || t.phase !== PHASE.hide ? t.beat : 0;
    this.seenDeskBeat = this.seenTableBeat;
    this.bellAt = t.phase >= PHASE.bell ? now() : null;
    this.tape = null;
    this.call = null;
    this.myCallDesk = null;
    this.revealTop = null;
    if (this.myDesk) this.myDesk = { ...this.freshMe(), level: this.myDesk.level };
    this.w.set((s) => ({
      reveal: null,
      results: [],
      me: this.myDesk,
      tape: { pool: new Array(DESKS).fill(0), closeBeat: TAPE_CLOSE_BEAT, myCall: null, needsFunding: this.needsFunding },
      table: { ...s.table, prints: [] },
    }));
    this.unwatch("tape");
    this.unwatch("call");
    if (t.recorded && this.tableId !== null) this.watchTape(this.tableId, t.round);
  }

  /* ================================================================ seat + Desk */

  private freshMe(): MyDesk {
    return {
      level: 0, resting: 0, picked: 0, nextAlgo: 0, pending: { kind: "none" }, marks: {},
      lastFill: null, nextSkim: SKIM_STEP, exposure: SKIM_STEP, pickedOffBeat: null,
    };
  }

  private setMe(p: Partial<MyDesk>) {
    if (!this.myDesk) return;
    this.myDesk = { ...this.myDesk, ...p };
    if (!this.released) this.w.set({ me: this.myDesk });
  }

  private takeSeat(idx: number) {
    if (this.tableId === null) return;
    this.waitingSeat = false;
    this.unwatch("desk");
    this.seat = idx;
    this.desk = null;
    this.deskReadable = false;
    this.released = false;
    this.seatedRound = this.round;
    this.myDesk = this.freshMe();
    this.w.set((s) => ({ me: null, canJoin: false, table: { ...s.table, mySeat: idx } }));
    const key = this.pdas.desk(this.tableId, idx);
    this.deskFirstPushAt = null;
    this.watches.desk = watchAccount(this.tee, key, (d, via) => this.onDesk(d, via), {
      expectEveryMs: 500,
      isLive: () => !!this.table && (this.table.phase === PHASE.hide || this.table.phase === PHASE.live),
      onError: () => {},
    });
  }

  private loseSeat() {
    this.unwatch("desk");
    this.released = false;
    this.seat = null;
    this.desk = null;
    this.deskReadable = false;
    this.myDesk = null;
    this.updatePlan();
    this.w.set((s) => ({ me: null, canJoin: true, table: { ...s.table, mySeat: null } }));
  }

  private onDesk(raw: Uint8Array | null, via: "push" | "poll" = "poll") {
    const arrivedAt = now();
    if (via === "push" && raw && this.deskFirstPushAt === null) this.deskFirstPushAt = arrivedAt;
    const t = this.table;
    if (!raw || !isAccount(raw, "Desk")) {
      this.deskReadable = false;
      this.updatePlan();
      return;
    }
    let d: Desk;
    try {
      d = decodeDesk(raw);
    } catch {
      return;
    }
    if (d.key !== this.burner.address) {
      this.deskReadable = false;
      this.updatePlan();
      return;
    }
    this.desk = d;
    this.deskReadable = true;
    this.ensureWorker(d);
    this.post({ type: "seqFloor", floor: d.lastSeq });
    this.trackAcks(d.lastSeq);
    if (this.released) {
      this.seenDeskBeat = Math.max(this.seenDeskBeat, Math.min(d.beat, 29));
      this.updatePlan();
      return;
    }
    if (!this.myDesk) this.myDesk = this.freshMe();

    if (t && d.round === t.round) {
      // private results of every newly resolved beat, in order
      const top = Math.min(d.beat, 29);
      let marks = this.myDesk.marks;
      let { lastFill, nextSkim, exposure, pickedOffBeat } = this.myDesk;
      for (let b = this.seenDeskBeat + 1; b <= top; b++) {
        const r = d.results[b];
        if (r.actionKind === ACT_REQUOTE) {
          exposure = SKIM_STEP;
          pickedOffBeat = null;
          if (lastFill === r.level) lastFill = null;
        }
        // anchor the measured number on this beat's scheduled close (its deadline slot)
        const close = this.timeOf(t.hideEndSlot + BigInt(b) * t.beatSlots);
        // The one number counts only genuine samples: the latest beat of this update, delivered by
        // the live subscription, with the slot clock already fitted and the subscription already
        // pushing before the beat's deadline (so not the takeover beat or a catch-up read).
        // Slow genuine results are kept.
        let latencyMs: number | undefined;
        if (b === top && via === "push" && this.clock.fitted && this.deskFirstPushAt !== null && this.deskFirstPushAt < close) {
          latencyMs = arrivedAt - close;
          this.lags.push(latencyMs);
          if (this.lags.length > 1000) this.lags.shift();
        }
        this.w.set((s) => ({ clock: { ...s.clock, liveStartedAt: close - b * BEAT_MS } }));
        for (const res of resultsOfBeat(b, r)) {
          if (res.kind === "pickedoff") {
            exposure = res.next ?? exposure;
            pickedOffBeat = b;
          } else {
            marks = { ...marks, [res.level!]: res.kind === "fill" ? "fill" : "miss" };
            if (res.kind === "fill") {
              lastFill = res.level!;
              nextSkim = res.next ?? nextSkim;
            } else if (lastFill === res.level) lastFill = null;
          }
          this.w.pushResult(latencyMs === undefined ? res : { ...res, latencyMs });
        }
      }
      if (top > this.seenDeskBeat) this.seenDeskBeat = top;
      this.setMe({ level: d.level, resting: d.resting, picked: d.picked, nextAlgo: d.nextAlgo, marks, lastFill, nextSkim, exposure, pickedOffBeat });
    } else {
      this.setMe({ level: d.level, resting: d.resting, picked: d.picked, nextAlgo: d.nextAlgo });
    }
    if (this.announceJoin && d.level) {
      this.announceJoin = false;
      this.w.set({ joinNotice: { name: this.playerLabel, seat: d.index, level: d.level, resting: d.resting } });
    }
    this.updatePlan();
  }

  private trackAcks(lastSeq: number) {
    if (lastSeq <= this.ackedSeq) return;
    const sent = this.sentAt.get(lastSeq);
    if (sent !== undefined) {
      this.acks.push(Date.now() - sent);
      if (this.acks.length > 1000) this.acks.shift();
    }
    for (const k of this.sentAt.keys()) if (k <= lastSeq) this.sentAt.delete(k);
    this.ackedSeq = lastSeq;
  }

  /* ================================================================ act sender */

  private seqKey(desk: string) {
    return `ping-seq-v1:${desk}`;
  }

  private ensureWorker(d: Desk) {
    if (this.tableId === null || this.seat === null) return;
    const desk = this.pdas.desk(this.tableId, this.seat).toBase58();
    if (this.workerSetupFor === desk) return;
    const url = this.tee.url;
    if (!url) return;
    if (!this.worker) {
      if (typeof Worker === "undefined") return;
      try {
        this.worker = new Worker(new URL("./sender.worker.ts", import.meta.url), { type: "module" });
      } catch (e) {
        this.fail(e);
        return;
      }
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onWorker(e.data);
      this.worker.onerror = (e) => this.fail(new Error(`act sender: ${e.message}`));
    }
    let stored = 0;
    try {
      stored = Number(this.kv.getItem(this.seqKey(desk)) ?? 0) || 0;
    } catch {
      stored = 0;
    }
    // continue above the desk's ack and above anything this browser may still have in flight
    const floor = Math.max(d.lastSeq, stored) + 16;
    this.workerSetupFor = desk;
    this.post({
      type: "setup",
      setup: {
        secretKey: this.burner.secretKey, player: this.burner.address, desk, book: this.pdas.book(this.tableId).toBase58(),
        program: this.cfg.programId, url, seqFloor: floor,
      },
    });
    this.post({ type: "plan", plan: this.plan });
  }

  private post(m: ToWorker) {
    this.worker?.postMessage(m);
  }

  private onWorker(m: FromWorker) {
    if (m.type === "sent") {
      const r = m.r;
      this.lastSentSeq = r.seq;
      if (r.ok) {
        this.lastActSig = r.signature;
        this.sentAt.set(r.seq, r.at);
      } else this.sendFailed++;
      if (Date.now() - this.seqSavedAt > 1000 && this.workerSetupFor) {
        this.seqSavedAt = Date.now();
        try {
          this.kv.setItem(this.seqKey(this.workerSetupFor), String(r.seq));
        } catch {
          /* ignore */
        }
      }
    } else if (m.type === "unauthorized") {
      void this.tee.reauth();
    } else if (m.type === "stats") {
      this.cadence = m.stats;
      this.sendFailed = Math.max(this.sendFailed, m.failed);
    }
  }

  /** Sending is allowed only while our own sealed Desk is readable for this round. */
  private canSend(): boolean {
    const t = this.table;
    const d = this.desk;
    if (!t || !d || this.seat === null || !this.deskReadable || this.released) return false;
    if (t.phase !== PHASE.hide && t.phase !== PHASE.live) return false;
    if (t.seats[this.seat]?.key !== this.burner.address || d.round !== t.round) return false;
    const deskSealed = (t.sealed >> this.seat) & 1;
    const bookSealed = (t.sealed >> 8) & 1;
    return deskSealed === 1 && bookSealed === 1;
  }

  private updatePlan() {
    const t = this.table;
    let plan: Plan;
    if (!t || !this.canSend()) plan = { phase: "off", deadline: 0, beatMs: BEAT_MS };
    else {
      const beatMs = this.clock.ready ? Number(t.beatSlots) * this.clock.slotMs : BEAT_MS;
      plan = { phase: t.phase === PHASE.hide ? "hide" : "live", deadline: toEpoch(this.timeOf(t.nextDeadlineSlot)), beatMs: beatMs > 0 ? beatMs : BEAT_MS };
    }
    const same = plan.phase === this.plan.phase && Math.abs(plan.deadline - this.plan.deadline) < 3 && Math.abs(plan.beatMs - this.plan.beatMs) < 1;
    if (same) return;
    this.plan = plan;
    this.post({ type: "plan", plan });
  }

  /* ================================================================ actions */

  private place(level: number) {
    if (this.myDesk && !this.released) this.keepSeat = true;
    if (!this.myDesk || this.table?.phase !== PHASE.hide || level < 1 || level > LEVELS) return;
    this.post({ type: "choose", kind: ACT_REQUOTE, level });
    this.setMe({ level });
  }

  private ping(level: number) {
    if (this.myDesk && !this.released) this.keepSeat = true;
    if (!this.myDesk || this.table?.phase !== PHASE.live || level < 1 || level > LEVELS) return;
    this.post({ type: "choose", kind: ACT_PING, level });
    this.setMe({ pending: { kind: "ping", level } });
  }

  private requote(level: number | null) {
    if (!this.myDesk || this.released) return;
    this.keepSeat = true;
    const own = this.myDesk.level;
    const pickLevel = () => {
      const marks = this.myDesk!.marks;
      const opts = Array.from({ length: LEVELS }, (_, i) => i + 1).filter((x) => x !== own && !marks[x]);
      const all = opts.length ? opts : Array.from({ length: LEVELS }, (_, i) => i + 1).filter((x) => x !== own);
      return all[crypto.getRandomValues(new Uint32Array(1))[0] % all.length];
    };
    if (this.table?.phase === PHASE.hide) return this.place(level ?? pickLevel());
    if (this.table?.phase !== PHASE.live) return;
    const L = level ?? pickLevel();
    if (L === own || L < 1 || L > LEVELS) return;
    this.post({ type: "choose", kind: ACT_REQUOTE, level: L });
    this.setMe({ pending: { kind: "requote", level: L } });
  }

  private join() {
    this.keepSeat = true;
    if (this.seat !== null && this.released) {
      // the seat is still ours on chain: take it back without a transaction
      this.released = false;
      this.seatedRound = this.round;
      this.myDesk = this.desk ? { ...this.freshMe(), level: this.desk.level, resting: this.desk.resting, picked: this.desk.picked, nextAlgo: this.desk.nextAlgo } : this.freshMe();
      this.w.set((s) => ({ me: this.myDesk, canJoin: false, table: { ...s.table, mySeat: this.seat } }));
      this.updatePlan();
      return;
    }
    void this.joinFlow();
  }

  private async joinFlow() {
    if (this.joining || this.seat !== null || !this.table || this.tableId === null) return;
    if (this.table.kind !== TABLE_KIND.house) return;
    const tid = this.tableId;
    this.joining = true;
    this.refreshBanner();
    const tried = new Set<number>();
    try {
      // seats are refused during BELL / ABORTED (a short window): wait it out and retry
      for (let attempt = 0; attempt < 120 && !this.stopped && this.seat === null; attempt++) {
        const t = this.table!;
        if (tried.size >= 8) {
          // every seat refused this time (e.g. a phase the program does not seat in): start over shortly
          tried.clear();
          await sleep(1500);
          await this.refreshTable(tid);
          continue;
        }
        if (t.phase === PHASE.bell || t.phase === PHASE.aborted) {
          await sleep(500);
          await this.refreshTable(tid);
          continue;
        }
        const free = (k: number) => [...t.seats.keys()].filter((i) => t.seats[i].kind === k && !this.heldByPlayer(t, i) && !tried.has(i));
        const seat = free(SEAT.empty)[0] ?? free(SEAT.bot)[0];
        if (seat === undefined) {
          if (!this.hasFreeSeat(t)) {
            // every desk is a player's: watch, and take the first one that frees up (seekSeat)
            this.waitingSeat = true;
            break;
          }
          for (let i = 0; i < 8; i++) tried.add(i);
          continue;
        }
        const c = this.tee.connection;
        if (!c) break;
        this.announceJoin = true;
        try {
          await this.sendTx(c, [joinIx(this.pdas, tid, seat, this.me, this.playerLabel)], false);
        } catch (e) {
          this.joinErrors.push(`seat ${seat}: ${(e as Error).message}`.slice(0, 240));
          if (this.joinErrors.length > 8) this.joinErrors.shift();
          // a phase refusal is retried on the same seat; anything else moves to another seat
          await this.refreshTable(tid);
          if (this.table!.phase !== PHASE.bell && this.table!.phase !== PHASE.aborted) tried.add(seat);
          await sleep(300);
          continue;
        }
        for (let i = 0; i < 25 && !this.stopped && this.seat === null; i++) {
          await sleep(200);
          await this.refreshTable(tid);
        }
        tried.add(seat);
      }
      if (this.seat === null && !this.waitingSeat) this.flash("could not take a seat · try again");
      if (this.seat !== null) this.waitingSeat = false;
    } finally {
      this.joining = false;
      this.refreshBanner();
    }
  }

  private async refreshTable(tid: bigint) {
    const d = await this.tee.get(this.pdas.table(tid)).catch(() => null);
    if (d) this.onTable(d);
  }

  /** Sign with the burner and send; resolves with the signature once confirmed (or throws). */
  private async sendTx(c: Connection, ixs: TransactionInstruction[], preflight: boolean): Promise<string> {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = this.me;
    tx.recentBlockhash = (await c.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(Keypair.fromSecretKey(this.burner.secretKey));
    // preflight against the newest state, so a tx another party has just made invalid is refused, not landed
    const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: !preflight, preflightCommitment: "processed", maxRetries: 3 });
    for (let i = 0; i < 60; i++) {
      const st = await c.getSignatureStatuses([sig]).catch(() => null);
      const v = st?.value?.[0];
      if (v?.err) throw new Error(`transaction failed: ${JSON.stringify(v.err)}`);
      if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) return sig;
      await sleep(250);
    }
    throw new Error("transaction not confirmed");
  }

  /* ================================================================ Tape (base layer) */

  private watchTape(t: bigint, n: bigint) {
    const tapeKey = this.pdas.tape(t, n);
    this.watches.tape = watchAccount(this.base, tapeKey, (d) => this.onTape(d), { expectEveryMs: 3000, subscribe: false, onError: () => {} });
    this.watches.call = watchAccount(this.base, this.pdas.call(tapeKey, this.me), (d) => this.onCall(d), { expectEveryMs: 4000, subscribe: false, onError: () => {} });
  }

  private tapeView(): TapeView {
    const tp = this.tape;
    const pool = tp ? tp.pool.map((x) => Number(x)) : new Array(DESKS).fill(0);
    let paid: TapeView["paid"];
    if (tp?.resolved) paid = tp.void || !tp.pool[tp.winner] ? "refund" : Number(tp.total) / Number(tp.pool[tp.winner]);
    else if (tp && this.revealTop !== null && tp.total > 0n) {
      // calls are closed by the bell, so the pool is final: the settle will pay this multiple
      const onTop = tp.pool[this.revealTop];
      paid = onTop > 0n ? Number(tp.total) / Number(onTop) : "refund";
    }
    return { pool, closeBeat: TAPE_CLOSE_BEAT, myCall: this.myCallDesk, paid, needsFunding: this.needsFunding };
  }

  private onTape(d: Uint8Array | null) {
    if (!d || !isAccount(d, "Tape")) return;
    const tp = decodeTape(d);
    if (this.round !== null && tp.round !== this.round) return;
    this.tape = tp;
    this.w.set({ tape: this.tapeView() });
  }

  private onCall(d: Uint8Array | null) {
    this.call = d && isAccount(d, "Call") ? decodeCall(d) : null;
    // a Call that disappears after the settle was paid out (anyone may send the claim)
    if (this.call) this.myCallDesk = this.call.desk;
    this.w.set({ tape: this.tapeView() });
  }

  /**
   * Claims are a fallback: the house sweeps settle + claim right after each recorded round, and a
   * client claim racing it would fail on chain. So the client claims only CLAIM_AFTER_MS after its
   * call, only if the Call is still open when read just before sending, and always as
   * settle_round + claim_call in one transaction. A Call that is gone was paid: say so.
   */
  private async checkClaims() {
    if (this.claiming || !this.pendingClaims.size) return;
    this.claiming = true;
    try {
      for (const [id, p] of [...this.pendingClaims]) {
        const tapeKey = this.pdas.tape(p.t, p.n);
        const d = await this.base.connection.getAccountInfo(this.pdas.call(tapeKey, this.me), "processed").catch(() => undefined);
        if (d === undefined) continue;
        const call = d && isAccount(d.data, "Call") ? decodeCall(d.data) : null;
        if (!call) {
          this.pendingClaims.delete(id);
          this.flash(`Tape call on round ${p.n} settled and paid`);
          continue;
        }
        if (call.claimed || call.owed > 0n) {
          this.pendingClaims.delete(id);
          continue;
        }
        if (now() - p.calledAt < CLAIM_AFTER_MS || p.tries >= 5) continue;
        p.tries++;
        try {
          await this.claim(p.t, p.n);
          this.pendingClaims.delete(id);
        } catch {
          /* not committed yet, or already claimed in between: preflight refused it, nothing landed */
        }
      }
    } finally {
      this.claiming = false;
    }
  }

  private async funded(need: number): Promise<boolean> {
    const bal = await this.base.connection.getBalance(this.me, "confirmed");
    const ok = bal >= need;
    if (this.needsFunding !== !ok) {
      this.needsFunding = !ok;
      this.w.set({ tape: this.tapeView() });
      this.refreshBanner();
    }
    return ok;
  }

  private async tapeCall(desk: number) {
    const t = this.table;
    this.keepSeat = true;
    if (!t || this.tableId === null || this.round === null || desk < 0 || desk >= DESKS || this.myCallDesk !== null) return;
    if (!t.recorded) return this.flash("no Tape on this round");
    if (t.phase >= PHASE.bell || (t.phase === PHASE.live && t.beat >= TAPE_CLOSE_BEAT)) return this.flash("the Tape is closed");
    if (!this.config) await this.loadConfig();
    const callLamports = Number(this.config?.callLamports ?? 10_000_000n);
    const rent = await this.base.connection.getMinimumBalanceForRentExemption(CALL_ACCOUNT_BYTES);
    const need = callLamports + rent + BASE_FEE_RESERVE;
    if (!(await this.funded(need)) && !(await this.drip(need))) return;
    const round = this.round;
    if (this.round === null || this.myCallDesk !== null) return;
    await this.sendTx(this.base.connection, [placeCallIx(this.pdas, this.tableId, round, this.me, desk)], true);
    this.pendingClaims.set(`${this.tableId}:${round}`, { t: this.tableId, n: round, calledAt: now(), tries: 0 });
    if (this.round === round) {
      this.myCallDesk = desk;
      this.w.set({ tape: this.tapeView() });
    }
    this.watches.call?.poke();
    this.watches.tape?.poke();
  }

  /** Ask the devnet drip for SOL for one call and wait until it lands; false (and a message) on failure. */
  private async drip(need: number): Promise<boolean> {
    if (!this.cfg.dripUrl) {
      this.flash(`Tape calls need devnet SOL on this browser's key ${this.burner.address}`);
      return false;
    }
    if (this.dripping) return false;
    this.dripping = true;
    this.refreshBanner();
    try {
      const res = await fetch(this.cfg.dripUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: this.burner.address }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      for (let i = 0; i < 40 && !this.stopped; i++) {
        if (await this.funded(need).catch(() => false)) return true;
        await sleep(500);
      }
      throw new Error("the SOL did not arrive in 20 s");
    } catch (e) {
      this.flash(`no devnet SOL for the call: ${(e as Error).message}`);
      return false;
    } finally {
      this.dripping = false;
      this.refreshBanner();
    }
  }

  private async claim(t: bigint, n: bigint) {
    if (!(await this.funded(BASE_FEE_RESERVE))) throw new Error("no SOL for the fee");
    // client rule: settle_round and claim_call in the same transaction
    await this.sendTx(this.base.connection, [settleRoundIx(this.pdas, t, n, this.me), claimCallIx(this.pdas, t, n, this.me, this.me)], true);
    this.flash("Tape call settled and claimed");
  }

  /* ================================================================ reveal */

  private async loadReveal(t: Table) {
    if (this.tableId === null) return;
    const n = t.round;
    this.revealRound = n;
    const tid = this.tableId;
    for (let attempt = 0; attempt < 30 && !this.stopped && this.round === n; attempt++) {
      let record: Uint8Array | null = null;
      let commit: Uint8Array | null = null;
      try {
        if (t.recorded) {
          const key = this.pdas.round(tid, n);
          const d = (await this.tee.get(key).catch(() => null)) ?? (await this.base.get(key).catch(() => null));
          if (d && isAccount(d, "Round")) {
            const r = decodeRound(d);
            if (r.status === ROUND_STATUS.revealed) {
              record = r.record;
              commit = r.commitHash;
            }
          }
        } else {
          const d = await this.tee.get(this.pdas.book(tid)).catch(() => null);
          if (d && isAccount(d, "Book")) {
            const b = decodeBook(d);
            if (b.round === n) {
              record = recordFromBook(b.state, tid, n);
              commit = this.table?.commitHash ?? t.commitHash;
            }
          }
        }
      } catch {
        /* retry */
      }
      if (record && commit) {
        const built = buildReveal(record, commit, Number(n));
        if (!built) break;
        const startedAt = this.bellAt ?? now();
        if (built.check.state === "ok") this.revealTop = built.view.topDesk;
        this.w.set({ tape: this.tapeView() });
        this.w.set({ reveal: { ...built.view, check: { state: "pending" }, startedAt, explorerUrl: this.explorer(tid, n, t.recorded === 1) }, joinNotice: null });
        const wait = Math.max(0, startedAt + 6000 - now());
        setTimeout(() => {
          this.w.set((s) => (s.reveal && s.reveal.round === Number(n) ? { reveal: { ...s.reveal, check: { state: built.check.state, hash: built.check.hash } } } : {}));
        }, wait);
        return;
      }
      await sleep(400);
    }
  }

  private explorer(tid: bigint, n: bigint, recorded: boolean): string | undefined {
    if (!recorded || this.cfg.explorer === null) return undefined;
    return `https://explorer.solana.com/address/${this.pdas.round(tid, n).toBase58()}${this.cfg.explorer}`;
  }

  /* ================================================================ status */

  private flash(text: string) {
    this.note = { text, until: now() + 4000 };
    this.refreshBanner();
  }

  private refreshBanner() {
    if (this.stopped) return;
    let b: Banner = null;
    const t = this.table;
    if (this.tee.state === "offline") b = { kind: "offline", text: `offline · ${this.tee.lastError ?? "rollup unreachable"} · retrying` };
    else if (this.tee.state === "connecting" && !this.tee.connection) b = { kind: "connecting", text: "connecting to the private rollup · signing in with this browser's key (no wallet)" };
    else if (this.tee.state === "connecting") b = { kind: "connecting", text: this.tee.lastError ?? "reconnecting" };
    else if (this.note && this.note.until > now()) b = { kind: "info", text: this.note.text };
    else if (!t) b = { kind: "connecting", text: "looking for a pool" };
    else if (this.waitingSeat && this.seat === null && !this.joining)
      b = { kind: "waiting", text: "all desks taken · you are watching · a desk frees up after each round and you take it automatically" };
    else if (this.joining) b = { kind: "connecting", text: "taking a seat" };
    else if (t.phase === PHASE.idle) b = { kind: "waiting", text: "waiting for the house to open the first round" };
    else if (this.dripping) b = { kind: "connecting", text: "getting devnet SOL for your Tape call from the drip" };
    else if (this.needsFunding) b = { kind: "info", text: `Tape calls need devnet SOL on this browser's key ${this.burner.address.slice(0, 6)}…` };
    this.banner.show(b);
  }

  private status(): ChainStatus {
    const ws: ChainStatus["watches"] = {};
    for (const [k, v] of Object.entries(this.watches)) ws[k] = { ...v.stats };
    return {
      cluster: this.cfg.cluster,
      burner: this.burner.address,
      link: this.tee.state,
      linkError: this.tee.lastError,
      tableId: this.tableId?.toString() ?? null,
      round: this.round?.toString() ?? null,
      seat: this.seat,
      deskReadable: this.deskReadable,
      sending: this.plan.phase !== "off",
      cadence: this.cadence,
      sendFailed: this.sendFailed,
      ackP50: pct(this.acks, 50),
      ackP95: pct(this.acks, 95),
      ackN: this.acks.length,
      resultLagP50: pct(this.lags, 50),
      resultLagP95: pct(this.lags, 95),
      resultLagN: this.lags.length,
      resultLags: this.lags.slice(-60).map((x) => Math.round(x)),
      deskActs: this.desk?.acts ?? null,
      deskLastSeq: this.desk?.lastSeq ?? null,
      lastSentSeq: this.lastSentSeq,
      joinErrors: [...this.joinErrors],
      slotMs: this.clock.slotMs,
      needsFunding: this.needsFunding,
      watches: ws,
    };
  }

  private playerName(): string {
    try {
      const k = this.kv.getItem("po.name");
      if (k) return k;
      const r = crypto.getRandomValues(new Uint32Array(2));
      const n = `${ADJ[r[0] % ADJ.length]}-${ANIMAL[r[1] % ANIMAL.length]}`;
      this.kv.setItem("po.name", n);
      return n;
    } catch {
      return "bright-otter";
    }
  }
}
