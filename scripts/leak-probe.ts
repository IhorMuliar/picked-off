// Hidden-information leak probes L1-L21 against a running stack (local MagicBlock stack by default,
// devnet with CLUSTER=devnet). Creates its own pool (table id >= 70), seats eight scripted players,
// drives ROUNDS rounds with scripted hidden states, probes every read path as another player, an
// outsider with a token and anonymously, and measures compute units from real transactions.
// Read-only probes also run against a house pool (HOUSE_POOL) without writing to it.
//
//   make leak-probe-local                    (after make local-stack + make local-fund)
//   CLUSTER=devnet make leak-probe-devnet
//
// Env (defaults: local stack):
//   CLUSTER       local | devnet
//   BASE_RPC      base layer HTTP            (local http://127.0.0.1:8899)
//   ER_RPC/ER_WS  private rollup, privacy-filtered endpoint (local :6699/:6700)
//   ER_RAW        unfiltered rollup endpoint, local diagnosis only ("" on devnet)
//   VALIDATOR     rollup validator identity
//   WALLET        house keypair (must equal Config.house)
//   PROGRAM_ID    program id (must match the build)
//   TABLE_ID      table id of the probe pool (>= 70; default 7_000_000 + unix % 1e6, a fresh pool)
//   ROUNDS        rounds to drive (default 3, minimum 3)
//   HOUSE_POOL    house pool table id for read-only probes ("" to skip; default 1001)
//   HOUSE_RPC_LOG house runner RPC log for L17
//   LEAK_LOG      write the full output to this file
// Prints one line per assertion: PASS / FAIL / SKIP / LOCAL-EXPECTED / INFO with its evidence.
// Exit code 1 if any assertion FAILs, 2 on a harness error.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { SystemProgram, Transaction, TransactionInstruction, Keypair, PublicKey, Connection } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { getAuthToken, MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { PROGRAM_ID, KIND, PHASE, NDESK, BN, pda, sleep, loadKeypair, rpc, readAccount, programOn, send, loadIdl, predictableTaskId, callPda, REPO, type SendResult } from "../tests/local/lib.ts";
import { Report, Sub, txShape, redacted, hist, spread, pool } from "./leak-probe-util.ts";

// ------------------------------------------------------------------ config
const CLUSTER = process.env.CLUSTER === "devnet" ? "devnet" : "local";
const DEV = CLUSTER === "devnet";
const env = (k: string, d: string) => (process.env[k] !== undefined ? process.env[k]! : d);
const CFG = {
  base: env("BASE_RPC", DEV ? "https://rpc.magicblock.app/devnet" : "http://127.0.0.1:8899"),
  er: env("ER_RPC", DEV ? "https://devnet-tee.magicblock.app" : "http://127.0.0.1:6699"),
  erWs: env("ER_WS", DEV ? "wss://devnet-tee.magicblock.app" : "ws://127.0.0.1:6700"),
  raw: env("ER_RAW", DEV ? "" : "http://127.0.0.1:7799"),
  validator: new PublicKey(env("VALIDATOR", DEV ? "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo" : "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev")),
  wallet: env("WALLET", path.join(os.homedir(), ".config/solana", DEV ? "blitz-ping-devnet.json" : "blitz-ping-localnet.json")),
  programId: env("PROGRAM_ID", PROGRAM_ID.toBase58()),
  tableId: Number(env("TABLE_ID", String(7_000_000 + (Math.floor(Date.now() / 1000) % 1_000_000)))),
  rounds: Math.max(3, Number(env("ROUNDS", "3"))),
  housePool: env("HOUSE_POOL", "1001"),
  houseRpcLog: env("HOUSE_RPC_LOG", path.join(os.homedir(), ".local/state/picked-off", `house-${CLUSTER}-rpc.jsonl`)),
  log: env("LEAK_LOG", ""),
};
// local oracle queue account (VRF is off in local configs; the account only has to exist)
const LOCAL_ER_QUEUE = new PublicKey("Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const CRANK_LINE = "Program Crank11111111111111111111111111111111111111 invoke [1]";
const ACT_MS = 250;

const R = new Report();
const IDL = loadIdl();
const disc = (name: string) => Buffer.from(IDL.instructions.find((i: any) => i.name === name).discriminator);
const ACT_DISC = disc("act"), TICK_DISC = disc("tick");
const ERRNAME: Record<number, string> = Object.fromEntries((IDL.errors ?? []).map((e: any) => [e.code, e.name]));
Object.assign(ERRNAME, { 3012: "AccountNotInitialized", 2006: "ConstraintSeeds", 3007: "AccountOwnedByWrongProgram", 3001: "AccountDiscriminatorNotFound" });

// ------------------------------------------------------------------ keys, tokens, endpoints
const house = loadKeypair(CFG.wallet);
const players = Array.from({ length: NDESK }, () => Keypair.generate()); // players[s] sits at desk s; A = 0, B = 1
const A = 0, B = 1;
const outsider = Keypair.generate(); // O: authenticated, no desk
const stranger = Keypair.generate(); // wrong-key acts, crank-id squats
const tok: Map<string, string> = new Map();
async function token(kp: Keypair): Promise<string> {
  const k = kp.publicKey.toBase58();
  if (!tok.has(k)) {
    const { token: t } = await getAuthToken(CFG.er, kp.publicKey, async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey));
    tok.set(k, t);
    R.addSecret(t);
  }
  return tok.get(k)!;
}
const erUrl = (t?: string) => (t ? `${CFG.er}?token=${t}` : CFG.er);
const wsUrl = (t?: string) => (t ? `${CFG.erWs}?token=${t}` : CFG.erWs);
const erConn = (t?: string) => new Connection(erUrl(t), { commitment: "confirmed", wsEndpoint: wsUrl(t) });
/** Where compute units and logs are read from: the raw rollup locally; on devnet the filtered endpoint after the reveal. */
const cuUrl = () => CFG.raw || CFG.er;

const T = CFG.tableId;
const table = pda.table(T), book = pda.book(T);
const desks = Array.from({ length: NDESK }, (_, s) => pda.desk(T, s));
const base = new Connection(CFG.base, "confirmed");
const progBase = programOn(base, house);
let progEr: any, erH: Connection, tH = "";

// ------------------------------------------------------------------ decoders (offsets from the frozen layout)
function decT(b: Buffer) {
  return {
    round: Number(b.readBigUInt64LE(16)), openSlot: Number(b.readBigUInt64LE(24)), hideEnd: Number(b.readBigUInt64LE(32)),
    nextDeadline: Number(b.readBigUInt64LE(40)),
    hideEndAtOpen: Number(b.readBigUInt64LE(40)), bellSlot: Number(b.readBigUInt64LE(48)), revealSlot: Number(b.readBigUInt64LE(56)),
    taskId: b.readBigInt64LE(64), tickCalls: Number(b.readBigUInt64LE(80)), resolves: Number(b.readBigUInt64LE(88)),
    beatSlots: Number(b.readBigUInt64LE(120)), chain: Buffer.from(b.subarray(248, 280)), commit: Buffer.from(b.subarray(280, 312)),
    seatKey: (s: number) => new PublicKey(b.subarray(312 + 56 * s, 344 + 56 * s)).toBase58(), seatKind: (s: number) => b[312 + 56 * s + 48],
    totals: Array.from({ length: NDESK }, (_, s) => b.readUInt16LE(776 + 2 * s)),
    sealed: b.readUInt16LE(808), beat: b.readUInt16LE(810), phase: b[1069], topDesk: b[1072], recorded: b[1073],
  };
}
type TableV = ReturnType<typeof decT>;
function decD(b: Buffer) {
  return { round: Number(b.readBigUInt64LE(16)), resultSlot: Number(b.readBigUInt64LE(32)), key: new PublicKey(b.subarray(40, 72)).toBase58(),
    lastSeq: b.readUInt32LE(72), acts: b.readUInt32LE(76), beat: b.readUInt16LE(84), index: b[86], level: b[87], phase: b[88],
    resultLevel: (k: number) => b[96 + 16 * k + 8] };
}
const TABLE_FIELDS: [string, number, number][] = [
  ["table_id", 8, 8], ["round", 16, 8], ["open_slot", 24, 8], ["hide_end_slot", 32, 8], ["next_deadline_slot", 40, 8], ["bell_slot", 48, 8],
  ["reveal_slot", 56, 8], ["task_id", 64, 8], ["task_slot", 72, 8], ["tick_calls", 80, 8], ["resolves", 88, 8], ["vrf_request_slot", 96, 8],
  ["vrf_fulfil_slot", 104, 8], ["planned_start_unix", 112, 8], ["beat_slots", 120, 8], ["hide_slots", 128, 8], ["crank_interval_ms", 136, 4],
  ["crank_iterations", 140, 4], ["tick_cu_limit", 144, 4], ["print_count", 148, 4], ["house", 152, 32], ["vrf_queue", 184, 32], ["round_key", 216, 32],
  ["chain_head", 248, 32], ["commit_hash", 280, 32], ["seats", 312, 448], ["picked", 760, 16], ["totals", 776, 16], ["beat_fill", 792, 16],
  ["sealed", 808, 2], ["beat", 810, 2], ["prints", 812, 192], ["beat_counts", 1004, 64], ["kind", 1068, 1], ["phase", 1069, 1], ["bell_min", 1070, 1],
  ["bell_max", 1071, 1], ["top_desk", 1072, 1], ["recorded", 1073, 1], ["fallback_seed", 1074, 1], ["vrf_fulfils", 1075, 1], ["bump", 1076, 1],
  ["book_bump", 1077, 1], ["layout", 1078, 1], ["_pad", 1079, 1], ["desk_bump", 1080, 8], ["_reserved", 1088, 64],
];
const fieldAt = (off: number) => TABLE_FIELDS.find(([, o, n]) => off >= o && off < o + n)?.[0] ?? `@${off}`;
// what a live beat may change in the public Table (everything else must stay put between beats)
const LIVE_WRITES = new Set(["next_deadline_slot", "tick_calls", "resolves", "print_count", "chain_head", "picked", "beat_fill", "beat", "prints", "beat_counts", "vrf_fulfil_slot", "vrf_fulfils"]);

