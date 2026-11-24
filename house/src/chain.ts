// Chain access for the house runner: PDAs, account decoders (offsets from the program's frozen
// layout), rollup auth tokens, logged account reads and transaction sending.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, SystemProgram,
} from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import {
  getAuthToken, permissionPdaFromAccount, magicFeeVaultPdaFromValidator, DELEGATION_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import type { HouseConfig } from "./config.ts";
import { log, RotatingFile } from "./log.ts";

const { AnchorProvider, Program, Wallet, BN } = anchor;
export { BN, Keypair, PublicKey, SystemProgram };

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, "..", "..");

export const KIND = { table: 0, book: 1, desk: 2, round: 3 } as const;
export const PHASE = { idle: 0, hide: 1, live: 2, bell: 3, revealed: 4, aborted: 5 } as const;
export const SEAT = { empty: 0, human: 1, bot: 2 } as const;
export const ROUND_STATUS = { created: 0, open: 1, revealed: 2, aborted: 3 } as const;
export const ACT = { noop: 0, ping: 1, requote: 2 } as const;
export const RES = { none: 0, miss: 1, fill: 2 } as const;
export const NDESK = 8;
export const LEVELS = 24;
export const SEAL_ALL = 0x1ff;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const loadKeypair = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
/** Loads the key at `p`, or creates and persists one (mode 0600) before it is ever used. */
export function loadOrCreateKeypair(p: string): Keypair {
  if (fs.existsSync(p)) return loadKeypair(p);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const kp = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

const le8 = (n: number | bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
export const disc = (ns: "account" | "global", name: string) => crypto.createHash("sha256").update(`${ns}:${name}`).digest().subarray(0, 8);

// ------------------------------------------------------------------ decoders (byte offsets include the 8-byte discriminator)
export interface Seat { key: string; name: string; kind: number; personality: number }
export interface TableView {
  tableId: number; round: number; openSlot: number; hideEndSlot: number; nextDeadlineSlot: number; bellSlot: number; revealSlot: number;
  taskId: bigint; tickCalls: number; resolves: number; plannedStartUnix: number; beatSlots: number; hideSlots: number;
  house: string; vrfQueue: PublicKey; roundKey: string; seats: Seat[]; picked: number[]; totals: number[];
  sealed: number; beat: number; kind: number; phase: number; topDesk: number; recorded: number; fallbackSeed: number;
}
export function decodeTable(b: Buffer): TableView {
  const u64 = (o: number) => Number(b.readBigUInt64LE(o));
  const seats: Seat[] = [];
  for (let s = 0; s < NDESK; s++) {
    const o = 312 + 56 * s;
    seats.push({ key: new PublicKey(b.subarray(o, o + 32)).toBase58(), name: b.subarray(o + 32, o + 48).toString("utf8").replace(/\0+$/, ""), kind: b[o + 48], personality: b[o + 49] });
  }
  return {
    tableId: u64(8), round: u64(16), openSlot: u64(24), hideEndSlot: u64(32), nextDeadlineSlot: u64(40), bellSlot: u64(48), revealSlot: u64(56),
    taskId: b.readBigInt64LE(64), tickCalls: u64(80), resolves: u64(88), plannedStartUnix: Number(b.readBigInt64LE(112)),
    beatSlots: u64(120), hideSlots: u64(128), house: new PublicKey(b.subarray(152, 184)).toBase58(), vrfQueue: new PublicKey(b.subarray(184, 216)),
    roundKey: new PublicKey(b.subarray(216, 248)).toBase58(), seats,
    picked: Array.from({ length: NDESK }, (_, s) => b.readUInt16LE(760 + 2 * s)),
    totals: Array.from({ length: NDESK }, (_, s) => b.readUInt16LE(776 + 2 * s)),
    sealed: b.readUInt16LE(808), beat: b.readUInt16LE(810), kind: b[1068], phase: b[1069], topDesk: b[1072], recorded: b[1073], fallbackSeed: b[1074],
  };
}
export interface DeskRow { resting: number; picked: number; fillAmt: number; lostAmt: number; level: number; actionKind: number; actionLevel: number; actionAlgo: number; result: number; victims: number; hitsTaken: number; nextAlgo: number }
export interface DeskView { tableId: number; round: number; ackSlot: number; key: string; lastSeq: number; acts: number; resting: number; picked: number; beat: number; index: number; level: number; phase: number; placed: number; rows: DeskRow[] }
export function decodeDesk(b: Buffer): DeskView {
  const rows: DeskRow[] = [];
  for (let i = 0; i < 30; i++) {
    const o = 96 + 16 * i;
    rows.push({ resting: b.readUInt16LE(o), picked: b.readUInt16LE(o + 2), fillAmt: b.readUInt16LE(o + 4), lostAmt: b.readUInt16LE(o + 6), level: b[o + 8],
      actionKind: b[o + 9], actionLevel: b[o + 10], actionAlgo: b[o + 11], result: b[o + 12], victims: b[o + 13], hitsTaken: b[o + 14], nextAlgo: b[o + 15] });
  }
  return { tableId: Number(b.readBigUInt64LE(8)), round: Number(b.readBigUInt64LE(16)), ackSlot: Number(b.readBigUInt64LE(24)), key: new PublicKey(b.subarray(40, 72)).toBase58(),
    lastSeq: b.readUInt32LE(72), acts: b.readUInt32LE(76), resting: b.readUInt16LE(80), picked: b.readUInt16LE(82), beat: b.readUInt16LE(84), index: b[86], level: b[87], phase: b[88], placed: b[92], rows };
}
export interface RoundView { tableId: number; round: number; plannedStartUnix: number; status: number; topDesk: number; nBeats: number; fallbackSeed: number; totals: number[] }
export function decodeRound(b: Buffer): RoundView {
  return { tableId: Number(b.readBigUInt64LE(8)), round: Number(b.readBigUInt64LE(16)), plannedStartUnix: Number(b.readBigInt64LE(24)), status: b[144], topDesk: b[146],
    fallbackSeed: b[147], nBeats: b[148], totals: Array.from({ length: NDESK }, (_, s) => b.readUInt16LE(128 + 2 * s)) };
}
export interface TapeView { tableId: number; round: number; closeUnix: number; pool: bigint[]; total: bigint; paid: bigint; openCalls: number; nCalls: number; winner: number; resolved: number; void: number }
export function decodeTape(b: Buffer): TapeView {
  return { tableId: Number(b.readBigUInt64LE(8)), round: Number(b.readBigUInt64LE(16)), closeUnix: Number(b.readBigInt64LE(24)),
    pool: Array.from({ length: NDESK }, (_, s) => b.readBigUInt64LE(32 + 8 * s)), total: b.readBigUInt64LE(96), paid: b.readBigUInt64LE(104),
    openCalls: b.readUInt32LE(112), nCalls: b.readUInt32LE(116), winner: b[120], resolved: b[121], void: b[122] };
}
export interface CallView { amount: bigint; owed: bigint; tape: string; bettor: string; desk: number; claimed: number }
export function decodeCall(b: Buffer): CallView {
  return { amount: b.readBigUInt64LE(8), owed: b.readBigUInt64LE(16), tape: new PublicKey(b.subarray(24, 56)).toBase58(),
    bettor: new PublicKey(b.subarray(56, 88)).toBase58(), desk: b[88], claimed: b[89] };
}
export interface ConfigView { house: string; teeValidator: string; vrfQueue: string; hideSecs: number; tapeCloseSecs: number; callLamports: bigint; crankIterations: number; beatSlots: number; hideSlots: number }
export function decodeConfig(b: Buffer): ConfigView {
  return { beatSlots: Number(b.readBigUInt64LE(8)), hideSlots: Number(b.readBigUInt64LE(16)), callLamports: b.readBigUInt64LE(24), crankIterations: b.readUInt32LE(44),
    hideSecs: b.readUInt32LE(56), tapeCloseSecs: b.readUInt32LE(60), house: new PublicKey(b.subarray(96, 128)).toBase58(),
    teeValidator: new PublicKey(b.subarray(128, 160)).toBase58(), vrfQueue: new PublicKey(b.subarray(160, 192)).toBase58() };
}

// ------------------------------------------------------------------ RPC with an access log (who read which account; checked by the I13 test)
let rpcLog: RotatingFile | null = null;
export function openRpcLog(file: string, maxMb = 0, keep = 3) {
  if (!file || file === "off") return;
  rpcLog = new RotatingFile(file, maxMb * 1048576, keep, () => { rpcLog = null; });
}
function logRead(who: string, layer: string, method: string, accounts: string[], extra?: Record<string, unknown>) {
  rpcLog?.write(JSON.stringify({ t: Date.now(), who, layer, m: method, a: accounts, ...extra }) + "\n");
}

export async function rpc(url: string, method: string, params: unknown[] = [], timeoutMs = 10_000): Promise<{ http: number; body: any }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ac.signal });
    const text = await r.text();
    try { return { http: r.status, body: JSON.parse(text) }; } catch { return { http: r.status, body: { raw: text.slice(0, 200) } }; }
  } catch (e: any) {
    return { http: 0, body: { fetchError: String(e?.message ?? e) } };
  } finally {
    clearTimeout(timer);
  }
}

