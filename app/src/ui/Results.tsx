/** The end of a round, about you first: your place and lots, who found you, the top desk, your call, then the replay. */
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useGame, useUi } from "../state/store";
import { LEVELS, lots, type RevealView } from "../state/types";
import { sfx } from "../fx/sound";
import { Sheet } from "./Sheet";
import { useRound } from "./round";
import { ordinal } from "./Score";
import { keepSeat } from "./act";
import { openSheet } from "../state/store";
import { Chevron } from "./icons";

const W = 640;
const H = 200;
const PL = 42;
const PR = 10;
const PT = 10;
const PB = 20;

function ReplayChart({ r, mySeat }: { r: RevealView; mySeat: number | null }) {
  const n = Math.max(1, r.beats.length);
  const [upto, setUpto] = useState(0);
  useEffect(() => {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return setUpto(n);
    let raf = 0;
    const t0 = performance.now();
    const loop = () => {
      const k = Math.min(n, Math.floor(((performance.now() - t0) / 2400) * n));
      setUpto(k);
      if (k < n) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // replay once per round (the check result arriving later must not restart it)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.round, n]);
  const x = (b: number) => PL + (b / n) * (W - PL - PR);
  const y = (L: number) => PT + ((L - 0.5) / LEVELS) * (H - PT - PB);
  const shown = r.beats.filter((b) => b.beat <= upto);
  const path = (d: number) => {
    let L = r.initialLevels[d];
    let p = `M${x(0)},${y(L)}`;
    for (const b of shown) {
      p += ` H${x(b.beat)}`;
      if (b.levels[d] !== L) {
        L = b.levels[d];
        p += ` V${y(L)}`;
      }
    }
    return p;
  };
  const order = [...Array(8).keys()].filter((d) => d !== mySeat && d !== r.topDesk);
  const marks: React.ReactNode[] = [];
  for (const b of shown)
    for (const f of b.fills) {
      if (f.pinger === mySeat) marks.push(<circle key={`f${b.beat}-${f.victim}`} cx={x(b.beat)} cy={y(f.level)} r={2.4 + f.tenths / 5} className="c-gain" />);
      if (f.victim === mySeat) {
        const cx = x(b.beat);
        const cy = y(f.level);
        marks.push(<path key={`v${b.beat}-${f.pinger}`} d={`M${cx - 4},${cy - 4} l8,8 m0,-8 l-8,8`} className="c-loss" />);
      }
    }
  return (
    <figure className="replay">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" data-testid="replay" role="img" aria-label="Replay of every order's price over the round">
        {[1, 12.5, 24].map((L) => (
          <g key={L}>
            <line x1={PL} x2={W - PR} y1={y(L)} y2={y(L)} className="grid" />
            <text x={PL - 6} y={y(L) + 3} textAnchor="end" className="ax">
              {L === 12.5 ? "mid" : (100.13 - L * 0.01).toFixed(2)}
            </text>
          </g>
        ))}
        {order.map((d) => (
          <path key={d} d={path(d)} className="p-other" />
        ))}
        {r.topDesk !== mySeat && <path d={path(r.topDesk)} className="p-top" />}
        {mySeat !== null && <path d={path(mySeat)} className="p-you" />}
        {marks}
        {upto >= n && (
          <g>
            <line x1={x(n)} x2={x(n)} y1={PT - 4} y2={H - PB + 4} className="bell-line" />
            <text x={x(n) - 4} y={H - 5} textAnchor="end" className="ax">
              bell · beat {r.bellBeat}
            </text>
          </g>
        )}
      </svg>
      <figcaption>
        <span><i className="k-you" />you</span>
        <span><i className="k-top" />top desk</span>
        <span><i className="k-gain" />your FILL</span>
        <span><i className="k-loss" />PICKED OFF</span>
      </figcaption>
    </figure>
  );
}

export function ResultsSheet() {
  const r = useGame((s) => s.reveal);
  const seats = useGame((s) => s.table.seats);
  const mySeat = useGame((s) => s.table.mySeat);
  const tape = useGame((s) => s.tape);
  const atRisk = useGame((s) => !!s.seatAtRisk);
  const canJoin = useGame((s) => s.canJoin);
  const phaseEndsAt = useGame((s) => s.clock.phaseEndsAt);
  const { base, late, acted } = useRound(useShallow((s) => ({ base: s.base, late: s.late, acted: s.acted })));
  const open = useUi((s) => s.sheet === "results");
  const [, tick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(id);
  }, [open]);
  const round = r?.round ?? null;
  useEffect(() => {
    if (round !== null) sfx.bell();
  }, [round]);
  const sum = useMemo(() => {
    if (!r) return null;
    const byHunter = new Map<number, { n: number; t: number }>();
    let took = 0;
    const victims = new Set<number>();
    for (const b of r.beats)
      for (const f of b.fills) {
        if (f.victim === mySeat) {
          const h = byHunter.get(f.pinger) ?? { n: 0, t: 0 };
          h.n++;
          h.t += f.tenths;
          byHunter.set(f.pinger, h);
        }
        if (f.pinger === mySeat) {
          took += f.tenths;
          victims.add(f.victim);
        }
      }
    const hunters = [...byHunter.entries()].sort((a, b) => b[1].n - a[1].n);
    return { hunters, took, victims: victims.size, hits: hunters.reduce((a, [, h]) => a + h.n, 0), lost: hunters.reduce((a, [, h]) => a + h.t, 0) };
  }, [r, mySeat]);
  if (!r || !sum) return null;
  const name = (d: number) => (d === mySeat ? "you" : (seats[d]?.name ?? `desk ${d + 1}`));
  const mine = mySeat !== null ? r.totals[mySeat] : null;
  const place = mine !== null ? 1 + r.totals.filter((v, d) => d !== mySeat && v > mine).length : null;
  const d = mine !== null && base !== null ? mine - base : null;
  const left = Math.max(0, Math.ceil((phaseEndsAt - performance.now()) / 1000));
  const sat = (late || base === null) && sum.hits === 0 && sum.took === 0;
  return (
    <Sheet id="results" title={mine !== null ? "Round over" : "Lights on"} testid="reveal" tall onClose={() => useUi.setState({ resultsClosed: r.round })}>
      {mine !== null ? (
        <div className="res-hero">
          <p className="place">
            You finished <b>{ordinal(place!)}</b> of {r.totals.length}
          </p>
          <p className="num">
            <span className="big">{lots(mine)}</span> lots
            {d !== null && (
              <span className={"delta" + (d > 0 ? " gain" : d < 0 ? " loss" : "")}>
                {d > 0 ? "+" : d < 0 ? "−" : "±"}
                {lots(Math.abs(d))} {late ? "since joining" : ""}
              </span>
            )}
          </p>
          {sat && <p className="line">You sat down near the end of this round.</p>}
        </div>
      ) : (
        <div className="res-hero">
          <p className="place">Every hidden order is shown.</p>
        </div>
      )}
      <ul className="res-lines">
        {mine !== null && (
          <li className={sum.hits ? "loss" : ""}>
            {sum.hits === 0 ? (
              "Nobody found your order."
            ) : (
              <>
                PICKED OFF {sum.hits}× · −{lots(sum.lost)} · by{" "}
                {sum.hunters.map(([h, x], k) => (
                  <span key={h}>
                    {k ? ", " : ""}
                    {name(h)}
                    {x.n > 1 ? ` (${x.n}×)` : ""}
                  </span>
                ))}
              </>
            )}
          </li>
        )}
        {mine !== null && sum.took > 0 && (
          <li className="gain">
            You took +{lots(sum.took)} from {sum.victims} desk{sum.victims === 1 ? "" : "s"}.
          </li>
        )}
        <li>
          Top desk: <b>{name(r.topDesk)}</b>
          {seats[r.topDesk]?.kind === "bot" && <span className="bot">bot</span>} · {lots(r.totals[r.topDesk])} lots
        </li>
        {tape.myCall !== null && tape.paid !== undefined && (
          <li className={tape.paid !== "refund" && tape.myCall === r.topDesk ? "gain" : ""}>
            Your call on {tape.myCall === mySeat ? "yourself" : name(tape.myCall)}{" "}
            {tape.paid === "refund" ? `was refunded: nobody called ${name(r.topDesk)}.` : tape.myCall === r.topDesk ? `won ${tape.paid.toFixed(1)}×.` : "lost."}
          </li>
        )}
      </ul>
      <p className={"check " + r.check.state} data-testid="check">
        {r.check.state === "ok" ? "Replay ✓ checked: every move matches the sealed round." : r.check.state === "fail" ? "Replay ✗ does not match the sealed round." : "Checking the replay…"}{" "}
        <button className="linkbtn" onClick={() => openSheet("proof")}>
          Proof <Chevron />
        </button>
      </p>
      <ReplayChart r={r} mySeat={mySeat} />
      <div className="res-foot">
        {mine !== null && atRisk && !acted && <p className="warn">You were away this round. Keep playing or your desk goes back to a bot.</p>}
        {mine !== null ? (
          <button
            className="btn primary you"
            data-testid="keep"
            onClick={() => {
              keepSeat();
              openSheet(null);
            }}
          >
            <span className="l">Keep playing</span>
            <span className="s">next round in {left} s</span>
          </button>
        ) : canJoin ? (
          <button
            className="btn primary you"
            data-testid="takedesk"
            onClick={() => {
              keepSeat();
              openSheet(null);
            }}
          >
            <span className="l">Take a desk</span>
            <span className="s">free chips, no wallet</span>
          </button>
        ) : null}
      </div>
    </Sheet>
  );
}
