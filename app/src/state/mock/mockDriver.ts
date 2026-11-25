/**
 * Mock driver: a scripted local house pool that loops forever (HIDE 5 s -> LIVE
 * beats of 1.5 s -> bell after beat 20..29 -> LIGHTS ON 8 s). Seven labelled
 * house bots play by their personalities; the player's desk is seat 0. The
 * first round opens already live so the first frame is a running pool.
 */
import {
  BEAT_MS, BELL_MAX, BELL_MIN, DESKS, HIDE_MS, LEVELS, LIGHTS_MS, TAPE_CLOSE_BEAT,
  type GameActions, type GameDriver, type MyDesk, type PeekProbe, type PeekRead, type PeekResult,
  type RevealBeat, type RevealView, type Seat, type StoreWriter, type BotKind, priceOf, lots,
} from "../types";
import {
  algoLevel, cloneBook, newBook, permutation, resolveBeat, rng, topDesk, SKIM, ALGO_MEMORY,
  type Act, type BookState, type Rng,
} from "./engine";
import { botDecide, botHide, botLearn, newMind, type BotMind } from "./bots";
import { hashLog, replayMatches, serializeLog } from "../replay";

const BOTS: { name: string; bot: BotKind }[] = [
  { name: "SHARK-1", bot: "shark" },
  { name: "GHOST-1", bot: "ghost" },
  { name: "MINNOW-1", bot: "minnow" },
  { name: "SHARK-2", bot: "shark" },
  { name: "GHOST-2", bot: "ghost" },
  { name: "MINNOW-2", bot: "minnow" },
  { name: "GHOST-3", bot: "ghost" },
];
/** The bot that holds seat 0 while the player is not seated. */
const SEAT0_BOT = { name: "MINNOW-3", bot: "minnow" as BotKind };

const ADJ = ["bright", "quiet", "swift", "amber", "silver", "lucky", "steady", "keen", "calm", "bold"];
const ANIMAL = ["otter", "heron", "fox", "lynx", "wren", "marten", "kestrel", "hare", "owl", "stoat"];
function playerName(): string {
  try {
    const k = localStorage.getItem("po.name");
    if (k) return k;
    const n = `${ADJ[Math.floor(Math.random() * ADJ.length)]}-${ANIMAL[Math.floor(Math.random() * ANIMAL.length)]}`;
    localStorage.setItem("po.name", n);
    return n;
  } catch {
    return "bright-otter";
  }
}

const now = () => performance.now();
const WARM_BEATS = 3; // first frame opens at live beat 4

export class MockDriver implements GameDriver {
  readonly name = "mock";
  private w!: StoreWriter;
  private timer: ReturnType<typeof setInterval> | null = null;
  private timeouts = new Set<ReturnType<typeof setTimeout>>();
  private r: Rng = rng(Date.now() & 0xffffffff);
  private round = 410;
  private book: BookState = newBook(Array(DESKS).fill(1));
  private initialLevels: number[] = [];
  private minds: (BotMind | null)[] = [];
  private bellBeat = 25;
  private beat = 0;
  private phase: "hide" | "live" | "lights" = "hide";
  private phaseEndsAt = 0;
  private beatEndsAt = 0;
  private liveStartedAt = 0;
  private algo: number[] = Array(DESKS).fill(1);
  private myAct: Act = null;
  private placed = false;
  private seated = true;
  private keepSeat = false;
  private log: RevealBeat[] = [];
  private commitHash = "";
  private me: MyDesk | null = null;
  private lastActBeat = 0;
  private player = playerName();
  private calls = 0;

  readonly actions: GameActions = {
    place: (level) => this.place(level),
    ping: (level) => this.ping(level),
    requote: (level) => this.requote(level),
    tapeCall: (desk) => this.tapeCall(desk),
    join: () => this.join(),
  };

  readonly peek: PeekProbe = { run: (n) => this.runPeek(n) };

  start(w: StoreWriter) {
    this.w = w;
    this.startRound(true);
    this.timer = setInterval(() => this.tick(), 40);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timeouts.forEach(clearTimeout);
    this.timeouts.clear();
  }