export interface Acc { data: Buffer | null; owner?: string; lamports?: number; slot?: number; http: number; error?: any }

/** An endpoint plus the identity reading through it (for the access log). */
export class Reader {
  constructor(public url: string, public who: string, public layer: "base" | "er") {}
  /** `revealed`: the read of an account that is public because its round was revealed (logged as such). */
  async account(acc: PublicKey, revealed?: { round: number; phase: number }): Promise<Acc> {
    logRead(this.who, this.layer, revealed ? "getAccountInfo:revealed" : "getAccountInfo", [acc.toBase58()], revealed);
    const r = await rpc(this.url, "getAccountInfo", [acc.toBase58(), { encoding: "base64", commitment: "confirmed" }]);
    const v = r.body?.result?.value;
    const slot = r.body?.result?.context?.slot;
    if (!v) return { data: null, http: r.http, error: r.body?.error ?? r.body?.fetchError, slot };
    return { data: Buffer.from(v.data[0], "base64"), owner: v.owner, lamports: v.lamports, http: r.http, slot };
  }
  /** `meta`: owner and lamports only (no account data is requested). */
  async accounts(accs: PublicKey[], meta = false): Promise<Acc[]> {
    const out: Acc[] = [];
    for (let i = 0; i < accs.length; i += 100) {
      const chunk = accs.slice(i, i + 100).map((a) => a.toBase58());
      logRead(this.who, this.layer, meta ? "getMultipleAccounts:meta" : "getMultipleAccounts", chunk);
      const r = await rpc(this.url, "getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed", ...(meta ? { dataSlice: { offset: 0, length: 0 } } : {}) }]);
      const vs: any[] = r.body?.result?.value;
      if (!vs) throw new Error(`getMultipleAccounts failed: ${JSON.stringify(r.body?.error ?? r.body).slice(0, 200)}`);
      for (const v of vs) out.push(v ? { data: Buffer.from(v.data[0], "base64"), owner: v.owner, lamports: v.lamports, http: r.http } : { data: null, http: r.http });
    }
    return out;
  }
  async programAccounts(program: PublicKey, filters: unknown[]): Promise<{ pubkey: string; data: Buffer; lamports: number }[]> {
    logRead(this.who, this.layer, "getProgramAccounts", [program.toBase58(), JSON.stringify(filters)]);
    const r = await rpc(this.url, "getProgramAccounts", [program.toBase58(), { encoding: "base64", commitment: "confirmed", filters }], 30_000);
    const vs: any[] = r.body?.result;
    if (!Array.isArray(vs)) throw new Error(`getProgramAccounts failed: ${JSON.stringify(r.body?.error ?? r.body).slice(0, 200)}`);
    return vs.map((x) => ({ pubkey: x.pubkey, data: Buffer.from(x.account.data[0], "base64"), lamports: x.account.lamports }));
  }
}

