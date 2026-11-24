import { useEffect, useMemo, useState } from "react";
import { useGame } from "../state/store";
import { actions } from "../state/runtime";
import { LEVELS, lots, type RevealView } from "../state/types";
import { sfx, unlockAudio } from "../fx/sound";
import { DESK_COLORS } from "./format";

const W = 720;
const H = 230;
const PAD_L = 44;
const PAD_R = 26;
const PAD_T = 12;
const PAD_B = 18;
const REPLAY_FROM = 500;
const REPLAY_MS = 5000;

/** Stepped order paths, pings, fills, PICKED OFF marks, re-quotes and the bell, drawn up to `upto` beats. */
function ReplaySvg({ r, upto, mySeat }: { r: RevealView; upto: number; mySeat: number | null }) {
  const n = r.beats.length;
  const x = (b: number) => PAD_L + (b / Math.max(1, n)) * (W - PAD_L - PAD_R);
  const y = (L: number) => PAD_T + ((L - 0.5) / LEVELS) * (H - PAD_T - PAD_B);
  const shown = r.beats.filter((b) => b.beat <= upto);
  const order = [...Array(8).keys()].sort((a, b) => (a === mySeat ? 1 : b === mySeat ? -1 : a === r.topDesk ? 1 : b === r.topDesk ? -1 : 0));
  const paths = order.map((d) => {
    let L = r.initialLevels[d];
    let p = `M${x(0)},${y(L)}`;
    for (const b of shown) {
      const nl = b.levels[d];
      p += ` H${x(b.beat)}`;
      if (nl !== L) {
        p += ` V${y(nl)}`;
        L = nl;
      }
    }
    const you = d === mySeat;
    const top = d === r.topDesk;
    return (
      <path key={d} d={p} fill="none" stroke={you ? "#8FA8FF" : top ? "#FFC247" : DESK_COLORS[d]} strokeOpacity={you || top ? 1 : 0.45} strokeWidth={you ? 3.2 : top ? 2.4 : 1.4} />
    );
  });
  const marks: React.ReactNode[] = [];
  for (const b of shown) {
    const bx = x(b.beat);
    for (const a of b.actions) {
      if (a.kind === "requote") {
        marks.push(<rect key={`q${b.beat}-${a.desk}`} x={bx - 3} y={y(a.level) - 3} width={6} height={6} transform={`rotate(45 ${bx} ${y(a.level)})`} fill={a.desk === mySeat ? "#8FA8FF" : DESK_COLORS[a.desk]} />);
      } else if (a.algo) {
        marks.push(<circle key={`a${b.beat}-${a.desk}`} cx={bx} cy={y(a.level)} r={2.2} fill="none" stroke="#2EF2D0" strokeOpacity={0.6} strokeWidth={1} />);
      } else {
        marks.push(<circle key={`p${b.beat}-${a.desk}`} cx={bx} cy={y(a.level)} r={2.2} fill="#2EF2D0" opacity={0.85} />);
      }
    }
    for (const f of b.fills) {
      const fy = y(f.level);
      marks.push(<circle key={`f${b.beat}-${f.pinger}-${f.victim}`} cx={bx} cy={fy} r={2.5 + f.tenths / 4} fill="#FFC247" />);
      marks.push(
        <path key={`v${b.beat}-${f.pinger}-${f.victim}`} d={`M${bx + 5},${fy - 4} l6,6 m0,-6 l-6,6`} stroke="#FF4D61" strokeWidth={1.6} />,
      );
    }
  }
  const done = upto >= r.bellBeat;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ background: "#05070d", border: "1px solid var(--line)", borderRadius: 10, display: "block" }} data-testid="replay">
      {[1, 13, 24].map((L) => (
        <text key={L} x={4} y={y(L) + 3} fontSize="9" fill="#5b6478" fontFamily="var(--mono)">
          {(100.13 - L * 0.01).toFixed(2)}
        </text>
      ))}
      {paths}
      {marks}
      {done && (
        <g>
          <line x1={x(n)} x2={x(n)} y1={PAD_T - 6} y2={H - PAD_B + 6} stroke="#FF4D61" strokeWidth={1.5} strokeDasharray="3 3" />
          <text x={x(n) - 4} y={H - 4} fontSize="10" fill="#FF4D61" textAnchor="end" fontFamily="var(--mono)">
            bell · beat {r.bellBeat}
          </text>
        </g>
      )}
    </svg>
  );
}

