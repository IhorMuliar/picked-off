import { useEffect, useRef, useState } from "react";
import { useGame } from "../state/store";
import { actions } from "../state/runtime";
import { DESKS, lots } from "../state/types";
import { Glyph } from "./glyphs";
import { odds } from "./format";
import { sfx, unlockAudio } from "../fx/sound";
import { canStartCall, remainingMs, windowLabel } from "../chain/tapewindow";

function DeskRow({ i }: { i: number }) {
  const seat = useGame((s) => s.table.seats[i]);
  const you = useGame((s) => s.table.mySeat === i);
  const myResting = useGame((s) => (s.table.mySeat === i ? s.me?.resting : undefined));
  const reveal = useGame((s) => s.reveal);
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef(seat?.picked ?? 0);
  useEffect(() => {
    if (!seat || !ref.current) return;
    if (seat.picked !== prev.current && seat.picked > prev.current) {
      const el = ref.current;
      el.classList.remove("bump");
      void el.offsetWidth;
      el.classList.add("bump");
    }
    prev.current = seat.picked;
  }, [seat?.picked, seat]);
  if (!seat) return null;
  const top = reveal?.topDesk === i;
  const resting = reveal ? lots(reveal.totals[i] - seat.picked) : myResting !== undefined ? lots(myResting) : "▒▒▒";
  return (
    <div ref={ref} className={"desk" + (you ? " you" : "") + (top ? " top" : "")}>
      <Glyph seat={seat} you={you} />
      <div className="nm">
        {you ? `YOU · ${seat.name}` : seat.name}
        {seat.kind === "bot" && <span className="tag">BOT</span>}
      </div>
      <div className="tally">+{lots(seat.picked)}</div>
      <div className="vault" title={reveal ? "resting at the bell" : you ? "your resting lots (private)" : "resting lots are dark until the bell"}>
        {resting}
      </div>
    </div>
  );
}

function Desks() {
  return (
    <section className="panel" data-testid="desks">
      <div className="ph">
        <span>Desks</span>
        <span>picked (public) · resting</span>
      </div>
      {Array.from({ length: DESKS }, (_, i) => (
        <DeskRow key={i} i={i} />
      ))}
    </section>
  );
}

/** Re-renders every 250 ms while `on` (the chain window counts down on its own clock, not per beat). */
function useTicker(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => set((x) => x + 1), 250);
    return () => clearInterval(id);
  }, [on]);
}

function Tape() {
  const tape = useGame((s) => s.tape);
  const seats = useGame((s) => s.table.seats);
  const clock = useGame((s) => s.clock);
  const reveal = useGame((s) => s.reveal);
  const total = tape.pool.reduce((a, b) => a + b, 0);
  const inPlay = clock.phase === "hide" || clock.phase === "live";
  const chainWindow = tape.closesAt !== undefined;
  useTicker(chainWindow && inPlay);
  let open: boolean;
  let label: string;
  if (chainWindow) {
    // the program's window: Tape.close_unix on the base clock; a call starts only with MIN_CALL_LEAD_MS left
    const rem = tape.closesAt != null ? remainingMs(tape.closesAt, Date.now()) : null;
    open = inPlay && !!tape.recorded && rem !== null && canStartCall(rem);
    label = !tape.recorded ? "no Tape this round" : rem === null ? "reading the Tape…" : !inPlay ? "calls closed" : windowLabel(rem);
  } else {
    open = clock.phase === "hide" || (clock.phase === "live" && clock.beat <= tape.closeBeat);
    const n = tape.closeBeat - clock.beat + 1;
    label = clock.phase === "hide" ? "calls open" : open ? `closes in ${n} beat${n === 1 ? "" : "s"}` : "calls closed";
  }
  let right: string;
  if (clock.phase === "lights" && reveal && tape.paid !== undefined)
    right = tape.paid === "refund" ? "nobody called it · refunded" : `paid ${tape.paid.toFixed(1)}×`;
  else right = label;
  return (
    <section className="panel tape" data-testid="tape">
      <div className="ph">
        <span>The Tape · call the Top Desk</span>
        <span className="mono" data-testid="tape-window">{right}</span>
      </div>
      {seats.map((s, i) => (
        <div className="row" key={i}>
          <div className="nm">
            {i === useGame.getState().table.mySeat ? "YOU" : s.name}
            {reveal?.topDesk === i && <b style={{ color: "var(--gold)" }}> · Top Desk</b>}
          </div>
          <div className="odds">{odds(total, tape.pool[i])}</div>
          <button
            className={tape.myCall === i ? "called" : ""}
            disabled={!open || tape.myCall !== null}
            onClick={() => {
              unlockAudio();
              sfx.register();
              actions().tapeCall(i);
            }}
          >
            {tape.myCall === i ? "CALLED" : "CALL 1"}
          </button>
        </div>
      ))}
      <div className="foot">
        Parimutuel, zero rake. Odds = pool ÷ stake on that desk. One call per player, 0.01 devnet SOL. Calls close after
        live beat 10. Settled from the committed result; refunded if nobody called the Top Desk.
      </div>
    </section>
  );
}

function OddsBoard() {
  return (
    <section className="panel">
      <div className="ph">
        <span>Open odds</span>
        <span>simulated · 4,000 rounds</span>
      </div>
      <div className="oddsboard">
        <div className="lbl"><span>Re-ping fills, re-quote when picked off</span><b>1.34×</b></div>
        <div className="bar"><i style={{ width: "67%", background: "var(--gold)" }} /></div>
        <div className="lbl"><span>Same, but away half the time</span><b>0.97×</b></div>
        <div className="bar"><i style={{ width: "48%", background: "var(--sonar)" }} /></div>
        <div className="lbl"><span>Never click (algo only)</span><b>0.44×</b></div>
        <div className="bar"><i style={{ width: "22%", background: "#5b6478" }} /></div>
        <div>House edge 0.00%. Every lot a desk loses, another desk picked off.</div>
      </div>
    </section>
  );
}

export function Side() {
  return (
    <aside className="side">
      <Desks />
      <Tape />
      <OddsBoard />
    </aside>
  );
}
