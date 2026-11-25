import { useEffect, useState } from "react";
import { openSheet, useGame, useUi } from "../state/store";
import { setMuted, sfx, unlockAudio } from "../fx/sound";
import { ShieldIcon, SoundIcon, TapeIcon } from "./icons";
import { tapeWindow } from "./Tape";

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
  const text = called ? "Called" : w.open ? w.short : "Tape";
  return (
    <button
      className={"chip tape" + (w.open && !called ? " open" : "") + (sheet === "tape" ? " on" : "")}
      onClick={() => {
        unlockAudio();
        sfx.ui();
        openSheet(sheet === "tape" ? null : "tape");
      }}
      aria-label="The Tape: call the top desk"
    >
      <TapeIcon />
      <span className={w.open || called ? "" : "long"}>{text}</span>
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
          <span className="long">measuring </span>
          {Math.min(latency.n, MIN_SAMPLES)}/{MIN_SAMPLES}
        </span>
      )}
    </button>
  );
}

export function Header() {
  const muted = useUi((s) => s.muted);
  const source = useGame((s) => s.table.source);
  const offline = useGame((s) => s.banner?.kind === "offline");
  return (
    <header className="top">
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
