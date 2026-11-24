/**
 * Raw account decoders for the Ping program, by byte offset (layout version 1).
 * Offsets include the 8-byte Anchor discriminator. No IDL is loaded at runtime.
 */
import bs58 from "bs58";
import { decodeRoundState, RECORD_LEN, ROUND_STATE_SIZE, type RoundState } from "../core";

export const LAYOUT_VERSION = 1;
export const NDESK = 8;
export const NO_DESK = 255;

export const PHASE = { idle: 0, hide: 1, live: 2, bell: 3, revealed: 4, aborted: 5 } as const;
export const SEAT = { empty: 0, human: 1, bot: 2 } as const;
export const TABLE_KIND = { house: 0, staked: 1 } as const;
export const ROUND_STATUS = { created: 0, open: 1, revealed: 2, aborted: 3 } as const;
export const PERSONALITY = ["none", "shark", "ghost", "minnow"] as const;
export const SEAL_ALL = 0x1ff;

/** sha256("account:<Name>")[0..8] */
export const DISC = {
  Config: [155, 12, 170, 224, 30, 250, 204, 130],
  Table: [34, 100, 138, 97, 236, 129, 230, 112],
  Book: [121, 34, 121, 35, 91, 62, 85, 222],
  Desk: [33, 28, 147, 6, 226, 158, 166, 73],
  Round: [87, 127, 165, 51, 73, 78, 116, 174],
  Ledger: [43, 41, 21, 213, 180, 176, 95, 32],
  Tape: [60, 19, 137, 0, 97, 74, 23, 131],
  Call: [62, 231, 169, 58, 154, 150, 83, 196],
} as const;
export type AccountName = keyof typeof DISC;

export const SIZE: Record<AccountName, number> = {
  Config: 272, Table: 1152, Book: 1256, Desk: 608, Round: 816, Ledger: 72, Tape: 160, Call: 112,
};

export class LayoutError extends Error {}

function check(b: Uint8Array, name: AccountName): DataView {
  if (b.length < SIZE[name]) throw new LayoutError(`${name}: ${b.length} bytes, expected ${SIZE[name]}`);
  const d = DISC[name];
  for (let i = 0; i < 8; i++) if (b[i] !== d[i]) throw new LayoutError(`${name}: wrong discriminator`);
  return new DataView(b.buffer, b.byteOffset, b.length);
}

/** True when `b` starts with the discriminator of `name`. */
export const isAccount = (b: Uint8Array | null | undefined, name: AccountName) =>
  !!b && b.length >= 8 && DISC[name].every((x, i) => b[i] === x);

const u64 = (v: DataView, o: number) => v.getBigUint64(o, true);
const i64 = (v: DataView, o: number) => v.getBigInt64(o, true);
const u32 = (v: DataView, o: number) => v.getUint32(o, true);
const u16 = (v: DataView, o: number) => v.getUint16(o, true);
const key = (b: Uint8Array, o: number) => bs58.encode(b.subarray(o, o + 32));
const u16s = (v: DataView, o: number, n: number) => Array.from({ length: n }, (_, i) => v.getUint16(o + 2 * i, true));
const isZeroKey = (b: Uint8Array, o: number) => b.subarray(o, o + 32).every((x) => x === 0);

/* ------------------------------------------------------------------ Config */
export interface Config {
  beatSlots: bigint; hideSlots: bigint; callLamports: bigint; lotLamports: bigint;
  crankIntervalMs: number; actIntervalMs: number; hideSecs: number; tapeCloseSecs: number;
  admin: string; house: string; teeValidator: string; vrfQueue: string;
  bellMin: number; bellMax: number; algoMemory: number; tapeCloseBeat: number; nDesks: number; levels: number; layout: number;
}
export function decodeConfig(b: Uint8Array): Config {
  const v = check(b, "Config");
  return {
    beatSlots: u64(v, 8), hideSlots: u64(v, 16), callLamports: u64(v, 24), lotLamports: u64(v, 32),
    crankIntervalMs: u32(v, 40), actIntervalMs: u32(v, 52), hideSecs: u32(v, 56), tapeCloseSecs: u32(v, 60),
    admin: key(b, 64), house: key(b, 96), teeValidator: key(b, 128), vrfQueue: key(b, 160),
    bellMin: b[195], bellMax: b[196], algoMemory: b[197], tapeCloseBeat: b[198], nDesks: b[199], levels: b[200], layout: b[202],
  };
}

