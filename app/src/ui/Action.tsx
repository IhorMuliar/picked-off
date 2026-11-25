/**
 * The thumb zone: one hint line, one primary button that always offers the right next move, and Move to….
 * The primary never acts on a price the player did not choose (only on their own last FILL or a random move).
 */
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { openSheet, useGame, useUi } from "../state/store";
import { actions } from "../state/runtime";
import { lots, priceOf } from "../state/types";
import { sfx, unlockAudio } from "../fx/sound";
import { acted, seen, useRound } from "./round";
import { keepSeat, moveTo, toggleMoveMode } from "./act";
import { MoveIcon, TapeIcon } from "./icons";

const PROMISE = "Find the hidden orders. Take from them before the bell.";

/** Seconds left in the current phase, re-rendered 4× a second while `on`. */
function usePhaseLeft(on: boolean) {
  const end = useGame((s) => s.clock.phaseEndsAt);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(id);
  }, [on]);
  return Math.max(0, (end - performance.now()) / 1000);
}

export function Hint() {
  const banner = useGame((s) => s.banner);
  const { phase, beat } = useGame(useShallow((s) => ({ phase: s.clock.phase, beat: s.clock.beat })));
  const me = useGame((s) => s.me);
  const seatState = useGame((s) => s.seatState);
  const atRisk = useGame((s) => !!s.seatAtRisk);
  const { coach, seatedAt, acted: didAct } = useRound(useShallow((s) => ({ coach: s.coach, seatedAt: s.seatedAt, acted: s.acted })));
  const moveMode = useUi((s) => s.moveMode);
  const firstVisit = !seen("po.tapped");
  const seated = !!me;

  let text: React.ReactNode = null;
  let kind = "";
  if (banner?.kind === "offline") {
    kind = "loss";
    text = "Offline · reconnecting…";
  } else if (banner?.kind === "info") {
    kind = "note";
    text = banner.text;
  } else if (!seated) {
    if (seatState === "waiting") text = "You get the next free desk automatically.";
    else text = firstVisit || phase === "connecting" ? PROMISE : "Free chips, no wallet. Your seat is on its way.";
  } else if (moveMode && phase === "live") {
    text = "Tap a price to move your order there.";
  } else if (seatedAt && seatedAt.round === useGame.getState().table.round && phase === "live" && beat <= seatedAt.beat + 2 && !didAct) {
    // a mid-round takeover is said once, in plain words; the score counts from here
    text = seatedAt.fresh ? `You're in. Your order hides at ${priceOf(me!.level)}.` : `You took over this desk: ${lots(seatedAt.total)} lots.`;
    kind = "join";
  } else if (coach && beat <= coach.until && phase !== "lights") {
    kind = "coach";
    text = coach.text;
  } else if (atRisk && phase === "live" && beat >= 15 && !didAct) {
    kind = "coach";
    text = "Tap any price to keep your desk.";
  } else if (phase === "hide") {
    text = me!.level ? `Hidden at ${priceOf(me!.level)}. Nobody else can see it.` : "Tap a price to hide your order there.";
  } else if (phase === "live" && firstVisit) {
    text = PROMISE;
  } else if (phase === "live" && me!.pending.kind === "none" && me!.nextAlgo) {
    text = <>No tap this beat? Auto pings {priceOf(me!.nextAlgo)}.</>;
  } else if (phase === "live" && me!.pending.kind === "ping") {
    text = "Tap another price to change your mind.";
  } else if (phase === "lights") {
    text = "Lights on: every hidden order is shown.";
  }
  return (
    <p className={"hint " + kind} aria-live="polite" data-testid={kind === "join" ? "join" : undefined}>
      {text}
      {/* the raw status line, for assistive tech and the browser checks */}
      {banner && (
        <span className="sr-only" data-testid="chain-status" data-kind={banner.kind}>
          {banner.text}
        </span>
      )}
    </p>
  );
}