  private later(ms: number, f: () => void) {
    const t = setTimeout(() => {
      this.timeouts.delete(t);
      f();
    }, ms);
    this.timeouts.add(t);
  }

  /* ------------------------------------------------------------ rounds */

  private seats(): Seat[] {
    const s0: Seat = this.seated
      ? { name: this.player, kind: "human", picked: this.book.picked[0] }
      : { name: SEAT0_BOT.name, kind: "bot", bot: SEAT0_BOT.bot, picked: this.book.picked[0] };
    return [s0, ...BOTS.map((b, i) => ({ name: b.name, kind: "bot" as const, bot: b.bot, picked: this.book.picked[i + 1] }))];
  }

  private startRound(first: boolean) {
    this.round++;
    this.r = rng((Date.now() ^ (this.round * 2654435761)) >>> 0);
    this.bellBeat = BELL_MIN + this.r.int(BELL_MAX - BELL_MIN + 1);
    if (!first) {
      this.seated = this.seated && this.keepSeat;
    }
    this.keepSeat = false;
    this.minds = [this.seated ? null : newMind(SEAT0_BOT.bot), ...BOTS.map((b) => newMind(b.bot))];
    const levels = Array.from({ length: DESKS }, () => botHide(this.r));
    if (first) {
      // the first frame seats you on a level nobody else rests on
      const free = Array.from({ length: LEVELS }, (_, i) => i + 1).filter((L) => !levels.slice(1).includes(L));
      levels[0] = free[this.r.int(free.length)];
    }
    this.book = newBook(levels);
    this.log = [];
    this.beat = 0;
    this.myAct = null;
    this.placed = false;
    this.lastActBeat = 0;
    this.me = this.seated ? this.freshMe(levels[0]) : null;
    const pool = Array.from({ length: DESKS }, () => this.r.int(3));
    this.w.set({
      ready: true,
      table: { ...this.w.get().table, pool: String(this.round).padStart(4, "0"), round: this.round, seats: this.seats(), mySeat: this.seated ? 0 : null, source: "mock", lastPings: 0, lastFills: 0 },
      me: this.me,
      tape: { pool, closeBeat: TAPE_CLOSE_BEAT, myCall: null },
      reveal: null,
      canJoin: !this.seated,
      results: [],
      seatState: this.seated ? "seated" : "released",
      seatAtRisk: this.seated,
    });
    if (first) {
      // instant join: skip HIDE, play a few beats so the book already has marks
      this.placed = true;
      this.beginLive(now() - WARM_BEATS * BEAT_MS);
      for (let i = 0; i < WARM_BEATS; i++) this.closeBeat(true);
      this.w.set({ joinNotice: { name: this.player, seat: 0, level: this.book.level[0], resting: this.book.resting[0] } });
    } else {
      this.phase = "hide";
      this.phaseEndsAt = now() + HIDE_MS;
      this.publishClock();
    }
  }

  private freshMe(level: number): MyDesk {
    return {
      level, resting: 100, picked: 0, nextAlgo: 1, pending: { kind: "none" }, marks: {},
      lastFill: null, nextSkim: SKIM[0], exposure: SKIM[0], pickedOffBeat: null,
    };
  }

  private beginLive(at: number) {
    this.phase = "live";
    this.initialLevels = [...this.book.level];
    this.liveStartedAt = at;
    this.beat = 1;
    this.beatEndsAt = at + BEAT_MS;
    this.prepareBeat();
    this.publishClock();
  }

  private prepareBeat() {
    for (let d = 0; d < DESKS; d++) this.algo[d] = algoLevel(this.book, d, this.beat, this.r);
    if (this.me) this.setMe({ nextAlgo: this.algo[0], pending: { kind: "none" } });
  }

  private publishClock() {
    const b = this.beat;
    this.w.set({
      clock: {
        phase: this.phase,
        beat: this.phase === "hide" ? 0 : b,
        phaseEndsAt: this.phaseEndsAt,
        beatEndsAt: this.beatEndsAt,
        liveStartedAt: this.liveStartedAt,
        bellChance: this.phase === "live" && b >= BELL_MIN ? 1 / (BELL_MAX + 1 - b) : 0,
      },
    });
  }