/* ------------------------------------------------------------------ Table */
export interface SeatInfo {
  key: string | null; // null = empty key
  name: string;
  kind: number; // SEAT.*
  personality: number;
}
export interface PrintInfo { tenths: number; beat: number; desk: number }
export interface Table {
  tableId: bigint; round: bigint;
  openSlot: bigint; hideEndSlot: bigint; nextDeadlineSlot: bigint; bellSlot: bigint; revealSlot: bigint;
  taskId: bigint; tickCalls: bigint; resolves: bigint; plannedStartUnix: bigint;
  beatSlots: bigint; hideSlots: bigint; printCount: number;
  house: string; chainHead: Uint8Array; commitHash: Uint8Array;
  seats: SeatInfo[]; picked: number[]; totals: number[]; beatFill: number[];
  sealed: number; beat: number;
  /** ring of 32, slot `printCount % 32` is the next one written */
  prints: PrintInfo[];
  /** [b] = [pings, fills] of live beat b (index 0 unused) */
  beatCounts: [number, number][];
  kind: number; phase: number; topDesk: number; recorded: number; fallbackSeed: number; layout: number;
}
const dec = new TextDecoder();
export const seatName = (b: Uint8Array) => {
  const end = b.indexOf(0);
  return dec.decode(end < 0 ? b : b.subarray(0, end));
};
export function decodeTable(b: Uint8Array): Table {
  const v = check(b, "Table");
  const seats: SeatInfo[] = [];
  for (let s = 0; s < NDESK; s++) {
    const o = 312 + 56 * s;
    seats.push({ key: isZeroKey(b, o) ? null : key(b, o), name: seatName(b.subarray(o + 32, o + 48)), kind: b[o + 48], personality: b[o + 49] });
  }
  const prints: PrintInfo[] = [];
  for (let i = 0; i < 32; i++) {
    const o = 812 + 6 * i;
    prints.push({ tenths: u16(v, o), beat: u16(v, o + 2), desk: b[o + 4] });
  }
  const beatCounts: [number, number][] = [];
  for (let i = 0; i < 32; i++) beatCounts.push([b[1004 + 2 * i], b[1005 + 2 * i]]);
  return {
    tableId: u64(v, 8), round: u64(v, 16), openSlot: u64(v, 24), hideEndSlot: u64(v, 32), nextDeadlineSlot: u64(v, 40),
    bellSlot: u64(v, 48), revealSlot: u64(v, 56), taskId: i64(v, 64), tickCalls: u64(v, 80), resolves: u64(v, 88),
    plannedStartUnix: i64(v, 112), beatSlots: u64(v, 120), hideSlots: u64(v, 128), printCount: u32(v, 148),
    house: key(b, 152), chainHead: b.slice(248, 280), commitHash: b.slice(280, 312),
    seats, picked: u16s(v, 760, 8), totals: u16s(v, 776, 8), beatFill: u16s(v, 792, 8),
    sealed: u16(v, 808), beat: u16(v, 810), prints, beatCounts,
    kind: b[1068], phase: b[1069], topDesk: b[1072], recorded: b[1073], fallbackSeed: b[1074], layout: b[1078],
  };
}

