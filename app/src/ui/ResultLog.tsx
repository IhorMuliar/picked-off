/** The latest private results as text, for screen readers (and the browser checks). Visually hidden: the book shows them. */
import { lots, priceOf, type PrivateResult } from "../state/types";
import { useRound } from "./round";

const say = (r: PrivateResult) =>
  r.kind === "pickedoff"
    ? `PICKED OFF −${lots(r.tenths)}${(r.count ?? 1) > 1 ? ` (${r.count} hits)` : ""}: someone found your order. Move it.`
    : `${r.algo ? "auto " : ""}${r.kind === "fill" ? `FILL ${priceOf(r.level!)} +${lots(r.tenths)}${r.next ? `, next +${lots(r.next)}` : ""}` : `miss ${priceOf(r.level!)}`}`;

export function ResultLog() {
  const log = useRound((s) => s.log);
  return (
    <div className="sr-only" data-testid="toasts" aria-live="polite">
      {log.map((r) => (
        <div key={r.id} className="toast" data-kind={r.kind} data-algo={r.algo ? "1" : undefined}>
          {say(r)}
        </div>
      ))}
    </div>
  );
}
