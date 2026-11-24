// Devnet helpers for the checks in tests/devnet: endpoints, the TEE validator, rollup auth tokens,
// the hand-encoded `act` (docs: 30-byte wire format), Clock sysvar reads, permission decoding and
// a JSONL evidence log. Reuses the PDAs, decoders and senders of tests/local/lib.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { getAuthToken, magicFeeVaultPdaFromValidator } from "@magicblock-labs/ephemeral-rollups-sdk";
import { PROGRAM_ID, REPO, loadIdl, rpc } from "../local/lib.ts";

export const DEV = {
  base: process.env.BASE_RPC ?? "https://rpc.magicblock.app/devnet",
  er: process.env.ER_RPC ?? "https://devnet-tee.magicblock.app",
  erWs: process.env.ER_WS ?? "wss://devnet-tee.magicblock.app",
  validator: new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"),
  vrfQueue: new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc"),
  wallet: process.env.WALLET ?? path.join(os.homedir(), ".config/solana/blitz-ping-devnet.json"),
};
export const feeVault = () => magicFeeVaultPdaFromValidator(DEV.validator);
export const CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");

export async function tokenFor(kp: Keypair): Promise<string> {
  const { token } = await getAuthToken(DEV.er, kp.publicKey, async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey));
  return token;
}
export const erUrl = (token?: string) => (token ? `${DEV.er}?token=${token}` : DEV.er);
export const erWsUrl = (token?: string) => (token ? `${DEV.erWs}?token=${token}` : DEV.erWs);
export const erConn = (token?: string) => new Connection(erUrl(token), { commitment: "confirmed", wsEndpoint: erWsUrl(token) });

// ------------------------------------------------------------------ act (wire format: disc | kind | level | seq u32 | salt[16])
const idl = loadIdl();
export const disc = (name: string) => Buffer.from(idl.instructions.find((i: any) => i.name === name).discriminator);
const ACT = disc("act");
export const TICK_DISC = disc("tick");
export function actIx(player: PublicKey, desk: PublicKey, book: PublicKey, kind: number, level: number, seq: number) {
  const data = Buffer.alloc(30);
  ACT.copy(data, 0);
  data[8] = kind;
  data[9] = level;
  data.writeUInt32LE(seq >>> 0, 10);
  crypto.randomBytes(16).copy(data, 14);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: false },
      { pubkey: desk, isSigner: false, isWritable: true },
      { pubkey: book, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/** Fire-and-forget raw send (skipPreflight; used for the 32 tx/s `act` stream only). */
export async function rawSend(url: string, tx: Transaction): Promise<{ sig?: string; err?: string; http: number }> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [tx.serialize().toString("base64"), { encoding: "base64", skipPreflight: true, maxRetries: 0 }] });
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    const j: any = await r.json().catch(() => ({}));
    if (j?.result) return { sig: j.result, http: r.status };
    return { err: JSON.stringify(j?.error ?? j).slice(0, 160), http: r.status };
  } catch (e: any) {
    return { err: String(e?.message ?? e).slice(0, 160), http: 0 };
  }
}

// ------------------------------------------------------------------ reads
/** unix_timestamp and slot of the Clock sysvar as `url` serves it, with the local time at the midpoint of the request. */
export async function readClock(url: string) {
  const t0 = Date.now();
  const r = await rpc(url, "getAccountInfo", [CLOCK.toBase58(), { encoding: "base64", commitment: "processed" }]);
  const t1 = Date.now();
  const v = r.body?.result?.value;
  if (!v) return null;
  const b = Buffer.from(v.data[0], "base64");
  return { slot: Number(b.readBigUInt64LE(0)), unix: Number(b.readBigInt64LE(32)), localMid: (t0 + t1) / 2, rtt: t1 - t0 };
}

/** Permission account as devnet-tee serves it: discriminator u8, bump u8, permissioned account [32], is_private u8,
 *  then members to the end, each { flags u8, pubkey [32] } (the owner program is listed as a default member). */
export function decodePermission(b: Buffer) {
  const discriminator = b[0], bump = b[1];
  const account = new PublicKey(b.subarray(2, 34)).toBase58();
  const isPrivate = b[34];
  const members: { flags: number; key: string }[] = [];
  for (let o = 35; o + 33 <= b.length; o += 33) members.push({ flags: b[o], key: new PublicKey(b.subarray(o + 1, o + 33)).toBase58() });
  return { discriminator, bump, account, isPrivate, members, size: b.length };
}

