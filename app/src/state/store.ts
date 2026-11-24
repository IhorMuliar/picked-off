import { create } from "zustand";
import type { GameView, PrivateResult, PublicPrint, StoreWriter } from "./types";

const initial: GameView = {
  ready: false,
  clock: { phase: "connecting", beat: 0, phaseEndsAt: 0, beatEndsAt: 0, liveStartedAt: 0, bellChance: 0 },
  table: { pool: "----", round: 0, seats: [], mySeat: null, prints: [], lastPings: 0, lastFills: 0, source: "" },
  me: null,
  joinNotice: null,
  canJoin: false,
  tape: { pool: [0, 0, 0, 0, 0, 0, 0, 0], closeBeat: 10, myCall: null },
  results: [],
  reveal: null,
  latency: { p95: null, n: 0 },
  error: null,
};

/** The game view-model. Written only by the active driver (and latency by the UI). */
export const useGame = create<GameView>()(() => initial);

let resultId = 1;
let printId = 1;
const MAX_RESULTS = 24;
const MAX_PRINTS = 14;

export const storeWriter: StoreWriter = {
  set: (patch) => useGame.setState(typeof patch === "function" ? patch(useGame.getState()) : patch),
  get: () => useGame.getState(),
  pushResult: (r) =>
    useGame.setState((s) => ({ results: [...s.results, { ...r, id: resultId++ } as PrivateResult].slice(-MAX_RESULTS) })),
  pushPrint: (p) =>
    useGame.setState((s) => ({
      table: { ...s.table, prints: [{ ...p, id: printId++ } as PublicPrint, ...s.table.prints].slice(0, MAX_PRINTS) },
    })),
};

/* ---- the one measured number: beat close -> private result rendered ---- */
const samples: number[] = [];
const measuredBeats = new Set<string>();
/** Called by the UI right after it paints a private result of `beat`. */
export function recordLatency(round: number, beat: number, ms: number) {
  const key = `${round}:${beat}`;
  if (measuredBeats.has(key)) return; // one sample per beat
  measuredBeats.add(key);
  if (measuredBeats.size > 4000) measuredBeats.clear();
  samples.push(Math.max(0, ms));
  if (samples.length > 1000) samples.shift();
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  useGame.setState((s) => ({ latency: { p95, n: s.latency.n + 1 } }));
}

/* ---- local UI state (not part of the driver contract) ---- */
interface UiState {
  selected: number;
  moveMode: boolean;
  muted: boolean;
  peekOpen: boolean;
  revealOpen: boolean;
  interacted: boolean;
  beatTick: boolean;
}
const readMuted = () => {
  try {
    return localStorage.getItem("po.muted") === "1";
  } catch {
    return false;
  }
};
export const useUi = create<UiState>()(() => ({
  selected: 12,
  moveMode: false,
  muted: readMuted(),
  peekOpen: false,
  revealOpen: true,
  interacted: false,
  beatTick: true,
}));