// ------------------------------------------------------------------ small chain helpers
const ix = (m: any) => m.instruction();
const le = (n: number | bigint, w: number, signed = false) => { const b = Buffer.alloc(w); if (w === 4) b.writeUInt32LE(Number(n)); else if (signed) b.writeBigInt64LE(BigInt(n)); else b.writeBigUInt64LE(BigInt(n)); return b; };
function must(r: SendResult, label: string) { if (!r.ok) throw new Error(`${label} failed: ${JSON.stringify(r.err)} ${(r.logs ?? []).slice(-4).join(" | ")}`); return r; }
function errName(err: any): string {
  if (!err) return "ok";
  const c = err?.InstructionError?.[1]?.Custom;
  if (typeof c === "number") return ERRNAME[c] ?? `Custom(${c})`;
  return JSON.stringify(err).slice(0, 60);
}
async function slotNow(): Promise<number> { return Number((await rpc(erUrl(tH), "getSlot", [{ commitment: "confirmed" }])).body?.result ?? 0); }
async function readTable(): Promise<{ v: TableV; bytes: Buffer } | null> {
  const a = await readAccount(CFG.er, table);
  return a.data ? { v: decT(a.data), bytes: a.data } : null;
}
async function waitFor<X>(fn: () => Promise<X | null | undefined | false>, ms: number, step = 100): Promise<X | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const x = await fn(); if (x) return x as X; await sleep(step); }
  return null;
}
async function getTx(url: string, sig: string, tries = 1): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const r = await rpc(url, "getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
    if (r.body?.result || i === tries - 1) return r.body;
    await sleep(500);
  }
}
async function sigList(url: string, addr: PublicKey, limit = 1000): Promise<string[]> {
  const r = await rpc(url, "getSignaturesForAddress", [addr.toBase58(), { limit, commitment: "confirmed" }]);
  return (r.body?.result ?? []).map((x: any) => x.signature);
}
const progCu = (logs: string[]) => Number(logs.map((l) => l.match(new RegExp(`^Program ${PROGRAM_ID.toBase58()} consumed (\\d+) of`))).find(Boolean)?.[1] ?? -1);
const programLogLines = (logs: string[]) => logs.filter((l) => l.startsWith("Program log:") || l.startsWith("Program data:")).length;

// ------------------------------------------------------------------ acts
type Sent = { sig: string; round: number; desk: number; who: "player" | "stranger"; cls: string; kind: number; level: number; seq: number; phase: number;
  tSend: number; http?: number; sendErr?: string; slot?: number; err?: any; cu?: number; pcu?: number; logLines?: number; data?: Buffer; found?: boolean };
const sent: Sent[] = [];
const seqOf = Array(NDESK).fill(0);
let blockhash = "";

function actIx(signer: PublicKey, desk: PublicKey, kind: number, level: number, seq: number) {
  const data = Buffer.concat([ACT_DISC, Buffer.from([kind & 0xff, level & 0xff]), le(seq >>> 0, 4), crypto.randomBytes(16)]);
  return new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: signer, isSigner: true, isWritable: false }, { pubkey: desk, isSigner: false, isWritable: true }, { pubkey: book, isSigner: false, isWritable: true }], data });
}
function sendAct(kp: Keypair, t: string, s: Omit<Sent, "sig" | "tSend">, deskAcc: PublicKey) {
  const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash }).add(actIx(kp.publicKey, deskAcc, s.kind, s.level, s.seq));
  tx.sign(kp);
  const rec: Sent = { ...s, sig: bs58.encode(tx.signature!), tSend: Date.now() };
  sent.push(rec);
  void fetch(erUrl(t), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [tx.serialize().toString("base64"), { encoding: "base64", skipPreflight: true, maxRetries: 0 }] }) })
    .then(async (r) => { rec.http = r.status; const j: any = await r.json().catch(() => null); if (!r.ok || j?.error) rec.sendErr = JSON.stringify(j?.error ?? r.status).slice(0, 80); })
    .catch((e) => { rec.sendErr = String(e?.message ?? e).slice(0, 80); });
  return rec;
}
const rnd = (n: number) => crypto.randomInt(n);
/** Scripted hidden states: round 1 crowds every desk on one level, round 2 spreads them, round 3 places nothing and fuzzes. */
function content(n: number, s: number, phase: number, k: number): { kind: number; level: number; cls: string; stale?: boolean } {
  const r = (n - 1) % 3;
  if (r === 0) {
    if (phase === PHASE.hide) return { kind: 2, level: 7, cls: "hide-place" };
    return [{ kind: 1, level: 7, cls: "ping" }, { kind: 2, level: 7, cls: "requote" }, { kind: 0, level: 0, cls: "noop" }][k % 3];
  }
  if (r === 1) {
    if (phase === PHASE.hide) return { kind: 2, level: 1 + 3 * s, cls: "hide-place" };
    if (s === A) return k % 2 ? { kind: 1, level: 1 + rnd(24), cls: "ping" } : { kind: 0, level: 0, cls: "noop" }; // A stays on level 1
    const kind = rnd(3);
    return { kind, level: kind ? 1 + rnd(24) : 0, cls: ["noop", "ping", "requote"][kind] };
  }
  if (k % 5 === 4) return { kind: rnd(3), level: rnd(26), cls: "stale-seq", stale: true };
  if (phase === PHASE.hide) { const kind = [0, 1, 3 + rnd(253)][rnd(3)]; return { kind, level: rnd(256), cls: "fuzz-hide" }; }
  return { kind: rnd(256), level: rnd(256), cls: "fuzz" };
}

// ------------------------------------------------------------------ round state shared by the loops
type Snap = { t: number; slot: number; v: TableV; bytes: Buffer };
type RoundRun = {
  n: number; openSig: string; open: TableV; snaps: Snap[]; latest: TableV | null; deskSeen: Set<number>[]; deskLatest: (ReturnType<typeof decD> | null)[];
  stop: boolean; squat: bigint[]; squatOk: boolean[]; final?: TableV; joinSig?: string; ticks?: any[]; lagMax: number;
};

async function monitor(rr: RoundRun) {
  while (!rr.stop) {
    const t = await readTable().catch(() => null);
    if (t && t.v.round === rr.n) {
      const last = rr.snaps[rr.snaps.length - 1];
      if (!last || last.v.beat !== t.v.beat || last.v.phase !== t.v.phase) rr.snaps.push({ t: Date.now(), slot: 0, v: t.v, bytes: t.bytes });
      rr.latest = t.v;
    }
    await sleep(100);
  }
}
async function deskWatch(rr: RoundRun) {
  while (!rr.stop) {
    await Promise.all(players.map(async (kp, s) => {
      const a = await readAccount(erUrl(await token(kp)), desks[s]).catch(() => null);
      if (a?.data) { const d = decD(a.data); if (d.round === rr.n && d.key === kp.publicKey.toBase58()) { rr.deskLatest[s] = d; rr.deskSeen[s].add(d.beat); } }
    }));
    await sleep(250);
  }
}
function gate(rr: RoundRun, s: number): boolean {
  const t = rr.latest, d = rr.deskLatest[s];
  if (!t || !d || t.round !== rr.n || (t.phase !== PHASE.hide && t.phase !== PHASE.live)) return false;
  if (t.seatKey(s) !== players[s].publicKey.toBase58()) return false;
  return ((t.sealed >> s) & 1) === 1 && ((t.sealed >> 8) & 1) === 1;
}
async function playerLoop(rr: RoundRun, s: number) {
  const kp = players[s], t = await token(kp);
  const t0 = performance.now();
  let k = 0;
  while (!rr.stop) {
    const target = t0 + k * ACT_MS;
    const wait = target - performance.now();
    if (wait > 0) await sleep(wait); else rr.lagMax = Math.max(rr.lagMax, -wait);
    k++;
    if (!gate(rr, s) || !blockhash) continue;
    const ph = rr.latest!.phase;
    const c = content(rr.n, s, ph, k);
    const seq = c.stale ? Math.max(1, seqOf[s] - 3) : ++seqOf[s];
    sendAct(kp, t, { round: rr.n, desk: s, who: "player", cls: c.cls, kind: c.kind, level: c.level, seq, phase: ph }, desks[s]);
  }
}
async function strangerLoop(rr: RoundRun) {
  const t = await token(stranger);
  while (!rr.stop) {
    await sleep(500);
    const ph = rr.latest?.phase;
    if (rr.latest?.round !== rr.n || (ph !== PHASE.hide && ph !== PHASE.live) || !blockhash) continue;
    const s = rnd(NDESK);
    sendAct(stranger, t, { round: rr.n, desk: s, who: "stranger", cls: "wrong-key", kind: rnd(3), level: 1 + rnd(24), seq: 4_000_000_000, phase: ph }, desks[s]);
  }
}
async function blockhashLoop(stop: () => boolean) {
  while (!stop()) {
    const r = await rpc(erUrl(tH), "getLatestBlockhash", [{ commitment: "confirmed" }]);
    if (r.body?.result?.value?.blockhash) blockhash = r.body.result.value.blockhash;
    await sleep(1000);
  }
}