// ------------------------------------------------------------------ the chain context shared by pools and bots
export type SendResult = { sig: string; ms: number; err: any; ok: boolean; logs?: string[] | null };

export class Chain {
  readonly programId: PublicKey;
  readonly validator: PublicKey;
  readonly house: Keypair;
  readonly base: Connection;
  readonly baseRead: Reader;
  readonly idl: any;
  houseToken = "";
  private tokenExpiry = 0;
  er!: Connection;
  erRead!: Reader;
  progBase: any;
  progEr: any;

  constructor(public cfg: HouseConfig) {
    this.programId = new PublicKey(cfg.programId);
    this.validator = new PublicKey(cfg.validator);
    this.house = loadKeypair(cfg.houseKeypair);
    this.base = new Connection(cfg.baseRpc, "confirmed");
    this.baseRead = new Reader(cfg.baseRpc, "house", "base");
    this.idl = JSON.parse(fs.readFileSync(path.join(REPO, "target", "idl", "ping.json"), "utf8"));
    if (this.idl.address !== this.programId.toBase58()) this.idl = { ...this.idl, address: this.programId.toBase58() };
    this.progBase = this.program(this.base, this.house);
  }

  program(conn: Connection, payer: Keypair) {
    return new Program(this.idl, new AnchorProvider(conn, new Wallet(payer), { commitment: "confirmed", skipPreflight: false })) as any;
  }

