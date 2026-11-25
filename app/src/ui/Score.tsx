/** The score line: your lots as one number, this round's change, your rank, the beat bar and the bell. */
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { openSheet, useGame } from "../state/store";
import { BEAT_MS, BELL_MIN, HIDE_MS, LIGHTS_MS, lots } from "../state/types";
import { useRound } from "./round";
import { BellIcon, Chevron } from "./icons";
import { sfx } from "../fx/sound";
import { useUi } from "../state/store";

export const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
};

/** Rank by the public tally of lots taken (the only number every desk can see). */
export function rankOf(seats: { picked: number }[], mySeat: number | null): number | null {
  if (mySeat === null || !seats[mySeat]) return null;
  const mine = seats[mySeat].picked;
  return 1 + seats.filter((s, i) => i !== mySeat && s.picked > mine).length;
}

/** Fills left → right over each beat (HIDE: over the hiding time), with its label. Driven by rAF from the
 *  scheduled deadlines, so it keeps time without waiting for the network. */
function BeatBar() {
  const bar = useRef<HTMLSpanElement>(null);
  const txt = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const c = useGame.getState().clock;
      const t = performance.now();
      let frac = 0;
      let label = "";
      let hot = false;
      if (c.phase === "live") {
        let end = c.beatEndsAt;
        if (end > 0 && end < t) end += Math.ceil((t - end) / BEAT_MS) * BEAT_MS;
        const left = end > 0 ? Math.min(BEAT_MS, end - t) : BEAT_MS;
        frac = 1 - left / BEAT_MS;
        hot = left < 300;
        label = `beat ${c.beat}`;
      } else if (c.phase === "hide") {
        const left = Math.max(0, c.phaseEndsAt - t);
        frac = 1 - Math.min(1, left / HIDE_MS);
        label = left > 0 ? `live in ${(left / 1000).toFixed(1)} s` : "going live";
      } else if (c.phase === "lights") {
        const left = Math.max(0, c.phaseEndsAt - t);
        frac = Math.min(1, left / LIGHTS_MS);
        label = `next round ${Math.ceil(left / 1000)} s`;
      }
      if (bar.current) {
        bar.current.style.transform = `scaleX(${frac.toFixed(4)})`;
        bar.current.classList.toggle("hot", hot);
      }
      if (txt.current && txt.current.textContent !== label) txt.current.textContent = label;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const phase = useGame((s) => s.clock.phase);
  return (
    <>
      <span className={"beatbar " + phase} aria-hidden="true">
        <span className="fill" ref={bar} />
      </span>
      <span className="bt" ref={txt} />
    </>
  );
}

function Bell() {
  const { phase, beat, chance } = useGame(useShallow((s) => ({ phase: s.clock.phase, beat: s.clock.beat, chance: s.clock.bellChance })));
  if (phase !== "live") return null;
  const hot = beat >= BELL_MIN;
  return (
    <span className={"bell" + (hot ? " hot" : "")} title="The round ends on a hidden beat between 20 and 29. This is the chance it is this beat.">
      <BellIcon size={13} />
      {hot ? `${Math.round(chance * 100)}%` : "from beat 20"}
    </span>
  );
}

function useBeatTick() {
  const beat = useGame((s) => s.clock.beat);
  const phase = useGame((s) => s.clock.phase);
  useEffect(() => {
    if (phase !== "live" || beat < 2 || !useUi.getState().beatTick) return;
    sfx.beat(useGame.getState().clock.bellChance >= 0.2);
  }, [beat, phase]);
}

export function Score() {
  useBeatTick();
  const me = useGame((s) => s.me);
  const { phase, beat } = useGame(useShallow((s) => ({ phase: s.clock.phase, beat: s.clock.beat })));
  const seats = useGame((s) => s.table.seats);
  const mySeat = useGame((s) => s.table.mySeat);
  const seatState = useGame((s) => s.seatState);
  const canJoin = useGame((s) => s.canJoin);
  const { base, late, hit, lastOwn } = useRound(useShallow((s) => ({ base: s.base, late: s.late, hit: s.hit, lastOwn: s.lastOwn })));
  const seated = !!me && mySeat !== null;
  const total = me ? me.resting + me.picked : 0;
  const rank = rankOf(seats, mySeat);
  const n = seats.length || 8;

  let delta: React.ReactNode = null;
  if (seated) {
    const recentHit = hit && beat - hit.beat <= 2 && phase === "live" && me!.pickedOffBeat !== null;
    const recentFill = lastOwn?.kind === "fill" && beat - lastOwn.beat <= 1 && phase === "live";
    if (recentHit)
      delta = (
        <span className="delta loss">−{lots(hit!.tenths)} PICKED OFF</span>
      );
    else if (recentFill) delta = <span className="delta gain">+{lots(lastOwn!.tenths)} FILL</span>;
    else if (base !== null) {
      const d = total - base;
      delta = (
        <span className={"delta" + (d > 0 ? " gain" : d < 0 ? " loss" : "")}>
          {d > 0 ? "+" : d < 0 ? "−" : "±"}
          {lots(Math.abs(d))} <span className="qual">{late ? "since joining" : "this round"}</span>
        </span>
      );
    }
  }

  let lead: React.ReactNode;
  if (seated)
    lead = (
      <>
        <span className="big">{lots(total)}</span>
        <span className="unit">lots</span>
        {delta}
      </>
    );
  else if (phase === "connecting" && !seats.length) lead = <span className="state">Opening the book…</span>;
  else if (seatState === "waiting") lead = <span className="state">Watching · all 8 desks are taken</span>;
  else if ((canJoin && seatState !== "joining") || seatState === "released") lead = <span className="state">Watching · a desk is free</span>;
  else lead = <span className="state">Taking your seat…</span>;

  return (
    <div className="score" data-testid="mydesk">
      <div className="score-top">
        <div className="lead" aria-live="off">{lead}</div>
        {rank !== null && seated && seats.some((x) => x.picked > 0) ? (
          <button className="rank" onClick={() => openSheet("desks")} aria-label={`${ordinal(rank)} of ${n} by lots taken. Open the desks.`} title="Ranked by lots taken so far. Hidden lots stay secret until the bell.">
            {ordinal(rank)} <span className="of">of {n}</span>
            <Chevron />
          </button>
        ) : (
          <button className="rank quiet" onClick={() => openSheet("desks")} aria-label="Open the desks">
            Desks <Chevron />
          </button>
        )}
      </div>
      <div className="score-beat" data-testid="clock" data-phase={phase} data-beat={phase === "live" || phase === "lights" ? beat : 0}>
        <BeatBar />
        <Bell />
      </div>
    </div>
  );
}
