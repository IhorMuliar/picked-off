// Helpers for the local MagicBlock stack checks (`make local-stack`, then `make local-fund`):
// endpoints, keys, PDAs, rollup auth tokens, raw reads and transaction sending.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import { getAuthToken, permissionPdaFromAccount, magicFeeVaultPdaFromValidator } from "@magicblock-labs/ephemeral-rollups-sdk";

const { AnchorProvider, Program, Wallet, BN } = anchor;
export { BN };

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, "..", "..");

export const LOCAL = {
  base: process.env.BASE_RPC ?? "http://127.0.0.1:8899",
  er: process.env.ER_RPC ?? "http://127.0.0.1:6699", // privacy filter in front of the local rollup
  erWs: process.env.ER_WS ?? "ws://127.0.0.1:6700",
  validator: new PublicKey("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev"),
  wallet: process.env.WALLET ?? path.join(os.homedir(), ".config/solana/blitz-ping-localnet.json"),
};

export const PROGRAM_ID = new PublicKey("5eP2A36T97mwaGHf6XoHZU6VoKh1NGxA2QwvtJhAJ6ms");
export const KIND = { table: 0, book: 1, desk: 2, round: 3 } as const;
export const PHASE = { idle: 0, hide: 1, live: 2, bell: 3, revealed: 4, aborted: 5 } as const;
export const NDESK = 8;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const loadKeypair = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));

const le8 = (n: number | bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const find = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
export const pda = {
  config: () => find([Buffer.from("config")]),
  table: (t: number) => find([Buffer.from("table"), le8(t)]),
  book: (t: number) => find([Buffer.from("book"), le8(t)]),
  desk: (t: number, s: number) => find([Buffer.from("desk"), le8(t), Buffer.from([s])]),
  round: (t: number, n: number) => find([Buffer.from("round"), le8(t), le8(n)]),
  tape: (t: number, n: number) => find([Buffer.from("tape"), le8(t), le8(n)]),
  ledger: (t: number) => find([Buffer.from("ledger"), le8(t)]),
  perm: (acc: PublicKey) => permissionPdaFromAccount(acc),
  feeVault: () => magicFeeVaultPdaFromValidator(LOCAL.validator),
};

/** The task id a design without the slot hash would use: sha256("ping/task" || table || round) & i64::MAX. */
export function predictableTaskId(t: number, n: number): bigint {
  const h = crypto.createHash("sha256").update(Buffer.concat([Buffer.from("ping/task"), le8(t), le8(n)])).digest();
  return h.readBigInt64LE(0) & 0x7fffffffffffffffn;
}

// ------------------------------------------------------------------ decoders (offsets: docs/LAYOUT.md, discriminator included)
export function decodeTable(b: Buffer) {
  return {
    tableId: Number(b.readBigUInt64LE(8)), round: Number(b.readBigUInt64LE(16)), openSlot: Number(b.readBigUInt64LE(24)),
    nextDeadlineSlot: Number(b.readBigUInt64LE(40)), bellSlot: Number(b.readBigUInt64LE(48)), revealSlot: Number(b.readBigUInt64LE(56)), taskId: b.readBigInt64LE(64),
    taskSlot: Number(b.readBigUInt64LE(72)), tickCalls: Number(b.readBigUInt64LE(80)), resolves: Number(b.readBigUInt64LE(88)),
    sealed: b.readUInt16LE(808), beat: b.readUInt16LE(810), kind: b[1068], phase: b[1069], topDesk: b[1072], recorded: b[1073],
    seat0Key: new PublicKey(b.subarray(312, 344)).toBase58(),
  };
}
export function decodeDesk(b: Buffer) {
  return { tableId: Number(b.readBigUInt64LE(8)), round: Number(b.readBigUInt64LE(16)), key: new PublicKey(b.subarray(40, 72)).toBase58(),
    lastSeq: b.readUInt32LE(72), resting: b.readUInt16LE(80), index: b[86], phase: b[88] };
}
export function decodeRound(b: Buffer) {
  return { tableId: Number(b.readBigUInt64LE(8)), round: Number(b.readBigUInt64LE(16)), status: b[144], nBeats: b[148] };
}

// ------------------------------------------------------------------ rollup auth + raw RPC
export async function tokenFor(kp: Keypair): Promise<string> {
  const { token } = await getAuthToken(LOCAL.er, kp.publicKey, async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey));
  return token;
}
export const erUrl = (token?: string) => (token ? `${LOCAL.er}?token=${token}` : LOCAL.er);
export const erConn = (token?: string) => new Connection(erUrl(token), { commitment: "confirmed", wsEndpoint: token ? `${LOCAL.erWs}?token=${token}` : LOCAL.erWs });