  private setMe(p: Partial<MyDesk>) {
    if (!this.me) return;
    this.me = { ...this.me, ...p };
    this.w.set({ me: this.me });
  }

  private tick() {
    const t = now();
    if (this.phase === "hide" && t >= this.phaseEndsAt) {
      this.beginLive(this.phaseEndsAt);
    } else if (this.phase === "live" && t >= this.beatEndsAt) {
      this.closeBeat(false);
    } else if (this.phase === "lights" && t >= this.phaseEndsAt) {
      this.startRound(false);
    }
  }

  /** Resolve the current beat. `silent` = warm-up (no toasts, no delay). */
  private closeBeat(silent: boolean) {
    const beat = this.beat;
    const acts: Act[] = Array(DESKS).fill(null);
    for (let d = 0; d < DESKS; d++) {
      const m = this.minds[d];
      if (m) acts[d] = botDecide(m, this.book, d, beat, this.r);
    }
    if (this.seated) acts[0] = this.myAct;
    const order = permutation(this.r);
    const before = this.seated ? cloneBook(this.book) : null;
    const res = resolveBeat(this.book, beat, acts, this.algo, order);
    this.log.push({
      beat,
      levels: [...this.book.level],
      actions: order.map((d) => res.actions[d]),
      fills: res.fills,
    });
    for (let d = 0; d < DESKS; d++) {
      const m = this.minds[d];
      if (m) botLearn(m, res.ping[d], res.lost[d].tenths);
    }
    // public: tallies + prints
    const fillsBy = new Map<number, number>();
    for (const f of res.fills) fillsBy.set(f.pinger, (fillsBy.get(f.pinger) ?? 0) + f.tenths);
    const tStamp = 5 + Math.floor(beat * 1.5);
    const publish = () => {
      for (const [desk, tenths] of fillsBy) this.w.pushPrint({ t: tStamp, desk, tenths });
      this.w.pushPrint({ t: tStamp, pings: res.actions.filter((a) => a.kind === "ping").length, fills: res.fills.length });
      this.w.set((s) => ({ table: { ...s.table, seats: this.seats(), lastPings: res.actions.filter((a) => a.kind === "ping").length, lastFills: res.fills.length } }));
      this.spectatorCalls(beat);
    };
    // private: own results
    const deliver = () => {
      if (!this.seated || !this.me || !before) return;
      const p = res.ping[0];
      const marks = { ...this.me.marks };
      let lastFill = this.me.lastFill;
      let nextSkim = this.me.nextSkim;
      if (p) {
        marks[p.level] = p.tenths > 0 ? "fill" : "miss";
        if (p.tenths > 0) {
          lastFill = p.level;
          const vs = res.fills.filter((f) => f.pinger === 0).map((f) => f.victim);
          nextSkim = Math.max(...vs.map((v) => SKIM[Math.min(this.book.streak[0][v], 2)]));
        } else if (lastFill === p.level) lastFill = null;
        if (!silent) this.w.pushResult({ beat, kind: p.tenths > 0 ? "fill" : "miss", level: p.level, tenths: p.tenths, algo: p.algo, next: p.tenths > 0 ? nextSkim : undefined, orders: p.tenths > 0 ? res.fills.filter((f) => f.pinger === 0).length : undefined });
      }
      const moved = res.actions[0].kind === "requote";
      if (moved) lastFill = lastFill === this.book.level[0] ? null : lastFill;
      const lost = res.lost[0];
      let exposure = moved ? SKIM[0] : this.me.exposure;
      let pickedOffBeat = moved ? null : this.me.pickedOffBeat;
      if (lost.tenths > 0) {
        const hunters = res.fills.filter((f) => f.victim === 0).map((f) => f.pinger);
        exposure = Math.max(...hunters.map((h) => SKIM[Math.min(this.book.streak[h][0], 2)]));
        pickedOffBeat = beat;
        if (!silent) this.w.pushResult({ beat, kind: "pickedoff", tenths: lost.tenths, count: lost.count, algo: false, next: exposure });
      }
      this.setMe({
        level: this.book.level[0], resting: this.book.resting[0], picked: this.book.picked[0],
        marks, lastFill, nextSkim, exposure, pickedOffBeat,
      });
    };
    if (silent) {
      publish();
      deliver();
    } else {
      // results reach the screen after a network-like delay
      const delay = 55 + this.r.int(120);
      this.later(delay, deliver);
      this.later(delay + 20, publish);
    }
    this.myAct = null;
    if (beat >= this.bellBeat) {
      this.later(silent ? 0 : 260, () => this.lightsOn());
      this.phase = "lights";
      this.phaseEndsAt = now() + LIGHTS_MS + 260;
      this.beat = beat;
      this.publishClock();
      return;
    }
    this.beat = beat + 1;
    this.beatEndsAt += BEAT_MS;
    this.prepareBeat();
    this.publishClock();
  }

