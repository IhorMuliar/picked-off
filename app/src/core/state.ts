// Constants and state types; mirror of crates/ping-core/src/state.rs (same units, same layout).
export const DESKS = 8;
export const LEVELS = 24;
export const STAKE = 100; // tenths of a lot
export const SKIM_STEP = 5;
export const SKIM_STEPS = 3;
export const ALGO_MEMORY = 4;
export const BELL_MIN = 20;
export const BELL_SPAN = 10;
export const MAX_BEATS = BELL_MIN + BELL_SPAN - 1;
export const LOG_ROW = 2 * DESKS;
export const LOG_LEN = MAX_BEATS * LOG_ROW;
export const ALGO_FLAG = 0x80;

export const NOOP = 0;
export const PING = 1;
export const REQUOTE = 2;

export const IDLE = 0;
export const HIDE = 1;
export const LIVE = 2;
export const BELL = 3;

export const RES_NONE = 0;
export const RES_MISS = 1;
export const RES_FILL = 2;

export interface RoundState {
  resting: Uint16Array;
  picked: Uint16Array;
  lastFill: Uint16Array;
  /** [desk * LEVELS + level - 1] = live beat of the desk's last ping on that level, 0 = never */
  lastPinged: Uint16Array;
  beat: number;
  bellBeat: number;
  seed: Uint8Array;
  vrf: Uint8Array;
  saltAcc: Uint8Array;
  chain: Uint8Array;
  level: Uint8Array;
  initialLevel: Uint8Array;
  placed: Uint8Array;
  pendingKind: Uint8Array;
  pendingLevel: Uint8Array;
  algoNext: Uint8Array;
  /** [hunter * DESKS + victim] */
  streak: Uint8Array;
  log: Uint8Array;
  phase: number;
  vrfSet: number;
  fallback: number;
  topDesk: number;
}

export interface Action {
  kind: number;
  level: number;
  algo: number;
}

export interface DeskOut {
  resting: number;
  picked: number;
  fillAmt: number;
  lostAmt: number;
  level: number;
  actionKind: number;
  actionLevel: number;
  actionAlgo: number;
  result: number;
  victims: number;
  hitsTaken: number;
  nextAlgo: number;
}

export interface BeatOut {
  desks: DeskOut[];
  picked: number[];
  totals: number[];
  beat: number;
  pings: number;
  fills: number;
  phase: number;
  topDesk: number;
  chain: Uint8Array;
}

export const ROUND_STATE_SIZE = 1144;

export function zeroState(): RoundState {
  return {
    resting: new Uint16Array(DESKS),
    picked: new Uint16Array(DESKS),
    lastFill: new Uint16Array(DESKS),
    lastPinged: new Uint16Array(DESKS * LEVELS),
    beat: 0,
    bellBeat: 0,
    seed: new Uint8Array(32),
    vrf: new Uint8Array(32),
    saltAcc: new Uint8Array(32),
    chain: new Uint8Array(32),
    level: new Uint8Array(DESKS),
    initialLevel: new Uint8Array(DESKS),
    placed: new Uint8Array(DESKS),
    pendingKind: new Uint8Array(DESKS),
    pendingLevel: new Uint8Array(DESKS),
    algoNext: new Uint8Array(DESKS),
    streak: new Uint8Array(DESKS * DESKS),
    log: new Uint8Array(LOG_LEN),
    phase: IDLE,
    vrfSet: 0,
    fallback: 0,
    topDesk: 0,
  };
}

export function zeroOut(): BeatOut {
  return {
    desks: Array.from({ length: DESKS }, () => ({
      resting: 0, picked: 0, fillAmt: 0, lostAmt: 0, level: 0, actionKind: 0,
      actionLevel: 0, actionAlgo: 0, result: 0, victims: 0, hitsTaken: 0, nextAlgo: 0,
    })),
    picked: new Array(DESKS).fill(0),
    totals: new Array(DESKS).fill(0),
    beat: 0,
    pings: 0,
    fills: 0,
    phase: 0,
    topDesk: 0,
    chain: new Uint8Array(32),
  };
}

/** Decode the Rust `RoundState` (#[repr(C)], little-endian, 1,144 bytes) at `offset`. */
export function decodeRoundState(buf: Uint8Array, offset = 0): RoundState {
  if (buf.length < offset + ROUND_STATE_SIZE) throw new Error("RoundState: short buffer");
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, ROUND_STATE_SIZE);
  const u16 = (o: number, n: number) => Uint16Array.from({ length: n }, (_, i) => dv.getUint16(o + 2 * i, true));
  const u8 = (o: number, n: number) => buf.slice(offset + o, offset + o + n);
  return {
    resting: u16(0, 8),
    picked: u16(16, 8),
    lastFill: u16(32, 8),
    lastPinged: u16(48, DESKS * LEVELS),
    beat: dv.getUint16(432, true),
    bellBeat: dv.getUint16(434, true),
    seed: u8(436, 32),
    vrf: u8(468, 32),
    saltAcc: u8(500, 32),
    chain: u8(532, 32),
    level: u8(564, 8),
    initialLevel: u8(572, 8),
    placed: u8(580, 8),
    pendingKind: u8(588, 8),
    pendingLevel: u8(596, 8),
    algoNext: u8(604, 8),
    streak: u8(612, 64),
    log: u8(676, LOG_LEN),
    phase: buf[offset + 1140],
    vrfSet: buf[offset + 1141],
    fallback: buf[offset + 1142],
    topDesk: buf[offset + 1143],
  };
}
