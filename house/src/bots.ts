// House bots: ordinary desks driven off-chain. Each bot has its own key and rollup token, reads only
// its own Desk (through its own token) and the public Table, and sends exactly one `act` every
// 250 ms while its round is in HIDE or LIVE: its latest choice, otherwise a no-op. It uses a private
// result only after a sampled human reaction time and is present on a share of beats, with absences
// in streaks; when absent it sends no-ops and the program's algo pings for it, as for a silent human.
import path from "node:path";
import crypto from "node:crypto";
import { Transaction } from "@solana/web3.js";
import { Chain, Keypair, PublicKey, Reader, actIx, ACT_DISC, decodeDesk, loadOrCreateKeypair, ACT, PHASE, RES, LEVELS, type DeskView, type DeskRow, type TableView } from "./chain.ts";
import { log } from "./log.ts";

// ------------------------------------------------------------------ personalities
export type Kind = "shark" | "ghost" | "minnow";
export interface Personality {
  kind: Kind; code: number; label: string;
  present: number; lapseBeats: number; // share of beats present; mean absence streak in beats
  flee: number; // re-quote probability after being PICKED OFF since the last action
  idle: number; // otherwise, idle re-quote probability
  follow: number; // re-ping the last FILL level (until it misses)
  memory: number; // sweep: ping a level last pinged more than this many beats ago
}
export const PERSONALITIES: Record<Kind, Personality> = {
  shark: { kind: "shark", code: 1, label: "SHARK", present: 0.9, lapseBeats: 2, flee: 0.3, idle: 0, follow: 1.0, memory: 8 },
  ghost: { kind: "ghost", code: 2, label: "GHOST", present: 0.9, lapseBeats: 2, flee: 1.0, idle: 0.1, follow: 0.6, memory: 6 },
  minnow: { kind: "minnow", code: 3, label: "MINNOW", present: 0.75, lapseBeats: 3, flee: 0.5, idle: 0.03, follow: 0.7, memory: 3 },
};
/** Seat → personality for an all-bot pool: 2 Shark, 3 Ghost, 2 Minnow plus one extra Minnow. */
export const SEAT_MIX: Kind[] = ["shark", "ghost", "minnow", "shark", "ghost", "minnow", "ghost", "minnow"];
export function seatName(seat: number): string {
  const kind = SEAT_MIX[seat];
  const n = SEAT_MIX.slice(0, seat + 1).filter((k) => k === kind).length;
  return `${PERSONALITIES[kind].label}-${n}`;
}

/** Reaction time: lognormal, median 0.9 s, sigma 0.35. */
export function reactionMs(rand = Math.random): number {
  const u = Math.max(rand(), 1e-12), v = rand();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return 900 * Math.exp(0.35 * z);
}

export type Choice = { kind: number; level: number };

/** The decision state of one bot within one round (pure; no I/O). */
export class Brain {
  hit: number | null = null; // last FILL level, until that level misses
  raided = false; // PICKED OFF since the last action
  last = new Array(LEVELS + 1).fill(-99); // beat each level was last pinged by this desk
  level = 0; // own level
  present: boolean;
  private a: number; private b: number;
  constructor(public p: Personality, private rand = Math.random) {
    this.b = 1 / p.lapseBeats;
    this.a = (this.b * (1 - p.present)) / p.present;
    this.present = rand() < p.present;
  }
  /** Markov presence step for the next beat (absences in streaks of mean `lapseBeats`). */
  step(): boolean {
    if (this.present) { if (this.rand() < this.a) this.present = false; }
    else if (this.rand() < this.b) this.present = true;
    return this.present;
  }
  /** Private result of a resolved beat (row b of the own Desk). */
  feedback(beat: number, row: DeskRow) {
    if (row.level) this.level = row.level;
    if (row.actionKind === ACT.ping && row.actionLevel) {
      this.last[row.actionLevel] = beat;
      if (row.result === RES.fill) this.hit = row.actionLevel;
      else if (row.result === RES.miss && this.hit === row.actionLevel) this.hit = null;
    }
    if (row.lostAmt > 0 || row.hitsTaken > 0) this.raided = true;
  }
  /** Uniform over levels not excluded and not pinged within the memory; else any level not excluded. */
  private fresh(beat: number, exclude: Set<number>): number {
    const all = Array.from({ length: LEVELS }, (_, i) => i + 1).filter((c) => !exclude.has(c));
    const cool = all.filter((c) => beat - this.last[c] > this.p.memory);
    const pool = cool.length ? cool : all;
    return pool[Math.floor(this.rand() * pool.length)];
  }
  hideLevel(): number { return 1 + Math.floor(this.rand() * LEVELS); }
  /** The action for live beat `beat`: flee when picked off, else maybe an idle re-quote, else follow a FILL, else sweep. */
  decide(beat: number): Choice {
    const own = this.level;
    const avoid = new Set<number>([own]);
    if (this.hit !== null) avoid.add(this.hit);
    let out: Choice | null = null;
    if (this.raided && this.rand() < this.p.flee) out = { kind: ACT.requote, level: this.fresh(beat, avoid) };
    else if (this.p.idle && this.rand() < this.p.idle) out = { kind: ACT.requote, level: this.fresh(beat, avoid) };
    this.raided = false;
    if (out) return out;
    if (this.hit !== null && this.hit !== own && this.rand() < this.p.follow) return { kind: ACT.ping, level: this.hit };
    return { kind: ACT.ping, level: this.fresh(beat, new Set([own])) };
  }
}