/** Full Table decode for the checks (offsets: docs layout table, discriminator included). */
export function decodeTableFull(b: Buffer) {
  const u64 = (o: number) => Number(b.readBigUInt64LE(o));
  return {
    tableId: u64(8), round: u64(16), openSlot: u64(24), hideEndSlot: u64(32), nextDeadlineSlot: u64(40), bellSlot: u64(48), revealSlot: u64(56),
    taskId: b.readBigInt64LE(64), taskSlot: u64(72), tickCalls: u64(80), resolves: u64(88), vrfRequestSlot: u64(96), vrfFulfilSlot: u64(104),
    plannedStartUnix: Number(b.readBigInt64LE(112)), beatSlots: u64(120), hideSlots: u64(128), crankIntervalMs: b.readUInt32LE(136), crankIterations: b.readUInt32LE(140),
    tickCuLimit: b.readUInt32LE(144), house: new PublicKey(b.subarray(152, 184)).toBase58(), vrfQueue: new PublicKey(b.subarray(184, 216)).toBase58(),
    seats: Array.from({ length: 8 }, (_, s) => {
      const o = 312 + 56 * s;
      return { key: new PublicKey(b.subarray(o, o + 32)).toBase58(), name: b.subarray(o + 32, o + 48).toString("utf8").replace(/\0+$/, ""), kind: b[o + 48], personality: b[o + 49] };
    }),
    picked: Array.from({ length: 8 }, (_, s) => b.readUInt16LE(760 + 2 * s)), totals: Array.from({ length: 8 }, (_, s) => b.readUInt16LE(776 + 2 * s)),
    sealed: b.readUInt16LE(808), beat: b.readUInt16LE(810), kind: b[1068], phase: b[1069], topDesk: b[1072], recorded: b[1073], fallbackSeed: b[1074], vrfFulfils: b[1075],
  };
}
export type TableFull = ReturnType<typeof decodeTableFull>;
export function decodeRoundFull(b: Buffer) {
  return {
    tableId: Number(b.readBigUInt64LE(8)), round: Number(b.readBigUInt64LE(16)), plannedStartUnix: Number(b.readBigInt64LE(24)), openSlot: Number(b.readBigUInt64LE(32)),
    hideEndSlot: Number(b.readBigUInt64LE(40)), bellSlot: Number(b.readBigUInt64LE(48)), revealSlot: Number(b.readBigUInt64LE(56)), topKey: new PublicKey(b.subarray(64, 96)).toBase58(),
    totals: Array.from({ length: 8 }, (_, s) => b.readUInt16LE(128 + 2 * s)), status: b[144], kind: b[145], topDesk: b[146], fallbackSeed: b[147], nBeats: b[148], seatKind: Array.from(b.subarray(152, 160)),
  };
}
export function decodeDeskFull(b: Buffer) {
  return {
    tableId: Number(b.readBigUInt64LE(8)), round: Number(b.readBigUInt64LE(16)), ackSlot: Number(b.readBigUInt64LE(24)), resultSlot: Number(b.readBigUInt64LE(32)),
    key: new PublicKey(b.subarray(40, 72)).toBase58(), lastSeq: b.readUInt32LE(72), acts: b.readUInt32LE(76), resting: b.readUInt16LE(80), picked: b.readUInt16LE(82),
    beat: b.readUInt16LE(84), index: b[86], level: b[87], phase: b[88], pendingKind: b[90], pendingLevel: b[91], placed: b[92],
  };
}

// ------------------------------------------------------------------ evidence log (docs/e2e when present, else /tmp)
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = fs.existsSync(path.join(REPO, "docs")) ? path.join(REPO, "docs", "e2e") : os.tmpdir();
fs.mkdirSync(outDir, { recursive: true });
export const LOG_PATH = path.join(outDir, `devnet-a5-${stamp}.jsonl`);
const j = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
export function evidence(q: string, step: string, data: unknown) {
  fs.appendFileSync(LOG_PATH, j({ t: new Date().toISOString(), q, step, data }) + "\n");
  const s = j(data);
  console.log(`[${q}] ${step}: ${s.length > 600 ? s.slice(0, 600) + "..." : s}`);
}

export const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
export const hist = (xs: (number | string | null)[]) => xs.reduce((h: Record<string, number>, c) => ((h[String(c)] = (h[String(c)] ?? 0) + 1), h), {});
