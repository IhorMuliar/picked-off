/**
 * The thumb zone: one hint line and two buttons, all three from one decision (./decide.ts), so the sentence above
 * the buttons always agrees with them.
 */
import { useGame } from "../state/store";
import { useDecision, type Btn } from "./decide";
import { MoveIcon, TapeIcon, CloseIcon } from "./icons";

export function Hint({ hint }: { hint: ReturnType<typeof useDecision>["hint"] }) {
  const banner = useGame((s) => s.banner);
  return (
    <p className={"hint " + hint.kind} aria-live="polite" data-testid={hint.kind === "join" ? "join" : undefined}>
      {hint.text}
      {/* the raw status line, for assistive tech and the browser checks */}
      {banner && (
        <span className="sr-only" data-testid="chain-status" data-kind={banner.kind}>
          {banner.text}
        </span>
      )}
    </p>
  );
}

function Secondary({ b }: { b: Btn }) {
  const icon = b.state === "tape" ? <TapeIcon /> : b.state.startsWith("cancel") ? <CloseIcon size={14} /> : b.state === "again-2" ? null : <MoveIcon />;
  return (
    <button
      className={"btn move " + b.state + (b.state === "cancel-mode" ? " on" : "")}
      data-testid={b.testid}
      data-state={b.state}
      disabled={b.disabled}
      onClick={() => b.onClick?.()}
    >
      {icon}
      <span className="l2">{b.label}</span>
      {b.sub && <span className="s2">{b.sub}</span>}
    </button>
  );
}

export function ThumbZone() {
  const d = useDecision();
  const p = d.primary;
  return (
    <>
      <Hint hint={d.hint} />
      <div className="actions">
        <button
          className={"btn primary " + p.tone}
          data-state={p.state}
          data-testid={p.testid ?? "primary"}
          aria-disabled={!p.onClick || p.disabled}
          disabled={p.disabled}
          onClick={() => p.onClick?.()}
        >
          <span className="l">{p.label}</span>
          {p.sub && <span className="s">{p.sub}</span>}
        </button>
        {d.secondary && <Secondary b={d.secondary} />}
      </div>
    </>
  );
}
