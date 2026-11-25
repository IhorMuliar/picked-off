/** The score line: your lots as one number, this round's change, your rank, the beat bar and the bell. */
import { memo, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { openSheet, useGame } from "../state/store";
import { BEAT_MS, BELL_MIN, HIDE_MS, lots } from "../state/types";
import { useRound } from "./round";
import { useLink } from "./link";
import { useDecision } from "./decide";
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

/** Rank by total lots after the bell (the reveal makes every total public). */
export function finalRankOf(totals: number[], mySeat: number | null): number | null {
  if (mySeat === null || totals[mySeat] === undefined) return null;
  return 1 + totals.filter((v, i) => i !== mySeat && v > totals[mySeat]).length;
}
/** The one wording for ranks, used everywhere: live it is by lots taken (all that is public), after the bell by total. */
export const RANK_LIVE = "in lots taken";
export const RANK_FINAL = "by total lots";
export const RANK_WHY = "Hidden lots are secret until the bell, so the live rank counts only lots taken.";

const SEGS = 29;
/**
 * The round as 29 beats: past beats filled, the current one filling over its 1.5 s, and the zone from beat 20 where
 * the bell can ring. Driven by rAF from the scheduled deadlines, so it keeps time without waiting for the network.
 */
const RoundBar = memo(function RoundBar() {
  const txt = useRef<HTMLSpanElement>(null);
  const stale = useLink((s) => s.stale);
  const { phase, beat, chance, round } = useGame(useShallow((s) => ({ phase: s.clock.phase, beat: s.clock.beat, chance: s.clock.bellChance, round: s.table.round })));
  const bellBeat = useGame((s) => s.reveal?.bellBeat ?? null);
  // the countdown text in HIDE / LIGHTS ON: a 200-ms text update, no per-frame work
  useEffect(() => {
    if (phase !== "hide" && phase !== "lights") return;
    const tick = () => {
      const c = useGame.getState().clock;
      const left = Math.max(0, c.phaseEndsAt - performance.now());
      const label = c.phase === "hide" ? (left > 0 ? `live in ${(left / 1000).toFixed(1)} s` : "going live") : `next round ${Math.ceil(left / 1000)} s`;
      if (txt.current && txt.current.textContent !== label) txt.current.textContent = label;
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [phase]);
  const cur = phase === "live" ? beat : 0;
  const done = phase === "lights" ? (bellBeat ?? beat) : cur - 1;
  const zone = phase === "live" && beat >= BELL_MIN;
  // the filling segment is a CSS animation started at the right offset when the beat (or HIDE) begins: the compositor
  // runs it, so nothing restyles the bar while the beat runs
  const c = useGame.getState().clock;
  const now = performance.now();
  const fill =
    phase === "live" && c.beatEndsAt > 0
      ? { key: `b${round}-${beat}`, dur: BEAT_MS, delay: -Math.max(0, Math.min(BEAT_MS, BEAT_MS - (c.beatEndsAt - now))) }
      : phase === "hide" && c.phaseEndsAt > 0
        ? { key: `h${round}`, dur: HIDE_MS, delay: -Math.max(0, Math.min(HIDE_MS, HIDE_MS - (c.phaseEndsAt - now))) }
        : null;
  return (
    <>
      <span className={"roundbar " + phase + (zone ? " inzone" : "") + (stale ? " stale" : "")} aria-hidden="true">
        {Array.from({ length: SEGS }, (_, i) => {
          const b = i + 1;
          const cls = ["seg", b >= BELL_MIN && "zone", b <= done && "past", b === cur && "now", phase === "lights" && b === bellBeat && "bell"].filter(Boolean).join(" ");
          const filling = fill && ((phase === "live" && b === cur) || (phase === "hide" && b === 1));
          return (
            <i key={b} className={cls}>
              {filling && <b key={fill!.key} className={"fl" + (phase === "hide" ? " hidefill" : "")} style={{ animationDuration: `${fill!.dur}ms`, animationDelay: `${Math.round(fill!.delay)}ms` }} />}
            </i>
          );
        })}
        <BellIcon size={11} className="zone-mark" />
      </span>
      {zone ? (
        <span className="bt bellnow" title="The round ends on a hidden beat between 20 and 29. This is the chance it is this beat.">
          <BellIcon size={14} />
          Bell {Math.round(chance * 100)} %
        </span>
      ) : (
        <span className="bt" ref={txt} />
      )}
    </>
  );
});

function useBeatTick() {
  const beat = useGame((s) => s.clock.beat);
  const phase = useGame((s) => s.clock.phase);
  useEffect(() => {
    if (phase !== "live" || beat < 2 || !useUi.getState().beatTick) return;
    sfx.beat(beat >= BELL_MIN);
  }, [beat, phase]);
}

export function Score() {
  useBeatTick();
  const me = useGame((s) => s.me);
  const { phase, beat } = useGame(useShallow((s) => ({ phase: s.clock.phase, beat: s.clock.beat })));
  const seats = useGame((s) => s.table.seats);
  const mySeat = useGame((s) => s.table.mySeat);
  const reveal = useGame((s) => s.reveal);
  const { base, late, hit, lastOwn, seatedAt } = useRound(useShallow((s) => ({ base: s.base, late: s.late, hit: s.hit, lastOwn: s.lastOwn, seatedAt: s.seatedAt })));
  const d0 = useDecision();
  const seated = !!me && mySeat !== null;
  const total = me ? me.resting + me.picked : 0;
  const n = seats.length || 8;
  const joinBeat = late && seatedAt ? seatedAt.beat : -1;

  let delta: React.ReactNode = null;
  let flash = "";
  if (seated && phase === "live") {
    const recentHit = hit && beat - hit.beat <= 2 && me!.pickedOffBeat !== null && hit.beat > joinBeat;
    const recentFill = lastOwn?.kind === "fill" && beat - lastOwn.beat <= 1;
    if (recentHit) {
      delta = <span className="delta loss">−{lots(hit!.tenths)} PICKED OFF</span>;
      flash = "hit-" + hit!.id;
    } else if (recentFill) {
      delta = <span className="delta gain">+{lots(lastOwn!.tenths)} FILL</span>;
      flash = "fill-" + lastOwn!.id;
    }
  }
  if (seated && !delta && base !== null && phase !== "hide") {
    const d = total - base;
    if (d !== 0)
      delta = (
        <span className={"delta" + (d > 0 ? " gain" : " loss")}>
          {d > 0 ? "+" : "−"}
          {lots(Math.abs(d))} <span className="qual">{late ? "since joining" : "this round"}</span>
        </span>
      );
  }

  const lead = seated ? (
    <>
      <span key={flash} className={"big" + (flash.startsWith("hit") ? " hitflash" : flash.startsWith("fill") ? " fillflash" : "")}>
        {lots(total)}
      </span>
      <span className="unit">lots</span>
      {delta}
    </>
  ) : (
    <span className="state">{d0.primary.state === "waiting" ? "Watching · all 8 desks are taken" : d0.primary.state === "join" ? "Watching · a desk is free" : d0.primary.label}</span>
  );

  // the rank, always with what it counts
  let rank: React.ReactNode = null;
  const fin = reveal && seated ? finalRankOf(reveal.totals, mySeat) : null;
  const live = rankOf(seats, mySeat);
  if (fin !== null) rank = <RankBtn place={fin} n={n} what={RANK_FINAL} />;
  else if (seated && live !== null && seats.some((x) => x.picked > 0)) rank = <RankBtn place={live} n={n} what={RANK_LIVE} />;

  return (
    <div className="score" data-testid="mydesk">
      <div className="score-top">
        <div className="lead" aria-live="off">{lead}</div>
        {rank ?? (
          <button className="rank quiet" onClick={() => openSheet("desks")} aria-label="Open the desks">
            Desks <Chevron />
          </button>
        )}
      </div>
      <div className="score-beat" data-testid="clock" data-phase={phase} data-beat={phase === "live" || phase === "lights" ? beat : 0}>
        <RoundBar />
      </div>
    </div>
  );
}

function RankBtn({ place, n, what }: { place: number; n: number; what: string }) {
  return (
    <button className="rank" data-testid="rank" onClick={() => openSheet("desks")} aria-label={`${ordinal(place)} of ${n} ${what}. Open the desks.`} title={RANK_WHY}>
      <span className="r1">
        {ordinal(place)} <span className="of">of {n}</span>
        <Chevron />
      </span>
      <span className="r2">{what}</span>
    </button>
  );
}
