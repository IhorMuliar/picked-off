/**
 * UI-local memory of the current round, built from the store: the marks on the book (with the beat they were made
 * and whether the auto made them), the latest results for the row flashes, the round's baseline for the score delta,
 * the join and move receipts, and the one-time hints. The only thing that goes back to the driver is the one move a
 * visitor makes on sitting down mid-round (through the normal action path).
 */
import { create } from "zustand";
import { STAKE_TENTHS, type PrivateResult } from "../state/types";
import { useGame } from "../state/store";
import { actions } from "../state/runtime";

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
  /** the newest auto FILL (a quiet mark, at most a hint) */
  autoFill: { level: number; beat: number } | null;
  /** total when the order first existed this round (or when this browser sat down), tenths */
  base: number | null;
  /** sat down after the round went live: the rest of the round is a warm-up */
  late: boolean;
  /** when this browser was first seated this round */
  seatedAt: { round: number; beat: number; total: number } | null;
  /** the one move made for a visitor who sat down mid-round */
  joinMove: { level: number; beat: number } | null;
  /** the last move that landed (receipt "Moved here") */
  moved: { level: number; beat: number } | null;
  /** the price tapped in HIDE (shown at once; re-sent until the desk confirms it) */
  hidePick: number | null;
  /** latest batch of results (screen-reader log + test hook) */
  log: PrivateResult[];
  /** one-time hints: the beat until which each shows */
  coach: { fill?: number; hit?: number };
  /** the player gave input this round */
  acted: boolean;
}

const empty = (round: number): RoundMem => ({
  round, marks: {}, flash: {}, hit: null, lastOwn: null, autoFill: null, base: null, late: false, seatedAt: null,
  joinMove: null, moved: null, hidePick: null, log: [], coach: {}, acted: false,
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

/** Feed the round memory from the store. Call once (App). Returns the unsubscribe. */
export function feedRound(): () => void {
  let seenId = 0;
  let prevLevel = 0;
  /** seated as the round began: a slow first read of the desk is not a takeover */
  let carried = false;
  /** the round in which the join move was sent (once per round, even if the seat flickers on takeover) */
  let joinMovedRound = -1;
  let resend: ReturnType<typeof setInterval> | null = null;
  const step = (s = useGame.getState()) => {
    const mem = useRound.getState();
    const round = s.table.round;
    if (round !== mem.round) {
      useRound.setState(empty(round));
      seenId = Math.max(seenId, ...s.results.map((r) => r.id), 0);
      prevLevel = 0;
      carried = !!s.me && s.table.mySeat !== null && mem.round !== 0;
    }
    const r = useRound.getState();
    const seated = !!s.me && s.table.mySeat !== null;
    // the baseline, once the order exists (never from an unplaced 0.0 desk)
    if (seated && r.base === null && s.me!.level > 0 && s.me!.resting + s.me!.picked > 0 && (s.clock.phase === "hide" || s.clock.phase === "live")) {
      const total = s.me!.resting + s.me!.picked;
      const early = carried || s.clock.phase === "hide" || s.clock.beat <= 1;
      useRound.setState({ base: early ? STAKE_TENTHS : total, late: !early, seatedAt: { round, beat: s.clock.beat, total } });
      if (!early && joinMovedRound !== round) {
        joinMovedRound = round;
        // sat down mid-round on someone else's order: hide it somewhere new at once (one move, normal action path)
        setTimeout(() => {
          const g = useGame.getState();
          if (!g.me || g.clock.phase !== "live" || g.table.round !== round || useRound.getState().acted) return;
          actions().requote(null);
          const p = useGame.getState().me?.pending;
          if (p?.kind === "requote") useRound.setState({ joinMove: { level: p.level, beat: g.clock.beat } });
        }, 0);
      }
    }
    if (!seated && r.base !== null) useRound.setState({ base: null, seatedAt: null });
    // a move that landed
    if (seated && s.clock.phase === "live") {
      const L = s.me!.level;
      if (prevLevel && L && L !== prevLevel) useRound.setState({ moved: { level: L, beat: s.clock.beat } });
      prevLevel = L;
    } else if (seated) prevLevel = s.me!.level;
    // a HIDE tap the desk has not confirmed yet is sent again (the first tap after sitting down can race the desk)
    const pick = useRound.getState().hidePick;
    const want = s.clock.phase === "hide" && seated && pick !== null && s.me!.level !== pick;
    if (want && !resend) {
      let n = 0;
      resend = setInterval(() => {
        const g = useGame.getState();
        const p = useRound.getState().hidePick;
        if (g.clock.phase !== "hide" || !g.me || p === null || g.me.level === p || ++n > 10) {
          if (resend) clearInterval(resend);
          resend = null;
          return;
        }
        actions().place(p);
      }, 450);
    }
    // new results
    const fresh = s.results.filter((x) => x.id > seenId);
    if (!fresh.length) return;
    seenId = Math.max(...fresh.map((x) => x.id));
    const cur = useRound.getState();
    const marks = { ...cur.marks };
    const flash = { ...cur.flash };
    const coach = { ...cur.coach };
    let { hit, lastOwn, autoFill } = cur;
    const beatNow = s.clock.beat;
    // after a mid-round takeover, results of the joining beat come from the previous owner's queued action: quiet marks
    const inherited = (x: PrivateResult) => cur.late && !!cur.seatedAt && x.beat <= cur.seatedAt.beat && x.kind !== "pickedoff";
    for (const x0 of fresh) {
      const x = inherited(x0) ? { ...x0, algo: true } : x0;
      if (x.kind === "pickedoff") {
        hit = { id: x.id, beat: x.beat, tenths: x.tenths, count: x.count ?? 1, next: x.next };
        lastOwn = x;
        if (firstTime("po.coach.pickedoff")) coach.hit = beatNow + 2;
        continue;
      }
      const L = x.level!;
      const orders = Math.max(1, x.orders ?? 1);
      // skims are 0.5 / 1.0 / 1.5 per order: the size per order is the escalation step
      const step = x.kind === "fill" ? Math.min(3, Math.max(1, Math.round(x.tenths / orders / 5))) : 0;
      marks[L] = { kind: x.kind, beat: x.beat, algo: x.algo, tenths: x.tenths, step, orders, next: x.next };
      flash[L] = { id: x.id, kind: x.kind, algo: x.algo };
      if (!x.algo) lastOwn = x;
      if (x.kind === "fill" && x.algo) autoFill = { level: L, beat: x.beat };
      if (x.kind === "fill" && !x.algo && firstTime("po.coach.fill")) coach.fill = beatNow + 2;
    }
    const latest = Math.max(...fresh.map((x) => x.beat));
    useRound.setState({ marks, flash, hit, lastOwn, autoFill, coach, log: fresh.filter((x) => x.beat === latest) });
  };
  step();
  const unsub = useGame.subscribe((s) => step(s));
  return () => {
    unsub();
    if (resend) clearInterval(resend);
  };
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
