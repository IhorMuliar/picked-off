/** Pure mappings from decoded accounts to the screen's view-model. */
import { ALGO_FLAG, DESKS, LOG_ROW, PING, REQUOTE, deriveOrder, readRecord, replay, verify, writeRecord, recordFromState, type RoundState } from "../core";
import type { PrivateResult, RevealBeat, RevealView, Seat, BotKind, PublicPrint } from "../state/types";
import { BELL_MAX, BELL_MIN } from "../state/types";
import { PERSONALITY, SEAT, type DeskOutRaw, type Table } from "./layout";

export const SKIM_STEP = 5;
export const SKIM_CAP = 15;

/** Public bell chance for live beat `b`: the bell is uniform on BELL_MIN..BELL_MAX. */
export const bellChance = (b: number) => (b >= BELL_MIN && b <= BELL_MAX ? 1 / (BELL_MAX + 1 - b) : 0);

const short = (k: string | null) => (k ? `${k.slice(0, 4)}…${k.slice(-4)}` : "");
export function seatsView(t: Table): Seat[] {
  return t.seats.map((s, i) => {
    const bot = PERSONALITY[s.personality] as BotKind | "none" | undefined;
    const name = s.name || (s.kind === SEAT.empty ? `DESK-${i + 1}` : short(s.key));
    return s.kind === SEAT.human
      ? { name, kind: "human" as const, picked: t.picked[i] }
      : { name, kind: "bot" as const, bot: bot && bot !== "none" ? bot : undefined, picked: t.picked[i] };
  });
}

/** The prints of live beat `beat` from the Table's ring (FILL prints, then the beat summary). */
export function printsOfBeat(t: Table, beat: number): Omit<PublicPrint, "id">[] {
  const stamp = 5 + Math.floor(beat * 1.5);
  const out: Omit<PublicPrint, "id">[] = [];
  const n = Math.min(32, t.printCount);
  for (let i = 0; i < n; i++) {
    const p = t.prints[(t.printCount - n + i) % 32];
    if (p.beat === beat && p.tenths > 0) out.push({ t: stamp, desk: p.desk, tenths: p.tenths });
  }
  const c = t.beatCounts[beat] ?? [0, 0];
  out.push({ t: stamp, pings: c[0], fills: c[1] });
  return out;
}

/** Private results of one resolved beat of the own Desk. */
export function resultsOfBeat(beat: number, r: DeskOutRaw): Omit<PrivateResult, "id">[] {
  const out: Omit<PrivateResult, "id">[] = [];
  if (beat < 1) return out;
  if (r.actionKind === PING && r.result > 0) {
    const fill = r.result === 2 && r.fillAmt > 0;
    out.push({
      beat, kind: fill ? "fill" : "miss", level: r.actionLevel, tenths: fill ? r.fillAmt : 0, algo: r.actionAlgo === 1,
      next: fill ? nextSkim(r.fillAmt, r.victims) : undefined,
    });
  }
  if (r.lostAmt > 0) out.push({ beat, kind: "pickedoff", tenths: r.lostAmt, count: r.hitsTaken, algo: false, next: nextSkim(r.lostAmt, r.hitsTaken) });
  return out;
}

/** Estimate of the next skim on the same pair: one step above the average skim just taken. */
export const nextSkim = (amt: number, count: number) => Math.min(SKIM_CAP, Math.round(amt / Math.max(1, count) / SKIM_STEP) * SKIM_STEP + SKIM_STEP);

export interface RevealBuild {
  view: Omit<RevealView, "startedAt" | "check" | "explorerUrl">;
  check: { state: "ok" | "fail"; hash: string; error?: string };
}

const hex = (b: Uint8Array) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Replay a committed round record, build the LIGHTS ON data and verify it against `commit`. */
export function buildReveal(record: Uint8Array, commit: Uint8Array, round: number): RevealBuild | null {
  let rec;
  try {
    rec = readRecord(record);
  } catch {
    return null;
  }
  const beats: RevealBeat[] = [];
  let fills: RevealBeat["fills"] = [];
  const res = replay(
    rec,
    { pair: (hunter, victim, level, hit, amt) => void (hit && amt > 0 && fills.push({ pinger: hunter, victim, level, tenths: amt })) },
    (st: RoundState) => {
      const b = st.beat;
      const row = rec.log.subarray((b - 1) * LOG_ROW, b * LOG_ROW);
      const order = deriveOrder(rec.seed, b);
      const actions = Array.from(order, (d) => {
        const k = row[2 * d] & ~ALGO_FLAG & 0xff;
        return { desk: d, kind: k === REQUOTE ? ("requote" as const) : ("ping" as const), level: row[2 * d + 1], algo: (row[2 * d] & ALGO_FLAG) !== 0 };
      });
      beats.push({ beat: b, levels: Array.from(st.level), actions, fills });
      fills = [];
    },
  );
  const v = verify(record, commit);
  const totals = res.ok ? res.verdict.totals : new Array(DESKS).fill(0);
  return {
    view: { round, bellBeat: rec.bellBeat, initialLevels: Array.from(rec.initialLevel), beats, totals, topDesk: res.ok ? res.verdict.topDesk : 0 },
    check: { state: v.ok ? "ok" : "fail", hash: hex(commit), error: v.ok ? undefined : v.error.kind },
  };
}

/** Record bytes rebuilt from an unsealed Book (rounds without a Round account). */
export const recordFromBook = (st: RoundState, tableId: bigint, round: bigint) => writeRecord(recordFromState(st, tableId, round));

export { PING, REQUOTE };
