// Scripted players for the live house pools on devnet.
//
// Each player takes one desk of a house pool with a fresh 0-SOL burner through the ordinary `join`, then plays
// whole rounds exactly like a browser tab: one `act` every 250 ms while the round is in HIDE or LIVE (its current
// choice, otherwise a no-op), never outside HIDE/LIVE, never on a Table view older than 700 ms, and it stops at the
// bell. It reads only its own Desk (through its own rollup token, live subscription plus a fallback poll) and the
// public Table. To leave, it goes silent for one whole round, so the house gives the desk back to a bot.
//
// Player behaviours (one per round, rotating, so every behaviour sees the same pools at the same hours):
//   typical   information player: re-pings its last FILL until that level misses, otherwise pings a level it has not
//             pinged in the last 6 s, re-quotes to a fresh level whenever it was PICKED OFF; it uses each private
//             result only after a human reaction time (lognormal, median 0.9 s, sigma 0.35)
//   instant   the same player reading every result at machine speed (reaction time 0)
//   present50 the typical player present on half of the beats (absences in streaks of 3 s on average); when absent
//             it sends no-ops and the program's algo pings for it
//   random    pings a uniformly random level other than its own every beat, never re-quotes, ignores every result
//
// Output: one JSON line per round (strategy, pool, round, seat, resting/picked/total, rank, margins, every desk's
// total and kind, bell beat, recorded flag, acts per beat from the post-reveal history, result and ack latencies).
//
//   npx tsx scripts/humans.ts --pools 1,2 --rounds 100 [--strategies typical,instant,present50,random] [--seat 7]
//   env: OUT_DIR (JSON lines, default ./f2-out), KEYS_DIR (burner keys), STOP_FILE (finish and leave when it exists)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { DEV, tokenFor, erUrl, erWsUrl, disc } from "../tests/devnet/devnet.ts";
import { PROGRAM_ID, pda, loadKeypair } from "../tests/local/lib.ts";
import { decodeDesk, ACT, PHASE, RES, LEVELS, SEAT, NDESK, type TableView, type DeskView, type DeskRow } from "../house/src/chain.ts";
import { Jsonl, SlotClock, TablePoll, account, call, http429, iso, pct, mean } from "./f2-lib.ts";

const PERMISSION_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const JOIN = disc("join");
const ACT_DISC = disc("act");
const BEAT_MS = 1500;
const ACT_MS = 250;
const MAX_SNAP_AGE_MS = 700;
/** stop carrying a changed choice this close to a beat deadline (a late act would become the next beat's choice) */
const LATE_GUARD_MS = 120;
const MEMORY_BEATS = 4; // 6 s at 1.5-s beats

export type Strategy = "typical" | "instant" | "present50" | "random";
export const STRATEGIES: Strategy[] = ["typical", "instant", "present50", "random"];
const RT_MEDIAN: Record<Strategy, number> = { typical: 900, instant: 0, present50: 900, random: 0 };

