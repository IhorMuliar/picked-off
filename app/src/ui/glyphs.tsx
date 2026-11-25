/** 24-px desk glyphs drawn in SVG (no image assets). Neutral: only your own is in your colour. */
import type { Seat } from "../state/types";

export function Glyph({ seat, you }: { seat: Seat; you?: boolean }) {
  const c = you ? "var(--you)" : "var(--n6)";
  return (
    <svg className="av" viewBox="0 0 30 30" aria-hidden="true">
      <rect width="30" height="30" rx="8" fill="var(--n2)" />
      {seat.kind === "human" ? (
        <>
          <circle cx="15" cy="12" r="4.5" fill={c} />
          <path d="M7 25 a8 7 0 0 1 16 0z" fill={c} />
        </>
      ) : seat.bot === "shark" ? (
        <>
          <path d="M5 19 Q15 9 25 19 Z" fill={c} />
          <path d="M14 12 L17 5 L19 13 Z" fill={c} />
        </>
      ) : seat.bot === "ghost" ? (
        <>
          <path d="M8 24 V13 a7 7 0 0 1 14 0 V24 l-3.5-2 -3.5 2 -3.5-2z" fill={c} opacity=".85" />
          <circle cx="12.5" cy="14" r="1.5" fill="var(--n2)" />
          <circle cx="17.5" cy="14" r="1.5" fill="var(--n2)" />
        </>
      ) : (
        <>
          <ellipse cx="14" cy="15" rx="7" ry="4" fill={c} />
          <path d="M21 15 L26 11 V19 Z" fill={c} />
        </>
      )}
    </svg>
  );
}