// ------------------------------------------------------------------ pool setup (own pool)
async function setupPool() {
  if (!(T >= 70)) throw new Error(`TABLE_ID ${T}: the probe pool needs a table id >= 70`);
  if (CFG.programId !== PROGRAM_ID.toBase58()) throw new Error(`PROGRAM_ID ${CFG.programId} does not match the build ${PROGRAM_ID.toBase58()}`);
  const cfg = await readAccount(CFG.base, pda.config());
  if (!cfg.data) throw new Error("no Config on the base layer");
  const cfgHouse = new PublicKey(cfg.data.subarray(96, 128)).toBase58();
  if (cfgHouse !== house.publicKey.toBase58()) throw new Error(`WALLET ${house.publicKey.toBase58()} is not Config.house ${cfgHouse}`);
  const vrfQueue = new PublicKey(cfg.data.subarray(160, 192));
  const existing = await readAccount(CFG.base, table);
  if (existing.data) throw new Error(`table ${T} already exists; pick a fresh TABLE_ID`);
  R.log(`setup  pool ${T}  table ${table.toBase58()}  program ${PROGRAM_ID.toBase58()}  cluster ${CLUSTER}`);
  must(await send(base, [await ix(progBase.methods.createPool(new BN(T), 0, new BN(50_000_000)).accountsPartial({ house: house.publicKey, config: pda.config(), table, book, ledger: pda.ledger(T) }))], [house]), "create_pool");
  for (let s = 0; s < NDESK; s += 4) {
    const ixs = [];
    for (let j = s; j < s + 4; j++) ixs.push(await ix(progBase.methods.createDesk(new BN(T), j).accountsPartial({ house: house.publicKey, config: pda.config(), table, desk: desks[j] })));
    must(await send(base, ixs, [house]), `create_desk ${s}`);
  }
  const targets: [number, number, PublicKey][] = [[KIND.table, 0, table], [KIND.book, 0, book], ...desks.map((d, s) => [KIND.desk, s, d] as [number, number, PublicKey])];
  await Promise.all(targets.map(async ([kind, idx, acc]) => {
    must(await send(base, [await ix(progBase.methods.delegate(kind, new BN(T), new BN(idx)).accountsPartial({ house: house.publicKey, config: pda.config(), pda: acc, validator: CFG.validator }))], [house]), `delegate ${kind}/${idx}`);
  }));
  for (const [, , acc] of targets) if (!(await waitFor(async () => { const a = await readAccount(erUrl(tH), acc); return a.data && a.owner === PROGRAM_ID.toBase58(); }, 20_000))) throw new Error(`${acc.toBase58()} not visible on the rollup`);
  const permIx = async (kind: number, idx: number, target: PublicKey | null) =>
    ix(progEr.methods.setupPermissions(kind, new BN(idx)).accountsPartial({ house: house.publicKey, table, target, permission: pda.perm(target ?? table) }));
  const items: [number, number, PublicKey | null][] = [[KIND.table, 0, null], [KIND.book, 0, book], ...desks.map((d, s) => [KIND.desk, s, d] as [number, number, PublicKey])];
  for (let i = 0; i < items.length; i += 3) must(await send(erH, await Promise.all(items.slice(i, i + 3).map(([k, s, t]) => permIx(k, s, t))), [house], { cu: 1_000_000 }), `setup_permissions ${i}`);
  // seats 1..7: scripted players seated by the house; seat 0 stays empty until A joins in round 1
  for (let s = 1; s < NDESK; s += 4) {
    const ixs = [];
    for (let j = s; j < Math.min(NDESK, s + 4); j++) {
      const name = Buffer.alloc(16); name.write(`PROBE-${j}`);
      ixs.push(await ix(progEr.methods.joinBot(j, players[j].publicKey, 2, Array.from(name)).accountsPartial({ house: house.publicKey, table, desk: desks[j], permission: pda.perm(desks[j]) })));
    }
    must(await send(erH, ixs, [house], { cu: 1_000_000 }), `join_bot ${s}`);
  }
  return { vrfQueue: vrfQueue.equals(PublicKey.default) ? LOCAL_ER_QUEUE : vrfQueue };
}
async function reseal() {
  const permIx = async (kind: number, idx: number, target: PublicKey) =>
    ix(progEr.methods.setupPermissions(kind, new BN(idx)).accountsPartial({ house: house.publicKey, table, target, permission: pda.perm(target) }));
  const items: [number, number, PublicKey][] = [[KIND.book, 0, book], ...desks.map((d, s) => [KIND.desk, s, d] as [number, number, PublicKey])];
  for (let i = 0; i < items.length; i += 3) must(await send(erH, await Promise.all(items.slice(i, i + 3).map(([k, s, t]) => permIx(k, s, t))), [house], { cu: 1_000_000 }), `re-seal ${i}`);
}
async function unseal() {
  const items: [number, number, PublicKey][] = [[KIND.book, 0, book], ...desks.map((d, s) => [KIND.desk, s, d] as [number, number, PublicKey])];
  for (let i = 0; i < items.length; i += 3)
    must(await send(erH, await Promise.all(items.slice(i, i + 3).map(([k, s, t]) => ix(progEr.methods.unseal(k, new BN(s)).accountsPartial({ house: house.publicKey, table, target: t, permission: pda.perm(t) })))), [house], { cu: 1_000_000 }), `unseal ${i}`);
}
function joinIx(kp: Keypair, seat: number) {
  const name = Buffer.alloc(16); name.write("PROBE-A");
  const deskAcc = seat < NDESK ? desks[seat] : pda.desk(T, seat);
  return ix(programOn(erH, kp).methods.join(seat, Array.from(name)).accountsPartial({ player: kp.publicKey, table, desk: deskAcc, permission: pda.perm(deskAcc) }));
}
/** Squat: schedule a crank task for `id` from the stranger, as anyone could before open_round. */
function squatIx(id: bigint) {
  const memo = new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from("squat") });
  const enc = Buffer.concat([memo.programId.toBuffer(), le(memo.keys.length, 8), le(memo.data.length, 8), memo.data]);
  return new TransactionInstruction({ programId: MAGIC_PROGRAM_ID, keys: [{ pubkey: stranger.publicKey, isSigner: true, isWritable: true }],
    data: Buffer.concat([le(6, 4), le(id, 8, true), le(1000, 8, true), le(60, 8, true), le(1, 8), enc]) });
}

// ------------------------------------------------------------------ mid-round probes
const ROLES = () => ({ anon: undefined as string | undefined, O: tok.get(outsider.publicKey.toBase58())!, B: tok.get(players[B].publicKey.toBase58())!, A: tok.get(players[A].publicKey.toBase58())! });