/* ------------------------------------------------------------------ Desk */
export interface DeskOutRaw {
  resting: number; picked: number; fillAmt: number; lostAmt: number; level: number;
  actionKind: number; actionLevel: number; actionAlgo: number; result: number; victims: number; hitsTaken: number; nextAlgo: number;
}
export const DESK_RESULTS_AT = 96;
export const DESK_RESULT_SLOTS = 30;
export interface Desk {
  tableId: bigint; round: bigint; ackSlot: bigint; resultSlot: bigint; key: string | null;
  lastSeq: number; acts: number; resting: number; picked: number; beat: number; index: number; level: number;
  phase: number; nextAlgo: number; pendingKind: number; pendingLevel: number; placed: number; layout: number;
  /** [b] = engine DeskOut of the tick that resolved beat b (0 = HIDE end, 1..29 live) */
  results: DeskOutRaw[];
}
export function decodeDeskOut(v: DataView, o: number): DeskOutRaw {
  const g = (i: number) => v.getUint8(o + i);
  return {
    resting: v.getUint16(o, true), picked: v.getUint16(o + 2, true), fillAmt: v.getUint16(o + 4, true), lostAmt: v.getUint16(o + 6, true),
    level: g(8), actionKind: g(9), actionLevel: g(10), actionAlgo: g(11), result: g(12), victims: g(13), hitsTaken: g(14), nextAlgo: g(15),
  };
}
export function decodeDesk(b: Uint8Array): Desk {
  const v = check(b, "Desk");
  const results: DeskOutRaw[] = [];
  for (let i = 0; i < DESK_RESULT_SLOTS; i++) results.push(decodeDeskOut(v, DESK_RESULTS_AT + 16 * i));
  return {
    tableId: u64(v, 8), round: u64(v, 16), ackSlot: u64(v, 24), resultSlot: u64(v, 32), key: isZeroKey(b, 40) ? null : key(b, 40),
    lastSeq: u32(v, 72), acts: u32(v, 76), resting: u16(v, 80), picked: u16(v, 82), beat: u16(v, 84), index: b[86], level: b[87],
    phase: b[88], nextAlgo: b[89], pendingKind: b[90], pendingLevel: b[91], placed: b[92], layout: b[93], results,
  };
}

/* ------------------------------------------------------------------ Book (readable after unseal) */
export const BOOK_STATE_AT = 40;
export interface Book { tableId: bigint; round: bigint; vrfSlot: bigint; state: RoundState; layout: number }
export function decodeBook(b: Uint8Array): Book {
  const v = check(b, "Book");
  return { tableId: u64(v, 8), round: u64(v, 16), vrfSlot: u64(v, 24), state: decodeRoundState(b, BOOK_STATE_AT), layout: b[BOOK_STATE_AT + ROUND_STATE_SIZE] };
}

/* ------------------------------------------------------------------ Round */
export const ROUND_RECORD_AT = 160;
export interface Round {
  tableId: bigint; round: bigint; plannedStartUnix: bigint; openSlot: bigint; hideEndSlot: bigint; bellSlot: bigint; revealSlot: bigint;
  topKey: string | null; commitHash: Uint8Array; totals: number[]; status: number; kind: number; topDesk: number;
  fallbackSeed: number; nBeats: number; layout: number; seatKind: number[];
  /** ping_core::RoundRecord bytes (522) */
  record: Uint8Array;
}
export function decodeRound(b: Uint8Array): Round {
  const v = check(b, "Round");
  return {
    tableId: u64(v, 8), round: u64(v, 16), plannedStartUnix: i64(v, 24), openSlot: u64(v, 32), hideEndSlot: u64(v, 40),
    bellSlot: u64(v, 48), revealSlot: u64(v, 56), topKey: isZeroKey(b, 64) ? null : key(b, 64), commitHash: b.slice(96, 128),
    totals: u16s(v, 128, 8), status: b[144], kind: b[145], topDesk: b[146], fallbackSeed: b[147], nBeats: b[148], layout: b[150],
    seatKind: Array.from(b.subarray(152, 160)), record: b.slice(ROUND_RECORD_AT, ROUND_RECORD_AT + RECORD_LEN),
  };
}

/* ------------------------------------------------------------------ Tape / Call (base layer) */
export interface Tape {
  tableId: bigint; round: bigint; closeUnix: bigint; pool: bigint[]; total: bigint; paid: bigint;
  openCalls: number; nCalls: number; winner: number; resolved: number; void: number; layout: number;
}
export function decodeTape(b: Uint8Array): Tape {
  const v = check(b, "Tape");
  return {
    tableId: u64(v, 8), round: u64(v, 16), closeUnix: i64(v, 24), pool: Array.from({ length: 8 }, (_, i) => u64(v, 32 + 8 * i)),
    total: u64(v, 96), paid: u64(v, 104), openCalls: u32(v, 112), nCalls: u32(v, 116), winner: b[120], resolved: b[121], void: b[122], layout: b[124],
  };
}
export interface Call { amount: bigint; owed: bigint; tape: string; bettor: string; desk: number; claimed: number; layout: number }
export function decodeCall(b: Uint8Array): Call {
  const v = check(b, "Call");
  return { amount: u64(v, 8), owed: u64(v, 16), tape: key(b, 24), bettor: key(b, 56), desk: b[88], claimed: b[89], layout: b[91] };
}
