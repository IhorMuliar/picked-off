// Rules engine; byte-for-byte port of crates/ping-core/src/engine.rs. The Rust code is written
// branch-free for the on-chain program; this port uses plain branches with the same results.
import { sha256 } from "./sha256";
import {
  ALGO_MEMORY, BELL, BELL_MIN, BELL_SPAN, DESKS, HIDE, LEVELS, LIVE, LOG_ROW, MAX_BEATS, NOOP, PING,
  REQUOTE, SKIM_STEP, SKIM_STEPS, STAKE, zeroState,
  type Action, type BeatOut, type RoundState,
} from "./state";

const enc = new TextEncoder();
const tag = (s: string) => enc.encode(s);
const T = {
  seed: tag("ping/seed/v1"), fallback: tag("ping/fallback"), bell: tag("ping/bell"), levels: tag("ping/levels"),
  order: tag("ping/order"), tie: tag("ping/tie"), algo: tag("ping/algo"), salt: tag("ping/salt"),
  chain: tag("ping/chain"), open: tag("ping/open"),
};

export function u16le(x: number): Uint8Array {
  return new Uint8Array([x & 0xff, (x >>> 8) & 0xff]);
}
export function u64le(x: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, x), true);
  return b;
}
const leU32 = (h: Uint8Array, i: number) => (h[i] | (h[i + 1] << 8) | (h[i + 2] << 16) | (h[i + 3] << 24)) >>> 0;

/** Observer of the resolution (same calls as the Rust `Sink`; masks are 0/1 numbers). */
export interface Sink {
  pair?(hunter: number, victim: number, level: number, hit: number, amt: number): void;
  ping?(desk: number, level: number, pinged: number, fill: number): void;
}

export const validLevel = (l: number) => l >= 1 && l <= LEVELS;

export function deriveSeed(src: Uint8Array, saltAcc: Uint8Array, tableId: bigint, round: bigint): Uint8Array {
  return sha256(T.seed, src, saltAcc, u64le(tableId), u64le(round));
}

export function deriveBell(seed: Uint8Array): number {
  const h = sha256(T.bell, seed);
  const x = new DataView(h.buffer).getBigUint64(0, true);
  return BELL_MIN + Number(x % BigInt(BELL_SPAN));
}

export function deriveDefaultLevels(seed: Uint8Array): Uint8Array {
  const h = sha256(T.levels, seed);
  const out = new Uint8Array(DESKS);
  for (let s = 0; s < DESKS; s++) out[s] = 1 + ((h[2 * s] | (h[2 * s + 1] << 8)) % LEVELS);
  return out;
}