async function probeL1(rr: RoundRun) {
  const r = ROLES();
  const res: Record<string, string[]> = { anonData: [], OData: [], BData: [] };
  const read = async (t: string | undefined, acc: PublicKey) => !!(await readAccount(erUrl(t), acc)).data;
  for (const [who, t, skip] of [["anon", r.anon, -1], ["O", r.O, -1], ["B", r.B, B]] as const) {
    if (await read(t, book)) res[`${who}Data`].push("book");
    for (let s = 0; s < NDESK; s++) if (s !== skip && (await read(t, desks[s]))) res[`${who}Data`].push(`desk${s}`);
  }
  const aOwn = await read(r.A, desks[A]), aBook = await read(r.A, book);
  const tableId = bs58.encode(le(T, 8));
  const gpa = async (t: string | undefined, size: number): Promise<number | string> => {
    const r = await rpc(erUrl(t), "getProgramAccounts", [PROGRAM_ID.toBase58(), { encoding: "base64", filters: [{ dataSize: size }, { memcmp: { offset: 8, bytes: tableId } }] }]);
    return Array.isArray(r.body?.result) ? r.body.result.length : `refused: ${JSON.stringify(r.body?.error ?? r.http).slice(0, 60)}`;
  };
  const none = (x: number | string) => x === 0 || typeof x === "string";
  const g = { anonDesks: await gpa(r.anon, 608), anonBook: await gpa(r.anon, 1256), ODesks: await gpa(r.O, 608), OBook: await gpa(r.O, 1256), BDesks: await gpa(r.B, 608) };
  const ok = !res.anonData.length && !res.OData.length && !res.BData.length && aOwn && !aBook && none(g.anonDesks) && none(g.anonBook) && none(g.ODesks) && none(g.OBook) && (typeof g.BDesks === "string" || g.BDesks <= 1);
  R.check("L1", ok, `round ${rr.n} beat ${rr.latest?.beat}: Book + other Desks as B, O (token) and anon; getProgramAccounts`, { nonNullForB: res.BData, nonNullForO: res.OData, nonNullForAnon: res.anonData, AownDesk: aOwn, ABook: aBook, gpa: g });
}
async function probeHousePool() {
  if (!CFG.housePool) return R.add("L1.house", "SKIP", "house pool read-only probe", "HOUSE_POOL empty");
  const hT = Number(CFG.housePool);
  const t = await readAccount(CFG.er, pda.table(hT));
  if (!t.data) return R.add("L1.house", "SKIP", `house pool ${hT}`, "Table not found on the rollup");
  const v = decT(t.data);
  if (v.phase < PHASE.hide || v.phase > PHASE.bell) return R.add("L1.house", "SKIP", `house pool ${hT}`, `phase ${v.phase}: not in play right now`);
  const r = ROLES();
  const hits: string[] = [];
  for (const [who, tk] of [["anon", r.anon], ["O", r.O]] as const) {
    if ((await readAccount(erUrl(tk), pda.book(hT))).data) hits.push(`${who}:book`);
    for (let s = 0; s < NDESK; s++) if ((await readAccount(erUrl(tk), pda.desk(hT, s))).data) hits.push(`${who}:desk${s}`);
  }
  const after = decT((await readAccount(CFG.er, pda.table(hT))).data!);
  const stillPlaying = after.round === v.round && after.phase >= PHASE.hide && after.phase <= PHASE.bell;
  R.add("L1.house", hits.length === 0 ? "PASS" : stillPlaying ? "FAIL" : "SKIP", `house pool ${hT} round ${v.round} (phase ${v.phase}, read-only): Book + 8 Desks as anon and O`, { nonNull: hits, roundStillInPlay: stillPlaying });
}
function pickA(rr: RoundRun, ageMs = 1500) {
  const now = Date.now(), out: Record<string, string> = {};
  for (const x of sent) if (x.round === rr.n && x.desk === A && x.who === "player" && now - x.tSend > ageMs) out[x.cls] = x.sig;
  return out;
}
async function shapes(sig: string) {
  const r = ROLES();
  const out: Record<string, ReturnType<typeof txShape>> = {};
  for (const [who, t] of [["anon", r.anon], ["A", r.A], ["B", r.B], ["O", r.O]] as const) out[who] = txShape(await getTx(erUrl(t), sig));
  return out;
}
async function probeL3(rr: RoundRun) {
  const sigs = pickA(rr);
  const views: Record<string, any> = {};
  let ok = Object.keys(sigs).length > 0;
  for (const [cls, sig] of Object.entries(sigs)) {
    const sh = await shapes(sig);
    const allRedacted = Object.values(sh).every(redacted);
    ok &&= allRedacted;
    views[cls] = Object.fromEntries(Object.entries(sh).map(([w, s]) => [w, `${s.kind} k${s.keys} i${s.ixs} l${s.logs}`]));
  }
  R.check("L3", ok, `round ${rr.n}: getTransaction of A's acts (${Object.keys(sigs).join(", ")}) as anon, A, B, O`, views);
}
async function probeL4(rr: RoundRun, obs: Obs) {
  const items: Record<string, string> = { open_round: rr.openSig };
  if (rr.joinSig) items.join = rr.joinSig;
  if (CFG.raw) {
    for (const s of await sigList(CFG.raw, table, 40)) {
      const t = await getTx(CFG.raw, s);
      if ((t?.result?.meta?.logMessages ?? []).includes(CRANK_LINE)) { items.tick = s; break; }
    }
  } else {
    const n = obs.all.flatMap((x) => x.notes).find((x) => (x.v?.value?.logs ?? []).includes(CRANK_LINE) && (x.v?.value?.logs ?? []).some((l: string) => l.includes(PROGRAM_ID.toBase58())));
    if (n) items.tick = n.v.value.signature;
  }
  const views: Record<string, any> = {};
  let ok = true;
  for (const [what, sig] of Object.entries(items)) {
    const sh = await shapes(sig);
    ok &&= Object.values(sh).every(redacted);
    views[what] = Object.fromEntries(Object.entries(sh).map(([w, s]) => [w, `${s.kind} k${s.keys} i${s.ixs} l${s.logs}`]));
  }
  R.add("L4", !ok ? "FAIL" : items.tick ? "PASS" : DEV ? "SKIP" : "FAIL", `round ${rr.n}: getTransaction of tick, open_round${rr.joinSig ? ", join" : ""} during the round as anon, A, B, O`, { ...views, tickSigSource: CFG.raw ? "raw rollup list" : items.tick ? "log stream sample" : "no tick in the log stream sample yet" });
  R.add("L4.vrf", "SKIP", "VRF fulfil redacted", DEV ? "fulfil signature only visible through the log stream; read from the house's own list" : "local stack: VRF off (fallback seed), no fulfil tx");
}
async function probeL5list(rr: RoundRun) {
  const r = ROLES();
  const aSigs = new Set(sent.filter((x) => x.round === rr.n && x.desk === A && x.who === "player").map((x) => x.sig));
  const res: Record<string, number> = {};
  for (const [who, t] of [["anon", r.anon], ["B", r.B]] as const)
    for (const [name, acc] of [["program", PROGRAM_ID], ["Aburner", players[A].publicKey], ["deskA", desks[A]], ["table", table], ["book", book]] as const)
      res[`${who}:${name}`] = (await sigList(erUrl(t), acc)).filter((s) => aSigs.has(s)).length;
  const own = (await sigList(erUrl(r.A), desks[A])).filter((s) => aSigs.has(s)).length;
  const listed = Object.values(res).reduce((a, b) => a + b, 0);
  R.add("L5", listed === 0 ? "PASS" : DEV ? "FAIL" : "LOCAL-EXPECTED", `round ${rr.n} mid-round: A's acts (${aSigs.size} sent) in signature lists of others${DEV ? "" : " (the local stack lists every tx; devnet-tee lists none)"}`, { listedToOthers: res, listedToA: own });
}
async function probeL6() {
  const r = ROLES();
  const slot = (await slotNow()) - 3;
  const out: Record<string, string> = {};
  let ok = true;
  for (const [who, t] of [["anon", r.anon], ["O", r.O], ["A", r.A]] as const) {
    const b = await rpc(erUrl(t), "getBlock", [slot, { maxSupportedTransactionVersion: 0, transactionDetails: "full" }]);
    const txs = b.body?.result?.transactions;
    ok &&= !txs || txs.length === 0;
    out[who] = `HTTP ${b.http} ${txs ? `${txs.length} txs` : JSON.stringify(b.body?.error ?? b.body?.raw ?? b.body).slice(0, 60)}`;
  }
  R.check("L6", ok, `getBlock(${slot}) on the rollup`, out);
}
async function probeL7(rr: RoundRun) {
  const kp = players[B], t = await token(kp);
  const aLevel = 1; // round 2: A placed on level 1 and only pings
  const kinds = [0, 1, 2, 3, 255], levels = [...Array.from({ length: 26 }, (_, i) => i), 255];
  const cases = kinds.flatMap((k) => levels.map((l) => [k, l]));
  const shapesSeen: Record<string, number> = {};
  let postState = 0, nAt = 0;
  await pool(cases, 6, async ([k, l]) => {
    const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash }).add(actIx(kp.publicKey, desks[B], k, l, seqOf[B] + 1000));
    tx.sign(kp);
    const r = await rpc(erUrl(t), "simulateTransaction", [tx.serialize().toString("base64"), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed",
      accounts: { encoding: "base64", addresses: [book.toBase58(), desks[A].toBase58()] } }]);
    const v = r.body?.result?.value;
    const accs = v?.accounts ?? null;
    if (accs && accs.some((a: any) => a)) postState++;
    if (l === aLevel) nAt++;
    const key = JSON.stringify({ err: v?.err ?? null, logs: v?.logs ?? null, cu: v?.unitsConsumed ?? null, ret: v?.returnData ?? null, rpcErr: r.body?.error?.code ?? null });
    shapesSeen[key] = (shapesSeen[key] ?? 0) + 1;
  });
  const distinct = Object.keys(shapesSeen);
  R.check("L7", distinct.length === 1 && postState === 0, `round ${rr.n}: B simulates act for ${cases.length} kind x level cases (${nAt} on A's level ${aLevel})`, { distinctResults: distinct.length, results: shapesSeen, postStateReturned: postState });
}
async function joinTry(kp: Keypair, seat: number): Promise<string> {
  const t = await token(kp);
  const r = await send(erConn(t), [await joinIx(kp, seat)], [kp], { timeoutMs: 8000 });
  return r.ok ? "ok" : errName(r.err);
}
const l12: Record<number, Record<string, string>> = {};
async function probeL12live(rr: RoundRun) {
  l12[rr.n] = {
    seat8: await joinTry(Keypair.generate(), 8),
    humanSeat0: await joinTry(Keypair.generate(), A),
    BalreadySeated: await joinTry(players[B], 2),
  };
}
async function probeL12bell(rr: RoundRun) { l12[rr.n].bellPhase = await joinTry(Keypair.generate(), 3); }

// ------------------------------------------------------------------ websocket observers (one set per round)
function observers(rr: RoundRun) {
  const r = ROLES();
  const acct = (label: string, t: string | undefined, acc: PublicKey) => new Sub(label, wsUrl(t), "accountSubscribe", [acc.toBase58(), { encoding: "base64", commitment: "confirmed" }]);
  const logs = (label: string, t: string | undefined, filter: unknown) => new Sub(label, wsUrl(t), "logsSubscribe", [filter, { commitment: "confirmed" }]);
  return {
    own: acct("B:deskB", r.B, desks[B]),
    nonMember: [acct("anon:deskA", r.anon, desks[A]), acct("anon:book", r.anon, book), acct("O:deskA", r.O, desks[A]), acct("O:book", r.O, book), acct("B:deskA", r.B, desks[A]), acct("B:book", r.B, book)],
    logs: [logs("anon:program", r.anon, { mentions: [PROGRAM_ID.toBase58()] }), logs("anon:table", r.anon, { mentions: [table.toBase58()] }), logs("anon:book", r.anon, { mentions: [book.toBase58()] }),
      logs("O:program", r.O, { mentions: [PROGRAM_ID.toBase58()] }), logs("O:book", r.O, { mentions: [book.toBase58()] })],
    all: [logs("anon:all", r.anon, "all"), logs("O:all", r.O, "all")],
  };
}
type Obs = ReturnType<typeof observers>;
function closeObs(o: Obs) { for (const s of [o.own, ...o.nonMember, ...o.logs, ...o.all]) s.close(); }

