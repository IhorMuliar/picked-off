// When a recorded round opens, and the planned start written into its record.
//
// The program closes a round's Tape calls at `planned_start + hide_secs + tape_close_secs` (base clock) and refuses
// `open_round` before `planned_start` (rollup clock). So the planned start has to be the moment the round really
// opens, or the Tape closes early. Rule:
//  - the record of round n+1 is created when the house sees the bell of round n (≈ 10 s before n+1 opens: LIGHTS ON,
//    then the re-seal), with planned start = round((bell + LIGHTS ON + measured lead) / 1 s), where the lead is the
//    measured time from the end of LIGHTS ON to "re-sealed, ready to open" (moving average);
//  - a record that has to be created when its round is already due (a player sat down during LIGHTS ON, a restart, an
//    abort) gets planned start = ceil((now + LATE_CREATE_LEAD_MS) / 1 s): confirmation, visibility and the re-seal;
//  - the round opens at planned start + OPEN_MARGIN_MS by the runner's clock, once the rollup clock has reached the
//    planned start; never before, and not later than the re-seal makes it.
// Both clocks were measured within a second of the runner's (devnet, 2026-11-24: base and rollup unix time read
// 0.0-1.0 s behind it, i.e. whole seconds rounded down).

/** Margin after the planned start (runner clock) before open_round is sent. */
export const OPEN_MARGIN_MS = 100;
/** A record created when its round is already due: time to confirm it, see it on the rollup and re-seal. */
export const LATE_CREATE_LEAD_MS = 3_500;
/** A pipelined record needs at least this long before its planned start (base confirmation ≈ 1-3 s, a dropped send
 *  is recovered by the first rebroadcast ≈ 3 s); with less, the round's own due-time create is used instead. */
export const MIN_PIPELINE_LEAD_MS = 5_000;

/** Moving average of the lead from the end of LIGHTS ON to "re-sealed, ready to open" (ms). */
export class LeadEstimator {
  value: number;
  n = 0;
  constructor(prior = 2_700, private alpha = 0.3, private min = 300, private max = 6_000) { this.value = prior; }
  observe(ms: number) {
    if (!Number.isFinite(ms) || ms < this.min || ms > this.max) return; // a resumed round or a stalled step: ignore
    this.value = this.n === 0 ? ms : this.value * (1 - this.alpha) + ms * this.alpha;
    this.n++;
  }
}

/** Planned start (unix s) of the round after the one whose bell was seen at `bellAtMs`. */
export function plannedFromBell(bellAtMs: number, lightsOnMs: number, leadMs: number): number {
  return Math.round((bellAtMs + lightsOnMs + leadMs) / 1000);
}

/** Planned start (unix s) of a record created when its round is already due. */
export function plannedLate(nowMs: number, leadMs = LATE_CREATE_LEAD_MS): number {
  return Math.ceil((nowMs + leadMs) / 1000);
}

/** ms to wait (runner clock) before open_round may be sent for a round planned at `plannedUnix`; 0 = now. */
export function openWaitMs(plannedUnix: number, nowMs: number): number {
  return Math.max(0, plannedUnix * 1000 + OPEN_MARGIN_MS - nowMs);
}

/** Per-round numbers: how late the round opened against its planned start, and the Tape window error
 *  (Tape.close_unix − (open + hide + tape close)): 0 = calls close exactly at live beat 10; negative = early. */
export function openTiming(plannedUnix: number, openAtMs: number, tapeLeadSecs: number) {
  const openLateMs = Math.round(openAtMs - plannedUnix * 1000);
  return { openLateMs, tapeWindowErrMs: -openLateMs, closeUnix: plannedUnix + tapeLeadSecs };
}

/** Running stats of the per-round numbers (health). */
export class OpenStats {
  private xs: number[] = [];
  add(openLateMs: number) { this.xs.push(openLateMs); if (this.xs.length > 500) this.xs.shift(); }
  get summary() {
    const s = [...this.xs].sort((a, b) => a - b);
    const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null);
    return { n: s.length, openLateP50Ms: q(0.5), openLateMaxMs: s.length ? s[s.length - 1] : null, openLateMinMs: s.length ? s[0] : null, over1500: s.filter((x) => x > 1500).length };
  }
}
