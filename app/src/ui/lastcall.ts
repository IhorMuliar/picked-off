/**
 * The player's last Tape call, kept across rounds (and reloads) until they dismiss it or make the next call, so a
 * player who looked away still finds out what happened to their 0.01 SOL: open → won / lost / refunded (from the
 * reveal) → paid out (when the driver sees the Call settled).
 */
import { create } from "zustand";
import { useGame } from "../state/store";

export type CallOutcome = "open" | "won" | "lost" | "refunded";
export interface LastCall {
  round: number;
  desk: number;
  name: string;
  /** stake in lamports (0 in the demo) */
  stake: number;
  outcome: CallOutcome;
  mult?: number;
  /** what the chain says about the payout; "demo" when there is nothing to pay */
  settled?: "settled" | "claimed" | "owed" | "demo";
  dismissed: boolean;
}

const KEY = "po.lastcall";
const load = (): LastCall | null => {
  try {
    const v = localStorage.getItem(KEY);
    return v ? (JSON.parse(v) as LastCall) : null;
  } catch {
    return null;
  }
};
export const useLastCall = create<{ call: LastCall | null }>()(() => ({ call: load() }));

function save(call: LastCall | null) {
  useLastCall.setState({ call });
  try {
    if (call) localStorage.setItem(KEY, JSON.stringify(call));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: kept for this page only */
  }
}

export const dismissLastCall = () => {
  const c = useLastCall.getState().call;
  if (c) save({ ...c, dismissed: true });
};

/** SOL with up to 3 decimals: 10_000_000 → "0.01". */
export const sol = (lamports: number) => `${(lamports / 1e9).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")} SOL`;

/** What the player gets back, lamports (null while unknown). */
export function payout(c: LastCall): number | null {
  if (c.outcome === "refunded") return c.stake;
  if (c.outcome === "lost") return 0;
  if (c.outcome === "won" && c.mult) return Math.floor(c.stake * c.mult);
  return null;
}

/** Feed from the store. Call once (App). */
export function feedLastCall(): () => void {
  const step = () => {
    const s = useGame.getState();
    let c = useLastCall.getState().call;
    const t = s.tape;
    const round = s.table.round;
    if (t.myCall !== null && round && (!c || c.round !== round)) {
      const chain = t.closesAt !== undefined;
      c = {
        round, desk: t.myCall, name: t.myCall === s.table.mySeat ? "yourself" : (s.table.seats[t.myCall]?.name ?? `desk ${t.myCall + 1}`),
        stake: chain ? (s.callLamports ?? 10_000_000) : 0, outcome: "open", dismissed: false,
      };
      save(c);
    }
    if (!c) return;
    let next = c;
    if (c.outcome === "open" && c.round === round && s.reveal && s.reveal.round === round && t.paid !== undefined) {
      const outcome: CallOutcome = t.paid === "refund" ? "refunded" : c.desk === s.reveal.topDesk ? "won" : "lost";
      next = { ...next, outcome, mult: typeof t.paid === "number" ? t.paid : undefined, settled: t.closesAt === undefined ? "demo" : next.settled };
    }
    const st = s.tapeSettled?.[c.round];
    if (st && next.settled !== st) next = { ...next, settled: st };
    if (next !== c) save(next);
  };
  step();
  return useGame.subscribe(step);
}

/** The words for a call's state, shared by the chip, the Tape sheet and the results. */
export function callWords(c: LastCall, currentRound: number): { chip: string; title: string; detail: string; done: boolean } {
  const p = payout(c);
  const paid = c.settled === "settled" || c.settled === "claimed";
  const amt = p !== null && c.stake ? sol(p) : null;
  if (c.outcome === "open")
    return {
      chip: "Tape ✓", title: `Your call on ${c.name}${c.stake ? ` · ${sol(c.stake)}` : ""}`,
      detail: c.round === currentRound ? "The result comes at the bell." : `Waiting for the result of round ${c.round}.`, done: false,
    };
  const tail = c.settled === "demo" ? "Demo: nothing to pay." : c.settled === "owed" ? `${amt} owed: too small to send yet, kept on your call.` : null;
  if (c.outcome === "won")
    return {
      chip: "Call won", title: `Won ${c.mult ? `${c.mult.toFixed(1)}×` : ""} on ${c.name}`.replace("  ", " "),
      detail: tail ?? (paid ? `${amt} paid to this browser ✓` : `Paying out ${amt ?? "your share"} after the round…`), done: paid || !!tail,
    };
  if (c.outcome === "refunded")
    return {
      chip: "Refunded", title: "Refunded: nobody called the top desk",
      detail: tail ?? (paid ? `${amt ?? "Your stake"} paid back ✓` : `Paying back ${amt ?? "your stake"} after the round…`), done: paid || !!tail,
    };
  return {
    chip: "Call lost", title: `Lost: ${c.name === "yourself" ? "you" : c.name} did not finish on top`,
    detail: tail ?? (paid ? `Settled ✓ ${c.stake ? `(your ${sol(c.stake)} went to the right calls)` : ""}`.trim() : "Settling after the round…"), done: paid || !!tail,
  };
}