function judgeObservers(rr: RoundRun, o: Obs, tOpen: number, tBell: number) {
  const within = (s: Sub) => s.notes.filter((x) => x.t >= tOpen && x.t <= tBell);
  // L2: own Desk delivered every beat; B reads its own Desk
  const beats = new Set<number>(o.own.notes.map((x) => { try { return Buffer.from(x.v.value.data[0], "base64").readUInt16LE(84); } catch { return -1; } }));
  const bell = rr.final?.beat ?? 0;
  const firstSeen = Math.min(...[...beats].filter((b) => b >= 0));
  const missing: number[] = [];
  for (let b = Math.max(1, firstSeen); b <= bell; b++) if (!beats.has(b)) missing.push(b);
  R.check("L2", o.own.subscribed && beats.size > 0 && missing.length === 0 && rr.deskSeen[B].size > 0,
    `round ${rr.n}: B's own Desk by read and accountSubscribe(token)`, { notifications: o.own.notes.length, beatsDelivered: beats.size, firstBeat: firstSeen, bell, missingBeats: missing, error: o.own.error });
  const nm = Object.fromEntries(o.nonMember.map((s) => [s.label, { ...s.summary(), inRound: within(s).length }]));
  R.check("L2.nonmember", o.nonMember.every((s) => within(s).length === 0), `round ${rr.n}: accountSubscribe(Desk A / Book) as anon, O, B between open and bell`, nm);
  // log streams: private acts or ticks delivered to non-members between open and bell
  const actSigs = new Set(sent.filter((x) => x.round === rr.n).map((x) => x.sig));
  const classify = (s: Sub) => {
    const xs = within(s);
    const acts = xs.filter((x) => actSigs.has(x.v?.value?.signature)).length;
    const ticks = xs.filter((x) => (x.v?.value?.logs ?? []).includes(CRANK_LINE) && (x.v?.value?.logs ?? []).some((l: string) => l.includes(PROGRAM_ID.toBase58()))).length;
    return { ...s.summary(), acts, ticks };
  };
  const lv = Object.fromEntries(o.logs.map((s) => [s.label, classify(s)]));
  const anySub = o.logs.some((s) => s.subscribed);
  const leaked = Object.values(lv).reduce((a: number, v: any) => a + v.acts + v.ticks, 0);
  if (!anySub && !DEV) R.add("L5.logs", "LOCAL-EXPECTED", `round ${rr.n}: logsSubscribe(program / Table / Book) as anon and O (the local stack refuses logsSubscribe; devnet: delivers nothing private)`, lv);
  else R.check("L5.logs", leaked === 0, `round ${rr.n}: logsSubscribe(program / Table / Book) as anon and O, private acts/ticks delivered between open and bell`, lv);
  const av = Object.fromEntries(o.all.map((s) => [s.label, classify(s)]));
  const allSub = o.all.some((s) => s.subscribed);
  const sampled = Object.values(av).reduce((a: number, v: any) => a + v.acts + v.ticks, 0);
  if (!allSub && !DEV) R.add("L19.live", "LOCAL-EXPECTED", `round ${rr.n}: logsSubscribe("all") live sample (refused by the local stack; on devnet-tee it samples acts and ticks with logs and CU)`, av);
  else R.add("L19.live", "INFO", `round ${rr.n}: logsSubscribe("all") sample of private txs (expected on devnet-tee; harmless only because act/tick log nothing and burn constant CU, see L19)`, { ...av, sampled });
  return { allNotes: o.all.flatMap((s) => within(s)) };
}

// ------------------------------------------------------------------ after the bell
async function collectCu(rr: RoundRun) {
  const mine = sent.filter((x) => x.round === rr.n && !x.found);
  await pool(mine, 24, async (x) => {
    const b = await getTx(cuUrl(), x.sig, 3);
    const r = b?.result;
    if (!r) return;
    x.found = true;
    x.slot = r.slot;
    x.err = r.meta?.err ?? null;
    x.cu = r.meta?.computeUnitsConsumed ?? -1;
    const logs: string[] = r.meta?.logMessages ?? [];
    x.pcu = progCu(logs);
    x.logLines = programLogLines(logs);
    const msg = r.transaction?.message;
    const pi = (msg?.accountKeys ?? []).indexOf(PROGRAM_ID.toBase58());
    const ins = (msg?.instructions ?? []).find((i: any) => i.programIdIndex === pi);
    if (ins) x.data = Buffer.from(bs58.decode(ins.data));
  });
  // ticks of this round: the Table's signature list between open and reveal
  const lo = rr.open.openSlot, hi = rr.final!.revealSlot || Number.MAX_SAFE_INTEGER;
  const sigs: string[] = [];
  let before: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await rpc(cuUrl(), "getSignaturesForAddress", [table.toBase58(), { limit: 1000, before, commitment: "confirmed" }]);
    const xs: any[] = r.body?.result ?? [];
    if (!xs.length) break;
    for (const x of xs) if (x.slot >= lo && x.slot <= hi) sigs.push(x.signature);
    before = xs[xs.length - 1].signature;
    if (xs[xs.length - 1].slot < lo) break;
  }
  const ticks: any[] = [];
  await pool(sigs, 24, async (s) => {
    const b = await getTx(cuUrl(), s, 3);
    const r = b?.result;
    const logs: string[] = r?.meta?.logMessages ?? [];
    const msg = r?.transaction?.message;
    const keys: string[] = msg?.accountKeys ?? [];
    const viaCrank = logs.includes(CRANK_LINE);
    const direct = (msg?.instructions ?? []).some((i: any) => keys[i.programIdIndex] === PROGRAM_ID.toBase58() && Buffer.from(bs58.decode(i.data)).subarray(0, 8).equals(TICK_DISC));
    if (!viaCrank && !direct) return;
    if (viaCrank && !logs.some((l) => l.startsWith(`Program ${PROGRAM_ID.toBase58()} invoke`))) return; // another task's crank
    ticks.push({ sig: s, slot: r.slot, err: r.meta?.err ?? null, pcu: progCu(logs), logLines: programLogLines(logs), viaCrank });
  });
  ticks.sort((a, b) => a.slot - b.slot);
  rr.ticks = ticks;
}
const roundData: { n: number; record?: Buffer; seed?: Buffer; ok: boolean }[] = [];
async function probeL14(rr: RoundRun) {
  const anonBook = await readAccount(CFG.er, book);
  const anonDesks = await Promise.all(desks.map((d) => readAccount(CFG.er, d)));
  const round = await readAccount(CFG.er, pda.round(T, rr.n));
  const corePath = new URL("../app/src/core/index.ts", import.meta.url).href;
  const core: any = await import(corePath);
  const ev: any = { bookPublic: !!anonBook.data, desksPublic: anonDesks.filter((a) => a.data).length };
  let ok = !!anonBook.data && ev.desksPublic === NDESK && !!round.data;
  if (round.data) {
    const rec = Buffer.from(round.data.subarray(160, 160 + 522)), commit = round.data.subarray(96, 128);
    const totals = Array.from({ length: NDESK }, (_, s) => round.data!.readUInt16LE(128 + 2 * s));
    const v = core.verify(new Uint8Array(rec), new Uint8Array(commit));
    // per-beat chain heads: replay and compare with the Table's chain_head seen live after each beat
    const heads = new Map<number, string>();
    core.replay(core.readRecord(new Uint8Array(rec)), {}, (st: any) => heads.set(st.beat, Buffer.from(st.chain).toString("hex")));
    let match = 0, mismatch = 0;
    for (const s of rr.snaps) if (s.v.beat >= 1 && heads.has(s.v.beat)) (heads.get(s.v.beat) === s.v.chain.toString("hex") ? match++ : mismatch++);
    const flipped = Buffer.from(rec); flipped[58 + 5] ^= 0x01;
    const vf = core.verify(new Uint8Array(flipped), new Uint8Array(commit));
    ev.verify = v.ok ? "ok" : v.error; ev.totalsMatch = v.ok && JSON.stringify(v.verdict.totals) === JSON.stringify(totals);
    ev.commitEqTable = Buffer.from(commit).equals(rr.final!.commit); ev.chainHeadsMatched = match; ev.chainHeadsMismatched = mismatch; ev.flippedByte = vf.ok ? "ACCEPTED" : vf.error.kind;
    ev.bell = rr.final!.beat; ev.status = round.data[144];
    ok &&= v.ok && ev.totalsMatch && ev.commitEqTable && mismatch === 0 && match >= rr.final!.beat - 2 && !vf.ok;
    roundData.push({ n: rr.n, record: rec, seed: Buffer.from(rec.subarray(16, 48)), ok });
  }
  // L10 evidence: every Desk holds a result for every beat 0..bell, sizes constant
  const bell = rr.final!.beat;
  const holes: string[] = [];
  anonDesks.forEach((a, s) => { if (!a.data || a.data.length !== 608) { holes.push(`d${s}:size`); return; } const d = decD(a.data); for (let b = 0; b <= bell; b++) if (!d.resultLevel(b)) holes.push(`d${s}b${b}`); if (d.beat !== bell) holes.push(`d${s}:beat${d.beat}`); });
  (rr as any).deskResultsOk = holes.length === 0 && anonBook.data?.length === 1256;
  (rr as any).deskResults = { round: rr.n, holes: holes.slice(0, 6), bookSize: anonBook.data?.length };
  R.check("L14", ok, `round ${rr.n} after the reveal: Book/Desks public to anon; the record replays to the commit, totals and every per-beat chain head; one flipped log byte fails`, ev);
}
const l20: Record<number, { sigs: Record<string, string>; before: any }> = {};
async function probeL20after(rr: RoundRun) {
  const sigs = pickA(rr, 0);
  const view: Record<string, string> = {};
  let full = 0;
  for (const [cls, s] of Object.entries(sigs)) { const sh = txShape(await getTx(CFG.er, s, 3)); view[cls] = `${sh.kind} k${sh.keys} i${sh.ixs}`; if (sh.kind === "full") full++; }
  const aSigs = new Set(sent.filter((x) => x.round === rr.n && x.desk === A && x.who === "player").map((x) => x.sig));
  const listed = (await sigList(CFG.er, desks[A])).filter((s) => aSigs.has(s)).length;
  l20[rr.n] = { sigs, before: { view, full, listed } };
  R.check("L20.reveal", full === Object.keys(sigs).length && full > 0, `round ${rr.n} after the bell: anon reads A's acts (public replay, by design)`, { view, deskAListedToAnon: listed });
}
async function probeL20resealed(n: number) {
  const rec = l20[n];
  if (!rec) return R.add("L20", "FAIL", `round ${n}`, "no post-reveal record");
  const r = ROLES();
  const view: Record<string, string> = {};
  let allRedacted = true;
  for (const [cls, s] of Object.entries(rec.sigs)) {
    for (const [who, t] of [["anon", r.anon], ["B", r.B]] as const) {
      const sh = txShape(await getTx(erUrl(t), s));
      view[`${cls}/${who}`] = `${sh.kind} k${sh.keys} i${sh.ixs}`;
      allRedacted &&= redacted(sh);
    }
  }
  const aSigs = new Set(sent.filter((x) => x.round === n && x.desk === A && x.who === "player").map((x) => x.sig));
  const listedDesk = (await sigList(CFG.er, desks[A])).filter((s) => aSigs.has(s)).length;
  const listedBurner = (await sigList(CFG.er, players[A].publicKey)).filter((s) => aSigs.has(s)).length;
  const listedAnon = listedDesk + listedBurner;
  R.check("L20", allRedacted, `round ${n} after the re-seal for round ${n + 1}: getTransaction of its acts as anon and B redacted again`, view);
  R.add("L20.list", listedAnon === 0 ? "PASS" : DEV ? "FAIL" : "LOCAL-EXPECTED", `round ${n} after the re-seal: A's acts in the signature lists of Desk A and A's burner, as anon${DEV ? "" : " (the local stack lists every tx)"}`, { deskA: listedDesk, burner: listedBurner, of: aSigs.size });
}

