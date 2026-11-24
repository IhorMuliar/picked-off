// Base-layer transaction sending with rebroadcast.
//
// A signed transaction is sent once with preflight on (a transaction that would fail never lands), then the same
// bytes (same signature, same blockhash, so it can never execute twice) are sent again every `rebroadcastMs` while
// the RPC reports no status for it, until it is confirmed, fails on chain, or its blockhash expires
// (`lastValidBlockHeight` passed and no status in the history). Only then is a new transaction built and signed,
// after `stillNeeded` has re-read chain state, so a transaction whose effect already happened is not sent again.

/** The few RPC calls the sender needs (a fake one in the tests). */
export interface BaseRpc {
  /** Sends raw bytes. `result` is the signature; `error` is set when the RPC refused it (with preflight on: the
   *  simulation failed, so it was not forwarded); `network` is set when the request itself failed (it may or may
   *  not have been forwarded). */
  sendRaw(bytes: Uint8Array, preflight: boolean, maxRetries: number): Promise<{ result?: string; error?: { message?: string; logs?: string[] | null }; network?: string }>;
  /** Status of one signature: null = none known; undefined = the request failed. */
  status(sig: string, history: boolean): Promise<{ confirmationStatus?: string | null; err: any } | null | undefined>;
  /** Current block height; null when the request failed. */
  blockHeight(): Promise<number | null>;
}

/** A freshly signed transaction. */
export interface Signed { bytes: Uint8Array; sig: string; lastValidBlockHeight: number }

export interface BaseSendOpts {
  label?: string;
  /** Called before a new transaction is built to replace an expired one; false = its effect is already on chain
   *  (or no longer wanted): nothing is sent again and the result is `obsolete`. */
  stillNeeded?: () => Promise<boolean>;
  /** True = stop rebroadcasting and never rebuild (the caller moved on); the signature is still watched until it
   *  lands or expires, so a late landing is reported as such. */
  abandoned?: () => boolean;
}

export interface BaseSendTiming {
  pollMs: number; // status poll interval (first `fastPolls` polls at `fastPollMs`)
  fastPollMs: number;
  fastPolls: number;
  rebroadcastMs: number; // resend the same bytes after this long without a status
  heightEveryMs: number; // blockhash expiry check interval while there is no status
  maxAttempts: number; // newly signed transactions per call (1 + rebuilds after expiry)
  maxAttemptMs: number; // a single signature is given up after this long (safety net)
}

export const DEFAULT_TIMING: BaseSendTiming = { pollMs: 400, fastPollMs: 60, fastPolls: 50, rebroadcastMs: 2_000, heightEveryMs: 2_000, maxAttempts: 3, maxAttemptMs: 10 * 60_000 };

export interface BaseTxCounters {
  /** newly signed transactions sent (first sends) */
  sent: number;
  /** extra sends of an already sent signature */
  rebroadcasts: number;
  /** transactions that had no status for a rebroadcast interval, were rebroadcast, and then confirmed */
  droppedThenConfirmed: number;
  /** blockhash expired without the transaction landing (each is rebuilt, obsolete, abandoned or given up) */
  expired: number;
  /** expired and replaced by a newly built and signed transaction */
  expiredRebuilt: number;
  /** expired, and the re-read showed its effect already on chain (or no longer wanted): not sent again */
  obsolete: number;
  /** stopped by the caller (e.g. a late create_record after its round opened unrecorded) */
  abandoned: number;
  confirmed: number;
  /** refused at preflight (never landed) */
  refused: number;
  /** landed and failed (visible on chain; must stay 0) */
  failedOnChain: number;
  /** injected first-send drops (test switch; 0 in production) */
  injectedDrops: number;
}

export const newCounters = (): BaseTxCounters => ({ sent: 0, rebroadcasts: 0, droppedThenConfirmed: 0, expired: 0, expiredRebuilt: 0, obsolete: 0, abandoned: 0, confirmed: 0, refused: 0, failedOnChain: 0, injectedDrops: 0 });

export interface BaseSendResult { sig: string; ms: number; err: any; ok: boolean; logs?: string[] | null; rebroadcasts: number; attempts: number }

type Logger = (level: "info" | "warn", ev: string, data: Record<string, unknown>) => void;

const isFinal = (v: { confirmationStatus?: string | null; err: any } | null | undefined) =>
  !!v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized" || !!v.err);

export class BaseSender {
  readonly counters: BaseTxCounters = newCounters();
  private signedCount = 0;
  constructor(
    private rpc: BaseRpc,
    private timing: BaseSendTiming = DEFAULT_TIMING,
    private logger: Logger = () => {},
    /** test switch: skip the first network send of every Nth newly signed transaction (0 = off) */
    private dropEvery: number | (() => number) = 0,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private now: () => number = () => performance.now(),
  ) {}

