/**
 * Is the screen live? The driver's own offline rule needs three failed reads; the screen does not wait that long.
 * One full beat past the scheduled close without the next beat arriving (or the browser reporting no network) is
 * enough to say "Offline · reconnecting…" and stop offering actions that cannot be sent. On return it says what was
 * missed ("Back. You missed 5 beats.").
 */
import { create } from "zustand";
import { useGame } from "../state/store";
import { BEAT_MS } from "../state/types";

interface Link {
  stale: boolean;
  /** round and beat when the screen went stale */
  from: { round: number; beat: number } | null;
  /** the notice after reconnecting: missed beats (null when the round changed meanwhile), shown until `until` */
  back: { missed: number | null; what: "beats" | "bell" | "newround"; round: number; until: number; at: number } | null;
}
export const useLink = create<Link>()(() => ({ stale: false, from: null, back: null }));

export const isStale = () => useLink.getState().stale;

export function feedLink(): () => void {
  const tick = () => {
    const s = useGame.getState();
    const c = s.clock;
    const now = performance.now();
    let late = false;
    if (c.phase === "live" && c.beatEndsAt > 0) late = now - c.beatEndsAt > BEAT_MS;
    else if (c.phase === "hide" && c.phaseEndsAt > 0) late = now - c.phaseEndsAt > 2500;
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    const stale = s.ready && (late || offline || s.banner?.kind === "offline");
    const cur = useLink.getState();
    if (stale && !cur.stale) useLink.setState({ stale: true, from: { round: s.table.round, beat: c.beat }, back: null });
    else if (!stale && cur.stale) {
      const f = cur.from;
      const same = !!f && f.round === s.table.round;
      const missed = same && c.phase === "live" ? Math.max(0, c.beat - f!.beat) : null;
      const what = !same ? "newround" : c.phase === "lights" ? "bell" : "beats";
      useLink.setState({ stale: false, from: null, back: { missed, what, round: s.table.round, until: c.phase === "live" ? c.beat + 2 : c.beat, at: performance.now() } });
    } else if (cur.back && now - cur.back.at > 3000 && (s.table.round !== cur.back.round || c.beat > cur.back.until)) useLink.setState({ back: null });
  };
  const id = setInterval(tick, 200);
  return () => clearInterval(id);
}