// ------------------------------------------------------------------ one round
async function runRound(n: number, vrfQueue: PublicKey, bettors: Keypair[]): Promise<RoundRun> {
  R.log(`round ${n}: ${["crowd (every desk on level 7, pings 7)", "spread (desk s on level 3s+1; A stays on level 1)", "silent + fuzz (no placement, random kinds/levels, stale seqs)"][(n - 1) % 3]}`);
  const roundAcc = pda.round(T, n), tape = pda.tape(T, n);
  const planned = Math.floor(Date.now() / 1000) - 2;
  must(await send(base, [
    await ix(progBase.methods.createRecord(new BN(T), new BN(n), new BN(planned)).accountsPartial({ house: house.publicKey, config: pda.config(), ledger: pda.ledger(T), round: roundAcc, tape })),
    await ix(progBase.methods.delegate(KIND.round, new BN(T), new BN(n)).accountsPartial({ house: house.publicKey, config: pda.config(), pda: roundAcc, validator: CFG.validator })),
  ], [house]), `create_record ${n}`);
  if (n === 1) {
    const call = (kp: Keypair) => ix(programOn(base, kp).methods.placeCall(3).accountsPartial({ bettor: kp.publicKey, config: pda.config(), tape, call: callPda(tape, kp.publicKey) }));
    const c1 = await send(base, [await call(bettors[0])], [bettors[0]]);
    const c2 = await send(base, [await call(bettors[0])], [bettors[0]]);
    (l16 as any).first = c1.ok ? "ok" : errName(c1.err); (l16 as any).second = c2.ok ? "ok" : errName(c2.err) + " " + ((c2.logs ?? []).find((l) => /already in use|Error/.test(l)) ?? "").slice(0, 80);
  }
  if (!(await waitFor(async () => { const a = await readAccount(erUrl(tH), roundAcc); return a.data && a.owner === PROGRAM_ID.toBase58(); }, 20_000))) throw new Error(`Round ${n} not visible on the rollup`);
  if (n > 1) { await reseal(); await probeL20resealed(n - 1); }

  // L21: a stranger schedules every task id computable from public data before open_round
  const squat = [predictableTaskId(T, n), predictableTaskId(T, n) + 1n, predictableTaskId(T, n) - 1n, predictableTaskId(T, n + 1), predictableTaskId(T, n - 1)].map((x) => x & 0x7fffffffffffffffn);
  const sT = await token(stranger);
  const squatOk = await Promise.all(squat.map(async (id) => (await send(erConn(sT), [squatIx(id)], [stranger], { timeoutMs: 8000 })).ok));

  const openIx = await ix(progEr.methods.openRound(new BN(n)).accountsPartial({ house: house.publicKey, table, book, desk0: desks[0], desk1: desks[1], desk2: desks[2], desk3: desks[3], desk4: desks[4], desk5: desks[5], desk6: desks[6], desk7: desks[7], round: roundAcc, oracleQueue: vrfQueue }));
  const open = must(await send(erH, [openIx], [house], { cu: 1_000_000 }), `open_round ${n}`);
  const t0 = (await readTable())!.v;
  const rr: RoundRun = { n, openSig: open.sig, open: t0, snaps: [], latest: t0, deskSeen: players.map(() => new Set<number>()), deskLatest: players.map(() => null), stop: false, squat, squatOk, lagMax: 0 };
  const tOpen = Date.now();
  const obs = observers(rr);
  const loops = [monitor(rr), deskWatch(rr), strangerLoop(rr), ...players.map((_, s) => playerLoop(rr, s))];
  if (n === 1) { // A takes the empty seat 0 with `join` in HIDE, then plays
    const t = await token(players[A]);
    const j = await send(erConn(t), [await joinIx(players[A], A)], [players[A]], { timeoutMs: 10_000 });
    if (!j.ok) throw new Error(`A's join failed: ${errName(j.err)}`);
    rr.joinSig = j.sig;
  }
  // mid-round probes, from live beat 4
  await waitFor(async () => rr.latest?.phase === PHASE.live && rr.latest.beat >= 4, 30_000);
  await probeL1(rr);
  await probeL3(rr);
  await probeL4(rr, obs);
  await probeL5list(rr);
  if (n === 1) { await probeL6(); await probeHousePool(); }
  if (n === 2) await probeL7(rr);
  if (n >= 2) await probeL12live(rr);
  if (rr.latest?.phase !== PHASE.live) R.log(`warn   round ${n}: mid-round probes ran past the live phase (phase ${rr.latest?.phase})`);
  // the bell
  const atBell = await waitFor(async () => (rr.latest?.phase === PHASE.bell ? rr.latest : null), 90_000, 50);
  if (!atBell) throw new Error(`round ${n}: no bell`);
  const tBell = Date.now();
  rr.stop = true;
  await Promise.all(loops);
  // fuzz in BELL (sealed): every player sends two acts
  for (let s = 0; s < NDESK; s++) for (let i = 0; i < 2; i++)
    sendAct(players[s], await token(players[s]), { round: n, desk: s, who: "player", cls: "fuzz-bell", kind: rnd(256), level: rnd(256), seq: ++seqOf[s], phase: PHASE.bell }, desks[s]);
  if (n >= 2) await probeL12bell(rr);
  await sleep(1500);
  closeObs(obs);
  rr.final = (await readTable())!.v;
  const ticksBefore = rr.final.tickCalls;
  must(await send(erH, [await ix(progEr.methods.reveal().accountsPartial({ caller: house.publicKey, table, book, round: roundAcc }))], [house], { cu: 400_000 }), `reveal ${n}`);
  await unseal();
  rr.final = (await readTable())!.v;
  await sleep(1500);
  const afterCancel = (await readTable())!.v.tickCalls;
  (rr as any).ticksAfterCancel = afterCancel - rr.final.tickCalls;
  (rr as any).ticksBell = rr.final.tickCalls - ticksBefore;
  judgeObservers(rr, obs, tOpen, tBell);
  if (n === 1) { // fuzz in REVEALED (public): acts never fail
    for (let s = 0; s < NDESK; s++)
      sendAct(players[s], await token(players[s]), { round: n, desk: s, who: "player", cls: "fuzz-revealed", kind: rnd(256), level: rnd(256), seq: ++seqOf[s], phase: PHASE.revealed }, desks[s]);
    await sleep(1000);
  }
  await collectCu(rr);
  await probeL14(rr);
  await probeL20after(rr);
  if (n === 1) {
    const tp = await readAccount(CFG.base, tape);
    const close = tp.data ? Number(tp.data.readBigInt64LE(24)) : 0;
    while (Date.now() / 1000 < close + 2) await sleep(500);
    const late = await send(base, [await ix(programOn(base, bettors[1]).methods.placeCall(3).accountsPartial({ bettor: bettors[1].publicKey, config: pda.config(), tape, call: callPda(tape, bettors[1].publicKey) }))], [bettors[1]]);
    (l16 as any).afterClose = late.ok ? "ok" : errName(late.err);
  }
  R.log(`round ${n}: bell after live beat ${rr.final.beat}, resolves ${rr.final.resolves}, tick calls ${rr.final.tickCalls}, acts sent ${sent.filter((x) => x.round === n).length}, ticks read ${rr.ticks?.length}`);
  return rr;
}
const l16: Record<string, string> = {};