  // ---------------------------------------------------------------- rollup auth
  async token(kp: Keypair): Promise<{ token: string; expiresAt: number }> {
    return getAuthToken(this.cfg.erRpc, kp.publicKey, async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey));
  }
  erUrl(token?: string) {
    return token ? `${this.cfg.erRpc}${this.cfg.erRpc.includes("?") ? "&" : "?"}token=${token}` : this.cfg.erRpc;
  }
  /** (Re)authenticates the house on the rollup when the token is missing or about to expire. */
  async ensureHouseToken(force = false) {
    if (!force && this.houseToken && Date.now() < this.tokenExpiry - 60_000) return;
    const { token, expiresAt } = await this.token(this.house);
    this.houseToken = token;
    this.tokenExpiry = expiresAt && expiresAt > 1e12 ? expiresAt : expiresAt ? expiresAt * 1000 : Date.now() + 10 * 60_000;
    this.er = new Connection(this.erUrl(token), { commitment: "confirmed" });
    this.erRead = new Reader(this.erUrl(token), "house", "er");
    this.progEr = this.program(this.er, this.house);
  }

  // ---------------------------------------------------------------- PDAs
  private find(seeds: Buffer[]) { return PublicKey.findProgramAddressSync(seeds, this.programId)[0]; }
  readonly pda = {
    config: () => this.find([Buffer.from("config")]),
    table: (t: number) => this.find([Buffer.from("table"), le8(t)]),
    book: (t: number) => this.find([Buffer.from("book"), le8(t)]),
    desk: (t: number, s: number) => this.find([Buffer.from("desk"), le8(t), Buffer.from([s])]),
    round: (t: number, n: number) => this.find([Buffer.from("round"), le8(t), le8(n)]),
    tape: (t: number, n: number) => this.find([Buffer.from("tape"), le8(t), le8(n)]),
    ledger: (t: number) => this.find([Buffer.from("ledger"), le8(t)]),
    call: (tape: PublicKey, bettor: PublicKey) => this.find([Buffer.from("call"), tape.toBuffer(), bettor.toBuffer()]),
    perm: (acc: PublicKey) => permissionPdaFromAccount(acc),
    feeVault: () => magicFeeVaultPdaFromValidator(this.validator),
  };
  isDelegatedOwner(owner?: string) { return owner === DELEGATION_PROGRAM_ID.toBase58(); }

  // ---------------------------------------------------------------- sending
  /** Signs, sends and polls until confirmed or failed. Preflight is on unless asked otherwise.
   *  `untilExpired`: keep polling past `timeoutMs` until the blockhash has expired, so a tx reported as
   *  dropped can no longer land (a re-send can then never race the first copy). */
  async send(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], opts: { cu?: number; timeoutMs?: number; skipPreflight?: boolean; label?: string; untilExpired?: boolean } = {}): Promise<SendResult> {
    const tx = new Transaction();
    if (opts.cu) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cu }));
    tx.add(...ixs);
    tx.feePayer = signers[0].publicKey;
    const t0 = performance.now();
    let sig = "";
    let lastValid = 0;
    try {
      const bh = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = bh.blockhash;
      lastValid = bh.lastValidBlockHeight;
      tx.sign(...signers);
      sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: opts.skipPreflight ?? false, preflightCommitment: "confirmed", maxRetries: 3 });
    } catch (e: any) {
      return { sig, ms: performance.now() - t0, err: e?.message ?? String(e), ok: false, logs: e?.logs ?? null };
    }
    const deadline = t0 + (opts.timeoutMs ?? 30_000);
    let lastHeightAt = 0;
    for (let i = 0; ; i++) {
      const st = await conn.getSignatureStatuses([sig]).catch(() => null);
      const v = st?.value?.[0];
      if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized" || v.err)) return { sig, ms: performance.now() - t0, err: v.err, ok: !v.err };
      const now = performance.now();
      if (now >= deadline) {
        if (!opts.untilExpired) return { sig, ms: now - t0, err: "timeout", ok: false };
        if (now - lastHeightAt > 2_000) {
          lastHeightAt = now;
          const h = await conn.getBlockHeight("confirmed").catch(() => 0);
          if (h > lastValid) {
            const fin = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true }).catch(() => null))?.value?.[0];
            if (fin && (fin.confirmationStatus === "confirmed" || fin.confirmationStatus === "finalized" || fin.err)) return { sig, ms: performance.now() - t0, err: fin.err, ok: !fin.err };
            return { sig, ms: now - t0, err: "dropped", ok: false };
          }
        }
        if (now - t0 > 10 * 60_000) return { sig, ms: now - t0, err: "timeout", ok: false };
      }
      await sleep(i < 50 ? 60 : 500);
    }
  }
  /** Base transactions: preflight on; one with no status after `baseDropMs` (blockhash expired, so it can no
   *  longer land) is sent once more with a fresh blockhash. */
  async sendBase(ixs: TransactionInstruction[], opts: { cu?: number; label?: string; signers?: Keypair[] } = {}) {
    this.baseTxs.sent++;
    let r = await this.send(this.base, ixs, opts.signers ?? [this.house], { ...opts, skipPreflight: false, timeoutMs: this.cfg.baseDropMs, untilExpired: true });
    if (r.err === "dropped") {
      this.baseTxs.dropped++;
      log.warn("base_tx_dropped", { label: opts.label, sig: r.sig, ms: Math.round(r.ms), note: "no status, blockhash expired: sent again" });
      this.baseTxs.sent++;
      r = await this.send(this.base, ixs, opts.signers ?? [this.house], { ...opts, skipPreflight: false, timeoutMs: this.cfg.baseDropMs, untilExpired: true });
    }
    if (!r.ok) {
      // preflight refusals never land; a landed failure would show in the tx's status
      if (r.err && typeof r.err !== "string") this.baseTxs.failedOnChain++;
      else this.baseTxs.refused++;
    }
    return r;
  }
  readonly baseTxs = { sent: 0, dropped: 0, refused: 0, failedOnChain: 0 };
  async sendEr(ixs: TransactionInstruction[], opts: { cu?: number; label?: string } = {}) {
    await this.ensureHouseToken();
    return this.send(this.er, ixs, [this.house], { ...opts, skipPreflight: false });
  }

  /** unix_timestamp of the rollup's Clock sysvar (open_round checks a record's planned start against it). */
  async erUnix(): Promise<number | null> {
    await this.ensureHouseToken();
    const r = await rpc(this.erUrl(this.houseToken), "getAccountInfo", ["SysvarC1ock11111111111111111111111111111111", { encoding: "base64", commitment: "processed" }]);
    const v = r.body?.result?.value;
    return v ? Number(Buffer.from(v.data[0], "base64").readBigInt64LE(32)) : null;
  }

  // ---------------------------------------------------------------- house balance (low-balance guard)
  balanceLamports: number | null = null;
  balanceAt = 0;
  async refreshBalance() {
    const r = await rpc(this.cfg.baseRpc, "getBalance", [this.house.publicKey.toBase58(), { commitment: "confirmed" }]);
    const v = r.body?.result?.value;
    if (typeof v === "number") { this.balanceLamports = v; this.balanceAt = Date.now(); }
    return this.balanceLamports;
  }
  /** True when the house balance is known to be below the soft threshold: records are spaced out. */
  lowBalance() {
    const soft = this.cfg.softBalanceSol;
    return !!soft && this.balanceLamports !== null && this.balanceLamports < soft * 1e9;
  }
  /** False when the house balance is known to be below the guard: no new records. */
  canRecord() {
    const min = this.cfg.minBalanceSol;
    return !min || this.balanceLamports === null || this.balanceLamports >= min * 1e9;
  }

  /** Polls `reader` until `acc` is owned by the program; ms it took, or null. */
  async waitOwner(reader: Reader, acc: PublicKey, timeoutMs: number, meta = false): Promise<number | null> {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      const a = meta ? (await reader.accounts([acc], true))[0] : await reader.account(acc);
      if (a.data && a.owner === this.programId.toBase58()) return Math.round(performance.now() - t0);
      await sleep(150);
    }
    return null;
  }
}