// ------------------------------------------------------------------ the shared view a pool gives its bots (public Table only)
export interface Snapshot { table: TableView; slot: number; at: number; slotMs: number }
export interface PoolView { tableId: number; snap: Snapshot | null; book: PublicKey; blockhash(): string | null }

interface RoundStats { reported?: boolean; round: number; sent: number; sendErr: number; firstSend: number; lastSend: number; pings: number; requotes: number; place: number; present: number; absent: number; rtSum: number; rtN: number; algo: number; fills: number; picked: number; final?: DeskView }

// ------------------------------------------------------------------ one bot
export class Bot {
  readonly key: Keypair;
  readonly desk: PublicKey;
  private token = "";
  private tokenExp = 0;
  private reader!: Reader;
  private sendUrl = "";
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private round = -1;
  private ready = false; // own Desk read in this round, reset and sealed with us as member
  private processed = -1; // last beat whose result was taken in
  private reading = false;
  private brain: Brain;
  private choice: Choice | null = null;
  private decideAt = 0;
  private hidePlaceAt = 0;
  private seq = 0;
  stats: RoundStats | null = null;
  onRoundDone: ((s: RoundStats, bot: Bot) => void) | null = null;

  constructor(private chain: Chain, private pool: PoolView, readonly seat: number, readonly personality: Personality, keysDir: string) {
    this.key = loadOrCreateKeypair(path.join(keysDir, `t${pool.tableId}-s${seat}.json`));
    this.desk = chain.pda.desk(pool.tableId, seat);
    this.brain = new Brain(personality);
  }
  get name() { return seatName(this.seat); }
  get running() { return !this.stopped && this.timer !== null; }

  private async ensureToken() {
    if (this.token && Date.now() < this.tokenExp - 60_000) return;
    const { token, expiresAt } = await this.chain.token(this.key);
    this.token = token;
    this.tokenExp = expiresAt && expiresAt > 1e12 ? expiresAt : expiresAt ? expiresAt * 1000 : Date.now() + 10 * 60_000;
    const url = this.chain.erUrl(token);
    this.reader = new Reader(url, `bot:${this.key.publicKey.toBase58()}`, "er");
    this.sendUrl = url;
  }

