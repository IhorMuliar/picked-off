/**
 * watchAccount: websocket subscription plus an HTTP polling fallback.
 *  - every update (push or poll) goes to `onData`; `null` = the account is not readable;
 *  - quiet for 1.5x the expected interval -> poll over HTTP (at most once per that interval);
 *  - no push for 3x -> re-subscribe (at most every 5 s): subscriptions can stop silently;
 *  - the source replaced (new token, new connection) -> re-subscribe and poll at once;
 *  - tab visible again -> poll at once.
 */
import type { PublicKey } from "@solana/web3.js";
import type { AccountSource } from "./link";

export interface WatchOptions {
  /** How often the account is expected to change while live, ms. */
  expectEveryMs: number;
  /** Polling and re-subscribing run only while this is true (default: always). */
  isLive?: () => boolean;
  /** false = poll only, every `expectEveryMs` (base layer). */
  subscribe?: boolean;
  onError?: (e: unknown) => void;
  now?: () => number;
  resubscribeMinMs?: number;
}

export interface Watch {
  stop(): void;
  /** Poll now (e.g. after sending a tx). */
  poke(): void;
  readonly stats: { pushes: number; polls: number; resubscribes: number };
}

export function watchAccount(src: AccountSource, key: PublicKey, onData: (d: Uint8Array | null, via: "push" | "poll") => void, opts: WatchOptions): Watch {
  const now = opts.now ?? (() => performance.now());
  const live = opts.isLive ?? (() => true);
  const useWs = opts.subscribe !== false;
  const resubMin = opts.resubscribeMinMs ?? 5000;
  let stopped = false;
  let unsub: (() => void) | null = null;
  let lastAt = now();
  let lastPushAt = now();
  let lastPoll = -Infinity;
  let lastResub = now();
  let polling = false;
  const stats = { pushes: 0, polls: 0, resubscribes: 0 };

  const poll = async () => {
    if (polling || stopped) return;
    polling = true;
    lastPoll = now();
    try {
      const d = await src.get(key);
      if (stopped) return;
      stats.polls++;
      lastAt = now();
      onData(d, "poll");
    } catch (e) {
      opts.onError?.(e);
    } finally {
      polling = false;
    }
  };

  const subscribe = () => {
    if (!useWs || stopped) return;
    try {
      unsub?.();
    } catch {
      /* old connection gone */
    }
    unsub = null;
    try {
      unsub = src.subscribe(key, (d) => {
        if (stopped) return;
        stats.pushes++;
        lastAt = lastPushAt = now();
        onData(d, "push");
      });
    } catch (e) {
      opts.onError?.(e);
    }
  };

  subscribe();
  void poll();

  const offReplaced = src.onReplaced(() => {
    stats.resubscribes++;
    lastResub = now();
    subscribe();
    void poll();
  });

  const timer = setInterval(() => {
    if (stopped || !live()) return;
    const t = now();
    const quiet = t - lastAt;
    const every = useWs ? opts.expectEveryMs * 1.5 : opts.expectEveryMs;
    if (quiet >= every && t - lastPoll >= every) void poll();
    if (useWs && t - lastPushAt >= opts.expectEveryMs * 3 && t - lastResub >= resubMin) {
      lastResub = t;
      stats.resubscribes++;
      subscribe();
    }
  }, Math.max(50, Math.min(250, opts.expectEveryMs / 2)));

  const onVis = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") void poll();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);

  return {
    stats,
    poke: () => void poll(),
    stop() {
      stopped = true;
      clearInterval(timer);
      offReplaced();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
      try {
        unsub?.();
      } catch {
        /* ignore */
      }
    },
  };
}