/** Short error text of a failed send (program error name when present). */
export function errText(r: SendResult): string {
  if (r.ok) return "ok";
  const s = typeof r.err === "string" ? r.err : JSON.stringify(r.err);
  const m = s.match(/Error Code: (\w+)/) ?? (r.logs ?? []).join("\n").match(/Error Code: (\w+)/);
  return (m ? m[1] + " " : "") + s.slice(0, 160);
}
export function must(r: SendResult, label: string): SendResult {
  if (!r.ok) {
    log.warn("tx_failed", { label, err: errText(r) });
    throw new Error(`${label}: ${errText(r)}`);
  }
  return r;
}

/** Hand-encoded `act` (30 bytes): disc, kind u8, level u8, seq u32 LE, salt [16]; accounts player (s), desk (w), book (w). */
export const ACT_DISC = disc("global", "act");
export function actIx(programId: PublicKey, player: PublicKey, desk: PublicKey, book: PublicKey, kind: number, level: number, seq: number): TransactionInstruction {
  const data = Buffer.alloc(30);
  ACT_DISC.copy(data, 0);
  data[8] = kind;
  data[9] = level;
  data.writeUInt32LE(seq >>> 0, 10);
  crypto.randomFillSync(data, 14, 16);
  return new TransactionInstruction({ programId, keys: [{ pubkey: player, isSigner: true, isWritable: false }, { pubkey: desk, isSigner: false, isWritable: true }, { pubkey: book, isSigner: false, isWritable: true }], data });
}
