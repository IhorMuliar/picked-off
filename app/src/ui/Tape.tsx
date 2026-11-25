/** The Tape: the spectator bet on the top desk, in its own sheet, with its true closing time and funding state. */
import { useEffect, useState } from "react";
import { useGame } from "../state/store";
import { actions } from "../state/runtime";
import type { Clock, TapeView } from "../state/types";
import { sfx, unlockAudio } from "../fx/sound";
import { canStartCall, remainingMs, windowLabel } from "../chain/tapewindow";
import { acted } from "./round";
import { Sheet } from "./Sheet";
import { callWords, dismissLastCall, useLastCall } from "./lastcall";

export interface TapeWindow {
  open: boolean;
  /** full label for the sheet */
  label: string;
  /** whole seconds until calls close, while open */
  secs: number | null;
}

/** The call window: on the chain it is the program's (Tape.close_unix on the base clock); the mock follows the beats. */
export function tapeWindow(tape: TapeView, clock: Clock): TapeWindow {
  const inPlay = clock.phase === "hide" || clock.phase === "live";
  if (tape.closesAt !== undefined) {
    const rem = tape.closesAt != null ? remainingMs(tape.closesAt, Date.now()) : null;
    const open = inPlay && !!tape.recorded && rem !== null && canStartCall(rem);
    const label = !tape.recorded ? "No Tape this round" : rem === null ? "Reading the Tape…" : !inPlay ? "Calls closed" : windowLabel(rem).replace(/^c/, "C");
    return { open, label, secs: open && rem !== null ? Math.ceil(rem / 1000) : null };
  }
  const open = clock.phase === "hide" || (clock.phase === "live" && clock.beat <= tape.closeBeat);
  const n = tape.closeBeat - clock.beat + 1;
  const label = clock.phase === "hide" ? "Calls open" : open ? `Closes in ${n} beat${n === 1 ? "" : "s"}` : "Calls closed";
  const secs = !open ? null : clock.phase === "hide" ? Math.ceil(Math.max(0, clock.phaseEndsAt - performance.now()) / 1000 + tape.closeBeat * 1.5) : Math.ceil(n * 1.5);
  return { open, label, secs };
}

const fmt = (x: number) => (x >= 10 ? x.toFixed(0) : x.toFixed(1));

export function TapeSheet() {
  const tape = useGame((s) => s.tape);
  const seats = useGame((s) => s.table.seats);
  const mySeat = useGame((s) => s.table.mySeat);
  const clock = useGame((s) => s.clock);
  const reveal = useGame((s) => s.reveal);
  const banner = useGame((s) => s.banner);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(id);
  }, []);
  const w = tapeWindow(tape, clock);
  const chain = tape.closesAt !== undefined;
  const total = tape.pool.reduce((a, b) => a + b, 0);
  const top = reveal?.topDesk;
  let result: React.ReactNode = null;
  if (clock.phase === "lights" && reveal && tape.paid !== undefined) {
    const name = top === mySeat ? "you" : seats[top!]?.name;
    if (tape.paid === "refund") result = <>Refunded: nobody called {name}.</>;
    else result = <>Paid {tape.paid.toFixed(1)}× on {name}.</>;
    if (tape.myCall !== null && tape.paid !== "refund") result = <>{result} Your call {tape.myCall === top ? <b className="gain">won</b> : <b className="loss">lost</b>}.</>;
  }
  // the chain pools hold lamports; the demo counts calls
  const staked = (x: number) => (chain ? `${(x / 1e9).toFixed(2)} SOL` : `${x} call${x === 1 ? "" : "s"}`);
  const note = banner?.kind === "info" ? banner.text : null;
  const funding = banner?.kind === "connecting" && /SOL|drip/.test(banner.text);
  const last = useLastCall((x) => x.call);
  const lw = last ? callWords(last, useGame.getState().table.round) : null;
  return (
    <Sheet id="tape" title="The Tape" testid="tape">
      {last && !last.dismissed && (
        <div className={"lastcall " + last.outcome} data-testid="lastcall" data-call={last.outcome} data-settled={last.settled ?? ""}>
          <div className="lc-h">
            <span className="lc-r">{`Round ${last.round} · your call`}</span>
            {lw!.done && (
              <button className="linkbtn" onClick={dismissLastCall}>
                OK
              </button>
            )}
          </div>
          <p className="lc-t">{lw!.title}</p>
          <p className="lc-d">{lw!.detail}</p>
        </div>
      )}
      <p className="cost">{chain ? "One call costs 0.01 devnet SOL · free from the faucet" : "Demo calls are free"}</p>
      <p className="lede">Call which desk finishes on top. One call per round; the pot is split among the right calls.</p>
      <div className="tape-status">
        <span className={"win" + (w.open ? " open" : "")} data-testid="tape-window">
          {result ?? w.label}
        </span>
        {tape.myCall !== null && <span className="mine">Your call: {tape.myCall === mySeat ? "You" : seats[tape.myCall]?.name}</span>}
      </div>
      {funding ? (
        <p className="note">Getting free devnet SOL from the faucet… your call is not placed yet.</p>
      ) : note ? (
        <p className="note">{note}</p>
      ) : tape.needsFunding && tape.myCall === null && w.open ? (
        <p className="note">Your first call fetches its 0.01 devnet SOL from the faucet first (a few seconds).</p>
      ) : null}
      <div className="tape-rows">
        {seats.map((s, i) => {
          const called = tape.myCall === i;
          const odds = tape.pool[i] > 0 ? `${fmt(total / tape.pool[i])}×` : null;
          return (
            <div className={"tape-row" + (top === i ? " top" : "") + (called ? " called" : "")} key={i}>
              <span className="nm">
                <span className="t">{i === mySeat ? "You" : s.name}</span>
                {s.kind === "bot" && <span className="bot">bot</span>}
              </span>
              <span className="pool">{tape.pool[i] > 0 ? `${staked(tape.pool[i])} · pays ${odds}` : called ? "your call · counting…" : "no calls yet"}</span>
              <button
                className={"call" + (called ? " called" : "")}
                data-called={called ? "1" : undefined}
                disabled={!w.open || tape.myCall !== null}
                onClick={() => {
                  unlockAudio();
                  sfx.register();
                  acted();
                  actions().tapeCall(i);
                }}
              >
                {called ? "Called ✓" : "Call"}
              </button>
            </div>
          );
        })}
      </div>
      <p className="fine">Parimutuel, zero rake. The closing time is the program's own clock. Refunded if nobody called the top desk.</p>
    </Sheet>
  );
}