  private spectatorCalls(beat: number) {
    if (beat > TAPE_CLOSE_BEAT) return;
    if (this.r.next() < 0.55) {
      const seats = this.w.get().table.seats;
      const wts = seats.map((s) => 1 + s.picked / 5);
      let x = this.r.next() * wts.reduce((a, b) => a + b, 0);
      let d = 0;
      while (d < DESKS - 1 && (x -= wts[d]) > 0) d++;
      this.w.set((s) => ({ tape: { ...s.tape, pool: s.tape.pool.map((v, i) => (i === d ? v + 1 : v)) } }));
    }
  }

  private async lightsOn() {
    const totals = this.book.resting.map((x, d) => x + this.book.picked[d]);
    const top = topDesk(this.book);
    const reveal: RevealView = {
      round: this.round, bellBeat: this.bellBeat, initialLevels: this.initialLevels, beats: this.log,
      totals, topDesk: top, check: { state: "pending" }, startedAt: now(),
    };
    this.commitHash = await hashLog(serializeLog(reveal));
    const tape = this.w.get().tape;
    const paid = tape.pool[top] > 0 ? tape.pool.reduce((a, b) => a + b, 0) / tape.pool[top] : ("refund" as const);
    this.phaseEndsAt = now() + LIGHTS_MS;
    this.publishClock();
    this.w.set((s) => ({ reveal, tape: { ...s.tape, paid }, joinNotice: null }));
    // the browser re-plays the revealed log and checks it against the commit
    const ok = replayMatches(reveal) && (await hashLog(serializeLog(reveal))) === this.commitHash;
    this.later(6000, () => {
      this.w.set((s) => (s.reveal && s.reveal.round === reveal.round ? { reveal: { ...s.reveal, check: { state: ok ? "ok" : "fail", hash: this.commitHash } } } : {}));
    });
  }

  /* ------------------------------------------------------------ actions */

  /** Any player input keeps the seat for the next round. */
  private keep() {
    this.keepSeat = true;
    if (this.w.get().seatAtRisk) this.w.set({ seatAtRisk: false });
  }

  private place(level: number) {
    if (!this.seated || !this.me || level < 1 || level > LEVELS) return;
    this.keep();
    if (this.phase === "hide") {
      this.book.level[0] = level;
      this.placed = true;
      this.setMe({ level });
    }
  }

  private ping(level: number) {
    if (!this.seated || !this.me || this.phase !== "live" || level < 1 || level > LEVELS) return;
    this.keep();
    this.lastActBeat = this.beat;
    this.myAct = { kind: "ping", level };
    this.setMe({ pending: { kind: "ping", level } });
  }

  private requote(level: number | null) {
    if (!this.seated || !this.me) return;
    if (this.phase === "hide") {
      this.place(level ?? 1 + this.r.int(LEVELS));
      return;
    }
    if (this.phase !== "live") return;
    this.keep();
    this.lastActBeat = this.beat;
    let L = level;
    if (L === null) {
      const own = this.book.level[0];
      const opts: number[] = [];
      for (let x = 1; x <= LEVELS; x++) if (x !== own && this.beat - this.book.lastPinged[0][x] > ALGO_MEMORY) opts.push(x);
      L = opts.length ? opts[this.r.int(opts.length)] : ((own % LEVELS) + 1);
    }
    if (L === this.book.level[0]) return;
    this.myAct = { kind: "requote", level: L };
    this.setMe({ pending: { kind: "requote", level: L } });
  }

