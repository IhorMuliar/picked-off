/**
 * One decision per moment: the hint line, the primary button and the secondary button come from the same state, so
 * they can never contradict each other. Priority while live: moving / move mode > PICKED OFF (last 2 beats) > a
 * queued ping > the player's own FILL > "Tap a price". Auto results never drive a button; they are marks and at
 * most a hint. Offline overrides everything and offers nothing that cannot be sent.
 */
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useGame, useUi } from "../state/store";
import { actions } from "../state/runtime";
import { lots, priceOf } from "../state/types";
import { sfx, unlockAudio } from "../fx/sound";
import { acted, seen, useRound } from "./round";
import { useLink } from "./link";
import { keepSeat, moveTo, nudgeBook, toggleMoveMode } from "./act";

export const PROMISE = "Find the hidden orders. Tap a price.";
const JOIN_SLOW_MS = 15_000;

export type Tone = "you" | "loss" | "plain" | "wait" | "quiet";
export interface Btn {
  label: string;
  sub?: string;
  tone: Tone;
  state: string;
  onClick?: () => void;
  testid?: string;
  disabled?: boolean;
}
export interface Decision {
  hint: { text: string; kind: "" | "loss" | "note" | "coach" | "join" | "promise" };
  primary: Btn;
  secondary: Btn | null;
}

/** Seconds left in the current phase, re-rendered 4× a second while `on`. */
export function usePhaseLeft(on: boolean) {
  const end = useGame((s) => s.clock.phaseEndsAt);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(id);
  }, [on]);
  return Math.max(0, (end - performance.now()) / 1000);
}

/** ms since the seat state became "joining" (for the slow-join retry). */
function useJoiningFor(joining: boolean) {
  const [since, setSince] = useState<number | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    setSince(joining ? performance.now() : null);
    if (!joining) return;
    const id = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [joining]);
  return since === null ? 0 : performance.now() - since;
}

const pingAgain = (L: number) => () => {
  unlockAudio();
  actions().ping(L);
  sfx.ping();
  acted();
};