export async function rpc(url: string, method: string, params: unknown[] = []): Promise<{ http: number; body: any }> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const text = await r.text();
    try { return { http: r.status, body: JSON.parse(text) }; } catch { return { http: r.status, body: { raw: text.slice(0, 200) } }; }
  } catch (e: any) {
    return { http: 0, body: { fetchError: String(e?.message ?? e) } };
  }
}

/** getAccountInfo through `url`: the data, or null when the endpoint returns no account (or refuses). */
export async function readAccount(url: string, acc: PublicKey): Promise<{ data: Buffer | null; owner?: string; lamports?: number; http: number; error?: any }> {
  const r = await rpc(url, "getAccountInfo", [acc.toBase58(), { encoding: "base64", commitment: "confirmed" }]);
  const v = r.body?.result?.value;
  if (!v) return { data: null, http: r.http, error: r.body?.error };
  return { data: Buffer.from(v.data[0], "base64"), owner: v.owner, lamports: v.lamports, http: r.http };
}

// ------------------------------------------------------------------ program + tx
export function loadIdl() {
  return JSON.parse(fs.readFileSync(path.join(REPO, "target", "idl", "ping.json"), "utf8"));
}
export function programOn(conn: Connection, payer: Keypair) {
  const provider = new AnchorProvider(conn, new Wallet(payer), { commitment: "confirmed", skipPreflight: true });
  return new Program(loadIdl(), provider) as any;
}

export type SendResult = { sig: string; ms: number; err: any; ok: boolean; logs?: string[] | null; cu?: number | null };

/** Sign, send and poll until confirmed or failed. Fetches logs of failed txs for diagnosis. */
export async function send(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], opts: { cu?: number; timeoutMs?: number; skipPreflight?: boolean } = {}): Promise<SendResult> {
  const tx = new Transaction();
  if (opts.cu) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cu }));
  tx.add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(...signers);
  const t0 = performance.now();
  let sig = "";
  try {
    sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: opts.skipPreflight ?? true, maxRetries: 3 });
  } catch (e: any) {
    return { sig, ms: performance.now() - t0, err: e?.message ?? String(e), ok: false, logs: e?.logs ?? null };
  }
  const deadline = t0 + (opts.timeoutMs ?? 30_000);
  while (performance.now() < deadline) {
    const st = await conn.getSignatureStatuses([sig]).catch(() => null);
    const v = st?.value?.[0];
    if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized" || v.err)) {
      let logs: string[] | null = null, cu: number | null = null;
      const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
      logs = t?.meta?.logMessages ?? null;
      cu = t?.meta?.computeUnitsConsumed ?? null;
      return { sig, ms: performance.now() - t0, err: v.err, ok: !v.err, logs, cu };
    }
    await sleep(40);
  }
  return { sig, ms: performance.now() - t0, err: "timeout", ok: false };
}

/** Polls `url` until `acc` is owned by `owner` (default: the program); returns the ms it took or null. */
export async function waitOwner(url: string, acc: PublicKey, owner = PROGRAM_ID, timeoutMs = 20_000): Promise<number | null> {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    const a = await readAccount(url, acc);
    if (a.data && a.owner === owner.toBase58()) return Math.round(performance.now() - t0);
    await sleep(100);
  }
  return null;
}

export function diffBytes(a: Buffer, b: Buffer): number {
  let n = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++;
  return n;
}

export { Keypair, PublicKey, Connection };

// ------------------------------------------------------------------ Tape / Call (base layer; offsets: docs/LAYOUT.md)
export const callPda = (tape: PublicKey, bettor: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("call"), tape.toBuffer(), bettor.toBuffer()], PROGRAM_ID)[0];
export function decodeTape(b: Buffer) {
  return {
    tableId: Number(b.readBigUInt64LE(8)), round: Number(b.readBigUInt64LE(16)), closeUnix: Number(b.readBigInt64LE(24)),
    pool: Array.from({ length: NDESK }, (_, s) => b.readBigUInt64LE(32 + 8 * s)), total: b.readBigUInt64LE(96), paid: b.readBigUInt64LE(104),
    openCalls: b.readUInt32LE(112), nCalls: b.readUInt32LE(116), winner: b[120], resolved: b[121], void: b[122],
  };
}
export function decodeCall(b: Buffer) {
  return { amount: b.readBigUInt64LE(8), owed: b.readBigUInt64LE(16), tape: new PublicKey(b.subarray(24, 56)).toBase58(),
    bettor: new PublicKey(b.subarray(56, 88)).toBase58(), desk: b[88], claimed: b[89] };
}
