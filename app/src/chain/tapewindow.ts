/**
 * The Tape's call window, on the base layer's clock.
 *
 * `place_call` is refused once the base layer's unix time reaches `Tape.close_unix`, whatever the round on screen says.
 * So the panel counts down to `close_unix` on an estimate of the base clock (one offset, measured from the Clock
 * sysvar at start, never the visitor's local clock alone), and a call (and the drip before it) starts only while at
 * least MIN_CALL_LEAD_MS remain, so it confirms before the program would refuse it.
 */

/** A call starts (drip, then place_call) only with at least this much of the window left. */
export const MIN_CALL_LEAD_MS = 3_000;
/** Beat length on screen. */
const BEAT_MS = 1_500;

/** One reading of the base layer's Clock sysvar (`unix_timestamp`, whole seconds) bracketed by local times. */
export interface ClockSample {
  unix: number;
  sentAt: number;
  recvAt: number;
}

/**
 * Base clock − local clock, in ms. The sysvar holds whole seconds rounded down, so on average it reads 0.5 s behind
 * the instant it describes; each sample is centred on its round trip, and the median of the samples is used.
 */
export function baseClockOffsetMs(samples: ClockSample[]): number | null {
  const xs = samples
    .filter((s) => Number.isFinite(s.unix) && s.recvAt >= s.sentAt)
    .map((s) => s.unix * 1000 + 500 - (s.sentAt + s.recvAt) / 2)
    .sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = xs.length >> 1;
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

/** Local epoch ms at which the base clock reaches `closeUnix` (the program refuses calls from then on). */
export const closesAtLocal = (closeUnix: number, offsetMs: number) => closeUnix * 1000 - offsetMs;

/** ms of the call window left at local time `localNow` (≤ 0: closed). */
export const remainingMs = (closesAt: number, localNow: number) => closesAt - localNow;

/** A call may start now: enough of the window is left for the drip and the transaction to confirm. */
export const canStartCall = (remaining: number) => remaining >= MIN_CALL_LEAD_MS;

/** The panel's label for the window. */
export function windowLabel(remaining: number): string {
  if (remaining <= 0) return "calls closed";
  const s = Math.ceil(remaining / 1000);
  if (!canStartCall(remaining)) return `closing · ${s} s`;
  const beats = Math.ceil(remaining / BEAT_MS);
  return `closes in ${beats} beat${beats === 1 ? "" : "s"} · ${s} s`;
}

/** Send options of every base-layer transaction the browser signs: preflight always on, so a call the program would
 *  refuse is refused by the RPC and never lands as a failed transaction; no RPC-side retries of a stale copy. */
export const BASE_SEND_OPTIONS = { skipPreflight: false, preflightCommitment: "processed", maxRetries: 0 } as const;

/** The part of a web3 Connection the guarded send needs. */
export interface SendConn {
  sendRawTransaction(raw: Uint8Array, opts: typeof BASE_SEND_OPTIONS): Promise<string>;
  getSignatureStatuses(sigs: string[]): Promise<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>;
}

export class WindowClosed extends Error {
  constructor() {
    super("calls closed for this round");
  }
}

/**
 * Sends signed bytes with preflight on and waits for confirmation. While no status is seen the same bytes are sent
 * again every `rebroadcastMs` (preflight on again: a copy the program would now refuse is refused, not landed), but
 * only while `gate()` holds; nothing at all is sent when it does not hold at the start.
 */
export async function sendGuarded(
  c: SendConn,
  raw: Uint8Array,
  o: { gate?: () => boolean; rebroadcastMs?: number; pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const gate = o.gate ?? (() => true);
  const pollMs = o.pollMs ?? 250, rebroadcastMs = o.rebroadcastMs ?? 2_000, timeoutMs = o.timeoutMs ?? 15_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (!gate()) throw new WindowClosed();
  const sig = await c.sendRawTransaction(raw, BASE_SEND_OPTIONS);
  let since = 0;
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    const st = await c.getSignatureStatuses([sig]).catch(() => null);
    const v = st?.value?.[0];
    if (v?.err) throw new Error(`transaction failed: ${JSON.stringify(v.err)}`);
    if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) return sig;
    if (!v && (since += pollMs) >= rebroadcastMs) {
      since = 0;
      if (gate()) await c.sendRawTransaction(raw, BASE_SEND_OPTIONS).catch(() => undefined);
    }
    await sleep(pollMs);
  }
  throw new Error("transaction not confirmed");
}
