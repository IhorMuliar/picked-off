/** Player instructions other than `act` (built with web3.js, main thread only). */
import { Buffer } from "buffer";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { EPHEMERAL_VAULT, MAGIC_PROGRAM, PERMISSION_PROGRAM, SYSTEM_PROGRAM, type Pdas } from "./pda";
import { encodeName } from "./wire";

export const IX_DISC = {
  join: [206, 55, 2, 106, 113, 220, 17, 163],
  place_call: [11, 8, 17, 8, 195, 166, 211, 69],
  claim_call: [127, 62, 203, 190, 73, 227, 70, 158],
  settle_round: [40, 101, 18, 1, 31, 129, 52, 77],
} as const;

const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });

/** Rollup: take an empty or bot seat `seat` of house pool `t`. */
export function joinIx(p: Pdas, t: bigint, seat: number, player: PublicKey, name: string): TransactionInstruction {
  const desk = p.desk(t, seat);
  const data = new Uint8Array(8 + 1 + 16);
  data.set(IX_DISC.join, 0);
  data[8] = seat;
  data.set(encodeName(name), 9);
  return new TransactionInstruction({
    programId: p.program,
    keys: [r(player, true), w(p.table(t)), w(desk), w(p.permission(desk)), r(PERMISSION_PROGRAM), w(EPHEMERAL_VAULT), r(MAGIC_PROGRAM)],
    data: Buffer.from(data),
  });
}

/** Base: call `desk` as Top Desk on the Tape of round `n`. */
export function placeCallIx(p: Pdas, t: bigint, n: bigint, bettor: PublicKey, desk: number): TransactionInstruction {
  const tape = p.tape(t, n);
  const data = new Uint8Array(9);
  data.set(IX_DISC.place_call, 0);
  data[8] = desk;
  return new TransactionInstruction({
    programId: p.program,
    keys: [w(bettor, true), r(p.config()), w(tape), w(p.call(tape, bettor)), r(SYSTEM_PROGRAM)],
    data: Buffer.from(data),
  });
}

/** Base: claim the payout (or refund) of `bettor`'s call; `caller` pays the fee. */
export function claimCallIx(p: Pdas, t: bigint, n: bigint, caller: PublicKey, bettor: PublicKey): TransactionInstruction {
  const tape = p.tape(t, n);
  return new TransactionInstruction({
    programId: p.program,
    keys: [w(caller, true), w(tape), w(p.call(tape, bettor)), w(bettor)],
    data: Buffer.from(Uint8Array.from(IX_DISC.claim_call)),
  });
}

/** Base: settle round `n`'s Tape from its committed Round (anyone; idempotent). Send it with the claim. */
export function settleRoundIx(p: Pdas, t: bigint, n: bigint, caller: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: p.program,
    keys: [r(caller, true), r(p.round(t, n)), w(p.tape(t, n))],
    data: Buffer.from(Uint8Array.from(IX_DISC.settle_round)),
  });
}