  async start() {
    if (this.timer || this.stopped) return;
    await this.ensureToken();
    const offset = (this.seat * 31) % 250; // spread the 8 desks over the 250-ms period
    const loop = () => {
      if (this.stopped) return;
      this.slot().catch((e) => log.warn("bot_slot_error", { pool: this.pool.tableId, seat: this.seat, err: String(e?.message ?? e) }));
      if (this.stopped) { this.timer = null; return; } // stopped inside this slot (seat taken): do not re-arm
      const now = Date.now();
      // next boundary recomputed from the wall clock every time (never from a stale step)
      const next = Math.floor((now - offset) / 250) * 250 + 250 + offset;
      this.timer = setTimeout(loop, Math.max(1, next - now));
    };
    this.timer = setTimeout(loop, 1);
  }
  stop(reason: string) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopped = true;
    log.info("bot_stopped", { pool: this.pool.tableId, seat: this.seat, name: this.name, key: this.key.publicKey.toBase58(), reason });
  }

  /** One 250-ms slot: check the seat, take in new results, send exactly one act while in play. */
  private async slot() {
    const snap = this.pool.snap;
    if (!snap) return;
    const t = snap.table;
    if (t.seats[this.seat].key !== this.key.publicKey.toBase58()) { this.stop(t.seats[this.seat].kind === 1 ? "seat taken by a player" : "seat no longer ours"); return; }
    if (t.round !== this.round) this.newRound(t.round);
    const inPlay = t.phase === PHASE.hide || t.phase === PHASE.live;
    if (!inPlay) {
      if ((t.phase === PHASE.bell || t.phase === PHASE.revealed) && this.ready && this.stats && !this.stats.final && !this.reading) this.finalRead();
      return;
    }
    if (!this.ready || (t.phase === PHASE.live && t.beat > this.processed)) {
      if (!this.reading) this.readDesk(t);
      if (!this.ready) return; // never send before the own Desk of this round is readable to us (sealed, reset)
    }
    const now = Date.now();
    let c: Choice = { kind: ACT.noop, level: 0 };
    if (t.phase === PHASE.hide) {
      if (this.hidePlaceAt && now >= this.hidePlaceAt) {
        if (!this.choice) { this.choice = { kind: ACT.requote, level: this.brain.hideLevel() }; this.stats!.place++; }
        c = this.choice;
      }
    } else {
      if (this.decideAt && now >= this.decideAt) {
        this.choice = this.brain.decide(t.beat + 1);
        this.decideAt = 0;
        if (this.choice.kind === ACT.ping) this.stats!.pings++; else this.stats!.requotes++;
      }
      if (this.choice) c = this.choice;
    }
    this.sendAct(c);
  }

  private newRound(n: number) {
    this.report();
    this.round = n;
    this.ready = false;
    this.processed = -1;
    this.choice = null;
    this.decideAt = 0;
    this.hidePlaceAt = 0;
    this.brain = new Brain(this.personality);
    this.stats = { round: n, sent: 0, sendErr: 0, firstSend: 0, lastSend: 0, pings: 0, requotes: 0, place: 0, present: 0, absent: 0, rtSum: 0, rtN: 0, algo: 0, fills: 0, picked: 0 };
  }

  private async readDesk(t: TableView) {
    this.reading = true;
    try {
      await this.ensureToken();
      const a = await this.reader.account(this.desk);
      if (a.http === 401) { this.token = ""; return; }
      if (!a.data) return;
      const d = decodeDesk(a.data);
      if (d.round !== this.round || d.key !== this.key.publicKey.toBase58()) return;
      this.seq = Math.max(this.seq, d.lastSeq);
      if (!this.ready) {
        this.ready = true;
        // HIDE: place the order after a human-like delay (the level is drawn afresh every round)
        if (t.phase === PHASE.hide) this.hidePlaceAt = Date.now() + 800 + Math.random() * 2200;
      }
      if (d.phase >= PHASE.live || d.beat > 0) {
        if (d.beat > this.processed) {
          for (let b = Math.max(0, this.processed + 1); b <= d.beat && b < 30; b++) {
            const row = d.rows[b];
            this.brain.feedback(b, row);
            if (b > 0 && row.actionAlgo) this.stats!.algo++;
            if (b > 0 && row.result === RES.fill) this.stats!.fills++;
          }
          this.processed = d.beat;
          this.choice = null;
          // presence for the coming beat; when present, act after a reaction time
          if (this.brain.step()) {
            const rt = reactionMs();
            this.decideAt = Date.now() + rt;
            this.stats!.present++; this.stats!.rtSum += rt; this.stats!.rtN++;
          } else {
            this.decideAt = 0;
            this.stats!.absent++;
          }
        }
      }
    } finally {
      this.reading = false;
    }
  }

  private async finalRead() {
    this.reading = true;
    try {
      const a = await this.reader.account(this.desk);
      if (a.data) {
        const d = decodeDesk(a.data);
        if (d.round === this.round && this.stats) { this.stats.final = d; this.report(); }
      }
    } finally {
      this.reading = false;
    }
  }

  private report() {
    if (this.stats && this.stats.sent && !this.stats.reported && this.onRoundDone) { this.stats.reported = true; this.onRoundDone(this.stats, this); }
  }

  // the act message is built once per blockhash; each send patches kind, level, seq and a fresh
  // salt into it and signs it natively (ed25519), so 4 sends per second per desk stay cheap
  private signer: crypto.KeyObject | null = null;
  private tmpl: { bh: string; msg: Buffer; off: number } | null = null;
  private wire(bh: string, c: Choice, seq: number): string {
    if (!this.signer) {
      const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(this.key.secretKey.subarray(0, 32))]);
      this.signer = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    }
    if (!this.tmpl || this.tmpl.bh !== bh) {
      const tx = new Transaction({ feePayer: this.key.publicKey, recentBlockhash: bh });
      tx.add(actIx(this.chain.programId, this.key.publicKey, this.desk, this.pool.book, 0, 0, 0));
      const msg = tx.serializeMessage();
      const off = msg.lastIndexOf(ACT_DISC);
      if (off < 0 || off + 30 !== msg.length) throw new Error("act message layout");
      this.tmpl = { bh, msg, off };
    }
    const m = Buffer.from(this.tmpl.msg);
    const o = this.tmpl.off;
    m[o + 8] = c.kind;
    m[o + 9] = c.level;
    m.writeUInt32LE(seq >>> 0, o + 10);
    crypto.randomFillSync(m, o + 14, 16);
    const sig = crypto.sign(null, m, this.signer);
    return Buffer.concat([Buffer.from([1]), sig, m]).toString("base64");
  }

  private sendAct(c: Choice) {
    const bh = this.pool.blockhash();
    if (!bh || !this.stats) return;
    this.seq += 1;
    const raw = this.wire(bh, c, this.seq);
    const st = this.stats;
    const now = Date.now();
    if (!st.firstSend) st.firstSend = now;
    st.lastSend = now;
    st.sent++;
    fetch(this.sendUrl, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [raw, { encoding: "base64", skipPreflight: true, maxRetries: 0 }] }) })
      .then(async (r) => {
        const j: any = await r.json().catch(() => null);
        if (!r.ok || j?.error) { st.sendErr++; if (r.status === 401) this.token = ""; }
      })
      .catch(() => { st.sendErr++; });
  }
}