export function useDecision(): Decision {
  const g = useGame(
    useShallow((s) => ({
      me: s.me, phase: s.clock.phase, beat: s.clock.beat, canJoin: s.canJoin, seatState: s.seatState, mySeat: s.table.mySeat,
      round: s.table.round, revealed: !!s.reveal, atRisk: !!s.seatAtRisk, banner: s.banner,
    })),
  );
  const m = useRound(
    useShallow((s) => ({
      marks: s.marks, hit: s.hit, coach: s.coach, seatedAt: s.seatedAt, late: s.late, joinMove: s.joinMove, moved: s.moved,
      acted: s.acted, autoFill: s.autoFill, hidePick: s.hidePick,
    })),
  );
  const link = useLink(useShallow((s) => ({ stale: s.stale, back: s.back })));
  const moveMode = useUi((s) => s.moveMode);
  const left = usePhaseLeft(g.phase === "hide" || g.phase === "lights");
  const joiningFor = useJoiningFor(!g.me && (g.seatState === "joining" || g.seatState === undefined) && g.phase !== "connecting" && !g.canJoin);
  const { me, phase, beat } = g;
  const seated = !!me && g.mySeat !== null;
  const firstVisit = !seen("po.tapped");

  const H = (text: string, kind: Decision["hint"]["kind"] = "") => ({ text, kind });
  const moveTo_: Btn = { label: "Move to…", tone: "plain", state: "moveto", onClick: toggleMoveMode, testid: "move" };
  const offMove: Btn = { ...moveTo_, disabled: true, onClick: undefined };

  /* ---------------- offline: nothing that cannot be sent */
  if (link.stale && g.phase !== "connecting") {
    return {
      hint: H("Offline · reconnecting… The book shows the last state received.", "loss"),
      primary: { label: "Reconnecting…", sub: "nothing is sent until the book is back", tone: "wait", state: "offline", disabled: true },
      secondary: seated ? offMove : null,
    };
  }
  const b = link.back;
  const info = g.banner?.kind === "info" ? g.banner.text : null;
  const infoHint = info ? H(/^Tape call (on round \d+ )?settled/.test(info) ? "Your Tape call is settled: open the Tape to see it." : info, "note") : null;
  const backHint = b
    ? H(
        b.what === "bell" ? "Back. The bell rang while you were offline." : b.what === "newround" ? "Back. A new round started while you were offline."
          : b.missed ? `Back. You missed ${b.missed} beat${b.missed === 1 ? "" : "s"}.` : "Back. The book is live again.",
        "note",
      )
    : null;

  /* ---------------- not seated */
  if (!seated) {
    const tape: Btn = { label: "The Tape", tone: "plain", state: "tape", testid: "tape-open", onClick: () => useUi.setState({ sheet: "tape", peekOpen: false }) };
    if (g.phase === "connecting" && !g.round)
      return { hint: H(PROMISE, "promise"), primary: { label: "Opening the book…", tone: "wait", state: "connecting", disabled: true }, secondary: tape };
    if (g.seatState === "waiting")
      return { hint: H("All 8 desks are taken. You get the next free one automatically."), primary: { label: "You're next for a desk", tone: "wait", state: "waiting", disabled: true }, secondary: tape };
    if (g.canJoin && g.seatState !== "joining")
      return {
        hint: H(firstVisit ? PROMISE : "A desk is free. Free chips, no wallet.", firstVisit ? "promise" : ""),
        primary: { label: "Take a desk", sub: "free chips, no wallet", tone: "you", state: "join", testid: "takedesk", onClick: () => { unlockAudio(); sfx.ui(); actions().join(); } },
        secondary: tape,
      };
    if (joiningFor > JOIN_SLOW_MS)
      return {
        hint: H("Taking a seat is slow right now. Trying again…", "note"),
        primary: { label: "Try again", sub: "take a seat", tone: "you", state: "retry", onClick: () => { unlockAudio(); actions().join(); } },
        secondary: tape,
      };
    return { hint: H(firstVisit ? PROMISE : "Free chips, no wallet. Your seat is on its way.", firstVisit ? "promise" : ""), primary: { label: "Taking your seat…", tone: "wait", state: "joining", disabled: true }, secondary: tape };
  }

  /* ---------------- HIDE */
  if (phase === "hide") {
    const at = m.hidePick ?? me!.level;
    const picked = m.hidePick !== null;
    return {
      hint: backHint ?? infoHint ?? (picked ? H(`Hidden at ${priceOf(at)}. Nobody else can see it.`) : H(firstVisit ? "Tap a price to hide your order there." : `Your order hides at ${priceOf(at)} unless you tap another price.`)),
      primary: picked
        ? { label: `Hidden at ${priceOf(at)}`, sub: `live in ${left.toFixed(1)} s`, tone: "quiet", state: "hidden" }
        : { label: "Tap a price to hide your order", sub: `live in ${left.toFixed(1)} s`, tone: "you", state: "hide", onClick: nudgeBook },
      secondary: offMove,
    };
  }

  /* ---------------- LIGHTS ON */
  if (phase !== "live") {
    const atRisk = g.atRisk && !m.acted;
    return {
      hint: backHint ?? (atRisk ? H("You were away this round. Keep playing to keep your desk.", "coach") : infoHint ?? H("Lights on: every hidden order is shown.")),
      primary: !g.revealed
        ? { label: "Lights on…", tone: "wait", state: "lights", disabled: true }
        : atRisk
          ? { label: "Keep playing", sub: `next round in ${Math.ceil(left)} s`, tone: "you", state: "keep", testid: "keep-bar", onClick: keepSeat }
          : { label: "You're in for the next round", sub: `${Math.ceil(left)} s`, tone: "quiet", state: "lights" },
      secondary: offMove,
    };
  }

  /* ---------------- LIVE */
  const p = me!.pending;
  const ownL = me!.lastFill;
  const own = ownL !== null && m.marks[ownL]?.kind === "fill" && !m.marks[ownL].algo ? ownL : null;
  const each = own !== null && m.marks[own].orders > 1 ? " each" : "";
  const next = `next +${lots(me!.nextSkim)}${each}`;
  const joinBeat = m.late && m.seatedAt ? m.seatedAt.beat : -1;
  const hitNow = !!m.hit && me!.pickedOffBeat !== null && beat - m.hit.beat <= 2 && m.hit.beat > joinBeat;
  const joining = !!m.joinMove && p.kind === "requote" && p.level === m.joinMove.level;
  const joined = !!m.joinMove && !joining && me!.level === m.joinMove.level && beat <= m.joinMove.beat + 2;
  const coachHit = m.coach.hit !== undefined && beat <= m.coach.hit;
  const coachFill = m.coach.fill !== undefined && beat <= m.coach.fill;
  const tap: Btn = { label: "Tap a price", tone: "you", state: "tap", onClick: nudgeBook };

  if (moveMode)
    return {
      hint: H("Tap the new price for your order."),
      primary: { label: "Tap the new price", sub: `your order is at ${priceOf(me!.level)}`, tone: "plain", state: "movemode" },
      secondary: { label: "Cancel", tone: "plain", state: "cancel-mode", onClick: toggleMoveMode, testid: "move" },
    };
  if (joining)
    return {
      hint: H(`You're in. Hiding your order at ${priceOf(p.level)}…`, "join"),
      primary: tap,
      secondary: moveTo_,
    };
  if (p.kind === "requote")
    return {
      hint: H(`Your order moves to ${priceOf(p.level)} when this beat closes.`),
      primary: { label: `Moving to ${priceOf(p.level)}`, sub: "this beat", tone: "wait", state: "moving" },
      secondary: { label: "Cancel", sub: "keep it here", tone: "plain", state: "cancel-move", onClick: cancelQueued, testid: "move" },
    };
  if (hitNow) {
    const h = m.hit!;
    return {
      hint: backHint
        ? H(`${backHint.text} They found you: move.`, "loss")
        : coachHit
          ? H("Someone found your order. Move it: that resets their bonus on you.", "coach")
          : H(`Found: −${lots(h.tenths)}${h.count > 1 ? ` (${h.count} hits)` : ""}. Move before they hit again.`, "loss"),
      primary: { label: "Move · they found you", sub: "to a random untested price", tone: "loss", state: "move", onClick: () => moveTo(null) },
      secondary: own !== null
        ? { label: "Ping again", sub: `+${lots(me!.nextSkim)}${each}`, tone: "plain", state: "again-2", onClick: pingAgain(own), testid: "again2" }
        : moveTo_,
    };
  }
  if (p.kind === "ping")
    return {
      hint: backHint ?? H(`Pinging ${priceOf(p.level)}. Tap another price to change your mind.`),
      primary: { label: `Pinging ${priceOf(p.level)}`, sub: own === p.level ? next : "result when this beat closes", tone: "wait", state: "pinging" },
      secondary: moveTo_,
    };
  if (own !== null)
    return {
      hint: backHint
        ? H(`${backHint.text} FILL at ${priceOf(own)}: ping it again.`, "note")
        : coachFill ? H("Still there? Ping it again: the next take is bigger.", "coach") : H(`FILL at ${priceOf(own)}. Ping it again for more.`),
      primary: { label: `Ping again ${priceOf(own)}`, sub: next, tone: "you", state: "again", onClick: pingAgain(own) },
      secondary: moveTo_,
    };
  let hint = H(`No tap this beat? Auto pings ${priceOf(me!.nextAlgo)}.`);
  if (backHint) hint = backHint;
  else if (joined) hint = H(`You're in. Your order is hidden at ${priceOf(me!.level)}.`, "join");
  else if (m.moved && beat <= m.moved.beat + 1) hint = H(`Moved to ${priceOf(m.moved.level)}. Their bonus on you is reset.`);
  else if (firstVisit) hint = H(PROMISE, "promise");
  else if (g.atRisk && beat >= 15 && !m.acted) hint = H("Tap any price to keep your desk.", "coach");
  else if (infoHint) hint = infoHint;
  else if (m.autoFill && beat - m.autoFill.beat <= 1) hint = H(`Auto found one at ${priceOf(m.autoFill.level)}.`);
  else if (!me!.nextAlgo) hint = H("Tap any price to look for hidden orders.");
  return { hint, primary: tap, secondary: moveTo_ };
}

export function cancelQueued() {
  unlockAudio();
  sfx.ui();
  actions().cancel?.();
}

export { keepSeat };