export function Reveal() {
  const r = useGame((s) => s.reveal);
  const seats = useGame((s) => s.table.seats);
  const mySeat = useGame((s) => s.table.mySeat);
  const tape = useGame((s) => s.tape);
  const phaseEndsAt = useGame((s) => s.clock.phaseEndsAt);
  const [t, setT] = useState(0);
  const [closed, setClosed] = useState<number | null>(null);

  useEffect(() => {
    if (!r) return;
    sfx.bell();
    let raf = 0;
    let fanfare = false;
    const loop = () => {
      const el = performance.now() - r.startedAt;
      setT(el);
      if (!fanfare && el >= REPLAY_FROM + REPLAY_MS) {
        fanfare = true;
        sfx.fanfare();
      }
      if (el < 9000) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [r]);

  const stats = useMemo(() => {
    if (!r) return null;
    let pings = 0, algo = 0, fills = 0, requotes = 0;
    for (const b of r.beats)
      for (const a of b.actions) {
        if (a.kind === "requote") requotes++;
        else {
          pings++;
          if (a.algo) algo++;
        }
      }
    for (const b of r.beats) fills += b.fills.length;
    return { pings, algo, fills, requotes };
  }, [r]);

  if (!r || t < REPLAY_FROM || closed === r.round) return null;
  const upto = Math.min(r.bellBeat, Math.floor(((t - REPLAY_FROM) / REPLAY_MS) * r.bellBeat));
  const showTotals = t >= REPLAY_FROM + REPLAY_MS;
  const showCheck = t >= 6000;
  const top = r.topDesk;
  const mine = mySeat !== null ? r.totals[mySeat] : null;
  const left = Math.max(0, Math.ceil((phaseEndsAt - performance.now()) / 1000));
  const short = (h?: string) => (h ? `${h.slice(0, 6)}…${h.slice(-2)}` : "");
  return (
    <div className="overlay" data-testid="reveal">
      <div className="card">
        <h2>
          🔔 CLOSING BELL · beat {r.bellBeat} · LIGHTS ON
          <button className="close" onClick={() => setClosed(r.round)} aria-label="close">✕</button>
        </h2>
        <div className="body">
          <p style={{ marginTop: 0, color: "var(--mute)" }}>The Book is public now. Every order's path and every ping replays at speed.</p>
          <ReplaySvg r={r} upto={upto} mySeat={mySeat} />
          <div className="rlegend">
            <span><svg width="18" height="6"><line x1="0" x2="18" y1="3" y2="3" stroke="#8FA8FF" strokeWidth="3" /></svg>your order</span>
            <span><svg width="18" height="6"><line x1="0" x2="18" y1="3" y2="3" stroke="#FFC247" strokeWidth="2" /></svg>Top Desk</span>
            <span><svg width="8" height="8"><circle cx="4" cy="4" r="2.5" fill="#2EF2D0" /></svg>ping</span>
            <span><svg width="8" height="8"><circle cx="4" cy="4" r="2.5" fill="none" stroke="#2EF2D0" /></svg>algo ping</span>
            <span><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="#FFC247" /></svg>FILL</span>
            <span><svg width="9" height="9"><path d="M1,1 l7,7 m0,-7 l-7,7" stroke="#FF4D61" strokeWidth="1.6" /></svg>PICKED OFF</span>
            <span><svg width="9" height="9"><rect x="2" y="2" width="5" height="5" transform="rotate(45 4.5 4.5)" fill="#B48CFF" /></svg>re-quote</span>
            <span><svg width="6" height="10"><line x1="3" x2="3" y1="0" y2="10" stroke="#FF4D61" strokeDasharray="2 2" /></svg>bell</span>
          </div>
          {stats && (
            <p className="mono" style={{ color: "var(--mute)", fontSize: 12, margin: "6px 0 0" }}>
              {r.bellBeat} beats · {stats.pings} pings ({stats.algo} by algos) · {stats.fills} fills · {stats.requotes} re-quotes
            </p>
          )}
          {showTotals && (
            <div className="fadein">
              <div className="reveal-grid">
                {r.totals.map((v, d) => (
                  <div key={d} className={(d === top ? "win" : "") + (d === mySeat ? " you" : "")}>
                    {d === mySeat ? "YOU" : seats[d]?.name}
                    <br />
                    <b>{lots(v)}</b>
                  </div>
                ))}
              </div>
              <p>
                <b style={{ color: "var(--gold)" }}>Top Desk: {top === mySeat ? "YOU" : seats[top]?.name} · {lots(r.totals[top])} lots</b>
                {mine !== null && (
                  <>
                    {" "}· you finished <b>{lots(mine)}</b> ({mine >= 100 ? "+" : "−"}{lots(Math.abs(mine - 100))})
                  </>
                )}
                {tape.paid !== undefined && (
                  <> · {tape.paid === "refund" ? "Tape refunded: nobody called the Top Desk" : `Tape paid ${tape.paid.toFixed(1)}× on ${seats[top]?.name}`}</>
                )}
                {tape.myCall !== null && tape.paid !== "refund" && <> · your call {tape.myCall === top ? "won ✓" : "lost"}</>}
              </p>
            </div>
          )}
          {showCheck && (
            <p className={"mono check " + r.check.state} data-testid="check">
              {r.check.state === "ok"
                ? `replay ✓ ${short(r.check.hash)} matches commit`
                : r.check.state === "fail"
                  ? "replay ✗ the log does not match the commit"
                  : "replaying the log from the seed…"}
              {r.explorerUrl ? (
                <>
                  {" "}·{" "}
                  <a href={r.explorerUrl} target="_blank" rel="noreferrer" style={{ color: "var(--sonar)" }}>settle tx ↗</a>
                </>
              ) : null}
            </p>
          )}
          <p style={{ color: "var(--mute)" }}>Paid to every desk: resting + picked. Zero rake.</p>
          <button
            className="go"
            onClick={() => {
              unlockAudio();
              actions().join();
              setClosed(r.round);
            }}
          >
            NEXT POOL IN {left} s
          </button>
        </div>
      </div>
    </div>
  );
}