export function reactionMs(median: number, rand = Math.random) {
  if (median <= 0) return 0;
  const u = Math.max(rand(), 1e-12), v = rand();
  return median * Math.exp(0.35 * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
}
const randLevel = (exclude: Set<number>) => {
  for (;;) { const c = 1 + Math.floor(Math.random() * LEVELS); if (!exclude.has(c)) return c; }
};

/** What the information player knows: last FILL level, PICKED OFF since its last decision, when it last pinged each level. */
class Mind {
  hit: number | null = null;
  raided = false;
  raidSeq = 0;
  last = new Array(LEVELS + 1).fill(-99);
  level = 0;
  feed(beat: number, row: DeskRow) {
    if (row.level) this.level = row.level;
    if (row.actionKind === ACT.ping && row.actionLevel) {
      this.last[row.actionLevel] = beat;
      if (row.result === RES.fill) this.hit = row.actionLevel;
      else if (row.result === RES.miss && this.hit === row.actionLevel) this.hit = null;
    }
    if (row.actionKind === ACT.requote && this.hit === row.level) this.hit = null;
    if (row.lostAmt > 0 || row.hitsTaken > 0) { this.raided = true; this.raidSeq++; }
  }
  private fresh(beat: number, exclude: Set<number>) {
    const all = Array.from({ length: LEVELS }, (_, i) => i + 1).filter((c) => !exclude.has(c));
    const cool = all.filter((c) => beat - this.last[c] > MEMORY_BEATS);
    const pool = cool.length ? cool : all;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  /** pure: the action for live beat `beat` from what is known now; `usesRaid` = this decision answers the PICKED OFF */
  decide(beat: number): { kind: number; level: number; usesRaid: boolean; raidSeq: number } {
    const own = this.level;
    if (this.raided) {
      const ex = new Set([own]); if (this.hit !== null) ex.add(this.hit);
      return { kind: ACT.requote, level: this.fresh(beat, ex), usesRaid: true, raidSeq: this.raidSeq };
    }
    if (this.hit !== null && this.hit !== own) return { kind: ACT.ping, level: this.hit, usesRaid: false, raidSeq: this.raidSeq };
    return { kind: ACT.ping, level: this.fresh(beat, new Set([own])), usesRaid: false, raidSeq: this.raidSeq };
  }
}

interface RoundLog {
  round: number; strategy: Strategy; seat: number; fromHide: boolean; startedAt: number;
  sent: number; sendErr: number; httpErr: Record<string, number>; sentSigs: Map<string, { at: number; seq: number; kind: number; phase: number }>;
  decisions: number; pings: number; requotes: number; absent: number; present: number; place: number; usedRt: number[]; lateInfo: number;
  lags: { beat: number; ms: number; via: string }[]; acks: number[]; outsidePlay: number; bellSeenAt?: number; done?: boolean;
}

export interface PlayerOpts { tableId: number; strategies: Strategy[]; rounds: number; seat?: number; outDir: string; keysDir: string; stopFile?: string; tag?: string }

export class Player {
  readonly table: PublicKey; readonly book: PublicKey;
  readonly kp: Keypair;
  private token = ""; private tokenAt = 0;
  private conn!: Connection;
  private subId: number | null = null;
  readonly poll: TablePoll;
  readonly clock = new SlotClock();
  private out: Jsonl;
  seat: number | null = null;
  private desk: PublicKey | null = null;
  private dv: DeskView | null = null; // latest own Desk view
  private dvAt = 0;
  private bh: string | null = null;
  private seq = 0;
  private cur: RoundLog | null = null;
  private mind = new Mind();
  private queue: { beat: number; row: DeskRow; usableAt: number }[] = [];
  private fedBeat = -1; private seenBeat = -1;
  private present = true; private presentBeat = -1;
  private choice: { kind: number; level: number; forBeat: number; usesRaid: boolean; raidSeq: number } | null = null;
  private placeAt = 0; private placeLevel = 0;
  private played = 0;
  private leaving = false; private silentFrom = -1;
  private stopped = false;
  private firstPushAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private signer: crypto.KeyObject;
  private pendingAcks: { seq: number; at: number }[] = [];
  private finals = new Map<number, Promise<void>>();

  constructor(readonly o: PlayerOpts) {
    this.table = pda.table(o.tableId);
    this.book = pda.book(o.tableId);
    const kf = path.join(o.keysDir, `human-t${o.tableId}${o.tag ? "-" + o.tag : ""}.json`); // one fresh burner per run tag
    if (fs.existsSync(kf)) this.kp = loadKeypair(kf);
    else {
      fs.mkdirSync(o.keysDir, { recursive: true, mode: 0o700 });
      this.kp = Keypair.generate();
      fs.writeFileSync(kf, JSON.stringify(Array.from(this.kp.secretKey)), { mode: 0o600 });
    }
    const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(this.kp.secretKey.subarray(0, 32))]);
    this.signer = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    this.out = new Jsonl(path.join(o.outDir, `humans-t${o.tableId}.jsonl`));
    this.poll = new TablePoll(o.tableId, this.table, 120);
  }
  get me() { return this.kp.publicKey.toBase58(); }
  log(ev: string, d: Record<string, unknown> = {}) { this.out.write(ev, { pool: this.o.tableId, key: this.me, ...d }); }

  private async ensureToken(force = false) {
    if (!force && this.token && Date.now() - this.tokenAt < 8 * 60_000) return;
    this.token = await tokenFor(this.kp);
    this.tokenAt = Date.now();
    this.conn = new Connection(erUrl(this.token), { commitment: "processed", wsEndpoint: erWsUrl(this.token) });
    if (this.desk) await this.subscribe();
  }
  private async subscribe() {
    if (!this.desk) return;
    if (this.subId !== null) { const old = this.subId; this.subId = null; await this.conn.removeAccountChangeListener(old).catch(() => {}); }
    this.firstPushAt = null;
    this.subId = this.conn.onAccountChange(this.desk, (acc) => { if (this.firstPushAt === null) this.firstPushAt = Date.now(); this.onDesk(Buffer.from(acc.data), "push"); }, { commitment: "processed" });
  }
  private async refreshBlockhash() {
    const r = await call(erUrl(this.token), "getLatestBlockhash", [{ commitment: "processed" }]);
    const bh = r.body?.result?.value?.blockhash;
    if (bh) this.bh = bh;
  }

  async start() {
    this.clock.start();
    this.poll.start();
    await this.ensureToken();
    await this.refreshBlockhash();
    const bhTimer = setInterval(() => { this.refreshBlockhash().catch(() => {}); this.ensureToken().catch(() => {}); }, 10_000);
    while (!this.poll.view) await sleep(100);
    // already seated with this key (a restart)? keep the desk, else join
    const s0 = this.poll.view.seats.findIndex((x) => x.key === this.me && x.kind === SEAT.human);
    if (s0 >= 0) { this.seat = s0; this.log("resume_seat", { seat: s0, round: this.poll.view.round }); }
    else await this.join();
    this.desk = pda.desk(this.o.tableId, this.seat!);
    await this.subscribe();
    this.poll.listeners.push((t, prev) => this.onTable(t, prev));
    const loop = () => {
      if (this.stopped) return;
      this.slot().catch((e) => this.log("slot_error", { err: String(e?.message ?? e).slice(0, 200) }));
      const n = Date.now(), off = (this.o.tableId * 97) % ACT_MS;
      this.timer = setTimeout(loop, Math.max(1, Math.floor((n - off) / ACT_MS) * ACT_MS + ACT_MS + off - n));
    };
    loop();
    while (!this.stopped) await sleep(500);
    clearInterval(bhTimer);
    await Promise.all(this.finals.values());
    this.poll.stop(); this.clock.stop();
    if (this.subId !== null) await this.conn.removeAccountChangeListener(this.subId).catch(() => {});
  }

  /** Waits for a phase in which seats change hands without a half-played round, then joins the chosen desk. */
  private async join() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const t = this.poll.view!;
      // join while the previous round is revealed (or idle), so the next round is played from its HIDE
      if (t.phase !== PHASE.revealed && t.phase !== PHASE.idle) { await sleep(150); continue; }
      const prefer = this.o.seat !== undefined ? [this.o.seat] : [7, 5, 2, 6, 4, 1, 3, 0];
      const seat = prefer.find((s) => t.seats[s].kind === SEAT.bot) ?? prefer.find((s) => t.seats[s].kind === SEAT.empty);
      if (seat === undefined) { this.log("no_free_seat", {}); await sleep(5000); continue; }
      await this.refreshBlockhash();
      const name = Buffer.alloc(16); Buffer.from(`script-${this.o.tableId}`).copy(name);
      const desk = pda.desk(this.o.tableId, seat);
      const ix = new TransactionInstruction({ programId: PROGRAM_ID, data: Buffer.concat([JOIN, Buffer.from([seat]), name]), keys: [
        { pubkey: this.kp.publicKey, isSigner: true, isWritable: false }, { pubkey: this.table, isSigner: false, isWritable: true },
        { pubkey: desk, isSigner: false, isWritable: true }, { pubkey: pda.perm(desk), isSigner: false, isWritable: true },
        { pubkey: PERMISSION_PROGRAM, isSigner: false, isWritable: false }, { pubkey: EPHEMERAL_VAULT, isSigner: false, isWritable: true },
        { pubkey: MAGIC_PROGRAM, isSigner: false, isWritable: false }] });
      const tx = new Transaction({ feePayer: this.kp.publicKey, recentBlockhash: this.bh! }).add(ix);
      tx.sign(this.kp);
      const t0 = Date.now();
      const r = await call(erUrl(this.token), "sendTransaction", [tx.serialize().toString("base64"), { encoding: "base64", skipPreflight: false, preflightCommitment: "processed" }]);
      if (!r.body?.result) { this.log("join_refused", { seat, phase: t.phase, err: JSON.stringify(r.body?.error ?? r.body).slice(0, 300) }); await sleep(1000); continue; }
      for (let i = 0; i < 50; i++) {
        await sleep(100);
        const v = this.poll.view!;
        if (v.seats[seat].key === this.me) {
          this.seat = seat;
          this.log("joined", { seat, round: v.round, phase: v.phase, ms: Date.now() - t0, sig: r.body.result, replaced: t.seats[seat].name });
          return;
        }
      }
      this.log("join_unconfirmed", { seat, sig: r.body.result });
    }
    throw new Error("could not join");
  }

  // ---------------------------------------------------------------- own Desk updates
  private onDesk(data: Buffer, via: string) {
    const d = decodeDesk(data);
    const t = this.poll.view;
    if (!t || d.key !== this.me) return;
    this.dv = d; this.dvAt = Date.now();
    this.seq = Math.max(this.seq, d.lastSeq);
    const r = this.cur;
    if (r && d.round === r.round) {
      // send -> ack: the act shows in Desk.last_seq
      while (this.pendingAcks.length && this.pendingAcks[0].seq <= d.lastSeq) { const a = this.pendingAcks.shift()!; if (via === "push") r.acks.push(this.dvAt - a.at); }
      const top = Math.min(d.beat, 29);
      if (d.phase >= PHASE.live || d.beat > 0) {
        for (let b = this.seenBeat + 1; b <= top; b++) {
          const row = d.rows[b];
          const close = this.clock.timeOf(t.hideEndSlot + b * t.beatSlots);
          if (b === top && b > 0 && close !== null && this.clock.fitted && this.firstPushAt !== null && this.firstPushAt < close && via === "push")
            r.lags.push({ beat: b, ms: this.dvAt - close, via });
          const rt = b === 0 ? 0 : reactionMs(RT_MEDIAN[r.strategy]);
          this.queue.push({ beat: b, row, usableAt: this.dvAt + rt });
          if (b > 0) r.usedRt.push(Math.round(rt));
        }
        if (top > this.seenBeat) this.seenBeat = top;
      }
    }
  }

  private onTable(t: TableView, prev: TableView | null) {
    if (this.seat === null) return;
    if (t.seats[this.seat].key !== this.me) { if (!this.leaving) this.log("seat_lost", { round: t.round, now: t.seats[this.seat].name }); this.stopped = true; return; }
    if (!this.cur || t.round !== this.cur.round) {
      if (t.phase === PHASE.hide || t.phase === PHASE.live) this.newRound(t);
    }
    if (this.cur && t.round === this.cur.round && t.phase >= PHASE.bell && !this.cur.bellSeenAt) {
      this.cur.bellSeenAt = Date.now();
    }
    if (this.cur && t.round === this.cur.round && t.phase === PHASE.revealed && !this.cur.done) {
      this.cur.done = true;
      const r = this.cur;
      this.finals.set(r.round, this.finish(r, t).catch((e) => this.log("finish_error", { round: r.round, err: String(e?.message ?? e).slice(0, 200) })).finally(() => this.finals.delete(r.round)));
    }
    void prev;
  }

  private newRound(t: TableView) {
    if (this.o.stopFile && fs.existsSync(this.o.stopFile) && !this.leaving) this.leave("stop file");
    if (this.played >= this.o.rounds && !this.leaving) this.leave("rounds done");
    const strategy = this.o.strategies[(t.round + this.o.tableId) % this.o.strategies.length];
    this.cur = { round: t.round, strategy, seat: this.seat!, fromHide: t.phase === PHASE.hide && t.beat === 0, startedAt: Date.now(), sent: 0, sendErr: 0, httpErr: {}, sentSigs: new Map(),
      decisions: 0, pings: 0, requotes: 0, absent: 0, present: 0, place: 0, usedRt: [], lateInfo: 0, lags: [], acks: [], outsidePlay: 0 };
    this.mind = new Mind();
    this.queue = []; this.fedBeat = -1; this.seenBeat = -1; this.choice = null; this.pendingAcks = [];
    this.present = Math.random() < (strategy === "present50" ? 0.5 : 1); this.presentBeat = 0;
    this.placeAt = Date.now() + 800 + Math.random() * 1700; this.placeLevel = 1 + Math.floor(Math.random() * LEVELS);
    if (this.leaving && this.silentFrom < 0) this.silentFrom = t.round;
  }

  private leave(why: string) {
    this.leaving = true;
    this.log("leaving", { why, played: this.played });
  }

  // ---------------------------------------------------------------- one 250-ms slot
  private async slot() {
    const t = this.poll.view, r = this.cur;
    if (!t || !r || t.round !== r.round || this.seat === null) return;
    const fresh = Date.now() - this.poll.at <= MAX_SNAP_AGE_MS;
    const inPlay = (t.phase === PHASE.hide || t.phase === PHASE.live) && fresh && !r.bellSeenAt;
    if (!inPlay) return; // never outside HIDE/LIVE, never on a stale view, never after the bell was seen
    if (this.leaving) return; // silent for a whole round: the house hands the desk back to a bot
    // own Desk of this round readable? (re-sealed with us as its member and reset)
    if (!this.dv || this.dv.round !== r.round) {
      if (Date.now() - this.dvAt > 400) { const a = await account(erUrl(this.token), this.desk!, "processed"); if (a.data) this.onDesk(a.data, "poll"); else if (a.http === 401) await this.ensureToken(true); }
      if (!this.dv || this.dv.round !== r.round) return;
    }
    // a result we should have by now but no push came: poll once (not counted as a latency sample)
    if (t.phase === PHASE.live && t.beat > this.seenBeat && Date.now() - this.dvAt > 300) {
      const a = await account(erUrl(this.token), this.desk!, "processed"); if (a.data) this.onDesk(a.data, "poll");
    }
    const c = this.choose(t, r);
    this.send(c, t, r);
  }

  /** The act to send now. */
  private choose(t: TableView, r: RoundLog): { kind: number; level: number } {
    const nowMs = Date.now();
    if (t.phase === PHASE.hide) {
      if (nowMs < this.placeAt) return { kind: ACT.noop, level: 0 };
      if (!r.place) r.place = 1;
      return { kind: ACT.requote, level: this.placeLevel };
    }
    const next = this.seenBeat + 1; // the beat being collected now
    const deadline = this.clock.timeOf(t.hideEndSlot + next * t.beatSlots) ?? nowMs + BEAT_MS;
    const open = nowMs < deadline - LATE_GUARD_MS;
    // presence for the coming beat (Markov, mean absence 2 beats = 3 s; stationary share 0.5)
    if (this.presentBeat !== next) {
      this.presentBeat = next;
      if (r.strategy === "present50") { if (this.present) { if (Math.random() < 0.5) this.present = false; } else if (Math.random() < 0.5) this.present = true; }
      if (this.present) r.present++; else r.absent++;
    }
    // take in every result whose reaction time has passed (in beat order)
    let fed = false;
    while (this.queue.length && this.queue[0].usableAt <= nowMs) { const q = this.queue.shift()!; this.mind.feed(q.beat, q.row); this.fedBeat = q.beat; fed = true; }
    if (this.dv) this.mind.level = this.dv.level || this.mind.level;
    if (this.choice && this.choice.forBeat !== next) {
      // the previous beat resolved: its decision is final (a PICKED OFF it answered is consumed)
      if (this.choice.usesRaid && this.mind.raidSeq === this.choice.raidSeq) this.mind.raided = false;
      if (this.choice.kind === ACT.ping) r.pings++; else if (this.choice.kind === ACT.requote) r.requotes++;
      this.choice = null;
    }
    // close to (or past) the deadline of the beat being collected: carry nothing new (a late act would become
    // the next beat's choice); the acts already sent in this beat hold the choice
    if (!open) { if (fed) r.lateInfo++; return { kind: ACT.noop, level: 0 }; }
    if (!this.present) return { kind: ACT.noop, level: 0 };
    if (r.strategy === "random") {
      if (!this.choice) { this.choice = { kind: ACT.ping, level: randLevel(new Set([this.dv?.level ?? 0])), forBeat: next, usesRaid: false, raidSeq: 0 }; r.decisions++; }
    } else if (!this.choice || fed) {
      if (!this.choice) r.decisions++;
      this.choice = { ...this.mind.decide(next), forBeat: next };
    }
    return this.choice ?? { kind: ACT.noop, level: 0 };
  }

  private send(c: { kind: number; level: number }, t: TableView, r: RoundLog) {
    if (!this.bh) return;
    this.seq += 1;
    const seq = this.seq;
    const tx = new Transaction({ feePayer: this.kp.publicKey, recentBlockhash: this.bh });
    const data = Buffer.alloc(30); ACT_DISC.copy(data, 0); data[8] = c.kind; data[9] = c.level; data.writeUInt32LE(seq >>> 0, 10); crypto.randomFillSync(data, 14, 16);
    tx.add(new TransactionInstruction({ programId: PROGRAM_ID, data, keys: [
      { pubkey: this.kp.publicKey, isSigner: true, isWritable: false }, { pubkey: this.desk!, isSigner: false, isWritable: true }, { pubkey: this.book, isSigner: false, isWritable: true }] }));
    const msg = tx.serializeMessage();
    const sig = crypto.sign(null, msg, this.signer);
    const raw = Buffer.concat([Buffer.from([1]), sig, msg]).toString("base64");
    const sigB58 = bs58enc(sig);
    const at = Date.now();
    r.sent++;
    r.sentSigs.set(sigB58, { at, seq, kind: c.kind, phase: t.phase });
    this.pendingAcks.push({ seq, at });
    if (this.pendingAcks.length > 64) this.pendingAcks.shift();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2000);
    fetch(erUrl(this.token), { method: "POST", headers: { "content-type": "application/json" }, signal: ac.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [raw, { encoding: "base64", skipPreflight: true, maxRetries: 0 }] }) })
      .then(async (res) => { const j: any = await res.json().catch(() => null); if (!res.ok || j?.error) { r.sendErr++; const k = String(res.status); r.httpErr[k] = (r.httpErr[k] ?? 0) + 1; if (res.status === 429) http429.n++; if (res.status === 401) this.token = ""; } })
      .catch(() => { r.sendErr++; r.httpErr.net = (r.httpErr.net ?? 0) + 1; })
      .finally(() => clearTimeout(timer));
  }

  // ---------------------------------------------------------------- after the reveal: results and the post-reveal history
  private async finish(r: RoundLog, t: TableView) {
    const partial = !r.fromHide || this.leaving;
    if (!partial) this.played++;
    // own final Desk (still ours through the token; public once unsealed)
    let d: DeskView | null = null;
    for (let i = 0; i < 20 && !d; i++) { const a = await account(erUrl(this.token), this.desk!, "confirmed"); if (a.data) { const x = decodeDesk(a.data); if (x.round === r.round) d = x; } if (!d) await sleep(250); }
    // wait for the unseal (the Desk turns readable without a token), then list this desk's transactions
    let unsealSlot: number | null = null;
    for (let i = 0; i < 60; i++) {
      const a = await account(DEV.er, this.desk!, "confirmed");
      if (a.data && decodeDesk(a.data).round === r.round) { unsealSlot = a.slot ?? null; break; }
      await sleep(200);
    }
    let hist: any = null;
    if (unsealSlot !== null && r.sentSigs.size) {
      const sres = await call(DEV.er, "getSignaturesForAddress", [this.desk!.toBase58(), { limit: 1000, commitment: "confirmed" }]);
      const list: any[] = sres.body?.result ?? [];
      const mine = list.filter((x) => r.sentSigs.has(x.signature));
      const perBeat = new Map<number, number>();
      let hideActs = 0, afterBell = 0, afterUnseal = 0, failed = 0;
      for (const x of mine) {
        if (x.err) failed++;
        if (x.slot < t.hideEndSlot) hideActs++;
        else if (t.bellSlot && x.slot > t.bellSlot) afterBell++;
        else { const b = Math.floor((x.slot - t.hideEndSlot) / t.beatSlots) + 1; perBeat.set(b, (perBeat.get(b) ?? 0) + 1); }
        if (x.slot >= unsealSlot) afterUnseal++;
      }
      const full = [...perBeat.entries()].filter(([b]) => b >= 1 && b <= t.beat).map(([, n]) => n);
      hist = { listed: list.length, mine: mine.length, sent: r.sentSigs.size, missing: r.sentSigs.size - mine.length, failed, hideActs, afterBell, afterUnseal,
        perBeat: Object.fromEntries([...perBeat.entries()].sort((a, b) => a[0] - b[0])), perBeatMin: full.length ? Math.min(...full) : null, perBeatMax: full.length ? Math.max(...full) : null };
    }
    const totals = t.totals, me = r.seat;
    const sorted = [...totals].sort((a, b) => b - a);
    const mine = totals[me];
    const others = totals.filter((_, s) => s !== me);
    const rec = {
      round: r.round, strategy: r.strategy, seat: me, fromHide: r.fromHide, partial, silent: r.sent === 0, recorded: t.recorded, bellBeat: t.beat, topDesk: t.topDesk,
      resting: d?.resting ?? null, picked: d?.picked ?? t.picked[me], total: mine, stakes: mine / 100,
      rank: 1 + totals.filter((x, s) => s !== me && x > mine).length, top: t.topDesk === me,
      gapToBestOther: mine - Math.max(...others), topMargin: sorted[0] - sorted[1],
      fills: d ? d.rows.slice(1, t.beat + 1).filter((x) => x.result === RES.fill && x.actionKind === ACT.ping).length : null,
      algo: d ? d.rows.slice(1, t.beat + 1).filter((x) => x.actionAlgo).length : null,
      pickedOff: d ? d.rows.slice(1, t.beat + 1).filter((x) => x.lostAmt > 0).length : null,
      deskActs: d?.acts ?? null, sent: r.sent, sendErr: r.sendErr, httpErr: r.httpErr, decisions: r.decisions, present: r.present, absent: r.absent, lateInfo: r.lateInfo,
      rtMedian: pct(r.usedRt, 50), seats: t.seats.map((s, i) => ({ s: i, kind: s.kind, name: s.name, total: totals[i] })),
      lagN: r.lags.length, lagP50: pct(r.lags.map((x) => x.ms), 50), lags: r.lags.map((x) => Math.round(x.ms)), ackN: r.acks.length, ackP50: pct(r.acks, 50), acks: r.acks.map(Math.round),
      bellSlot: t.bellSlot, hideEndSlot: t.hideEndSlot, openSlot: t.openSlot, unsealSlot, hist, http429: http429.n,
    };
    this.log("round", rec);
    if (this.leaving && this.silentFrom >= 0 && r.round >= this.silentFrom) {
      // silent through this whole round: wait for the house to hand the desk back to a bot
      for (let i = 0; i < 300; i++) {
        const v = this.poll.view!;
        if (v.seats[me].key !== this.me) { this.log("left", { round: v.round, seat: me, now: v.seats[me].name, kind: v.seats[me].kind }); this.stopped = true; return; }
        await sleep(200);
      }
    }
  }
  stop() { if (!this.leaving) this.leave("signal"); }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58enc(buf: Buffer): string {
  let n = BigInt("0x" + buf.toString("hex")), s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = "1" + s; else break; }
  return s;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
