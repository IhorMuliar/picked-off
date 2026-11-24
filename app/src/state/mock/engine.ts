/**
 * Local beat resolver for the mock driver (GAME-SPEC 5.3): re-quotes land first,
 * then pings fire in a seeded order; skim 0.5 / 1.0 / 1.5 lot per hunter->victim,
 * reset when the victim moves; a silent desk's algo pings a level it has not
 * pinged in the last 4 beats. Lots in tenths, levels 1..24.
 */
import { DESKS, LEVELS, STAKE_TENTHS } from "../types";

export const SKIM = [5, 10, 15];
export const ALGO_MEMORY = 4;

export type Act = { kind: "ping" | "requote"; level: number } | null;

export interface Rng {
  next(): number;
  int(n: number): number;
}
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n) };
}

export interface BookState {
  level: number[];
  resting: number[];
  picked: number[];
  streak: number[][]; // [hunter][victim]
  lastPinged: number[][]; // [desk][level] beat, -99 = never
  lastFillBeat: number[];
}

export function newBook(levels: number[]): BookState {
  return {
    level: [...levels],
    resting: Array(DESKS).fill(STAKE_TENTHS),
    picked: Array(DESKS).fill(0),
    streak: Array.from({ length: DESKS }, () => Array(DESKS).fill(0)),
    lastPinged: Array.from({ length: DESKS }, () => Array(LEVELS + 1).fill(-99)),
    lastFillBeat: Array(DESKS).fill(-1),
  };
}

export function cloneBook(b: BookState): BookState {
  return {
    level: [...b.level],
    resting: [...b.resting],
    picked: [...b.picked],
    streak: b.streak.map((r) => [...r]),
    lastPinged: b.lastPinged.map((r) => [...r]),
    lastFillBeat: [...b.lastFillBeat],
  };
}

/** The level desk `d` would algo-ping at `beat` (deterministic for the rng state). */
export function algoLevel(b: BookState, d: number, beat: number, r: Rng): number {
  const own = b.level[d];
  const fresh: number[] = [];
  const any: number[] = [];
  for (let L = 1; L <= LEVELS; L++) {
    if (L === own) continue;
    any.push(L);
    if (beat - b.lastPinged[d][L] > ALGO_MEMORY) fresh.push(L);
  }
  const pool = fresh.length ? fresh : any;
  return pool[r.int(pool.length)];
}

export interface Resolved {
  order: number[];
  actions: { desk: number; kind: "ping" | "requote"; level: number; algo: boolean }[];
  fills: { pinger: number; victim: number; level: number; tenths: number }[];
  /** Per desk: own ping outcome (null if it re-quoted). */
  ping: ({ level: number; tenths: number; algo: boolean } | null)[];
  /** Per desk: tenths lost this beat and number of fills against it. */
  lost: { tenths: number; count: number }[];
}

/**
 * Resolve one beat in place. `acts[d]` is the desk's chosen action or null (algo).
 * `algo[d]` is the precomputed algo level for silent desks. `order` is the
 * in-beat order (a permutation of 0..7).
 */
export function resolveBeat(b: BookState, beat: number, acts: Act[], algo: number[], order: number[]): Resolved {
  const actions = acts.map((a, d) =>
    a ? { desk: d, kind: a.kind, level: a.level, algo: false } : { desk: d, kind: "ping" as const, level: algo[d], algo: true },
  );
  // 1. re-quotes land first
  for (const d of order) {
    const a = actions[d];
    if (a.kind === "requote" && a.level !== b.level[d]) {
      b.level[d] = a.level;
      for (let h = 0; h < DESKS; h++) b.streak[h][d] = 0;
    }
  }
  // 2. pings in order
  const fills: Resolved["fills"] = [];
  const ping: Resolved["ping"] = Array(DESKS).fill(null);
  const lost = Array.from({ length: DESKS }, () => ({ tenths: 0, count: 0 }));
  for (const p of order) {
    const a = actions[p];
    if (a.kind !== "ping") continue;
    const L = a.level;
    b.lastPinged[p][L] = beat;
    let sum = 0;
    for (let v = 0; v < DESKS; v++) {
      if (v === p || b.level[v] !== L || b.resting[v] <= 0) continue;
      const amt = Math.min(SKIM[Math.min(b.streak[p][v], 2)], b.resting[v]);
      b.resting[v] -= amt;
      b.picked[p] += amt;
      b.streak[p][v] += 1;
      sum += amt;
      lost[v].tenths += amt;
      lost[v].count += 1;
      fills.push({ pinger: p, victim: v, level: L, tenths: amt });
    }
    if (sum > 0) b.lastFillBeat[p] = beat;
    ping[p] = { level: L, tenths: sum, algo: a.algo };
  }
  return { order, actions, fills, ping, lost };
}

export function permutation(r: Rng): number[] {
  const o = Array.from({ length: DESKS }, (_, i) => i);
  for (let i = o.length - 1; i > 0; i--) {
    const j = r.int(i + 1);
    [o[i], o[j]] = [o[j], o[i]];
  }
  return o;
}

/** Next skim the hunter would take on the strongest victim still at `level`. */
export function nextSkimAt(b: BookState, hunter: number, level: number): number {
  let best = 0;
  for (let v = 0; v < DESKS; v++) {
    if (v === hunter || b.level[v] !== level || b.resting[v] <= 0) continue;
    best = Math.max(best, Math.min(SKIM[Math.min(b.streak[hunter][v], 2)], b.resting[v]));
  }
  return best;
}

/** Top Desk: largest total; ties by picked, then earlier last FILL, then lowest seat. */
export function topDesk(b: BookState): number {
  let best = 0;
  for (let d = 1; d < DESKS; d++) {
    const t = b.resting[d] + b.picked[d];
    const bt = b.resting[best] + b.picked[best];
    if (t > bt) best = d;
    else if (t === bt) {
      if (b.picked[d] > b.picked[best]) best = d;
      else if (b.picked[d] === b.picked[best] && b.lastFillBeat[d] >= 0 && (b.lastFillBeat[best] < 0 || b.lastFillBeat[d] < b.lastFillBeat[best])) best = d;
    }
  }
  return best;
}