// ------------------------------------------------------------------ assertions over the whole run
function staticChecks() {
  // L8: no log macros anywhere in the program; log-free features on by default
  const dir = path.join(REPO, "programs/ping/src");
  const files: string[] = [];
  const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : p.endsWith(".rs") && files.push(p); } };
  walk(dir);
  const hits: string[] = [];
  for (const f of files) fs.readFileSync(f, "utf8").split("\n").forEach((l, i) => { if (!/^\s*\/\//.test(l) && /\b(msg!|emit!|emit_cpi!|sol_log\w*)/.test(l)) hits.push(`${path.relative(REPO, f)}:${i + 1}`); });
  const cargo = fs.readFileSync(path.join(REPO, "programs/ping/Cargo.toml"), "utf8");
  const def = cargo.match(/^default\s*=\s*\[(.*)\]/m)?.[1] ?? "";
  R.check("L8", hits.length === 0 && def.includes("no-log-ix-name") && def.includes("custom-panic"), "no msg!/emit!/sol_log in programs/ping/src; no-log-ix-name + custom-panic default", { hits, files: files.length, defaultFeatures: def.trim() });
  // L12 structure: join cannot read hidden state (no Book among its accounts)
  const join = IDL.instructions.find((i: any) => i.name === "join");
  return { joinAccounts: join.accounts.map((a: any) => a.name) };
}

function finalChecks(runs: RoundRun[], joinAccounts: string[]) {
  const acts = sent;
  const missing = acts.filter((x) => !x.found);
  const failed = acts.filter((x) => x.found && x.err);
  const sendErr = acts.filter((x) => x.sendErr);
  const ticks = runs.flatMap((r) => (r.ticks ?? []).map((t) => ({ ...t, n: r.n, hideEnd: r.open.hideEndAtOpen, bellSlot: r.final!.bellSlot, resolves: r.final!.resolves })));

  // L19: CU classes from real transactions
  const actCu = acts.filter((x) => x.found).map((x) => x.cu!);
  const actPcu = acts.filter((x) => x.found).map((x) => x.pcu!);
  const resolving: number[] = [], noop: Record<string, number[]> = { HIDE: [], LIVE: [], BELL: [] };
  let gapOk = true;
  for (const r of runs) {
    const ts = (r.ticks ?? []).slice().sort((a, b) => b.pcu - a.pcu);
    const k = r.final!.resolves;
    const res = ts.slice(0, k), rest = ts.slice(k);
    if (res.length && rest.length && Math.min(...res.map((t) => t.pcu)) < 2 * Math.max(...rest.map((t) => t.pcu))) gapOk = false;
    resolving.push(...res.map((t) => t.pcu));
    for (const t of rest) noop[t.slot < r.open.hideEndAtOpen ? "HIDE" : r.final!.bellSlot && t.slot >= r.final!.bellSlot ? "BELL" : "LIVE"].push(t.pcu);
  }
  const cuSrc = CFG.raw ? "raw rollup (the local filter returns no meta)" : "post-reveal getTransaction";
  const byCls = hist(acts.filter((x) => x.found).map((x) => x.cls));
  const nResolvingExpected = runs.reduce((a, r) => a + r.final!.resolves, 0);
  R.check("L19", actCu.length > 0 && spread(actCu) === 0 && spread(actPcu) === 0 && resolving.length === nResolvingExpected && spread(resolving) === 0 && gapOk && Object.values(noop).every((v) => spread(v) === 0),
    `CU per class over ${runs.length} rounds from real transactions (${cuSrc})`,
    { act: { n: actCu.length, tx: hist(actCu), program: hist(actPcu), classes: byCls }, resolvingTick: { n: resolving.length, expected: nResolvingExpected, cu: hist(resolving) }, noopTick: Object.fromEntries(Object.entries(noop).map(([p, v]) => [p, { n: v.length, cu: hist(v) }])), gapOk, inProcess: "tests-magicsvm-rs/tests/cu.rs" });
  const logLines = acts.reduce((a, x) => a + (x.logLines ?? 0), 0) + ticks.reduce((a, t) => a + t.logLines, 0);
  R.check("L8.tx", logLines === 0 && actCu.length > 0, "program log lines in every act and tick read back", { programLogLines: logLines, acts: actCu.length, ticks: ticks.length });

  // L11: every act lands and succeeds, whatever kind, level, seq, key or phase
  const phases = hist(acts.map((x) => ["IDLE", "HIDE", "LIVE", "BELL", "REVEALED"][x.phase] ?? x.phase));
  R.check("L11", missing.length === 0 && failed.length === 0 && sendErr.length === 0, `${acts.length} acts (fuzz, wrong key, stale seq, every phase)`, { phases, byClass: byCls, failed: failed.length, missing: missing.length, sendErrors: sendErr.length, firstFail: failed[0] ? errName(failed[0].err) : undefined, firstSendErr: sendErr[0]?.sendErr });

  // L5 cadence: player acts per desk per live beat, and no failed act or tick
  const counts: number[] = [], crossDesk: number[] = [];
  let nBeats = 0;
  const perDesk: Record<number, number> = {};
  for (const r of runs) {
    const bs = r.open.beatSlots, he = r.open.hideEndAtOpen, bell = r.final!.beat;
    const c = new Map<string, number>();
    for (const x of acts) if (x.round === r.n && x.who === "player" && x.slot !== undefined && x.slot >= he && !x.cls.startsWith("fuzz-")) {
      const b = Math.floor((x.slot - he) / bs) + 1;
      if (b >= 2 && b <= bell - 1) c.set(`${x.desk}/${b}`, (c.get(`${x.desk}/${b}`) ?? 0) + 1);
    }
    for (let s = 0; s < NDESK; s++) for (let b = 2; b <= bell - 1; b++) { const v = c.get(`${s}/${b}`) ?? 0; counts.push(v); perDesk[s] = (perDesk[s] ?? 0) + v; }
    for (let b = 2; b <= bell - 1; b++) crossDesk.push(spread(Array.from({ length: NDESK }, (_, s) => c.get(`${s}/${b}`) ?? 0)));
    nBeats += Math.max(0, bell - 2);
  }
  const expected = (ACT_MS > 0 ? (runs[0].open.beatSlots * slotMsEstimate(runs)) / ACT_MS : 0);
  const mean = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
  const failedTicks = ticks.filter((t) => t.err).length;
  // every desk sends on the same 250-ms schedule whatever its hidden state: equal totals per desk, and
  // a mean per beat of beat length / 250 ms. Per-beat counts by landing slot jitter with slot timing.
  R.check("L5.cadence", counts.length > 0 && spread(Object.values(perDesk)) <= runs.length && Math.abs(mean - expected) <= 0.1 * expected && failed.length === 0 && failedTicks === 0,
    "player acts per desk per live beat (by landing slot, beats 2..bell-1), equal per desk; no failed act or tick",
    { perDeskTotals: perDesk, beats: nBeats, meanPerDeskPerBeat: Number(mean.toFixed(3)), expected: Number(expected.toFixed(3)), perBeatLandingHist: hist(counts), crossDeskSpreadPerBeat: hist(crossDesk),
      failedActs: failed.length, failedTicks, ticks: ticks.length, schedulerLagMaxMs: Math.round(Math.max(...runs.map((r) => r.lagMax))) });

  // L9: Table write set between live beats (the level permutation property itself: ping-core I3, in-process)
  const changed = new Set<string>();
  for (const r of runs) for (let i = 1; i < r.snaps.length; i++) {
    const a = r.snaps[i - 1], b = r.snaps[i];
    if (a.v.phase !== PHASE.live || b.v.phase !== PHASE.live) continue;
    for (let o = 0; o < a.bytes.length; o++) if (a.bytes[o] !== b.bytes[o]) changed.add(fieldAt(o));
  }
  const bad = [...changed].filter((f) => !LIVE_WRITES.has(f));
  R.check("L9", bad.length === 0 && changed.size > 0, "Table fields that change between live beats are only the public per-beat outputs (permutation invariance: crates/ping-core/tests/props.rs i3, in-process)", { changed: [...changed], unexpected: bad });

  // L10: every Desk and the Table written every beat, constant sizes
  const gaps: string[] = [];
  const sizes = new Set<number>(runs.flatMap((r) => r.snaps.map((s) => s.bytes.length)));
  for (const r of runs) for (let s = 0; s < NDESK; s++) {
    const seen = r.deskSeen[s];
    for (let b = 1; b < r.final!.beat; b++) if (!seen.has(b)) gaps.push(`r${r.n}d${s}b${b}`);
  }
  const tableBeats = runs.map((r) => { const bs = new Set(r.snaps.map((s) => s.v.beat)); let miss = 0; for (let b = 0; b <= r.final!.beat; b++) if (!bs.has(b)) miss++; return miss; });
  R.check("L10", sizes.size === 1 && sizes.has(1152) && runs.every((r) => (r as any).deskResultsOk === true),
    "every Desk holds a result for every beat 0..bell and its final beat (read after the reveal); constant sizes (live polls: evidence only, an observer stall misses beats)", { tableSizes: [...sizes], deskBeatsMissedByPoll: gaps.slice(0, 12), nMissed: gaps.length, tableBeatsMissed: tableBeats, deskResults: runs.map((r) => (r as any).deskResults) });

  // L12: join errors depend only on public fields and the caller's arguments
  const rounds12 = Object.values(l12);
  const sameAcross = rounds12.every((x) => JSON.stringify(x) === JSON.stringify(rounds12[0]));
  const exp = { seat8: ["AccountNotInitialized", "AccountOwnedByWrongProgram", "BadSeat", "ConstraintSeeds"], humanSeat0: ["SeatTaken"], BalreadySeated: ["AlreadySeated"], bellPhase: ["BadPhase"] };
  const asExpected = rounds12.every((x) => Object.entries(exp).every(([k, v]) => v.includes(x[k])));
  R.check("L12", !joinAccounts.includes("book") && sameAcross && asExpected && rounds12.length >= 2, "join errors identical across hidden states and public-only; join takes no Book", { joinAccounts, perRound: l12 });

  // L13: no bell information in the Table before the bell; the meter uses public rules only
  const leaks: string[] = [];
  for (const r of runs) for (const s of r.snaps) if (s.v.phase === PHASE.hide || s.v.phase === PHASE.live) {
    if (s.v.bellSlot !== 0) leaks.push(`r${r.n}b${s.v.beat}:bell_slot`);
    if (s.v.commit.some((x) => x)) leaks.push(`r${r.n}b${s.v.beat}:commit_hash`);
    if (s.v.totals.some((x) => x)) leaks.push(`r${r.n}b${s.v.beat}:totals`);
  }
  R.check("L13", leaks.length === 0 && bellMeterOk, "bell_slot, totals and commit hash stay zero in every pre-bell Table snapshot; the bell meter is a function of the public beat only", { leaks: leaks.slice(0, 10), snapshots: runs.reduce((a, r) => a + r.snaps.length, 0), bellMeter: bellMeterEv });

  // L16: Tape
  R.check("L16", l16.first === "ok" && l16.second !== "ok" && !!l16.afterClose && l16.afterClose !== "ok", "Tape: a second call from the same burner and a call after close_unix fail", l16);

  // L18: the harness, like the client, sends nothing before its re-sealed Desk for the round is read
  const early = runs.map((r) => acts.filter((x) => x.round === r.n && x.who === "player" && x.slot !== undefined && x.slot < r.open.openSlot).length);
  R.check("L18", early.every((x) => x === 0) && clientGateEv.present, "no player act landed before open_round of its round; the browser client gates its first send on its own sealed Desk", { earlyActsPerRound: early, clientGate: clientGateEv });

  // L20 extra (S19): nothing reusable across rounds in the revealed history
  const salts = acts.filter((x) => x.data).map((x) => x.data!.subarray(14, 30).toString("hex"));
  const lens = hist(acts.filter((x) => x.data).map((x) => x.data!.length));
  const seeds = roundData.map((r) => r.seed?.toString("hex"));
  R.check("L20.fresh", new Set(salts).size === salts.length && salts.length > 0 && new Set(seeds).size === seeds.length && Object.keys(lens).every((l) => l === "30"),
    "revealed act data: every salt unique, no key in instruction data (30 bytes), a fresh seed per round", { salts: salts.length, unique: new Set(salts).size, dataLengths: lens, seeds: seeds.map((s) => s?.slice(0, 12)) });

  // L21: crank task id not predictable / squattable
  const ev21 = runs.map((r) => ({ round: r.n, taskId: r.open.taskId.toString(), squatAccepted: r.squatOk.filter(Boolean).length + "/" + r.squat.length, squatHit: r.squat.includes(r.open.taskId),
    resolves: r.final!.resolves, bell: r.final!.beat, ticksAfterCancel: (r as any).ticksAfterCancel }));
  const ids = new Set(runs.map((r) => r.open.taskId.toString()));
  R.check("L21", ev21.every((e) => !e.squatHit && e.resolves === e.bell + 1 && e.ticksAfterCancel === 0) && ids.size === runs.length,
    "every public-data task id (and neighbours) pre-scheduled by a stranger before open_round; the round's crank still resolves every beat; 0 ticks after the cancel", ev21);
}
/** Rollup slot length over the probe rounds, from the Table's slots and the wall clock of its snapshots. */
function slotMsEstimate(runs: RoundRun[]): number {
  const xs: number[] = [];
  for (const r of runs) {
    const a = r.snaps.find((s) => s.v.phase === PHASE.live), b = [...r.snaps].reverse().find((s) => s.v.phase === PHASE.live);
    if (a && b && b.v.nextDeadline > a.v.nextDeadline) xs.push((b.t - a.t) / (b.v.nextDeadline - a.v.nextDeadline));
  }
  return xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : 50;
}
let bellMeterOk = false, bellMeterEv: any = null;
let clientGateEv: any = { present: false };
async function clientChecks() {
  try {
    const views: any = await import(new URL("../app/src/chain/views.ts", import.meta.url).href);
    const vals = [19, 20, 25, 29, 30].map((b) => Number(views.bellChance(b).toFixed(4)));
    bellMeterOk = views.bellChance.length === 1 && vals[0] === 0 && vals[1] === 0.1 && vals[3] === 1 && vals[4] === 0;
    bellMeterEv = { arity: views.bellChance.length, chanceAt19_20_25_29_30: vals };
  } catch (e: any) { bellMeterEv = { error: String(e?.message ?? e).slice(0, 100) }; }
  const drv = fs.readFileSync(path.join(REPO, "app/src/chain/driver.ts"), "utf8");
  clientGateEv = { present: /deskSealed === 1 && bookSealed === 1/.test(drv) && /deskReadable/.test(drv) && /d\.round !== t\.round/.test(drv), where: "app/src/chain/driver.ts canSend()" };
  // L15 (static part): tokens never logged by the client
  const hits: string[] = [];
  const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(p) && !/\.test\./.test(p)) fs.readFileSync(p, "utf8").split("\n").forEach((l, i) => { if (/console\.\w+\([^)]*token/i.test(l)) hits.push(`${path.relative(REPO, p)}:${i + 1}`); }); } };
  walk(path.join(REPO, "app/src"));
  return hits;
}

