// Round record and replay verifier; port of crates/ping-core/src/replay.rs.
import { chainOpen, computeAlgo, deriveBell, newRound, replayStep, u64le, validLevel, type Sink } from "./engine";
import { ALGO_FLAG, DESKS, LIVE, LOG_LEN, LOG_ROW, MAX_BEATS, PING, REQUOTE, zeroOut, type Action, type BeatOut, type RoundState } from "./state";

export const RECORD_LEN = 8 + 8 + 32 + DESKS + 2 + LOG_LEN;

export interface RoundRecord {
  tableId: bigint;
  round: bigint;
  seed: Uint8Array;
  initialLevel: Uint8Array;
  bellBeat: number;
  log: Uint8Array;
}

export function recordFromState(st: RoundState, tableId: bigint, round: bigint): RoundRecord {
  return { tableId, round, seed: Uint8Array.from(st.seed), initialLevel: Uint8Array.from(st.initialLevel), bellBeat: st.bellBeat, log: Uint8Array.from(st.log) };
}

export function writeRecord(r: RoundRecord): Uint8Array {
  const b = new Uint8Array(RECORD_LEN);
  b.set(u64le(r.tableId), 0);
  b.set(u64le(r.round), 8);
  b.set(r.seed, 16);
  b.set(r.initialLevel, 48);
  b[56] = r.bellBeat & 0xff;
  b[57] = r.bellBeat >>> 8;
  b.set(r.log, 58);
  return b;
}

export function readRecord(b: Uint8Array): RoundRecord {
  if (b.length !== RECORD_LEN) throw new Error(`round record must be ${RECORD_LEN} bytes`);
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  return {
    tableId: dv.getBigUint64(0, true),
    round: dv.getBigUint64(8, true),
    seed: b.slice(16, 48),
    initialLevel: b.slice(48, 56),
    bellBeat: dv.getUint16(56, true),
    log: b.slice(58),
  };
}

export type VerifyError =
  | { kind: "BadLength" }
  | { kind: "BadLevel"; desk: number }
  | { kind: "BadBell" }
  | { kind: "BadAction"; beat: number; desk: number }
  | { kind: "BadAlgo"; beat: number; desk: number }
  | { kind: "TrailingLog"; beat: number }
  | { kind: "BadCommit" };

export interface Verdict {
  totals: number[];
  picked: number[];
  topDesk: number;
  commit: Uint8Array;
}

export type VerifyResult = { ok: true; verdict: Verdict; state: RoundState } | { ok: false; error: VerifyError };

/** Replay a record; `onBeat(state, out)` sees every live beat (for the reveal animation). */
export function replay(rec: RoundRecord, sink: Sink = {}, onBeat?: (st: RoundState, out: BeatOut) => void): VerifyResult {
  for (let s = 0; s < DESKS; s++) if (!validLevel(rec.initialLevel[s])) return { ok: false, error: { kind: "BadLevel", desk: s } };
  if (deriveBell(rec.seed) !== rec.bellBeat) return { ok: false, error: { kind: "BadBell" } };
  const st = newRound();
  st.seed = Uint8Array.from(rec.seed);
  st.level = Uint8Array.from(rec.initialLevel);
  st.initialLevel = Uint8Array.from(rec.initialLevel);
  st.placed.fill(1);
  st.bellBeat = rec.bellBeat;
  st.chain = chainOpen(rec.tableId, rec.round, st.seed, st.initialLevel, st.bellBeat);
  st.phase = LIVE;
  st.algoNext = computeAlgo(st, 1);
  const out = zeroOut();
  for (let b = 1; b <= rec.bellBeat; b++) {
    const row = rec.log.subarray((b - 1) * LOG_ROW, b * LOG_ROW);
    const acts: Action[] = [];
    for (let s = 0; s < DESKS; s++) {
      const algo = row[2 * s] >> 7;
      const kind = row[2 * s] & ~ALGO_FLAG & 0xff;
      const level = row[2 * s + 1];
      if ((kind !== PING && kind !== REQUOTE) || !validLevel(level)) return { ok: false, error: { kind: "BadAction", beat: b, desk: s } };
      if (algo === 1 && (kind !== PING || level !== st.algoNext[s])) return { ok: false, error: { kind: "BadAlgo", beat: b, desk: s } };
      acts.push({ kind, level, algo });
    }
    replayStep(st, acts, sink, out);
    onBeat?.(st, out);
  }
  for (let b = rec.bellBeat + 1; b <= MAX_BEATS; b++) {
    if (rec.log.subarray((b - 1) * LOG_ROW, b * LOG_ROW).some((x) => x !== 0)) return { ok: false, error: { kind: "TrailingLog", beat: b } };
  }
  const totals = Array.from({ length: DESKS }, (_, s) => st.resting[s] + st.picked[s]);
  return { ok: true, verdict: { totals, picked: Array.from(st.picked), topDesk: st.topDesk, commit: Uint8Array.from(st.chain) }, state: st };
}

/** Verify a serialized round record against the published commit hash. */
export function verify(record: Uint8Array, commit: Uint8Array): VerifyResult {
  if (record.length !== RECORD_LEN) return { ok: false, error: { kind: "BadLength" } };
  const r = replay(readRecord(record));
  if (!r.ok) return r;
  if (commit.length !== 32 || r.verdict.commit.some((x, i) => x !== commit[i])) return { ok: false, error: { kind: "BadCommit" } };
  return r;
}
