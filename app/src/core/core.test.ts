import { describe, expect, it } from "vitest";
import goldenRaw from "../../../crates/ping-core/tests/vectors/golden.json?raw";
import engineRaw from "../../../crates/ping-core/tests/vectors/engine.json?raw";
import {
  BELL, LIVE, RECORD_LEN, ROUND_STATE_SIZE, applyBeat, decodeRoundState, newRound, readRecord, recordAct, recordFromState, setVrf, sha256, tick,
  verify, writeRecord, zeroOut, type Action, type BeatOut, type Sink,
} from "./index";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
const enc = new TextEncoder();

interface GoldenBeat { levels_before: number[]; order: number[]; actions: number[][]; events: number[][]; resting: number[]; picked: number[] }
interface GoldenRound { id: number; beats: GoldenBeat[]; final_total: number[] }
interface EngineRound {
  table_id: number; round: number; vrf: string | null; hide_slot: number;
  hide_acts: [number, number, number, string][]; beat_acts: [number, number, number, string][][];
  outs: { beat: number; phase: number; pings: number; fills: number; top_desk: number; picked: number[]; totals: number[]; chain: string; desks: number[][] }[];
  record: string; commit: string; final_state: string;
}
const golden: { rounds: GoldenRound[] } = JSON.parse(goldenRaw);
const engine: { rounds: EngineRound[] } = JSON.parse(engineRaw);

function outJson(o: BeatOut) {
  return {
    beat: o.beat, phase: o.phase, pings: o.pings, fills: o.fills, top_desk: o.topDesk, picked: [...o.picked], totals: [...o.totals], chain: hex(o.chain),
    desks: o.desks.map((d) => [d.resting, d.picked, d.fillAmt, d.lostAmt, d.level, d.actionKind, d.actionLevel, d.actionAlgo, d.result, d.victims, d.hitsTaken, d.nextAlgo]),
  };
}

function playEngineRound(r: EngineRound) {
  const st = newRound();
  const t = BigInt(r.table_id);
  const n = BigInt(r.round);
  for (const [d, k, l, s] of r.hide_acts) recordAct(st, d, k, l, unhex(s));
  if (r.vrf) setVrf(st, unhex(r.vrf));
  const outs = [outJson(tick(st, t, n, BigInt(r.hide_slot), {}, zeroOut()))];
  for (const acts of r.beat_acts) {
    expect(st.phase).toBe(LIVE);
    for (const [d, k, l, s] of acts) recordAct(st, d, k, l, unhex(s));
    outs.push(outJson(tick(st, t, n, 0n, {}, zeroOut())));
  }
  return { st, outs, record: writeRecord(recordFromState(st, t, n)) };
}

describe("sha256", () => {
  it("known answers", () => {
    expect(hex(sha256())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hex(sha256(enc.encode("a"), enc.encode("bc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hex(sha256(enc.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(hex(sha256(new Uint8Array(1_000_000).fill(97)))).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });
});

describe("golden vectors (reference rounds)", () => {
  it("replay exactly", () => {
    let beats = 0;
    for (const rd of golden.rounds) {
      const st = newRound();
      st.phase = LIVE;
      st.level.set(rd.beats[0].levels_before);
      const out = zeroOut();
      rd.beats.forEach((bt, i) => {
        expect([...st.level], `round ${rd.id} beat ${i} levels`).toEqual(bt.levels_before);
        const events: number[][] = [];
        const sink: Sink = {
          pair: (_h, v, level, hit, amt) => { if (hit) events.push([v, 2, level, amt]); },
          ping: (p, level, pinged, fill) => { if (pinged) events.push([p, fill > 0 ? 1 : 0, level, fill]); },
        };
        const acts: Action[] = bt.actions.map(([kind, level, algo]) => ({ kind, level, algo }));
        applyBeat(st, acts, bt.order, i + 1, true, sink, out);
        st.beat = i + 1;
        expect(events, `round ${rd.id} beat ${i} events`).toEqual(bt.events);
        expect([...st.resting]).toEqual(bt.resting);
        expect([...st.picked]).toEqual(bt.picked);
        beats++;
      });
      expect(Array.from(st.resting, (x, s) => x + st.picked[s])).toEqual(rd.final_total);
    }
    expect(golden.rounds.length).toBe(15);
    expect(beats).toBe(361);
  });
});

describe("engine vectors (Rust tick path)", () => {
  it("every tick's outputs, the record and the commit match", () => {
    for (const r of engine.rounds) {
      const { st, outs, record } = playEngineRound(r);
      expect(outs).toEqual(r.outs);
      expect(st.phase).toBe(BELL);
      expect(hex(record)).toBe(r.record);
      expect(hex(st.chain)).toBe(r.commit);
      const raw = unhex(r.final_state);
      expect(raw.length).toBe(ROUND_STATE_SIZE);
      expect(decodeRoundState(raw)).toEqual(st);
      const v = verify(record, unhex(r.commit));
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.verdict.totals).toEqual(r.outs[r.outs.length - 1].totals);
        expect(v.verdict.topDesk).toBe(r.outs[r.outs.length - 1].top_desk);
      }
    }
    expect(engine.rounds.length).toBe(16);
  });
});

describe("replay verifier", () => {
  it("rejects every flipped byte of the record and of the commit", () => {
    const r = engine.rounds[0];
    const rec = unhex(r.record);
    const commit = unhex(r.commit);
    expect(rec.length).toBe(RECORD_LEN);
    expect(hex(writeRecord(readRecord(rec)))).toBe(r.record);
    expect(verify(rec, commit).ok).toBe(true);
    for (let i = 0; i < RECORD_LEN; i++) {
      const b = Uint8Array.from(rec);
      b[i] ^= 0x01;
      expect(verify(b, commit).ok, `flip at ${i}`).toBe(false);
    }
    for (let i = 0; i < 32; i++) {
      const c = Uint8Array.from(commit);
      c[i] ^= 0x80;
      expect(verify(rec, c)).toEqual({ ok: false, error: { kind: "BadCommit" } });
    }
    expect(verify(rec.subarray(1), commit).ok).toBe(false);
  });
});
