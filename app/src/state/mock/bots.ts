/** House bot personalities (GAME-SPEC 3.2), deciding from their own desk only. */
import { LEVELS, type BotKind } from "../types";
import type { Act, BookState, Rng } from "./engine";

interface Persona {
  present: number;
  absence: number;
  fleeOnPicked: number;
  idleMove: number;
  reping: number;
  memory: number;
}
export const PERSONA: Record<BotKind, Persona> = {
  shark: { present: 0.9, absence: 2, fleeOnPicked: 0.3, idleMove: 0, reping: 1.0, memory: 8 },
  ghost: { present: 0.9, absence: 2, fleeOnPicked: 1.0, idleMove: 0.1, reping: 0.6, memory: 6 },
  minnow: { present: 0.75, absence: 3, fleeOnPicked: 0.5, idleMove: 0.03, reping: 0.7, memory: 3 },
};

/** What a bot remembers from its own private results. */
export interface BotMind {
  kind: BotKind;
  lastFill: number | null;
  pickedSinceAct: boolean;
  awayFor: number;
}

export function newMind(kind: BotKind): BotMind {
  return { kind, lastFill: null, pickedSinceAct: false, awayFor: 0 };
}

function pickLevel(b: BookState, d: number, beat: number, mem: number, r: Rng, avoid: number | null): number {
  const own = b.level[d];
  const ok: number[] = [];
  const any: number[] = [];
  for (let L = 1; L <= LEVELS; L++) {
    if (L === own || L === avoid) continue;
    any.push(L);
    if (beat - b.lastPinged[d][L] > mem) ok.push(L);
  }
  const pool = ok.length ? ok : any;
  return pool[r.int(pool.length)];
}

/** Decide a bot's action for `beat`; null = absent (the algo fires). */
export function botDecide(m: BotMind, b: BookState, d: number, beat: number, r: Rng): Act {
  const p = PERSONA[m.kind];
  if (m.awayFor > 0) {
    m.awayFor--;
    return null;
  }
  // absences come in streaks with the persona's mean length
  if (r.next() > p.present) {
    m.awayFor = Math.max(0, Math.round(p.absence * (0.5 + r.next())) - 1);
    return null;
  }
  let act: Act;
  if (m.pickedSinceAct && r.next() < p.fleeOnPicked) {
    act = { kind: "requote", level: pickLevel(b, d, beat, p.memory, r, m.lastFill) };
  } else if (r.next() < p.idleMove) {
    act = { kind: "requote", level: pickLevel(b, d, beat, p.memory, r, m.lastFill) };
  } else if (m.lastFill !== null && m.lastFill !== b.level[d] && r.next() < p.reping) {
    act = { kind: "ping", level: m.lastFill };
  } else {
    act = { kind: "ping", level: pickLevel(b, d, beat, p.memory, r, null) };
  }
  m.pickedSinceAct = false;
  return act;
}

/** Feed a bot its own results for the beat. */
export function botLearn(m: BotMind, ping: { level: number; tenths: number } | null, lostTenths: number) {
  if (ping) m.lastFill = ping.tenths > 0 ? ping.level : m.lastFill === ping.level ? null : m.lastFill;
  if (lostTenths > 0) m.pickedSinceAct = true;
}

/** HIDE placement drawn from the persona, independent of earlier rounds. */
export function botHide(r: Rng): number {
  return 1 + r.int(LEVELS);
}