export function ActionBar() {
  const me = useGame((s) => s.me);
  const { phase, beat } = useGame(useShallow((s) => ({ phase: s.clock.phase, beat: s.clock.beat })));
  const canJoin = useGame((s) => s.canJoin);
  const seatState = useGame((s) => s.seatState);
  const mySeat = useGame((s) => s.table.mySeat);
  const reveal = useGame((s) => s.reveal);
  const moveMode = useUi((s) => s.moveMode);
  const hit = useRound((s) => s.hit);
  const marks = useRound((s) => s.marks);
  const atRisk = useGame((s) => !!s.seatAtRisk);
  const left = usePhaseLeft(phase === "hide" || phase === "lights");
  const seated = !!me && mySeat !== null;
  const live = phase === "live" && seated;

  let label: React.ReactNode = "Tap a price";
  let sub: React.ReactNode = null;
  let tone: "passive" | "you" | "loss" | "plain" = "passive";
  let onClick: (() => void) | null = null;
  let state = "idle";
  let testid: string | undefined;

  if (!seated) {
    if (canJoin && phase !== "connecting" && seatState !== "joining" && seatState !== "waiting") {
      label = "Take a desk";
      sub = "free chips, no wallet";
      tone = "you";
      state = "join";
      testid = "takedesk";
      onClick = () => {
        unlockAudio();
        sfx.ui();
        actions().join();
      };
    } else if (seatState === "waiting") {
      label = "Waiting for a free desk";
      state = "waiting";
    } else {
      label = "Taking your seat…";
      state = "joining";
    }
  } else if (phase === "hide") {
    state = "hide";
    label = "Tap a price to hide your order";
    sub = me!.level ? `or leave it at ${priceOf(me!.level)}` : "or it goes to a random price";
  } else if (phase === "lights") {
    state = "lights";
    if (!reveal) label = "Lights on…";
    else if (atRisk) {
      label = "Keep playing";
      sub = `next round in ${Math.ceil(left)} s`;
      tone = "you";
      onClick = keepSeat;
    } else {
      label = "You're in for the next round";
      sub = `${Math.ceil(left)} s`;
    }
  } else if (live) {
    const p = me!.pending;
    const hitNow = !!hit && me!.pickedOffBeat !== null && beat - hit.beat <= 2;
    if (moveMode) {
      state = "movemode";
      label = "Tap a price to move";
      sub = `your order is at ${priceOf(me!.level)}`;
    } else if (p.kind === "requote") {
      state = "moving";
      label = `Moving to ${priceOf(p.level)}`;
    } else if (p.kind === "ping") {
      state = "pinging";
      label = `Pinging ${priceOf(p.level)}`;
      if (me!.lastFill === p.level) sub = `next +${lots(me!.nextSkim)}`;
    } else if (hitNow) {
      state = "move";
      label = "Move";
      sub = "they found you";
      tone = "loss";
      onClick = () => moveTo(null);
    } else if (me!.lastFill !== null && marks[me!.lastFill]?.kind === "fill") {
      // only a FILL the player can see on the book (never one from before they sat down)
      const L = me!.lastFill;
      state = "again";
      label = `Ping again ${priceOf(L)}`;
      sub = `next +${lots(me!.nextSkim)}`;
      tone = "you";
      onClick = () => {
        unlockAudio();
        actions().ping(L);
        sfx.ping();
        acted();
      };
    } else {
      state = "tap";
      label = "Tap a price";
    }
  }

  const secondary = live ? (
    <button className={"btn move" + (moveMode ? " on" : "")} data-testid="move" onClick={toggleMoveMode} aria-pressed={moveMode}>
      <MoveIcon />
      <span>{moveMode ? "Cancel" : "Move to…"}</span>
    </button>
  ) : !seated ? (
    <button className="btn move" onClick={() => openSheet("tape")} data-testid="tape-open">
      <TapeIcon />
      <span>The Tape</span>
    </button>
  ) : (
    <button className="btn move" disabled aria-hidden="true" tabIndex={-1}>
      <MoveIcon />
      <span>Move to…</span>
    </button>
  );

  return (
    <div className="actions">
      <button
        className={"btn primary " + tone}
        data-state={state}
        data-testid={testid ?? "primary"}
        aria-disabled={!onClick}
        onClick={() => onClick?.()}
      >
        <span className="l">{label}</span>
        {sub && <span className="s">{sub}</span>}
      </button>
      {secondary}
    </div>
  );
}
