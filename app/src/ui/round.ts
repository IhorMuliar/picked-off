/**
 * UI-local memory of the current round, built from the store: the marks on the book (with the beat they were made
 * and whether the auto made them), the latest results for the row flashes, the round's baseline for the score delta,
 * and the one-time hints. Nothing here goes back to the driver.
 */
import { create } from "zustand";
import { STAKE_TENTHS, type PrivateResult } from "../state/types";
import { useGame } from "../state/store";

export interface Mark {
  kind: "fill" | "miss";
  beat: number;
  algo: boolean;
  /** lots taken by this ping (fill), tenths */
  tenths: number;
  /** escalation step of the skim per order: 1 = 0.5, 2 = 1.0, 3 = 1.5 */
  step: number;
  orders: number;
  next?: number;
}
export interface Hit {
  id: number;
  beat: number;
  tenths: number;
  count: number;
  next?: number;
}
export interface RoundMem {
  round: number;
  marks: Record<number, Mark>;
  /** id of the newest result per level, for the flash */
  flash: Record<number, { id: number; kind: "fill" | "miss"; algo: boolean }>;
  hit: Hit | null;
  /** last own result (not auto) of any kind, for the score line */
  lastOwn: PrivateResult | null;
  /** total at the round's start (or when this browser sat down), tenths */
  base: number | null;
  late: boolean;
  /** beat + round the seat was first seen this round (takeover notice) */
  seatedAt: { round: number; beat: number; total: number; fresh: boolean } | null;
  /** latest batch of results (screen-reader log + test hook) */
  log: PrivateResult[];
  /** a one-time hint and the beat it shows until */
  coach: { text: string; until: number } | null;
  /** the player gave input this round */
  acted: boolean;
}

const empty = (round: number): RoundMem => ({
  round, marks: {}, flash: {}, hit: null, lastOwn: null, base: null, late: false, seatedAt: null, log: [], coach: null, acted: false,
});
export const useRound = create<RoundMem>()(() => empty(0));

/** Once per browser: returns true the first time it is called for `k`. */
export function firstTime(k: string): boolean {
  try {
    if (localStorage.getItem(k)) return false;
    localStorage.setItem(k, "1");
  } catch {
    /* storage unavailable: show it */
  }
  return true;
}
export function seen(k: string): boolean {
  try {
    return !!localStorage.getItem(k);
  } catch {
    return false;
  }
}

export const isTouch = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

function coachFor(text: string, beat: number) {
  useRound.setState({ coach: { text, until: beat + 3 } });
}

/** Feed the round memory from the store. Call once (App). Returns the unsubscribe. */
export function feedRound(): () => void {
  let seenId = 0;
  const step = (s = useGame.getState()) => {
    const mem = useRound.getState();
    const round = s.table.round;
    if (round !== mem.round) {
      useRound.setState(empty(round));
      seenId = Math.max(seenId, ...s.results.map((r) => r.id), 0);
    }
    // baseline for the delta
    const r = useRound.getState();
    if (s.me && s.table.mySeat !== null && r.base === null && s.clock.phase !== "connecting" && s.clock.phase !== "lights") {
      const total = s.me.resting + s.me.picked;
      const early = s.clock.phase === "hide" || (s.clock.phase === "live" && s.clock.beat <= 1);
      const base = early ? STAKE_TENTHS : total;
      useRound.setState({
        base, late: !early,
        seatedAt: { round, beat: s.clock.beat, total, fresh: total === STAKE_TENTHS && s.me.picked === 0 },
      });
    }
    if (!s.me && r.base !== null && s.table.mySeat === null) useRound.setState({ base: null, seatedAt: null });
    // new results
    const fresh = s.results.filter((x) => x.id > seenId);
    if (!fresh.length) return;
    seenId = Math.max(...fresh.map((x) => x.id));
    const marks = { ...useRound.getState().marks };
    const flash = { ...useRound.getState().flash };
    let hit = useRound.getState().hit;
    let lastOwn = useRound.getState().lastOwn;
    const beatNow = s.clock.beat;
    for (const x of fresh) {
      if (x.kind === "pickedoff") {
        hit = { id: x.id, beat: x.beat, tenths: x.tenths, count: x.count ?? 1, next: x.next };
        lastOwn = x;
        if (!seen("po.coach.pickedoff") && firstTime("po.coach.pickedoff")) coachFor("Someone found your order. Move it.", beatNow);
        continue;
      }
      const L = x.level!;
      const orders = Math.max(1, x.orders ?? 1);
      // skims are 0.5 / 1.0 / 1.5 per order: the size per order is the escalation step
      const step = x.kind === "fill" ? Math.min(3, Math.max(1, Math.round(x.tenths / orders / 5))) : 0;
      marks[L] = { kind: x.kind, beat: x.beat, algo: x.algo, tenths: x.tenths, step, orders, next: x.next };
      flash[L] = { id: x.id, kind: x.kind, algo: x.algo };
      if (!x.algo) lastOwn = x;
      if (x.kind === "fill" && !x.algo && !seen("po.coach.fill") && firstTime("po.coach.fill"))
        coachFor(isTouch() ? "Still there. Ping it again for more." : "Still there. Ping it again for more (Space).", beatNow);
    }
    const latest = Math.max(...fresh.map((x) => x.beat));
    useRound.setState({ marks, flash, hit, lastOwn, log: fresh.filter((x) => x.beat === latest) });
  };
  step();
  return useGame.subscribe((s) => step(s));
}

/** The player did something on purpose this round. */
export function acted() {
  if (!useRound.getState().acted) useRound.setState({ acted: true });
  try {
    if (!localStorage.getItem("po.tapped")) localStorage.setItem("po.tapped", "1");
  } catch {
    /* storage unavailable */
  }
}

export { coachFor };
