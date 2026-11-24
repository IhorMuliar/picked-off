import { describe, expect, it } from "vitest";
import { DESKS, STAKE_TENTHS } from "../types";
import { algoLevel, newBook, permutation, resolveBeat, rng, type Act } from "./engine";
import { botDecide, botLearn, newMind } from "./bots";
import { replayMatches } from "../replay";
import type { RevealBeat, RevealView } from "../types";

describe("mock beat resolver", () => {
  it("escalates 0.5 -> 1.0 -> 1.5 and resets on re-quote", () => {
    const b = newBook([5, 7, 1, 2, 3, 4, 6, 8]);
    const ping = (L: number): Act[] => [{ kind: "ping", level: L }, null, null, null, null, null, null, null];
    const algo = [9, 10, 10, 10, 10, 10, 10, 10];
    const order = [0, 1, 2, 3, 4, 5, 6, 7];
    const got = [1, 2, 3].map((beat) => resolveBeat(b, beat, ping(7), algo, order).ping[0]!.tenths);
    expect(got).toEqual([5, 10, 15]);
    const acts: Act[] = [{ kind: "ping", level: 7 }, { kind: "requote", level: 7 }, null, null, null, null, null, null];
    resolveBeat(b, 4, acts, algo, order); // moving onto the same level is not a move
    expect(b.streak[0][1]).toBe(4);
    resolveBeat(b, 5, [null, { kind: "requote", level: 12 }, null, null, null, null, null, null], algo, order);
    expect(b.streak[0][1]).toBe(0);
  });

  it("conserves lots, never pings its own level by algo, and replays", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const levels = Array.from({ length: DESKS }, () => 1 + r.int(24));
      const b = newBook(levels);
      const minds = Array.from({ length: DESKS }, (_, i) => newMind((["shark", "ghost", "minnow"] as const)[i % 3]));
      const beats: RevealBeat[] = [];
      const bell = 20 + r.int(10);
      for (let beat = 1; beat <= bell; beat++) {
        const algo = Array.from({ length: DESKS }, (_, d) => algoLevel(b, d, beat, r));
        algo.forEach((L, d) => expect(L).not.toBe(b.level[d]));
        const acts = minds.map((m, d) => botDecide(m, b, d, beat, r));
        const order = permutation(r);
        const res = resolveBeat(b, beat, acts, algo, order);
        minds.forEach((m, d) => botLearn(m, res.ping[d], res.lost[d].tenths));
        beats.push({ beat, levels: [...b.level], actions: order.map((d) => res.actions[d]), fills: res.fills });
        const sum = b.resting.reduce((x, y) => x + y, 0) + b.picked.reduce((x, y) => x + y, 0);
        expect(sum).toBe(DESKS * STAKE_TENTHS);
        expect(Math.min(...b.resting)).toBeGreaterThanOrEqual(0);
      }
      const reveal: RevealView = {
        round: seed, bellBeat: bell, initialLevels: levels, beats, totals: b.resting.map((x, d) => x + b.picked[d]),
        topDesk: 0, check: { state: "pending" }, startedAt: 0,
      };
      expect(replayMatches(reveal)).toBe(true);
      reveal.totals[3] += 5;
      expect(replayMatches(reveal)).toBe(false);
    }
  });
});