function shuffle(h: Uint8Array): Uint8Array {
  const out = Uint8Array.from({ length: DESKS }, (_, i) => i);
  for (let i = DESKS - 1; i >= 1; i--) {
    const j = leU32(h, 4 * i) % (i + 1);
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}

export function deriveOrder(seed: Uint8Array, beat: number): Uint8Array {
  return shuffle(sha256(T.order, seed, u16le(beat)));
}

export function deriveTieOrder(seed: Uint8Array): Uint8Array {
  return shuffle(sha256(T.tie, seed));
}

/** Algo levels for live beat `beat` from the current state (see the Rust docs). */
export function computeAlgo(st: RoundState, beat: number): Uint8Array {
  const h = sha256(T.algo, st.seed, u16le(beat));
  const out = new Uint8Array(DESKS);
  for (let s = 0; s < DESKS; s++) {
    const own = st.level[s];
    const e: number[] = [];
    for (let i = 0; i < LEVELS; i++) {
      const lp = st.lastPinged[s * LEVELS + i];
      e.push(i + 1 !== own && (lp === 0 || ((beat - lp) & 0xffff) > ALGO_MEMORY) ? 1 : 0);
    }
    if (!e.includes(1)) for (let i = 0; i < LEVELS; i++) e[i] = i + 1 !== own ? 1 : 0;
    let c = e.reduce((a, b) => a + b, 0);
    if (c === 0) c = 1;
    const k = leU32(h, 4 * s) % c;
    let run = 0;
    let chosen = 0;
    for (let i = 0; i < LEVELS; i++) {
      if (e[i] && run === k) chosen = i + 1;
      run += e[i];
    }
    out[s] = chosen;
  }
  return out;
}

/** Start a round: every field reset, resting = STAKE, phase HIDE. */
export function openRound(st: RoundState): void {
  Object.assign(st, zeroState());
  st.resting.fill(STAKE);
  st.phase = HIDE;
}

export function newRound(): RoundState {
  const st = zeroState();
  openRound(st);
  return st;
}

/** Store the VRF output; the first one wins. */
export function setVrf(st: RoundState, vrf: Uint8Array): void {
  if (!st.vrfSet) {
    st.vrf = Uint8Array.from(vrf);
    st.vrfSet = 1;
  }
}

/** Record one `act` (see the Rust `record_act`). */
export function recordAct(st: RoundState, desk: number, kind: number, level: number, salt: Uint8Array, ok = true): void {
  const s = desk % DESKS;
  const hide = ok && st.phase === HIDE;
  const live = ok && st.phase === LIVE;
  const valid = validLevel(level);
  if (hide) {
    st.saltAcc = sha256(T.salt, st.saltAcc, salt, new Uint8Array([s]));
    if (kind === REQUOTE && valid) {
      st.level[s] = level;
      st.placed[s] = 1;
    }
  }
  if (live && (kind === PING || kind === REQUOTE) && valid) {
    st.pendingKind[s] = kind;
    st.pendingLevel[s] = level;
  }
}

/** Resolve live beat `beat`'s actions in `order`: re-quotes first, then pings. */
export function applyBeat(st: RoundState, acts: Action[], order: ArrayLike<number>, beat: number, live: boolean, sink: Sink, out: BeatOut): void {
  const kind = acts.map((a) => ((a.kind === PING || a.kind === REQUOTE) && validLevel(a.level) ? a.kind : NOOP));
  const lvl = acts.map((a) => a.level);
  if (live) {
    for (let idx = 0; idx < DESKS; idx++) {
      const p = order[idx] % DESKS;
      if (kind[p] === REQUOTE && lvl[p] !== st.level[p]) {
        st.level[p] = lvl[p];
        for (let h = 0; h < DESKS; h++) st.streak[h * DESKS + p] = 0;
      }
    }
  }
  const fill = new Array(DESKS).fill(0);
  const lost = new Array(DESKS).fill(0);
  const victims = new Array(DESKS).fill(0);
  const taken = new Array(DESKS).fill(0);
  const ip = new Array(DESKS).fill(0);
  for (let idx = 0; idx < DESKS; idx++) {
    const p = order[idx] % DESKS;
    ip[p] = live && kind[p] === PING ? 1 : 0;
    const l = lvl[p];
    if (ip[p]) st.lastPinged[p * LEVELS + ((l + LEVELS - 1) % LEVELS)] = beat;
    for (let v = 0; v < DESKS; v++) {
      const rest = st.resting[v];
      const hit = ip[p] && v !== p && st.level[v] === l && rest > 0 ? 1 : 0;
      const sk = st.streak[p * DESKS + v];
      const amt = hit ? Math.min(SKIM_STEP * (1 + Math.min(sk, SKIM_STEPS - 1)), rest) : 0;
      st.resting[v] = rest - amt;
      st.picked[p] += amt;
      st.streak[p * DESKS + v] = Math.min(sk + hit, 200);
      sink.pair?.(p, v, l, hit, amt);
      fill[p] += amt;
      lost[v] += amt;
      victims[p] += hit;
      taken[v] += hit;
    }
    sink.ping?.(p, l, ip[p], fill[p]);
    if (ip[p] && fill[p] > 0) st.lastFill[p] = beat;
  }
  const row = Math.min(beat >= 1 ? beat - 1 : MAX_BEATS - 1, MAX_BEATS - 1) * LOG_ROW;
  let pings = 0;
  let fills = 0;
  for (let s = 0; s < DESKS; s++) {
    if (live) {
      st.log[row + 2 * s] = kind[s] | ((acts[s].algo & 1) << 7);
      st.log[row + 2 * s + 1] = lvl[s];
    }
    const filled = ip[s] && fill[s] > 0 ? 1 : 0;
    pings += ip[s];
    fills += filled;
    const d = out.desks[s];
    d.resting = st.resting[s];
    d.picked = st.picked[s];
    d.fillAmt = fill[s];
    d.lostAmt = lost[s];
    d.level = st.level[s];
    d.actionKind = live ? kind[s] : 0;
    d.actionLevel = live ? lvl[s] : 0;
    d.actionAlgo = live ? acts[s].algo & 1 : 0;
    d.result = ip[s] * (1 + filled);
    d.victims = victims[s];
    d.hitsTaken = taken[s];
  }
  out.pings = pings;
  out.fills = fills;
}

export function chainStep(chain: Uint8Array, seed: Uint8Array, beat: number, row: Uint8Array): Uint8Array {
  return sha256(T.chain, chain, seed, u16le(beat), row);
}

export function chainOpen(tableId: bigint, round: bigint, seed: Uint8Array, initial: Uint8Array, bell: number): Uint8Array {
  return sha256(T.open, u64le(tableId), u64le(round), seed, initial, u16le(bell));
}

/** Top Desk: largest total; ties by more picked, then the earlier last FILL, then the seed. */
export function topDesk(st: RoundState): number {
  const tie = deriveTieOrder(st.seed);
  const rank = new Array(DESKS).fill(0);
  for (let k = 0; k < DESKS; k++) rank[tie[k]] = DESKS - 1 - k;
  let best = 0;
  let bestKey = 0;
  for (let s = 0; s < DESKS; s++) {
    const tot = st.resting[s] + st.picked[s];
    const key = tot * 2 ** 40 + st.picked[s] * 2 ** 24 + (0xffff - st.lastFill[s]) * 2 ** 8 + rank[s];
    if (key > bestKey) {
      best = s;
      bestKey = key;
    }
  }
  return best;
}

function finish(st: RoundState, active: boolean, isBell: boolean, out: BeatOut): void {
  const nx = computeAlgo(st, st.beat + 1);
  for (let s = 0; s < DESKS; s++) {
    if (active) st.algoNext[s] = nx[s];
    out.desks[s].nextAlgo = st.algoNext[s];
    out.picked[s] = st.picked[s];
    out.totals[s] = st.resting[s] + st.picked[s];
  }
  if (isBell) st.topDesk = topDesk(st);
  out.topDesk = st.topDesk;
  out.beat = st.beat;
  out.phase = st.phase;
  out.chain = Uint8Array.from(st.chain);
}

/** One resolving tick: the HIDE end, or live beat `st.beat + 1` (see the Rust `tick`). */
export function tick(st: RoundState, tableId: bigint, round: bigint, slot: bigint, sink: Sink, out: BeatOut): BeatOut {
  const isHide = st.phase === HIDE;
  const isLive = st.phase === LIVE;
  const active = isHide || isLive;
  if (isHide) {
    const src = st.vrfSet ? st.vrf : sha256(T.fallback, st.saltAcc, u64le(slot));
    st.seed = deriveSeed(src, st.saltAcc, tableId, round);
    st.bellBeat = deriveBell(st.seed);
    st.fallback = st.vrfSet ? 0 : 1;
    const dl = deriveDefaultLevels(st.seed);
    for (let s = 0; s < DESKS; s++) {
      if (!st.placed[s] || !validLevel(st.level[s])) st.level[s] = dl[s];
      st.initialLevel[s] = st.level[s];
    }
    st.chain = chainOpen(tableId, round, st.seed, st.initialLevel, st.bellBeat);
  }
  const b = isLive ? st.beat + 1 : 0;
  const acts: Action[] = [];
  for (let s = 0; s < DESKS; s++) {
    const pk = st.pendingKind[s];
    acts.push(pk ? { kind: pk, level: st.pendingLevel[s], algo: 0 } : { kind: PING, level: st.algoNext[s], algo: 1 });
    if (active) {
      st.pendingKind[s] = 0;
      st.pendingLevel[s] = 0;
    }
  }
  applyBeat(st, acts, deriveOrder(st.seed, b), b, isLive, sink, out);
  let isBell = false;
  if (isLive) {
    const ri = (b - 1) * LOG_ROW;
    st.chain = chainStep(st.chain, st.seed, b, st.log.subarray(ri, ri + LOG_ROW));
    st.beat = b;
    isBell = b === st.bellBeat;
  }
  if (isHide) st.phase = LIVE;
  else if (isBell) st.phase = BELL;
  finish(st, active, isBell, out);
  return out;
}

/** Live step with explicit actions (the replay path). */
export function replayStep(st: RoundState, acts: Action[], sink: Sink, out: BeatOut): void {
  const b = st.beat + 1;
  applyBeat(st, acts, deriveOrder(st.seed, b), b, true, sink, out);
  const ri = (b - 1) * LOG_ROW;
  st.chain = chainStep(st.chain, st.seed, b, st.log.subarray(ri, ri + LOG_ROW));
  st.beat = b;
  const isBell = b === st.bellBeat;
  if (isBell) st.phase = BELL;
  finish(st, true, isBell, out);
}
