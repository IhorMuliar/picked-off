/**
 * View-model contract between the game screen and its data source.
 *
 * The UI never talks to a chain, a socket or a simulator directly. It reads one
 * zustand store (`useGame`, see ./store.ts) whose shape is `GameView`, and it
 * emits player intent only through `GameActions`. A data source is a
 * `GameDriver`: it fills the store through the `StoreWriter` it is given and
 * implements `GameActions`. Two drivers exist (selected by `VITE_DRIVER`):
 *
 *   - `mock`  (./mock/mockDriver.ts): a scripted local round loop, 8 desks,
 *             rule-accurate resolution, runs forever.
 *   - `chain` (../chain/, not part of this module): reads the public Table, the
 *             player's own Desk and, after the bell, the Book from the rollup;
 *             sends `act` / `join` / Tape calls.
 *
 * Rules every driver follows:
 *   1. Units. Lots are integers in TENTHS (10 lots = 100). Levels are 1..24,
 *      level 1 is the top price 100.12, level 24 the bottom 99.89 (`priceOf`).
 *      Desks are seat indices 0..7. Beats count live beats from 1.
 *   2. Privacy. Before the bell the store holds only what this browser may know:
 *      the public table (seats, picked tallies, prints, counters, clock) and the
 *      player's own desk (`me`). Other desks' levels and resting lots are never
 *      written before `phase === "lights"`; `reveal` is null until then.
 *   3. Time. `clock.beatEndsAt` / `clock.phaseEndsAt` are `performance.now()`
 *      timestamps of the *scheduled* end of the current beat / phase, so the UI
 *      can animate the beat ring locally without waiting for any confirmation.
 *   4. Private results. Each result of the player's own desk (FILL, miss,
 *      PICKED OFF) is appended once via `pushResult` with a unique `id` and the
 *      beat it belongs to. The UI renders toasts/sounds from new ids and
 *      measures "beat close -> private result rendered" itself (header number);
 *      drivers must not fake that number.
 *   5. Actions are fire-and-forget. The UI shows the ping ripple at once and
 *      the outcome only when the driver pushes the result for that beat.
 *      Multiple calls inside one beat: the last one counts (one action per
 *      desk per beat).
 *   6. Peek console. `PeekProbe.run(n)` performs read n of the five reads in
 *      GAME-SPEC 4.7 and returns the raw outcome as console lines. The chain
 *      implementation must run the live RPC call each time; nothing canned.
 */

export const DESKS = 8;
export const LEVELS = 24;
export const STAKE_TENTHS = 100;
export const BEAT_MS = 1500;
export const HIDE_MS = 5000;
export const LIGHTS_MS = 8000;
export const TAPE_CLOSE_BEAT = 10;
export const BELL_MIN = 20;
export const BELL_MAX = 29;

/** Price label of a level (1 = 100.12 ... 24 = 99.89). Cosmetic. */
export const priceOf = (level: number): string => (100.13 - level * 0.01).toFixed(2);
/** Tenths to a lots string: 15 -> "1.5". */
export const lots = (tenths: number): string => (tenths / 10).toFixed(1);

export type Phase = "connecting" | "hide" | "live" | "lights";
export type BotKind = "shark" | "ghost" | "minnow";

export interface Seat {
  /** Display name: "SHARK-2", "bright-otter", ... */
  name: string;
  kind: "human" | "bot";
  bot?: BotKind;
  /** Public picked tally in tenths, updated every beat. */
  picked: number;
}

export interface PublicPrint {
  id: number;
  /** Seconds since the round's live start, for the "0:18" stamp. */
  t: number;
  /** A FILL print: desk filled `tenths`, price withheld. */
  desk?: number;
  tenths?: number;
  /** A beat summary: "8 pings this beat · 3 fills". */
  pings?: number;
  fills?: number;
}

export interface Clock {
  phase: Phase;
  /** Live beat index (1..), 0 during HIDE. */
  beat: number;
  /** performance.now() of the scheduled end of the current phase (HIDE/LIGHTS) */
  phaseEndsAt: number;
  /** performance.now() of the scheduled close of the current live beat. */
  beatEndsAt: number;
  /** performance.now() of the live start (beat 1 opening). */
  liveStartedAt: number;
  /** Bell chance for the beat now being played, 0..1 (public formula). */
  bellChance: number;
}

export interface TableView {
  /** Pool id label, e.g. "0412". */
  pool: string;
  round: number;
  seats: Seat[];
  /** The player's seat index, or null when spectating. */
  mySeat: number | null;
  prints: PublicPrint[];
  /** Last resolved beat's public counters. */
  lastPings: number;
  lastFills: number;
  /** Driver label, shown nowhere prominent: "mock" | "devnet" | "local". */
  source: string;
}

export type PendingAction =
  | { kind: "none" }
  | { kind: "ping"; level: number }
  | { kind: "requote"; level: number };

