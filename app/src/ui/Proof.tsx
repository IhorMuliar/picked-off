/** Proof: the measured number, the five live "try to peek" reads, the replay check and the explorer link. */
import { useRef, useState } from "react";
import { useGame, useUi } from "../state/store";
import { peekProbe } from "../state/runtime";
import { PEEK_READS, type PeekLine, type PeekRead, type RevealView } from "../state/types";
import { sfx } from "../fx/sound";
import { Sheet } from "./Sheet";
import { MIN_SAMPLES } from "./Header";
import { ExternalIcon } from "./icons";

const READS: PeekRead[] = [1, 2, 3, 4, 5];
const short = (h?: string) => (h ? `${h.slice(0, 8)}…${h.slice(-4)}` : "");

/** The last round's replay check, kept after the round ends. */
let lastCheck: { round: number; check: RevealView["check"]; url?: string } | null = null;
export function rememberCheck(r: RevealView | null) {
  if (r && r.check.state !== "pending") lastCheck = { round: r.round, check: r.check, url: r.explorerUrl };
}

export function ProofSheet() {
  const source = useGame((s) => s.table.source);
  const latency = useGame((s) => s.latency);
  const reveal = useGame((s) => s.reveal);
  const beatTick = useUi((s) => s.beatTick);
  const [lines, setLines] = useState<PeekLine[]>([{ kind: "dim", text: "$ pick a read above" }]);
  const [busy, setBusy] = useState<PeekRead | null>(null);
  const box = useRef<HTMLDivElement>(null);
  rememberCheck(reveal);
  const chk = reveal && reveal.check.state !== "pending" ? { round: reveal.round, check: reveal.check, url: reveal.explorerUrl } : lastCheck;
  const run = async (n: PeekRead) => {
    const probe = peekProbe();
    if (!probe || busy) return;
    setBusy(n);
    sfx.ui();
    try {
      const res = await probe.run(n);
      setLines((l) => [...(l[0]?.text.startsWith("$ pick") ? [] : l), { kind: "dim", text: `# ${n} · ${PEEK_READS[n]} · ${res.ms} ms` }, ...res.lines]);
    } catch (e) {
      setLines((l) => [...l, { kind: "no", text: `✗ read ${n} failed: ${(e as Error).message}` }]);
    } finally {
      setBusy(null);
      requestAnimationFrame(() => box.current?.scrollTo({ top: box.current.scrollHeight }));
    }
  };
  const ready = latency.p95 !== null && latency.n >= MIN_SAMPLES;
  return (
    <Sheet id="proof" title="Proof" testid="peek" tall>
      <section className="proof-num">
        <div className="big">{ready ? `${Math.round(latency.p95!)} ms` : `Measuring ${Math.min(latency.n, MIN_SAMPLES)}/${MIN_SAMPLES} beats`}</div>
        <p>
          From each beat's scheduled close to your private result reaching this browser: p95 over {latency.n.toLocaleString("en-US")} beat
          {latency.n === 1 ? "" : "s"} (the number shows after {MIN_SAMPLES} genuine samples).
          {source === "mock" ? " This is the local demo, so it measures the screen only." : ""}
        </p>
      </section>
      <section>
        <h3>Try to peek</h3>
        <p className="lede">
          Every hidden order sits in one account inside a sealed enclave (TEE) on the private rollup, with no readers. Run the reads
          yourself.{" "}
          {source === "mock" ? "The demo mirrors what the rollup returns; the live game runs each call against devnet." : "Nothing is canned: each line is the live response."}
        </p>
        <div className="peekbtns">
          {READS.map((n) => (
            <button key={n} className="btn small" disabled={busy !== null} onClick={() => run(n)} data-peek={n}>
              <span className="n">{n}</span>
              {busy === n ? "Reading…" : PEEK_READS[n]}
            </button>
          ))}
        </div>
        <div className="console" ref={box} data-testid="console">
          {lines.map((l, i) => (
            <div key={i} className={l.kind}>
              {l.text}
            </div>
          ))}
        </div>
      </section>
      <section>
        <h3>Replay check</h3>
        {chk ? (
          <p className={"mono check-line " + chk.check.state}>
            Round {chk.round}:{" "}
            {chk.check.state === "ok" ? (
              <>
                replay ✓ <span className="hash">{short(chk.check.hash)}</span> matches commit
              </>
            ) : (
              "replay ✗ the log does not match the commit"
            )}
            {chk.url && (
              <>
                {" · "}
                <a href={chk.url} target="_blank" rel="noreferrer">
                  settle tx <ExternalIcon />
                </a>
              </>
            )}
          </p>
        ) : (
          <p className="lede">After each bell the book turns public. This browser replays every order from the revealed log and checks it against the hash committed before the round.</p>
        )}
      </section>
      <section>
        <h3>Keys and sound</h3>
        <p className="lede keys">
          <kbd>←</kbd>
          <kbd>↑</kbd>
          <kbd>↓</kbd>
          <kbd>→</kbd> choose a price · <kbd>Enter</kbd> ping · <kbd>Space</kbd> ping again · <kbd>R</kbd> move · <kbd>M</kbd> move to… · <kbd>Esc</kbd> close
        </p>
        <button className="btn small" aria-pressed={beatTick} onClick={() => useUi.setState({ beatTick: !beatTick })}>
          Beat tick {beatTick ? "on" : "off"}
        </button>
      </section>
    </Sheet>
  );
}