  private tapeCall(desk: number) {
    const s = this.w.get();
    if (s.tape.myCall !== null || desk < 0 || desk >= DESKS) return;
    if (this.phase === "lights" || (this.phase === "live" && this.beat > TAPE_CLOSE_BEAT)) return;
    this.calls++;
    this.keep();
    this.w.set({ tape: { ...s.tape, myCall: desk, pool: s.tape.pool.map((v, i) => (i === desk ? v + 1 : v)) } });
  }

  private join() {
    this.keep();
    if (this.seated) return;
    // take over seat 0 as it stands (its level and lots become yours)
    this.seated = true;
    this.minds[0] = null;
    const me = this.freshMe(this.book.level[0]);
    me.resting = this.book.resting[0];
    me.picked = this.book.picked[0];
    me.nextAlgo = this.algo[0];
    this.me = me;
    this.w.set((s) => ({
      me, canJoin: false, seatState: "seated", seatAtRisk: false,
      table: { ...s.table, seats: this.seats(), mySeat: 0 },
      joinNotice: { name: this.player, seat: 0, level: this.book.level[0], resting: this.book.resting[0] },
    }));
  }

  /* ------------------------------------------------------------ peek (mock probe) */

  private async runPeek(n: PeekRead): Promise<PeekResult> {
    const t0 = now();
    await new Promise((r) => setTimeout(r, 90 + Math.random() * 160));
    const who = this.seated ? this.player : "anon";
    const other = BOTS[2].name;
    const lines: PeekResult["lines"] = [];
    const cmd = (text: string) => lines.push({ kind: "cmd", text: "$ " + text });
    const lit = this.phase === "lights";
    switch (n) {
      case 1:
        cmd("getAccountInfo(Book, tee, no token)");
        lines.push(lit ? { kind: "ok", text: "✓ public after the bell: the round's book is open for the replay" } : { kind: "no", text: "✗ value: null (no token, no permission)" });
        cmd("getAccountInfo(Book, base layer)");
        lines.push({ kind: "no", text: "✗ owner = delegation program · only the zeroed state it was created with (the Book is never committed)" });
        break;
      case 2:
        cmd(`getAccountInfo(Book, tee, token=${who})`);
        lines.push(lit ? { kind: "ok", text: "✓ public after the bell" } : { kind: "no", text: "✗ value: null · the Book has 0 members" });
        break;
      case 3: {
        cmd(`getAccountInfo(Desk/${who}, tee, token=${who})`);
        const m = this.me;
        if (m) {
          const last = this.w.get().results.filter((r) => r.kind !== "pickedoff").at(-1);
          lines.push({ kind: "ok", text: `✓ { level: ${priceOf(m.level)}, resting: ${lots(m.resting)}, picked: ${lots(m.picked)}, last: ${last ? `${last.kind === "fill" ? "FILL" : "miss"} ${priceOf(last.level!)}${last.tenths ? " +" + lots(last.tenths) : ""}` : "none"} }` });
        } else lines.push({ kind: "no", text: "✗ no desk: you are not seated" });
        cmd(`getAccountInfo(Desk/${other}, tee, token=${who})`);
        lines.push(lit ? { kind: "ok", text: "✓ public after the bell" } : { kind: "no", text: "✗ value: null · not a member" });
        break;
      }
      case 4:
        cmd(`getTransaction(<your last act>, tee, token=${who})`);
        lines.push({ kind: "no", text: "✗ slot only · 0 account keys · instruction data redacted · logs: [] (you, the sender, get the same)" });
        lines.push({ kind: "dim", text: "every desk sends one act every 250 ms: ping, move or nothing look the same" });
        break;
      case 5:
        cmd("getSignaturesForAddress(program, tee, anon)");
        lines.push({ kind: "ok", text: `✓ ${2 + this.calls} public txs: open_round, join` });
        lines.push({ kind: "no", text: "✗ 0 act txs listed while the round runs" });
        lines.push({ kind: "dim", text: "every desk sends the same act at the same rate and no act fails, so even a full listing carries nothing; after the bell the whole round appears, by design" });
        break;
    }
    lines.push({ kind: "dim", text: "(local simulation: mock driver)" });
    return { read: n, lines, ms: Math.round(now() - t0) };
  }
}
