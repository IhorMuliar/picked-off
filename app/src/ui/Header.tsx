import { useEffect, useState } from "react";
import { openSheet, useGame, useUi } from "../state/store";
import { setMuted, sfx, unlockAudio } from "../fx/sound";
import { ShieldIcon, SoundIcon, TapeIcon } from "./icons";
import { tapeWindow } from "./Tape";
import { useLink } from "./link";
import { callWords, useLastCall } from "./lastcall";

/** The header shows the measured number only once this many beats are measured. */
export const MIN_SAMPLES = 8;

function TapeChip() {
  const tape = useGame((s) => s.tape);
  const clock = useGame((s) => s.clock);
  const sheet = useUi((s) => s.sheet);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((x) => x + 1), 500);
    return () => clearInterval(id);
  }, []);
  const w = tapeWindow(tape, clock);
  const called = tape.myCall !== null;
  const last = useLastCall((s) => s.call);
  const round = useGame((s) => s.table.round);
  // the last call's outcome stays on the chip until dismissed or the next call
  const lc = last && !last.dismissed && (last.outcome !== "open" || last.round !== round) ? callWords(last, round) : null;
  // always the word "Tape": "Tape 9 s" while calls are open, "Tape ✓" once you called, else "Tape"
  const text = lc ? lc.chip : called ? "Tape ✓" : w.open && w.secs !== null ? `Tape ${w.secs} s` : "Tape";
  return (
    <button
      className={"chip tape" + (w.open && !called && !lc ? " open" : "") + (sheet === "tape" ? " on" : "") + (lc ? " last " + last!.outcome : "")}
      data-testid="tape-chip"
      data-call={last && !last.dismissed ? last.outcome : undefined}
      data-call-round={last && !last.dismissed ? last.round : undefined}
      data-settled={last && !last.dismissed ? (last.settled ?? "") : undefined}
      onClick={() => {
        unlockAudio();
        sfx.ui();
        openSheet(sheet === "tape" ? null : "tape");
      }}
      aria-label={lc ? `The Tape: ${lc.title}. ${lc.detail}` : called ? "The Tape: you called" : w.open && w.secs !== null ? `The Tape: calls close in ${w.secs} seconds` : "The Tape"}
    >
      <TapeIcon />
      <span>{text}</span>
    </button>
  );
}

export function Number() {
  const latency = useGame((s) => s.latency);
  const source = useGame((s) => s.table.source);
  const sheet = useUi((s) => s.sheet);
  const ready = latency.p95 !== null && latency.n >= MIN_SAMPLES;
  const title =
    "Private result time, measured in this browser: from each beat's scheduled close to your private result reaching this browser (p95)" +
    (source === "mock" ? " · local simulation" : "") +
    ". Open Proof.";
  return (
    <button
      className={"chip peek number" + (sheet === "proof" ? " on" : "")}
      data-testid="number"
      data-p95={ready ? Math.round(latency.p95!) : ""}
      data-n={latency.n}
      title={title}
      aria-label={ready ? `Private result time ${Math.round(latency.p95!)} milliseconds. Open Proof.` : `Proof. Measuring the private result time, ${Math.min(latency.n, MIN_SAMPLES)} of ${MIN_SAMPLES} beats.`}
      onClick={() => {
        unlockAudio();
        sfx.ui();
        openSheet(sheet === "proof" ? null : "proof");
      }}
    >
      <ShieldIcon />
      {ready ? (
        <span className="v">{Math.round(latency.p95!)} ms</span>
      ) : (
        <span className="v pending">
          <span className="long">measuring {Math.min(latency.n, MIN_SAMPLES)}/{MIN_SAMPLES}</span>
          <span className="short">{source === "mock" ? "Demo" : "Proof"}</span>
        </span>
      )}
    </button>
  );
}

export function Header() {
  const muted = useUi((s) => s.muted);
  const source = useGame((s) => s.table.source);
  const offline = useLink((s) => s.stale);
  return (
    <header className="topbar">
      <div className="brand">
        <span className={"dot" + (offline ? " off" : "")} aria-hidden="true" />
        <span className="word">Picked off</span>
        {source === "mock" && <span className="demo" title="A local simulation: seven house bots, no network">Demo</span>}
      </div>
      <p className="promise">Find the hidden orders. Take from them before the bell.</p>
      <div className="chips">
        <TapeChip />
        <Number />
        <button className="chip icon" data-testid="mute" aria-pressed={muted} aria-label={muted ? "Sound off: turn on" : "Sound on: turn off"} onClick={() => setMuted(!muted)}>
          <SoundIcon off={muted} />
        </button>
      </div>
    </header>
  );
}