  /** Builds (via `build`), sends and confirms one base transaction; see the file comment. */
  async send(build: () => Promise<Signed>, opts: BaseSendOpts = {}): Promise<BaseSendResult> {
    const T = this.timing, k = this.counters, t0 = this.now();
    let rebroadcastsTotal = 0;
    for (let attempt = 1; ; attempt++) {
      let tx: Signed;
      try { tx = await build(); } catch (e: any) {
        return { sig: "", ms: this.now() - t0, err: `build: ${e?.message ?? e}`, ok: false, rebroadcasts: rebroadcastsTotal, attempts: attempt };
      }
      const r = await this.watch(tx, attempt, opts);
      rebroadcastsTotal += r.rebroadcasts;
      const out = (x: Partial<BaseSendResult>): BaseSendResult => ({ sig: tx.sig, ms: this.now() - t0, err: null, ok: false, rebroadcasts: rebroadcastsTotal, attempts: attempt, ...x });
      if (r.kind === "confirmed") { k.confirmed++; return out({ ok: true }); }
      if (r.kind === "failed") { k.failedOnChain++; return out({ err: r.err }); }
      if (r.kind === "refused") { k.refused++; return out({ err: r.err, logs: r.logs }); }
      if (r.kind === "timeout") return out({ err: "timeout" });
      // expired without landing
      k.expired++;
      if (opts.abandoned?.()) {
        k.abandoned++;
        this.logger("warn", "base_tx_expired", { label: opts.label, sig: tx.sig, attempt, next: "abandoned by the caller" });
        return out({ err: "abandoned" });
      }
      if (attempt >= T.maxAttempts) {
        this.logger("warn", "base_tx_expired", { label: opts.label, sig: tx.sig, attempt, next: "given up" });
        return out({ err: "dropped" });
      }
      if (opts.stillNeeded && !(await opts.stillNeeded().catch(() => true))) {
        k.obsolete++;
        this.logger("warn", "base_tx_expired", { label: opts.label, sig: tx.sig, attempt, next: "not sent again: its effect is already on chain" });
        return out({ err: "obsolete" });
      }
      k.expiredRebuilt++;
      this.logger("warn", "base_tx_expired", { label: opts.label, sig: tx.sig, attempt, next: "new blockhash, signed and sent again" });
    }
  }

  /** One signature: first send (preflight on), rebroadcasts while it has no status, until confirmed / failed / expired. */
  private async watch(tx: Signed, attempt: number, opts: BaseSendOpts): Promise<{ kind: "confirmed" | "failed" | "refused" | "expired" | "timeout"; err?: any; logs?: string[] | null; rebroadcasts: number }> {
    const T = this.timing, k = this.counters, t0 = this.now();
    const n = ++this.signedCount;
    k.sent++;
    let preflighted = false; // a send of this signature passed preflight (later copies may skip it)
    let maybeSent = false; // some copy may have reached the network
    let rebroadcasts = 0;
    const every = typeof this.dropEvery === "function" ? this.dropEvery() : this.dropEvery;
    const inject = every > 0 && n % every === 0;
    if (inject) {
      k.injectedDrops++;
      this.logger("info", "base_tx_drop_injected", { label: opts.label, sig: tx.sig });
    } else {
      const s = await this.rpc.sendRaw(tx.bytes, true, 3);
      if (s.result) { preflighted = true; maybeSent = true; }
      else if (s.error && !/already been processed/i.test(s.error.message ?? "")) return { kind: "refused", err: s.error.message ?? "refused", logs: s.error.logs ?? null, rebroadcasts };
      else maybeSent = true; // network error or "already processed": it may be out there
    }
    let lastSendAt = this.now(), lastHeightAt = -Infinity, seen = false, stopRebroadcast = false;
    for (let i = 0; ; i++) {
      const v = await this.rpc.status(tx.sig, false).catch(() => undefined);
      if (isFinal(v)) {
        if (v!.err) return { kind: "failed", err: v!.err, rebroadcasts };
        if (rebroadcasts > 0) {
          k.droppedThenConfirmed++;
          this.logger("info", "base_tx_recovered", { label: opts.label, sig: tx.sig, attempt, rebroadcasts, ms: Math.round(this.now() - t0) });
        }
        return { kind: "confirmed", rebroadcasts };
      }
      if (v) seen = true; // processed: it is on its way
      const now = this.now();
      if (v === null) {
        // no status: rebroadcast the same bytes, and watch the blockhash's expiry
        if (!stopRebroadcast && opts.abandoned?.()) stopRebroadcast = true;
        if (!stopRebroadcast && now - lastSendAt >= T.rebroadcastMs) {
          lastSendAt = now;
          const s = await this.rpc.sendRaw(tx.bytes, !preflighted, 0);
          rebroadcasts++;
          k.rebroadcasts++;
          if (rebroadcasts === 1) this.logger("info", "base_tx_rebroadcast", { label: opts.label, sig: tx.sig, attempt, msNoStatus: Math.round(now - t0), injected: inject || undefined, seenBefore: seen || undefined });
          if (s.result) { preflighted = true; maybeSent = true; }
          else if (s.error && !preflighted && !/already been processed/i.test(s.error.message ?? "")) {
            // the first copy never passed preflight and this one is refused: nothing will execute from here on
            if (!maybeSent) return { kind: "refused", err: s.error.message ?? "refused", logs: s.error.logs ?? null, rebroadcasts };
            stopRebroadcast = true; // an earlier copy may still land: watch it until expiry
          } else if (!s.error) maybeSent = true;
        }
        if (now - lastHeightAt >= T.heightEveryMs) {
          lastHeightAt = now;
          const h = await this.rpc.blockHeight().catch(() => null);
          if (h !== null && h > tx.lastValidBlockHeight) {
            const fin = await this.rpc.status(tx.sig, true).catch(() => undefined);
            if (fin === undefined) { /* unknown: look again on the next height check */ }
            else if (isFinal(fin)) {
              if (fin!.err) return { kind: "failed", err: fin!.err, rebroadcasts };
              if (rebroadcasts > 0) k.droppedThenConfirmed++;
              return { kind: "confirmed", rebroadcasts };
            } else if (!fin) return { kind: "expired", rebroadcasts };
          }
        }
      }
      if (now - t0 > T.maxAttemptMs) return { kind: "timeout", rebroadcasts };
      await this.sleep(i < T.fastPolls ? T.fastPollMs : T.pollMs);
    }
  }
}
