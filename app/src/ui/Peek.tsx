import { useRef, useState } from "react";
import { useGame, useUi } from "../state/store";
import { peekProbe } from "../state/runtime";
import { PEEK_READS, type PeekLine, type PeekRead } from "../state/types";
import { sfx } from "../fx/sound";

const READS: PeekRead[] = [1, 2, 3, 4, 5];

export function Peek() {
  const open = useUi((s) => s.peekOpen);
  const source = useGame((s) => s.table.source);
  const check = useGame((s) => s.reveal?.check);
  const [lines, setLines] = useState<PeekLine[]>([{ kind: "dim", text: "$ waiting for a read…" }]);
  const [busy, setBusy] = useState<PeekRead | null>(null);
  const box = useRef<HTMLDivElement>(null);
  if (!open) return null;
  const run = async (n: PeekRead) => {
    const probe = peekProbe();
    if (!probe || busy) return;
    setBusy(n);
    sfx.ui();
    try {
      const res = await probe.run(n);
      setLines((l) => [...(l[0]?.text.startsWith("$ waiting") ? [] : l), { kind: "dim", text: `# ${n} · ${PEEK_READS[n]} · ${res.ms} ms` }, ...res.lines]);
    } catch (e) {
      setLines((l) => [...l, { kind: "no", text: `✗ read ${n} failed: ${(e as Error).message}` }]);
    } finally {
      setBusy(null);
      requestAnimationFrame(() => box.current?.scrollTo({ top: box.current.scrollHeight }));
    }
  };
  return (
    <div className="overlay" data-testid="peek" onClick={(e) => e.target === e.currentTarget && useUi.setState({ peekOpen: false })}>
      <div className="card">
        <h2>
          🔒 TRY TO PEEK
          <button className="close" onClick={() => useUi.setState({ peekOpen: false })} aria-label="close">✕</button>
        </h2>
        <div className="body">
          <p style={{ color: "var(--mute)", marginTop: 0 }}>
            Every resting order sits in one account inside the TEE that has <b>no readers</b>. Run the reads yourself.{" "}
            {source === "mock"
              ? "This build runs on a local simulation: the responses mirror what the rollup returns; the live build runs each call against devnet."
              : "Nothing here is canned: each line is the live response."}
          </p>
          <div className="peekbtns">
            {READS.map((n) => (
              <button key={n} className="btn" disabled={busy !== null} onClick={() => run(n)} data-peek={n}>
                {busy === n ? "… " : ""}
                {n} · {PEEK_READS[n]}
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
          <p style={{ color: "var(--mute)" }}>
            After the bell the Book flips public. The browser re-plays all 8 desks' orders from the revealed log and checks
            the hash
            {check?.state === "ok" && check.hash ? (
              <>
                : <span className="mono" style={{ color: "var(--sonar)" }}>replay ✓ {check.hash.slice(0, 6)}…{check.hash.slice(-2)} matches commit</span>
              </>
            ) : (
              "."
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