void mean; void iso; void NDESK;

// ------------------------------------------------------------------ CLI
function arg(name: string, d?: string) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; }
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const pools = (arg("pools", "1") as string).split(",").map(Number);
  const strategies = (arg("strategies", STRATEGIES.join(",")) as string).split(",") as Strategy[];
  for (const s of strategies) if (!STRATEGIES.includes(s)) throw new Error(`unknown strategy ${s}`);
  const rounds = Number(arg("rounds", "20"));
  const seat = arg("seat") !== undefined ? Number(arg("seat")) : undefined;
  const outDir = process.env.OUT_DIR ?? path.resolve("f2-out");
  const keysDir = process.env.KEYS_DIR ?? path.join(outDir, "keys");
  const players = pools.map((t) => new Player({ tableId: t, strategies, rounds, seat, outDir, keysDir, stopFile: process.env.STOP_FILE ? `${process.env.STOP_FILE}-t${t}` : undefined, tag: process.env.KEY_TAG }));
  const onSig = () => { for (const p of players) p.stop(); };
  process.on("SIGTERM", onSig); process.on("SIGINT", onSig);
  await Promise.all(players.map((p) => p.start().catch((e) => { p.log("fatal", { err: String(e?.stack ?? e).slice(0, 500) }); })));
  process.exit(0);
}
