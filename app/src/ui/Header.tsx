import { useGame, useUi } from "../state/store";
import { setMuted, sfx, unlockAudio } from "../fx/sound";

/** The header shows the p95 only once this many beats are measured. */
const MIN_SAMPLES = 8;

export function Header() {
  const latency = useGame((s) => s.latency);
  const source = useGame((s) => s.table.source);
  const muted = useUi((s) => s.muted);
  const title =
    "Measured in this browser: from each beat's scheduled close to this desk's private result reaching this browser, p95 over the last 1,000 beats" +
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
        <span className="lbl">beat → private result </span>
        {latency.p95 === null || latency.n < MIN_SAMPLES ? (
          <>
            <b className="val pending">measuring</b> <span className="n">{Math.min(latency.n, MIN_SAMPLES)}/{MIN_SAMPLES} beats</span>
          </>
        ) : (
          <>
            <b className="val">{Math.round(latency.p95)} ms</b> <span className="n">p95 · n={latency.n.toLocaleString("en-US")}</span>
          </>
        )}
      </div>
      <button
        className="chip peek"
        onClick={() => {
          unlockAudio();
          sfx.ui();
          useUi.setState({ peekOpen: true });
        }}
      >
        🔒 <span className="lbl">Try to </span>peek
      </button>
      <button className="chip" data-testid="mute" aria-pressed={muted} aria-label="mute" onClick={() => setMuted(!muted)}>
        {muted ? "🔇 off" : "🔊 on"}
      </button>
    </header>
  );
}
