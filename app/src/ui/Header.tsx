import { useGame, useUi } from "../state/store";
import { setMuted, sfx, unlockAudio } from "../fx/sound";

export function Header() {
  const latency = useGame((s) => s.latency);
  const source = useGame((s) => s.table.source);
  const muted = useUi((s) => s.muted);
  const title =
    "Measured in this browser: from each beat's scheduled close to this desk's private result on screen, p95 over the last 1,000 beats" +
    (source === "mock" ? " (local simulation)" : "");
  return (
    <header>
      <div className="logo">
        <span className="dot" />
        PICKED <i>OFF</i>
      </div>
      <div className="hook">Hide your order in the dark book. Ping to pick off theirs.</div>
      <div className="spacer" />
      <div className="number mono" title={title} data-testid="number">
        beat → private result <b>{latency.p95 === null ? "…" : `${Math.round(latency.p95)} ms`}</b> p95 · n=
        {latency.n.toLocaleString("en-US")}
      </div>
      <button
        className="chip peek"
        onClick={() => {
          unlockAudio();
          sfx.ui();
          useUi.setState({ peekOpen: true });
        }}
      >
        🔒 Try to peek
      </button>
      <button className="chip" data-testid="mute" aria-pressed={muted} onClick={() => setMuted(!muted)}>
        {muted ? "🔇 off" : "🔊 on"}
      </button>
    </header>
  );
}