// ------------------------------------------------------------------ main
async function main() {
  R.log(`leak-probe  cluster ${CLUSTER}  er ${CFG.er}  raw ${CFG.raw || "-"}  base ${CFG.base}  table ${T}  rounds ${CFG.rounds}`);
  tH = await token(house);
  erH = erConn(tH);
  progEr = programOn(erH, house);
  for (const kp of [...players, outsider, stranger]) await token(kp);
  let stopBh = false;
  const bhLoop = blockhashLoop(() => stopBh);
  const { joinAccounts } = staticChecks();
  const consoleTokenHits = await clientChecks();
  const { vrfQueue } = await setupPool();
  const bettors = [Keypair.generate(), Keypair.generate()];
  must(await send(base, bettors.map((b) => SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: b.publicKey, lamports: 30_000_000 })), [house]), "fund bettors");
  const runs: RoundRun[] = [];
  for (let n = 1; n <= CFG.rounds; n++) runs.push(await runRound(n, vrfQueue, bettors));
  await reseal(); // seal again so the last round's history is checked after a re-seal too
  await probeL20resealed(CFG.rounds);
  stopBh = true;
  await bhLoop;
  finalChecks(runs, joinAccounts);
  // L17: the house runner's RPC log names only its own Desks and the Tables
  if (fs.existsSync(CFG.houseRpcLog)) {
    const r = spawnSync("npx", ["tsx", path.join(REPO, "house/src/i13-check.ts"), CFG.houseRpcLog], { cwd: REPO, encoding: "utf8", timeout: 120_000 });
    const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
    R.check("L17", r.status === 0, `house runner RPC log (${path.basename(CFG.houseRpcLog)}) touches only its own Desks and the Tables`, { exit: r.status, tail });
  } else R.add("L17", "SKIP", "house runner RPC log", `no log at ${CFG.houseRpcLog}`);
  R.check("L15", R.leakedSecrets() === 0 && consoleTokenHits.length === 0, `auth tokens (${tok.size}) never in this run's output; no console call with a token in app/src`, { tokenHitsInOutput: R.leakedSecrets(), consoleTokenLines: consoleTokenHits });
  R.add("L15.browser", "SKIP", "tokens in URLs shown to the user, explorer links, error reports", "needs the browser e2e run");

  // summary
  const order = (id: string) => { const m = id.match(/^L(\d+)/); return (m ? Number(m[1]) : 99) * 100 + (id.includes(".") ? 1 : 0); };
  const byId = [...R.results].sort((a, b) => order(a.id) - order(b.id));
  R.log("");
  R.log("summary");
  for (const r of byId) R.log(`  ${r.status.padEnd(14)} ${r.id.padEnd(12)} ${r.title.slice(0, 110)}`);
  const fails = R.results.filter((r) => r.status === "FAIL");
  const covered = new Set(R.results.map((r) => r.id.split(".")[0]));
  const absent = Array.from({ length: 21 }, (_, i) => `L${i + 1}`).filter((x) => !covered.has(x));
  R.log(`${R.results.length} assertions: ${Object.entries(hist(R.results.map((r) => r.status))).map(([k, v]) => `${v} ${k}`).join(", ")}; ${fails.length ? "FAILED: " + [...new Set(fails.map((f) => f.id))].join(" ") : "no failures"}${absent.length ? `; not covered: ${absent.join(" ")}` : ""}`);
  return fails.length || absent.length ? 1 : 0;
}

let code = 2;
main().then((c) => { code = c; }).catch((e) => { R.log(`ERROR ${e?.stack ?? e}`); code = 2; }).finally(() => {
  if (CFG.log) { fs.mkdirSync(path.dirname(CFG.log), { recursive: true }); fs.writeFileSync(CFG.log, R.lines.join("\n") + "\n"); console.log(`log written to ${CFG.log}`); }
  process.exit(code);
});