/** The player's own Desk (private). */
export interface MyDesk {
  level: number;
  resting: number;
  picked: number;
  /** Level the algo will ping if the player sends nothing this beat. */
  nextAlgo: number;
  /** What the driver has queued for this beat (as the UI last asked). */
  pending: PendingAction;
  /** Levels this desk pinged and how each last went (for the mark column). */
  marks: Record<number, "fill" | "miss">;
  /** Level of the last FILL that is still worth re-pinging, or null. */
  lastFill: number | null;
  /** Next skim this desk would take at lastFill (tenths), for the toast hint. */
  nextSkim: number;
  /** Escalation others have on this desk: the next fill against it (tenths). */
  exposure: number;
  /** Beat in which this desk was last picked off (for the RE-QUOTE pulse). */
  pickedOffBeat: number | null;
}

export type ResultKind = "fill" | "miss" | "pickedoff";

export interface PrivateResult {
  id: number;
  beat: number;
  /** Chain driver: beat deadline -> this result reaching the browser, ms; set only on genuine samples. */
  latencyMs?: number;
  kind: ResultKind;
  /** Pinged level for fill/miss; absent for pickedoff (victims never learn where from). */
  level?: number;
  /** Lots won (fill) or lost (pickedoff), tenths. */
  tenths: number;
  /** For pickedoff: how many fills hit this desk this beat. */
  count?: number;
  /** The ping was fired by the algo, not the player. */
  algo: boolean;
  /** For fill: the next skim at the same level (tenths). */
  next?: number;
}

export interface TapeView {
  /** Pool per desk in lamports-ish units (any consistent unit). */
  pool: number[];
  /** Live beat after which calls close. */
  closeBeat: number;
  /** Desk the player called this round, or null. */
  myCall: number | null;
  /** Result after the bell: multiple paid on the winner, or "refund". */
  paid?: number | "refund";
  /** Chain driver: a call or claim needs devnet SOL on this browser's key first. */
  needsFunding?: boolean;
}

export interface RevealAction {
  desk: number;
  kind: "ping" | "requote";
  level: number;
  algo: boolean;
}
export interface RevealFill {
  pinger: number;
  victim: number;
  level: number;
  tenths: number;
}
export interface RevealBeat {
  beat: number;
  /** Levels after re-quotes landed in this beat. */
  levels: number[];
  /** Every desk's resolved action, IN THE IN-BEAT RESOLUTION ORDER (re-quotes land first regardless). */
  actions: RevealAction[];
  fills: RevealFill[];
}
export interface RevealView {
  round: number;
  bellBeat: number;
  initialLevels: number[];
  beats: RevealBeat[];
  /** resting + picked per desk, tenths. */
  totals: number[];
  topDesk: number;
  /** Replay check: the browser re-ran the log and matched the commit. */
  check: { state: "pending" | "ok" | "fail"; hash?: string };
  /** Settle / commit transaction link, if any. */
  explorerUrl?: string;
  /** performance.now() when LIGHTS ON began. */
  startedAt: number;
}

export interface Latency {
  /** p95 of beat-close -> private-result-rendered over the last 1,000 beats, ms. */
  p95: number | null;
  n: number;
}

/** Everything the screen renders. */
export interface GameView {
  ready: boolean;
  clock: Clock;
  table: TableView;
  me: MyDesk | null;
  /** First-round seating notice (GAME-SPEC 4.8), null once dismissed. */
  joinNotice: { name: string; seat: number; level: number; resting: number } | null;
  /** Spectating after an idle round: offer a one-click seat. */
  canJoin: boolean;
  tape: TapeView;
  results: PrivateResult[];
  reveal: RevealView | null;
  latency: Latency;
  error: string | null;
}

/** Player intent. The driver implements these; all are fire-and-forget. */
export interface GameActions {
  /** HIDE: rest the order at `level`. */
  place(level: number): void;
  /** LIVE: ping `level` this beat. */
  ping(level: number): void;
  /** LIVE: re-quote to `level` this beat (null = a random untested level). */
  requote(level: number | null): void;
  /** Call the Top Desk on the Tape (one per round). */
  tapeCall(desk: number): void;
  /** Take a seat (spectator -> desk), or keep the seat for the next pool. */
  join(): void;
}

export interface PeekLine {
  kind: "cmd" | "ok" | "no" | "dim";
  text: string;
}
export interface PeekResult {
  read: PeekRead;
  lines: PeekLine[];
  ms: number;
}
export type PeekRead = 1 | 2 | 3 | 4 | 5;
export const PEEK_READS: Record<PeekRead, string> = {
  1: "Public RPC reads the Book",
  2: "Your token reads the Book",
  3: "Your token reads your Desk / another Desk",
  4: "Read a ping transaction",
  5: "List the program's transactions",
};

/** The five "try to peek" reads (GAME-SPEC 4.7). */
export interface PeekProbe {
  run(read: PeekRead): Promise<PeekResult>;
}

/** Narrow write access the store hands to a driver. */
export interface StoreWriter {
  set(patch: Partial<GameView> | ((s: GameView) => Partial<GameView>)): void;
  get(): GameView;
  pushResult(r: Omit<PrivateResult, "id">): void;
  pushPrint(p: Omit<PublicPrint, "id">): void;
}

export interface GameDriver {
  readonly name: string;
  readonly actions: GameActions;
  readonly peek: PeekProbe;
  start(store: StoreWriter): void;
  stop(): void;
}
