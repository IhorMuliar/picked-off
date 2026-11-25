/** The score line: your lots as one number, this round's change, your rank, the beat bar and the bell. */
import { useEffect, useRef } from "react";
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
function RoundBar() {
  const box = useRef<HTMLSpanElement>(null);
  const txt = useRef<HTMLSpanElement>(null);
  const stale = useLink((s) => s.stale);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const c = useGame.getState().clock;
      const t = performance.now();
      let label = "";
      let frac = 0;
      let hot = false;
      if (c.phase === "live") {
        const end = c.beatEndsAt;
        const left = end > 0 ? Math.max(0, Math.min(BEAT_MS, end - t)) : BEAT_MS;
        frac = useLink.getState().stale ? 0 : 1 - left / BEAT_MS;
        hot = left < 300 && left > 0;
      } else if (c.phase === "hide") {
        const left = Math.max(0, c.phaseEndsAt - t);
        frac = 1 - Math.min(1, left / HIDE_MS);
        label = left > 0 ? `live in ${(left / 1000).toFixed(1)} s` : "going live";
      } else if (c.phase === "lights") {
        const left = Math.max(0, c.phaseEndsAt - t);
        label = `next round ${Math.ceil(left / 1000)} s`;
      }
      const el = box.current;
      if (el) {
        el.style.setProperty("--f", frac.toFixed(3));
        el.classList.toggle("hot", hot);
      }
      if (txt.current && txt.current.textContent !== label) txt.current.textContent = label;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const { phase, beat, chance } = useGame(useShallow((s) => ({ phase: s.clock.phase, beat: s.clock.beat, chance: s.clock.bellChance })));
  const bellBeat = useGame((s) => s.reveal?.bellBeat ?? null);
  const cur = phase === "live" ? beat : 0;
  const done = phase === "lights" ? (bellBeat ?? beat) : cur - 1;
  const zone = phase === "live" && beat >= BELL_MIN;
  return (
    <>
      <span className={"roundbar " + phase + (zone ? " inzone" : "") + (stale ? " stale" : "")} ref={box} aria-hidden="true">
        {Array.from({ length: SEGS }, (_, i) => {
          const b = i + 1;
          const cls = ["seg", b >= BELL_MIN && "zone", b <= done && "past", b === cur && "now", phase === "lights" && b === bellBeat && "bell"].filter(Boolean).join(" ");
          return <i key={b} className={cls} />;
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
}

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
