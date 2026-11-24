// Devnet deploy checks: Config, two house pools on the TEE, then recorded rounds on one pool with
// eight scripted desks at 4 acts/s each, measuring privacy, constant compute and the round lifecycle.
//   make devnet-check-a5                     (PHASES=config,pools,rounds ROUNDS=3)
//   PHASES=rounds ROUNDS=10 POOL=1 npx tsx tests/devnet/a5-check.ts
// Env: PHASES (config,pools,rounds), POOLS (1,2), POOL (1: the pool that plays), ROUNDS (3),
//   EXPECT_VERSION (1), CALL_ROUNDS (all: rounds of this run with Tape calls, 1-based), SUBMIN_ROUND (last),
//   JOIN_ROUND (3), PROBE_ROUNDS (1,3,last), ALL_ACTS_ROUNDS (1,2: read every act back; others desk 0 + specials).
// Keys of the scripted desks, the outsider, bettors and joiners are kept outside the repository in
// ~/.config/solana/blitz-ping-a5-devnet.json. Evidence: one JSON line per observation (path printed).
// Every base-layer transaction is sent with preflight on.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import {
  PROGRAM_ID, KIND, PHASE, NDESK, BN, pda, sleep, loadKeypair, readAccount, programOn, send, waitOwner, diffBytes, rpc,
  decodeTape, decodeCall, callPda, Keypair, PublicKey, Connection, type SendResult,
} from "../local/lib.ts";
import {
  DEV, feeVault, tokenFor, erUrl, erConn, actIx, rawSend, readClock, decodePermission, decodeTableFull, decodeRoundFull, decodeDeskFull,
  TICK_DISC, evidence, LOG_PATH, pct, hist, type TableFull,
} from "./devnet.ts";

const env = (k: string, d: string) => process.env[k] ?? d;
const PHASES = env("PHASES", "config,pools,rounds").split(",");
const POOLS = env("POOLS", "1,2").split(",").map(Number);
const POOL = Number(env("POOL", "1"));
const ROUNDS = Number(env("ROUNDS", "3"));
const EXPECT_VERSION = Number(env("EXPECT_VERSION", "1"));
const listOf = (k: string, d: string) => (env(k, d) === "all" ? null : env(k, d).split(",").filter(Boolean).map((x) => (x === "last" ? ROUNDS : Number(x))));
const CALL_ROUNDS = listOf("CALL_ROUNDS", "all");
const SUBMIN_ROUND = Number(env("SUBMIN_ROUND", String(ROUNDS)));
const JOIN_ROUND = Number(env("JOIN_ROUND", "3"));
const PROBE_ROUNDS = listOf("PROBE_ROUNDS", "1,3,last")!;
const ALL_ACTS_ROUNDS = listOf("ALL_ACTS_ROUNDS", "1,2")!;
const CADENCE_MS = 250;
const TABLE_FLOAT = Number(env("TABLE_FLOAT", "100000000")); // 0.1 SOL: the Round-commit fee float
const LEAD_SECS = 6; // planned start = base clock + this at create_record

const CONFIG = {
  house: null as any, teeValidator: DEV.validator, vrfQueue: DEV.vrfQueue,
  beatSlots: new BN(150), hideSlots: new BN(500), callLamports: new BN(10_000_000), lotLamports: new BN(1_000_000),
  crankIntervalMs: 250, crankIterations: 240, tickCuLimit: 400_000, actIntervalMs: 250, hideSecs: 5, tapeCloseSecs: 15,
  bellMin: 20, bellMax: 29, algoMemory: 4, tapeCloseBeat: 10,
};

// ------------------------------------------------------------------ state outside the repo
const STATE_PATH = path.join(os.homedir(), ".config/solana/blitz-ping-a5-devnet.json");
type State = { bots: Record<string, number[][]>; outsider: number[]; bettors: number[][]; joiners: number[][]; nextRound: Record<string, number>; prevProbe?: any };
const st: State = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8"))
  : { bots: {}, outsider: Array.from(Keypair.generate().secretKey), bettors: [], joiners: [], nextRound: {} };
const saveState = () => fs.writeFileSync(STATE_PATH, JSON.stringify(st), { mode: 0o600 });
saveState();
const kp = (s: number[]) => Keypair.fromSecretKey(Uint8Array.from(s));
function botsOf(t: number): Keypair[] {
  if (!st.bots[t]) { st.bots[t] = Array.from({ length: NDESK }, () => Array.from(Keypair.generate().secretKey)); saveState(); }
  return st.bots[t].map(kp);
}
const PERSONALITY = ["Shark", "Ghost", "Minnow"];
const botName = (s: number) => `${PERSONALITY[s % 3]} ${s + 1}`;
function newBurner(list: "bettors" | "joiners") { const k = Keypair.generate(); st[list].push(Array.from(k.secretKey)); saveState(); return k; }

// ------------------------------------------------------------------ connections, senders
const house = loadKeypair(DEV.wallet);
CONFIG.house = house.publicKey;
const base = new Connection(DEV.base, "confirmed");
const progBase = programOn(base, house);
const outsider = kp(st.outsider);
const ix = (m: any) => m.instruction();
const houseTxs: { label: string; layer: string; ok: boolean; sig: string; err?: any }[] = [];
const fallbackSigs = new Set<string>();
let tickSampleShown = false;
const tokenCache = new Map<string, string>();

async function baseSend(ixs: any[], label: string, signers: Keypair[] = [house]) {
  let r = await send(base, ixs, signers, { skipPreflight: false, timeoutMs: 90_000 });
  // a dropped tx (no status after 90 s, its blockhash expired) is sent again with a fresh blockhash
  for (let i = 0; i < 2 && !r.ok && r.err === "timeout"; i++) {
    const stt = (await rpc(DEV.base, "getSignatureStatuses", [[r.sig], { searchTransactionHistory: true }])).body?.result?.value?.[0];
    if (stt) { r = { ...r, ok: !stt.err, err: stt.err }; break; }
    evidence("tx", `base ${label}: dropped (no status after 90 s), sent again`, { sig: r.sig });
    r = await send(base, ixs, signers, { skipPreflight: false, timeoutMs: 90_000 });
  }
  houseTxs.push({ label, layer: "base", ok: r.ok, sig: r.sig, err: r.ok ? undefined : r.err });
  if (!r.ok) { evidence("tx", `FAILED base ${label}`, { sig: r.sig, err: r.err, logs: (r.logs ?? []).slice(-6) }); throw new Error(`${label} failed`); }
  return r;
}
let tHouse = "";
const erH = () => erConn(tHouse);
async function erSend(ixs: any[], label: string, cu = 400_000, signers: Keypair[] = [house], token = tHouse) {
  const r = await send(erConn(token), ixs, signers, { cu, skipPreflight: false, timeoutMs: 30_000 });
  houseTxs.push({ label, layer: "tee", ok: r.ok, sig: r.sig, err: r.ok ? undefined : r.err });
  if (!r.ok) { evidence("tx", `FAILED tee ${label}`, { sig: r.sig, err: r.err, logs: (r.logs ?? []).slice(-6) }); throw new Error(`${label} failed`); }
  return r;
}
const bal = async (k: PublicKey = house.publicKey) => base.getBalance(k, "confirmed");
const sol = (l: number) => Number((l / 1e9).toFixed(9));
const readTable = async (t: number, token = tHouse) => decodeTableFull((await readAccount(erUrl(token), pda.table(t))).data!);
const baseUnix = async () => (await readClock(DEV.base))!.unix;

const isRedacted = (res: any) => !res || (!(res.transaction?.message?.accountKeys?.length) && !(res.transaction?.message?.instructions?.length) && !(res.meta?.logMessages?.length));
const getTx = (url: string, sig: string) => rpc(url, "getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
async function mapLimit<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (i < xs.length) { const k = i++; out[k] = await f(xs[k]); } }));
  return out;
}
/** Log lines printed by our program itself (log/data lines while our program is the innermost invoke). */
function programLogLines(logs: string[]): string[] {
  const stack: string[] = [];
  const out: string[] = [];
  for (const l of logs) {
    const inv = l.match(/^Program (\w+) invoke \[\d+\]$/);
    if (inv) { stack.push(inv[1]); continue; }
    if (/^Program \w+ (success|failed)/.test(l)) { stack.pop(); continue; }
    if (/^Program (log|data):/.test(l) && stack[stack.length - 1] === PROGRAM_ID.toBase58()) out.push(l);
  }
  return out;
}
const programCu = (logs: string[]) => {
  const m = logs.map((l) => l.match(new RegExp(`^Program ${PROGRAM_ID.toBase58()} consumed (\\d+) of (\\d+)`))).find(Boolean);
  return m ? Number(m[1]) : null;
};

// ------------------------------------------------------------------ config + version
async function ensureConfig() {
  const cur = await readAccount(DEV.base, pda.config());
  if (!cur.data) {
    const r = await baseSend([await ix(progBase.methods.initConfig(CONFIG).accountsPartial({ admin: house.publicKey, config: pda.config() }))], "init_config");
    evidence("deploy", "init_config", { sig: r.sig, config: pda.config().toBase58() });
  }
  evidence("deploy", "Config on base", { address: pda.config().toBase58(), ...(await readConfig()) });
}
async function readConfig() {
  const b = (await readAccount(DEV.base, pda.config())).data!;
  return {
    house: new PublicKey(b.subarray(96, 128)), teeValidator: new PublicKey(b.subarray(128, 160)), vrfQueue: new PublicKey(b.subarray(160, 192)),
    beatSlots: new BN(b.readBigUInt64LE(8).toString()), hideSlots: new BN(b.readBigUInt64LE(16).toString()),
    callLamports: new BN(b.readBigUInt64LE(24).toString()), lotLamports: new BN(b.readBigUInt64LE(32).toString()),
    crankIntervalMs: b.readUInt32LE(40), crankIterations: b.readUInt32LE(44), tickCuLimit: b.readUInt32LE(48), actIntervalMs: b.readUInt32LE(52),
    hideSecs: b.readUInt32LE(56), tapeCloseSecs: b.readUInt32LE(60), bellMin: b[195], bellMax: b[196], algoMemory: b[197], tapeCloseBeat: b[198],
  };
}
async function versionOnTee() {
  const ixv = await ix(programOn(erH(), house).methods.version().accountsPartial({ caller: house.publicKey }));
  const tx = new Transaction().add(ixv);
  tx.feePayer = house.publicKey;
  tx.recentBlockhash = (await erH().getLatestBlockhash()).blockhash;
  tx.sign(house);
  const r = await rpc(erUrl(tHouse), "simulateTransaction", [tx.serialize().toString("base64"), { encoding: "base64", sigVerify: false }]);
  const rd = r.body?.result?.value?.returnData;
  return rd ? Buffer.from(rd.data[0], "base64").readUInt32LE(0) : null;
}

// ------------------------------------------------------------------ pools
const desksOf = (t: number) => Array.from({ length: NDESK }, (_, s) => pda.desk(t, s));
const deskAccs = (t: number) => Object.fromEntries(desksOf(t).map((d, s) => [`desk${s}`, d]));
const DELEGATION_PROGRAM = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";

async function setupPool(t: number) {
  const table = pda.table(t), book = pda.book(t), desks = desksOf(t);
  const bots = botsOf(t);
  const b0 = await bal();
  if (!(await readAccount(DEV.base, table)).data) {
    const r = await baseSend([await ix(progBase.methods.createPool(new BN(t), 0, new BN(TABLE_FLOAT)).accountsPartial({ house: house.publicKey, config: pda.config(), table, book, ledger: pda.ledger(t) }))], `create_pool ${t}`);
    evidence("pool", `create_pool ${t}`, { sig: r.sig, table: table.toBase58(), book: book.toBase58(), ledger: pda.ledger(t).toBase58(), tableFloat: TABLE_FLOAT });
  }
  for (let s = 0; s < NDESK; s += 4) {
    const ixs = [];
    for (let j = s; j < s + 4; j++) if (!(await readAccount(DEV.base, desks[j])).data) ixs.push(await ix(progBase.methods.createDesk(new BN(t), j).accountsPartial({ house: house.publicKey, config: pda.config(), table, desk: desks[j] })));
    if (ixs.length) evidence("pool", `create_desk ${t} ${s}..${s + 3}`, { sig: (await baseSend(ixs, `create_desk ${t} ${s}`)).sig });
  }
  const targets: [number, number, PublicKey, string][] = [[KIND.table, 0, table, "table"], [KIND.book, 0, book, "book"], ...desks.map((d, s) => [KIND.desk, s, d, `desk${s}`] as [number, number, PublicKey, string])];
  for (const [kind, idx, acc, name] of targets) {
    const a = await readAccount(DEV.base, acc);
    if (a.owner === DELEGATION_PROGRAM) continue;
    const r = await baseSend([await ix(progBase.methods.delegate(kind, new BN(t), new BN(idx)).accountsPartial({ house: house.publicKey, config: pda.config(), pda: acc, validator: DEV.validator }))], `delegate ${t} ${name}`);
    const ms = await waitOwner(erUrl(tHouse), acc, PROGRAM_ID, 30_000);
    evidence("3.delegate", `pool ${t} delegate ${name} -> usable on the TEE`, { sig: r.sig, account: acc.toBase58(), confirmMs: Math.round(r.ms), usableAfterConfirmMs: ms });
  }
  const tb = await readTable(t);
  if (tb.sealed !== 0x1ff || !(await readAccount(erUrl(tHouse), pda.perm(table))).data) {
    const items: [number, number, PublicKey | null][] = [[KIND.table, 0, null], [KIND.book, 0, book], ...desks.map((d, s) => [KIND.desk, s, d] as [number, number, PublicKey])];
    for (let i = 0; i < items.length; i += 3) {
      const ixs = await Promise.all(items.slice(i, i + 3).map(([k, s, tg]) => ix(programOn(erH(), house).methods.setupPermissions(k, new BN(s)).accountsPartial({ house: house.publicKey, table, target: tg, permission: pda.perm(tg ?? table) }))));
      evidence("pool", `pool ${t} setup_permissions ${i}..${i + 2}`, { sig: (await erSend(ixs, `setup_permissions ${t} ${i}`, 1_000_000)).sig });
    }
  }
  const tb2 = await readTable(t);
  for (let s = 0; s < NDESK; s += 4) {
    const ixs = [];
    for (let j = s; j < s + 4; j++) {
      if (tb2.seats[j].key === bots[j].publicKey.toBase58() && tb2.seats[j].kind === 2) continue;
      const name = Buffer.alloc(16); name.write(botName(j));
      ixs.push(await ix(programOn(erH(), house).methods.joinBot(j, bots[j].publicKey, (j % 3) + 1, Array.from(name)).accountsPartial({ house: house.publicKey, table, desk: desks[j], permission: pda.perm(desks[j]) })));
    }
    if (ixs.length) evidence("pool", `pool ${t} join_bot ${s}..${s + 3}`, { sig: (await erSend(ixs, `join_bot ${t} ${s}`, 1_000_000)).sig });
  }
  await permissionMembers(t, "after setup");
  const tb3 = await readTable(t);
  evidence("pool", `pool ${t} on the TEE`, { table: table.toBase58(), book: book.toBase58(), desks: desks.map((d) => d.toBase58()), phase: tb3.phase, round: tb3.round, sealed: tb3.sealed.toString(16), house: tb3.house, seats: tb3.seats.map((x) => `${x.name}/${x.kind}/${x.personality}/${x.key.slice(0, 6)}`), lamports: (await readAccount(erUrl(tHouse), table)).lamports, baseCost: sol(b0 - (await bal())) });
}

/** Permission members as the TEE stores them. A private account's permission is readable only by its members:
 *  each Desk's with the seated key's token; the Book's (no member but the owner program) by nobody. */
async function permissionMembers(t: number, when: string) {
  const tb = await readTable(t);
  const seatTok: Record<string, string> = {};
  await Promise.all(botsOf(t).map(async (b) => { seatTok[b.publicKey.toBase58()] = tokenCache.get(b.publicKey.toBase58()) ?? (await tokenFor(b)); }));
  const tO = tokenCache.get(outsider.publicKey.toBase58()) ?? (await tokenFor(outsider));
  const pid = PROGRAM_ID.toBase58();
  const tablePerm = await readAccount(erUrl(), pda.perm(pda.table(t)));
  const tableP = tablePerm.data ? decodePermission(tablePerm.data) : null;
  const bookReads: Record<string, boolean> = {};
  await Promise.all(([["house", erUrl(tHouse)], ["outsider", erUrl(tO)], ["anon", erUrl()], ...Object.values(seatTok).map((tk, i) => [`seat${i}`, erUrl(tk)])] as [string, string][]).map(async ([who, url]) => { bookReads[who] = !!(await readAccount(url, pda.perm(pda.book(t)))).data; }));
  const desks = await Promise.all(Array.from({ length: NDESK }, async (_, s) => {
    const key = tb.seats[s].key;
    const tk = seatTok[key] ?? null;
    const permAcc = pda.perm(pda.desk(t, s));
    const [own, byHouse, byAnon] = await Promise.all([tk ? readAccount(erUrl(tk), permAcc) : Promise.resolve(null), readAccount(erUrl(tHouse), permAcc), readAccount(erUrl(), permAcc)]);
    const p = own?.data ? decodePermission(own.data) : null;
    const others = !!byHouse.data || !!byAnon.data;
    const nonProgram = p ? p.members.filter((m) => m.key !== pid) : null;
    return { s, private: p?.isPrivate, members: p?.members.map((m) => `${m.key === pid ? "program" : m.key === key ? "seat" : m.key.slice(0, 8)}/${m.flags}`) ?? null,
      ok: !!p && p.isPrivate === 1 && nonProgram!.length === 1 && nonProgram![0].key === key && nonProgram![0].flags === 0 && !others, readableByHouseOrAnon: others };
  }));
  const pass = desks.every((d) => d.ok) && !Object.values(bookReads).some(Boolean) && tableP?.isPrivate === 0;
  evidence("extra.perm", `pool ${t} permission members on the TEE (${when})`, {
    pass, table: tableP ? { isPrivate: tableP.isPrivate, members: tableP.members.map((m) => `${m.key === pid ? "program" : m.key.slice(0, 8)}/${m.flags}`) } : null,
    bookPermissionReadableBy: bookReads, desks,
  });
  return pass;
}

// ------------------------------------------------------------------ rounds
type Sent = { desk: number; who: "own" | "wrong" | "stale" | "oldkey" | "joiner"; url: string; seq: number; sig?: string; err?: string; http: number; tSend: number; kind: number; level: number; round: number; phase: "hide" | "live"; forBeat: number; tAck?: number; status?: any };

function plan(k: number, beat: number, s: number): { kind: number; level: number } | null {
  const L = (x: number) => (((x % 24) + 24) % 24) + 1;
  if (k === 1) { // scripted extreme hidden states
    if (beat <= 3) return { kind: 1, level: L(s + 12) }; // pings on empty levels
    if (beat === 4) return { kind: 2, level: 7 }; // all re-quote onto one level
    if (beat === 5) return { kind: 1, level: 7 }; // everyone pings it
    if (beat === 6) return { kind: 2, level: s + 1 }; // all re-quote apart
    if (beat <= 9) return null; // nobody pending: algo pings
    if (beat <= 12) return s % 2 ? { kind: 2, level: 3 } : { kind: 1, level: 3 };
    if (beat === 13) return s === 0 ? { kind: 2, level: 1 } : { kind: 2, level: 10 + s };
    if (beat <= 20) return s === 0 ? null : { kind: 1, level: 1 }; // seven hunters on desk 0
    return { kind: 1, level: L(beat * 5 + s) };
  }
  if (k === 2) return null; // nobody acts
  const r = Math.random();
  if (r < 0.6) return { kind: 1, level: 1 + Math.floor(Math.random() * 24) };
  if (r < 0.8) return { kind: 2, level: 1 + Math.floor(Math.random() * 24) };
  if (r < 0.85) return { kind: [0, 3, 7, 255][Math.floor(Math.random() * 4)], level: [0, 25, 200][Math.floor(Math.random() * 3)] }; // junk kinds/levels: no-ops
  return null;
}
const placeLevel = (k: number, s: number) => (k === 1 ? s + 1 : k === 2 ? -1 : 1 + Math.floor(Math.random() * 24));

async function runRounds(t: number, n: number) {
  const table = pda.table(t), book = pda.book(t), desks = desksOf(t);
  const bots = botsOf(t);
  const tBot = await Promise.all(bots.map((b) => tokenFor(b)));
  const tO = await tokenFor(outsider);
  bots.forEach((b, i) => tokenCache.set(b.publicKey.toBase58(), tBot[i]));
  tokenCache.set(outsider.publicKey.toBase58(), tO);
  const anon = new Connection(DEV.er, { commitment: "confirmed", wsEndpoint: DEV.erWs });
  const callers: Record<string, string> = { A: erUrl(tBot[0]), B: erUrl(tBot[1]), O: erUrl(tO), anon: erUrl() };

  // ---- public Table watcher (anon websocket + poll)
  let tab: TableFull | null = null;
  const tabEvents: { t: number; round: number; phase: number; beat: number }[] = [];
  const onTab = (d: Buffer) => {
    const x = decodeTableFull(d);
    if (!tab || x.phase !== tab.phase || x.beat !== tab.beat || x.round !== tab.round) tabEvents.push({ t: Date.now(), round: x.round, phase: x.phase, beat: x.beat });
    tab = x;
  };
  anon.onAccountChange(table, (a: any) => onTab(a.data), "confirmed");
  const pollTab = async () => { const a = await readAccount(erUrl(), table).catch(() => null); if (a?.data) onTab(a.data); };
  await pollTab();
  const tabTimer = setInterval(pollTab, 300);

  // ---- desk 7 identity (switched to a joiner mid-round in JOIN_ROUND)
  const deskKey: Keypair[] = [...bots];
  const deskTok: string[] = [...tBot];
  let joinerSeq = 0;
  let oldKeyOn = false;
  // ---- own-desk subscriptions (member tokens)
  const deskState: any[] = Array(NDESK).fill(null);
  const sent: Sent[] = [];
  const pending: Sent[][] = Array.from({ length: NDESK }, () => []);
  const deskConns = tBot.map((tk) => erConn(tk));
  const resolveSlot = new Map<string, number>(); // "round:beat" -> Desk.result_slot (the slot of the tick that resolved it)
  const onDesk = (i: number, d: Buffer) => {
    const x = decodeDeskFull(d);
    deskState[i] = x;
    if (x.round > 0 && x.resultSlot > 0 && x.phase >= PHASE.live && !resolveSlot.has(`${x.round}:${x.beat}`)) resolveSlot.set(`${x.round}:${x.beat}`, x.resultSlot);
    const now = Date.now();
    for (const s of pending[i]) if (!s.tAck && x.lastSeq >= s.seq && (s.who === "own" || s.who === "joiner")) s.tAck = now;
    pending[i] = pending[i].filter((s) => !s.tAck && now - s.tSend < 30_000);
  };
  const deskSubs = deskConns.map((cn, i) => cn.onAccountChange(desks[i], (a: any) => onDesk(i, a.data), "confirmed"));
  for (let i = 0; i < NDESK; i++) { const a = await readAccount(erUrl(tBot[i]), desks[i]); if (a.data) onDesk(i, a.data); }

  // websocket updates can stop (e.g. after a desk changes hands): poll a desk whose state is behind, and a joined desk always
  const deskPoll = setInterval(async () => {
    for (let i = 0; i < NDESK; i++) {
      if (deskState[i] && deskState[i].round === curRound && deskKey[i] === bots[i]) continue;
      const a = await readAccount(erUrl(deskTok[i]), desks[i]).catch(() => null);
      if (a?.data) onDesk(i, a.data);
    }
  }, 400);
  let blockhash = (await erH().getLatestBlockhash()).blockhash;
  const bhTimer = setInterval(async () => { try { blockhash = (await erH().getLatestBlockhash()).blockhash; } catch {} }, 5_000);


  // ---- bots: one act every 250 ms per desk
  const EPOCH = Date.UTC(2026, 10, 1);
  const lastSeq = Array(NDESK).fill(0);
  const placed = new Set<string>(), chosen = new Set<string>();
  let botsOn = false, curRound = 0, curK = 0;
  const sendStats = { fail: 0, http: {} as Record<string, number> };
  const fire = (rec: Sent, signer: Keypair, deskIdx: number) => {
    const tx = new Transaction().add(actIx(signer.publicKey, desks[deskIdx], book, rec.kind, rec.level, rec.seq));
    tx.feePayer = signer.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(signer);
    sent.push(rec);
    if (rec.who === "own" || rec.who === "joiner") pending[deskIdx].push(rec);
    rawSend(rec.url, tx).then((r) => {
      rec.sig = r.sig; rec.err = r.err; rec.http = r.http;
      if (!r.sig) { sendStats.fail++; const key = `${r.http}:${(r.err ?? "").slice(0, 60)}`; sendStats.http[key] = (sendStats.http[key] ?? 0) + 1; }
    });
  };
  const botLoop = async (i: number) => {
    const offset = Math.floor((i * CADENCE_MS) / NDESK);
    for (;;) {
      const due = offset + (Math.floor((Date.now() - offset) / CADENCE_MS) + 1) * CADENCE_MS;
      await sleep(Math.max(0, due - Date.now()));
      if (!botsOn) continue;
      const p = tab, d = deskState[i];
      if (!p || p.round !== curRound || !(p.phase === PHASE.hide || p.phase === PHASE.live) || !d || d.round !== curRound) continue;
      let kind = 0, level = 0, forBeat = 0;
      const phase: "hide" | "live" = p.phase === PHASE.hide ? "hide" : "live";
      if (phase === "hide") {
        const key = `${curRound}:${i}`, pl = placeLevel(curK, i);
        if (!placed.has(key) && pl >= 0) { kind = 2; level = pl; placed.add(key); }
      } else {
        forBeat = p.beat + 1;
        const key = `${curRound}:${forBeat}:${i}`;
        const beatT = [...tabEvents].reverse().find((e) => e.round === curRound && e.beat === p.beat)?.t ?? Date.now();
        if (!chosen.has(key) && Date.now() - beatT >= (curK <= 2 ? 0 : (i * 97) % 900)) {
          chosen.add(key);
          const a = plan(curK, forBeat, i);
          if (a) { kind = a.kind; level = a.level; }
        }
      }
      const joined = deskKey[i] !== bots[i];
      const roll = Math.random();
      if (!joined && kind === 0 && roll < 0.04 && lastSeq[i] > 0) { // stale seq (already used): a no-op
        fire({ desk: i, who: "stale", url: erUrl(deskTok[i]), seq: lastSeq[i], http: 0, tSend: Date.now(), kind: 1, level: 5, round: curRound, phase, forBeat }, deskKey[i], i);
        continue;
      }
      if (!joined && kind === 0 && roll < 0.08) { // wrong key: the next desk's bot signs for this desk
        const j = (i + 1) % NDESK;
        fire({ desk: i, who: "wrong", url: erUrl(tBot[j]), seq: 4_000_000_000, http: 0, tSend: Date.now(), kind: 2, level: 9, round: curRound, phase, forBeat }, bots[j], i);
        continue;
      }
      let seq: number;
      if (joined) seq = ++joinerSeq;
      else { seq = Math.floor((Date.now() - EPOCH) / 10); if (seq <= lastSeq[i]) seq = lastSeq[i] + 1; lastSeq[i] = seq; }
      fire({ desk: i, who: joined ? "joiner" : "own", url: erUrl(deskTok[i]), seq, http: 0, tSend: Date.now(), kind, level, round: curRound, phase, forBeat }, deskKey[i], i);
    }
  };
  for (let i = 0; i < NDESK; i++) botLoop(i);
  // the replaced key of a joined desk keeps sending (1/s): every act must be a no-op
  (async () => {
    for (;;) {
      await sleep(1000);
      const p = tab;
      if (!oldKeyOn || !botsOn || !p || p.round !== curRound || p.phase !== PHASE.live) continue;
      let seq = Math.floor((Date.now() - EPOCH) / 10);
      if (seq <= lastSeq[7]) seq = lastSeq[7] + 1;
      lastSeq[7] = seq;
      fire({ desk: 7, who: "oldkey", url: erUrl(tBot[7]), seq, http: 0, tSend: Date.now(), kind: 1, level: 4, round: curRound, phase: "live", forBeat: p.beat + 1 }, bots[7], 7);
    }
  })();

  // ---- status of every act, as its sender
  const statusTimer = setInterval(async () => {
    const groups = new Map<string, Sent[]>();
    for (const s of sent) if (s.sig && s.status === undefined && Date.now() - s.tSend > 2_000) { const g = groups.get(s.url) ?? []; if (g.length < 200) g.push(s); groups.set(s.url, g); }
    for (const [url, todo] of groups) {
      const r = await rpc(url, "getSignatureStatuses", [todo.map((s) => s.sig), { searchTransactionHistory: true }]);
      const vals = r.body?.result?.value;
      if (!Array.isArray(vals)) continue;
      vals.forEach((v: any, k: number) => {
        if (v) todo[k].status = { err: v.err, cs: v.confirmationStatus };
        else if (Date.now() - todo[k].tSend > 30_000) todo[k].status = { missing: true };
      });
    }
  }, 2_000);

  // ---- log observers, fresh every round (subscriptions die silently)
  type Obs = { who: string; sig: string; slot: number; t: number; mentionsProgram: boolean; cu: number | null; lines: number; budget: boolean };
  const obs: Obs[] = [];
  let obsConns: [Connection, number][] = [];
  const startObservers = async () => {
    for (const [cn, sid] of obsConns) await cn.removeOnLogsListener(sid).catch(() => {});
    obsConns = [];
    const mk = (who: string, cn: Connection, f: any) => obsConns.push([cn, cn.onLogs(f, (l: any, ctx: any) => {
      const lines: string[] = l.logs ?? [];
      const mp = lines.some((x) => x.includes(PROGRAM_ID.toBase58()));
      if (!who.includes(" all") || mp) obs.push({ who, sig: l.signature, slot: ctx.slot, t: Date.now(), mentionsProgram: mp, cu: programCu(lines), lines: programLogLines(lines).length, budget: lines.some((x) => x.startsWith("Program ComputeBudget111111111111111111111111111111 invoke")) });
    }, "confirmed")]);
    const fresh = (tk?: string) => erConn(tk);
    mk("anon program", fresh(), PROGRAM_ID);
    mk("anon mentions table", fresh(), table);
    mk("anon mentions book", fresh(), book);
    mk("O program", fresh(tO), PROGRAM_ID);
    mk("B program", fresh(tBot[1]), PROGRAM_ID);
    // the "all" stream samples private txs live; several subscriptions widen the sample of tick signatures
    for (let i = 0; i < 4; i++) mk(`anon${i} all`, fresh(), "all");
    mk("O all", fresh(tO), "all");
    mk("B all", fresh(tBot[1]), "all");
  };

  const summaries: any[] = [];
  const start = st.nextRound[t] ?? ((await readTable(t)).round + 1);
  // a round an interrupted run left committed but not closed: settle (idempotent) and close it
  for (const n of [start - 1, start - 2].filter((x) => x > 0)) {
    const ra = await readAccount(DEV.base, pda.round(t, n)), ta = await readAccount(DEV.base, pda.tape(t, n));
    if (!ra.data || !ta.data || ra.owner !== PROGRAM_ID.toBase58()) continue;
    const tp = decodeTape(ta.data);
    if (tp.openCalls !== 0) { evidence("recover", `round ${t}/${n} left with open calls`, tp); continue; }
    if (!tp.resolved) await baseSend([await ix(progBase.methods.settleRound().accountsPartial({ caller: house.publicKey, round: pda.round(t, n), tape: pda.tape(t, n) }))], `settle_round ${t}/${n} (recover)`);
    const c = await baseSend([await ix(progBase.methods.closeRound().accountsPartial({ house: house.publicKey, config: pda.config(), round: pda.round(t, n), tape: pda.tape(t, n) }))], `close_round ${t}/${n} (recover)`);
    evidence("recover", `round ${t}/${n} closed after an interrupted run`, { sig: c.sig });
  }
  for (let r = start; r < start + n; r++) {
    const k = r - start + 1;
    curK = k;
    await startObservers();
    const bal0 = await bal();
    const lam0 = await poolLamports(t);
    const sum: any = { round: r, k };
    const before = await readTable(t);

    // ---- re-seal (every round after the first one of the pool)
    if (before.round > 0) {
      const t0 = Date.now();
      const items: [number, number, PublicKey][] = [[KIND.book, 0, book], ...desks.map((d, s) => [KIND.desk, s, d] as [number, number, PublicKey])];
      for (let i = 0; i < items.length; i += 3) {
        const ixs = await Promise.all(items.slice(i, i + 3).map(([kd, s, tg]) => ix(programOn(erH(), house).methods.setupPermissions(kd, new BN(s)).accountsPartial({ house: house.publicKey, table, target: tg, permission: pda.perm(tg) }))));
        await erSend(ixs, `re-seal ${t}/${r} ${i}`, 1_000_000);
      }
      sum.resealMs = Date.now() - t0;
      // L20: the previous round's revealed acts are hidden again
      if (st.prevProbe && st.prevProbe.table === t) {
        const pp = st.prevProbe;
        const res: any = {};
        for (const who of ["B", "anon", "O"]) {
          const red = [];
          for (const sig of [pp.aChoice, pp.aHide, ...(pp.tickSigs ?? [])].filter(Boolean)) red.push(isRedacted((await getTx(callers[who], sig)).body?.result));
          const l = await rpc(callers[who], "getSignaturesForAddress", [desks[0].toBase58(), { limit: 1000 }]);
          const list = Array.isArray(l.body?.result) ? l.body.result : [];
          res[who] = { redacted: red, desk0SigsListed: list.length, prevActsListed: list.filter((x: any) => pp.aSigs?.includes(x.signature)).length };
        }
        const pass = Object.values(res).every((x: any) => x.redacted.every(Boolean) && x.prevActsListed === 0);
        evidence("1.L20", `round ${r}: after the re-seal, round ${pp.round}'s revealed acts are redacted again`, { pass, ...res });
        sum.l20 = pass;
      }
    }
    const sealed = await readTable(t);
    sum.sealedBeforeOpen = sealed.sealed.toString(16);

    // ---- record + Tape on base
    const round = pda.round(t, r), tape = pda.tape(t, r);
    const existing = await readAccount(DEV.base, round);
    const reused = !!existing.data; // created + delegated by an interrupted run: open it as it is, without calls
    const planned = reused ? decodeRoundFull(existing.data!).plannedStartUnix : (await baseUnix()) + LEAD_SECS;
    const rec = reused ? { sig: "(reused)", ms: 0 } : await baseSend([
      await ix(progBase.methods.createRecord(new BN(t), new BN(r), new BN(planned)).accountsPartial({ house: house.publicKey, config: pda.config(), ledger: pda.ledger(t), round, tape })),
      await ix(progBase.methods.delegate(KIND.round, new BN(t), new BN(r)).accountsPartial({ house: house.publicKey, config: pda.config(), pda: round, validator: DEV.validator })),
    ], `create_record + delegate ${t}/${r}`);
    const roundBase0 = (await readAccount(DEV.base, round)).data!;
    const usable = await waitOwner(erUrl(tHouse), round, PROGRAM_ID, 30_000);
    sum.record = { sig: rec.sig, round: round.toBase58(), tape: tape.toBase58(), confirmMs: Math.round(rec.ms), usableAfterConfirmMs: usable };

    // ---- Tape calls (before the close: planned + hide_secs + tape_close_secs on the base clock)
    const bettors: { kp: Keypair; desk: number; amount: number }[] = [];
    const withCalls = !reused && (CALL_ROUNDS === null || CALL_ROUNDS.includes(k));
    const subMin = !reused && k === SUBMIN_ROUND;
    const callRent = await base.getMinimumBalanceForRentExemption(112);
    if (subMin) {
      const cfg = await readConfig();
      await baseSend([await ix(progBase.methods.updateConfig({ ...cfg, callLamports: new BN(100_000) }).accountsPartial({ admin: house.publicKey, config: pda.config() }))], "update_config call 100000");
      const b = newBurner("bettors");
      // exactly the call, the Call rent and one fee: the bettor is left with 0 lamports
      await baseSend([SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: b.publicKey, lamports: 100_000 + callRent + 5000 })], "fund sub-minimum bettor");
      const desk = Math.floor(Math.random() * NDESK);
      await baseSend([await ix(programOn(base, b).methods.placeCall(desk).accountsPartial({ bettor: b.publicKey, config: pda.config(), tape, call: callPda(tape, b.publicKey) }))], "place_call sub-minimum", [b]);
      bettors.push({ kp: b, desk, amount: 100_000 });
      await baseSend([await ix(progBase.methods.updateConfig({ ...cfg, callLamports: new BN(10_000_000) }).accountsPartial({ admin: house.publicKey, config: pda.config() }))], "update_config call 10000000");
    } else if (withCalls) {
      const ds = [0, 1, 2, 3, 4, 5, 6, 7].sort(() => Math.random() - 0.5).slice(0, 3);
      const bs = ds.map((desk) => ({ kp: newBurner("bettors"), desk, amount: 10_000_000 }));
      await baseSend(bs.map((b) => SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: b.kp.publicKey, lamports: b.amount + callRent + 5000 })), `fund bettors ${t}/${r}`); // 0 left after the call
      for (const b of bs) await baseSend([await ix(programOn(base, b.kp).methods.placeCall(b.desk).accountsPartial({ bettor: b.kp.publicKey, config: pda.config(), tape, call: callPda(tape, b.kp.publicKey) }))], `place_call ${t}/${r} desk ${b.desk}`, [b.kp]);
      bettors.push(...bs);
    }
    if (bettors.length) { const tp = decodeTape((await readAccount(DEV.base, tape)).data!); sum.tapeBefore = { total: tp.total, pool: tp.pool, closeUnix: tp.closeUnix, nCalls: tp.nCalls }; }

    // ---- clocks: wait until the TEE clock reaches the planned start (open_round checks it)
    const clocks: any[] = [];
    for (;;) {
      const [ct, cb] = await Promise.all([readClock(erUrl(tHouse)), readClock(DEV.base)]);
      if (!ct || !cb) { evidence("clock", "Clock sysvar not readable", { tee: !!ct, base: !!cb }); await sleep(LEAD_SECS * 1000 + 2000); clocks.push({ teeMinusLocal: NaN, baseMinusLocal: NaN, tee: null, base: null }); break; }
      clocks.push({ teeMinusLocal: ct!.unix - ct!.localMid / 1000, baseMinusLocal: cb!.unix - cb!.localMid / 1000, tee: ct!.unix, base: cb!.unix });
      if (ct!.unix >= planned) break;
      await sleep(250);
    }
    const last = clocks[clocks.length - 1];
    sum.clock = { planned, teeUnixAtOpen: last.tee, baseUnixAtOpen: last.base, teeMinusBaseSecs: Number((last.teeMinusLocal - last.baseMinusLocal).toFixed(2)), teeMinusLocal: Number(last.teeMinusLocal.toFixed(2)), baseMinusLocal: Number(last.baseMinusLocal.toFixed(2)) };

    // ---- open
    const openIx = await ix(programOn(erH(), house).methods.openRound(new BN(r)).accountsPartial({ house: house.publicKey, table, book, ...deskAccs(t), round, oracleQueue: DEV.vrfQueue }));
    const tOpen = Date.now();
    curRound = r;
    const open = await erSend([openIx], `open_round ${t}/${r}`, 1_400_000);
    botsOn = true;
    const p0 = await readTable(t);
    sum.open = { sig: open.sig, ms: Math.round(open.ms), openSlot: p0.openSlot, taskId: p0.taskId.toString(), vrfRequestSlot: p0.vrfRequestSlot, phase: p0.phase };

    // ---- play: probes, join, liveness fallback
    let vrfSeenMs: number | null = null, probed = false, joinedNow = false, fallbackTicks = 0;
    let probeP: Promise<any> | null = null, joinP: Promise<any> | null = null, probeDone = !PROBE_ROUNDS.includes(k);
    let lastChange = Date.now(), lastKey = -1;
    const tLimit = Date.now() + 80_000;
    while (Date.now() < tLimit) {
      const p = tab;
      if (p && p.round === r) {
        if (p.vrfFulfils > 0 && vrfSeenMs === null) vrfSeenMs = Date.now() - tOpen;
        if (p.phase === PHASE.bell) break;
        if (p.phase * 100 + p.beat !== lastKey) { lastKey = p.phase * 100 + p.beat; lastChange = Date.now(); }
        if (p.phase === PHASE.live && Date.now() - lastChange > 3_500) {
          fallbackTicks++;
          const fb = await erSend([await ix(programOn(erH(), house).methods.tick().accountsPartial({ table, book, ...deskAccs(t) }))], `fallback tick ${t}/${r}`, 400_000 - fallbackTicks);
          fallbackSigs.add(fb.sig);
          lastChange = Date.now();
        }
        // probes and the join run beside this loop, so the bell is seen on time; the reveal waits for them
        if (!probed && PROBE_ROUNDS.includes(k) && p.phase === PHASE.live && p.beat >= 3) {
          probed = true;
          probeP = (async () => {
            const [a, b] = await Promise.all([privacyProbes(r, t, callers, sent, desks, book, tBot, tO, obs), permissionMembers(t, `round ${r} mid-round`)]);
            sum.privacyMid = a; sum.permissions = b; probeDone = true;
          })();
        }
        if (!joinedNow && probeDone && k === JOIN_ROUND && p.phase === PHASE.live && p.beat >= 8) {
          joinedNow = true;
          joinP = midLiveJoin(t, r, tBot, deskKey, deskTok, () => joinerSeq, (v: boolean) => { oldKeyOn = v; }).then((x) => { sum.join = x; });
        }
      }
      await sleep(50);
    }
    const tBell = tabEvents.find((e) => e.round === r && e.phase === PHASE.bell)?.t ?? Date.now();
    botsOn = false;
    oldKeyOn = false;
    const tWait = Date.now();
    await probeP; await joinP;
    sum.revealWaitedForProbesMs = Date.now() - tWait;
    // still sealed until the reveal: crank ticks of this round (signatures from the live "all" sample) are slot-only for everyone
    if (PROBE_ROUNDS.includes(k)) {
      const tsigs = [...new Set(obs.filter((o) => o.who.includes(" all") && o.budget && o.slot >= p0.openSlot).map((o) => o.sig))].slice(-3);
      const res: Record<string, string[]> = {};
      await Promise.all(Object.entries(callers).map(async ([who, url]) => { res[who] = await Promise.all(tsigs.map(async (sg) => { const x = (await getTx(url, sg)).body?.result; return isRedacted(x) ? `slot only (${x?.slot ?? "null"})` : "READABLE"; })); }));
      // pass also when no tick signature can be obtained before the reveal at all (nothing delivered or listed live)
      const pass = Object.values(res).every((v) => v.every((x) => x.startsWith("slot only")));
      evidence("1.mid", `round ${t}/${r} at the bell, before the reveal: getTransaction of ${tsigs.length} crank ticks`, { pass, sigs: tsigs, ...res });
      sum.tickRedacted = pass;
    }
    const pb = await readTable(t);
    if (pb.phase !== PHASE.bell) throw new Error(`round ${r}: no bell (phase ${pb.phase}, beat ${pb.beat})`);

    // ---- bell: reveal (cancels the crank), unseal, commit the Round alone
    const tReveal = Date.now();
    const rev = await erSend([await ix(programOn(erH(), house).methods.reveal().accountsPartial({ caller: house.publicKey, table, book, round }))], `reveal ${t}/${r}`, 400_000);
    const pr = await readTable(t);
    const tableLamBeforeCommit = (await readAccount(erUrl(tHouse), table)).lamports!;
    const tCommit = Date.now();
    sum.bellToCommitSentMs = tCommit - tBell;
    const com = await erSend([await ix(programOn(erH(), house).methods.commitRound(new BN(r)).accountsPartial({ house: house.publicKey, table, round, magicFeeVault: feeVault() }))], `commit_round ${t}/${r}`, 400_000);
    let roundBase: Buffer | null = null, tBase = 0;
    while (Date.now() - tCommit < 60_000) {
      const a = await readAccount(DEV.base, round);
      if (a.data && a.owner === PROGRAM_ID.toBase58() && a.data[144] === 2) { roundBase = a.data; tBase = Date.now(); break; }
      await sleep(200);
    }
    const rb = roundBase ? decodeRoundFull(roundBase) : null;
    // unseal after the commit (the Round needs no unseal; committing first gets it to base sooner)
    const items: [number, number, PublicKey][] = [[KIND.book, 0, book], ...desks.map((d, s) => [KIND.desk, s, d] as [number, number, PublicKey])];
    for (let i = 0; i < items.length; i += 3) {
      const ixs = await Promise.all(items.slice(i, i + 3).map(([kd, s, tg]) => ix(programOn(erH(), house).methods.unseal(kd, new BN(s)).accountsPartial({ house: house.publicKey, table, target: tg, permission: pda.perm(tg) }))));
      await erSend(ixs, `unseal ${t}/${r} ${i}`, 1_000_000);
    }
    sum.lamports = { afterUnseal: await poolLamports(t) };
    await sleep(1500);
    const pAfter = await readTable(t);
    const tableLamAfterCommit = (await readAccount(erUrl(tHouse), table)).lamports!;
    sum.bell = { bellBeat: pb.beat, bellSlot: pb.bellSlot, hideEndSlot: pb.hideEndSlot, resolves: pb.resolves, tickCallsAtBell: pb.tickCalls, tickCallsAtReveal: pr.tickCalls, tickCallsAfter: pAfter.tickCalls, revealSlot: pr.revealSlot, revealSig: rev.sig, fallbackTicks };
    sum.vrf = { requestSlot: pb.vrfRequestSlot, fulfilSlot: pb.vrfFulfilSlot, slots: pb.vrfFulfilSlot ? pb.vrfFulfilSlot - pb.vrfRequestSlot : null, fulfils: pb.vrfFulfils, tableFallback: pb.fallbackSeed, roundFallback: rb?.fallbackSeed, seenMsAfterOpenSent: vrfSeenMs };
    sum.commit = { sig: com.sig, ok: !!rb, owner: roundBase ? "program" : null, status: rb?.status, nBeats: rb?.nBeats, size: roundBase?.length, changedBytes: roundBase ? diffBytes(roundBase0, roundBase) : null, commitToBaseMs: rb ? tBase - tCommit : null, bellToBaseMs: rb ? tBase - tBell : null, tableLamportsBefore: tableLamBeforeCommit, tableLamportsAfter: tableLamAfterCommit };

    // ---- post-reveal reads (before the next re-seal hides them again)
    const R: number[] = [];
    for (let b = 0; b <= pb.beat; b++) R.push(resolveSlot.get(`${r}:${b}`) ?? -1);
    const cands = [...new Set(obs.filter((o) => o.who.includes(" all") && o.budget && o.slot >= p0.openSlot && o.slot <= pr.revealSlot + 400).map((o) => o.sig))];
    const allSubs = [...new Set(obs.filter((o) => o.who.includes(" all")).map((o) => o.who))];
    sum.allStream = { perSub: Object.fromEntries(allSubs.map((w) => [w, obs.filter((o) => o.who === w && o.budget && o.slot >= p0.openSlot && o.slot <= pr.revealSlot).length])), unionTickCandidates: cands.length };
    sum.ticks = await postRevealTicks(t, r, p0, pb, pr, cands, R);
    if (st.prevProbe && st.prevProbe.round === r) { st.prevProbe.tickSigs = sum.ticks.tickSigs; saveState(); }
    await sleep(3_000);
    sum.acts = await postRevealActs(r, sent, ALL_ACTS_ROUNDS.includes(k));
    if (PROBE_ROUNDS.includes(k)) await postRevealProbes(t, r, callers, sent, desks);
    // ---- after the reads: re-seat the desk a joiner took (REVEALED: join_bot may replace a human seat)
    if (joinedNow) {
      const d7 = decodeDeskFull((await readAccount(erUrl(), desks[7])).data!); // unsealed: public now
      const old = sent.filter((s) => s.round === r && s.who === "oldkey");
      const jn = sent.filter((s) => s.round === r && s.who === "joiner");
      sum.join.final = { deskKeyIsJoiner: d7.key === deskKey[7].publicKey.toBase58(), lastSeq: d7.lastSeq, joinerSeqSent: joinerSeq, joinerActs: jn.length, joinerAcked: jn.filter((s) => s.tAck).length, oldKeyActs: old.length,
        oldKeyActsIgnored: d7.lastSeq <= joinerSeq && old.length > 0, deskActsCounter: d7.acts };
      const name = Buffer.alloc(16); name.write(botName(7));
      await erSend([await ix(programOn(erH(), house).methods.joinBot(7, bots[7].publicKey, (7 % 3) + 1, Array.from(name)).accountsPartial({ house: house.publicKey, table, desk: desks[7], permission: pda.perm(desks[7]) }))], `join_bot re-seat ${t} 7`, 1_000_000);
      deskKey[7] = bots[7]; deskTok[7] = tBot[7];
      sum.join.reseated = (await readTable(t)).seats[7].key === bots[7].publicKey.toBase58();
    }


    const inRound = obs.filter((o) => o.slot > p0.openSlot && o.slot < pb.bellSlot);
    sum.logs = {
      // what counts is when a delivery arrives: during the round (open -> bell) or only once the round is public
      programFilterDeliveries: inRound.filter((o) => !o.who.includes(" all") && o.t < tBell).length,
      programFilterInRoundSlots: inRound.filter((o) => !o.who.includes(" all")).length,
      programFilterArrivedBeforeReveal: inRound.filter((o) => !o.who.includes(" all") && o.t < tReveal).length,
      programFilterFirstArrivalAfterRevealMs: (() => { const xs = inRound.filter((o) => !o.who.includes(" all")).map((o) => o.t - tReveal); return xs.length ? Math.min(...xs) : null; })(),
      byWho: hist(inRound.map((o) => `${o.who}${o.mentionsProgram ? "" : " (other)"}`)),
      allSampleCu: hist(inRound.filter((o) => o.who.includes(" all")).map((o) => o.cu)),
      allSampleProgramLogLines: inRound.filter((o) => o.who.includes(" all")).reduce((a, o) => a + o.lines, 0),
      allArrivedBeforeBell: inRound.filter((o) => o.who.includes(" all") && o.t < tBell).length,
      allArrivedBeforeReveal: inRound.filter((o) => o.who.includes(" all") && o.t < tReveal).length,
      allInRoundTotal: inRound.filter((o) => o.who.includes(" all")).length,
    };

    // ---- settle + claims (same tx), close the round, sweep the bettors
    sum.tape = await settleAndClose(t, r, bettors);
    // ---- acts: delivery
    await sleep(2_500);
    const rs = sent.filter((s) => s.round === r);
    const ack = rs.filter((s) => s.tAck).map((s) => s.tAck! - s.tSend);
    sum.sent = {
      n: rs.length, byWho: hist(rs.map((s) => s.who)), sendFailures: rs.filter((s) => !s.sig).length, txErr: rs.filter((s) => s.status?.err).length,
      missing: rs.filter((s) => s.status?.missing).length, unknown: rs.filter((s) => s.sig && !s.status).length, http: { ...sendStats.http },
      rate: Number((rs.filter((s) => s.who === "own" || s.who === "joiner" || s.who === "stale" || s.who === "wrong").length / NDESK / ((tBell - tOpen) / 1000)).toFixed(2)),
      ackMs: { n: ack.length, p50: pct(ack, 50), p95: pct(ack, 95), p99: pct(ack, 99), max: ack.length ? Math.max(...ack) : null },
    };
    sum.lamports.tableBeforeRound = lam0.table;
    sum.baseCostSol = sol(bal0 - (await bal()));
    summaries.push(sum);
    evidence("round", `round ${t}/${r} summary`, sum);
    st.nextRound[t] = r + 1;
    saveState();
  }
  clearInterval(statusTimer); clearInterval(bhTimer); clearInterval(tabTimer); clearInterval(deskPoll);
  for (const [cn, sid] of obsConns) await cn.removeOnLogsListener(sid).catch(() => {});
  for (let i = 0; i < NDESK; i++) await deskConns[i].removeAccountChangeListener(deskSubs[i]).catch(() => {});
  return { summaries, sent };
}

async function poolLamports(t: number) {
  const accs = [pda.table(t), pda.book(t), ...desksOf(t)];
  const tee = await Promise.all(accs.map((a) => readAccount(erUrl(tHouse), a).then((x) => x.lamports ?? null)));
  return { table: tee[0], book: tee[1], desks: tee.slice(2), total: tee.reduce((a, b) => a + (b ?? 0), 0) };
}

// ------------------------------------------------------------------ privacy probes (mid-round)
async function privacyProbes(r: number, t: number, callers: Record<string, string>, sent: Sent[], desks: PublicKey[], book: PublicKey, tBot: string[], tO: string, obs: any[]): Promise<boolean> {
  const t0 = Date.now();
  const aSent = sent.filter((s) => s.desk === 0 && s.round === r && s.sig && s.who === "own");
  const aChoice = aSent.filter((s) => s.kind !== 0 && s.phase === "live").slice(-1)[0]?.sig;
  const aNoop = aSent.filter((s) => s.kind === 0).slice(-1)[0]?.sig;
  const aHide = aSent.filter((s) => s.phase === "hide" && s.kind === 2)[0]?.sig;
  const openSlot = sent.filter((s) => s.round === r).length ? (await readTable(t)).openSlot : 0;
  const tickSig = [...obs].reverse().find((o) => o.who.includes(" all") && o.budget && o.slot >= openSlot && o.cu !== null && o.cu > 20_000 && o.cu < 100_000)?.sig;
  const out: any = { accounts: {}, txs: {}, sigLists: {}, ws: {} };
  const expectDesk: Record<string, number[]> = { A: [0], B: [1], O: [], anon: [] };
  let pass = true;
  // accountSubscribe for 6 s, in parallel with the reads: non-members get nothing; the member gets its own updates
  const ev: Record<string, number> = {};
  const subs: [Connection, number][] = [];
  const sub = (label: string, cn: Connection, acc: PublicKey) => { ev[label] = 0; subs.push([cn, cn.onAccountChange(acc, () => ev[label]++, "confirmed")]); };
  const anonC = erConn(), bC = erConn(tBot[1]), oC = erConn(tO), aC = erConn(tBot[0]);
  sub("anon book", anonC, book);
  for (let s = 0; s < NDESK; s++) sub(`anon desk${s}`, anonC, desks[s]);
  sub("B desk0", bC, desks[0]); sub("B book", bC, book);
  sub("O desk0", oC, desks[0]); sub("O book", oC, book);
  sub("A desk0 (own)", aC, desks[0]);
  const wsUntil = Date.now() + 6_000;
  const aSigs = new Set(sent.filter((s) => s.desk === 0 && s.sig && s.round === r && (s.who === "own" || s.who === "stale")).map((s) => s.sig));
  await Promise.all(Object.entries(callers).map(async ([who, url]) => {
    const accs: [string, PublicKey][] = [["book", book], ...desks.map((d, s) => [`desk${s}`, d] as [string, PublicKey])];
    const reads = await Promise.all(accs.map(async ([n, a]) => [n, !!(await readAccount(url, a)).data] as [string, boolean]));
    const readable = reads.filter(([, x]) => x).map(([n]) => n);
    out.accounts[who] = readable;
    if (JSON.stringify(readable) !== JSON.stringify(expectDesk[who].map((s) => `desk${s}`))) pass = false;
    const tx: any = {};
    await Promise.all(([["A choice act", aChoice], ["A no-op act", aNoop], ["A HIDE placement", aHide], ["crank tick", tickSig]] as [string, string | undefined][]).map(async ([label, sig]) => {
      if (!sig) { tx[label] = "n/a"; return; }
      const res = (await getTx(url, sig)).body?.result;
      tx[label] = isRedacted(res) ? `slot only (${res?.slot ?? "null"})` : `READABLE keys=${res.transaction?.message?.accountKeys?.length} logs=${res.meta?.logMessages?.length}`;
      if (!isRedacted(res)) pass = false;
    }));
    out.txs[who] = tx;
    if (who !== "A") {
      const lists: any = {};
      await Promise.all(([["desk0", desks[0]], ["book", book], ["table", pda.table(t)], ["program", PROGRAM_ID], ["A key", botsOf(t)[0].publicKey]] as [string, PublicKey][]).map(async ([label, acc]) => {
        const res = await rpc(url, "getSignaturesForAddress", [acc.toBase58(), { limit: 1000 }]);
        const list = res.body?.result;
        lists[label] = Array.isArray(list) ? list.filter((x: any) => aSigs.has(x.signature)).length : `err ${JSON.stringify(res.body?.error ?? res.http).slice(0, 60)}`;
        if (Array.isArray(list) && lists[label] !== 0) pass = false;
      }));
      out.sigLists[who] = lists;
    }
  }));
  await sleep(Math.max(0, wsUntil - Date.now()));
  for (const [cn, s] of subs) await cn.removeAccountChangeListener(s).catch(() => {});
  out.ws = ev;
  const nonMember = Object.entries(ev).filter(([k]) => !k.includes("(own)")).reduce((a, [, v]) => a + v, 0);
  if (nonMember !== 0 || ev["A desk0 (own)"] === 0) pass = false;
  out.sigsUsed = { aChoice, aNoop, aHide, tickSig };
  evidence("1.mid", `round ${t}/${r} mid-round privacy (A = desk 0's key, B = desk 1's key, O = outsider token, anon)`, { pass, ms: Date.now() - t0, ...out });
  st.prevProbe = { table: t, round: r, aChoice, aHide, aSigs: [...aSigs] };
  saveState();
  return pass;
}

async function postRevealProbes(t: number, r: number, callers: Record<string, string>, sent: Sent[], desks: PublicKey[]) {
  const pp = st.prevProbe;
  if (!pp || pp.round !== r) return;
  const res: any = {};
  for (const who of ["B", "anon"]) {
    const rr = pp.aChoice ? (await getTx(callers[who], pp.aChoice)).body?.result : null;
    const l = await rpc(callers[who], "getSignaturesForAddress", [desks[0].toBase58(), { limit: 1000 }]);
    res[who] = { aChoiceReadable: !isRedacted(rr), desk0Readable: !!(await readAccount(callers[who], desks[0])).data, desk0SigsListed: Array.isArray(l.body?.result) ? l.body.result.length : null };
  }
  evidence("1.after", `round ${t}/${r} after reveal + unseal: the round's history is public (until the next re-seal)`, res);
}

// ------------------------------------------------------------------ the post-reveal outsider view: ticks and acts with CU
async function postRevealTicks(t: number, r: number, p0: TableFull, pb: TableFull, pr: TableFull, cands: string[], R: number[]) {
  const url = erUrl();
  const sigs: any[] = [];
  let before: string | undefined;
  for (let i = 0; i < 10; i++) {
    const res = await rpc(url, "getSignaturesForAddress", [pda.table(t).toBase58(), { limit: 1000, ...(before ? { before } : {}) }]);
    const list = res.body?.result;
    if (!Array.isArray(list) || !list.length) break;
    sigs.push(...list);
    before = list[list.length - 1].signature;
    if (list[list.length - 1].slot < p0.openSlot) break;
  }
  // devnet-tee does not index crank ticks in signature lists: the tick signatures come from the live "all" sample
  const inRound = sigs.filter((x) => x.slot >= p0.openSlot && x.slot <= pr.revealSlot + 400);
  const listed = new Set(inRound.map((x) => x.signature));
  const todo = [...inRound.map((x) => x.signature), ...cands.filter((c) => !listed.has(c))];
  const txs = await mapLimit(todo, 8, async (sig) => {
    let res: any = null;
    for (let i = 0; i < 3 && !res; i++) { res = (await getTx(url, sig)).body?.result; if (!res) await sleep(400); }
    return { sig, slot: res?.slot ?? 0, err: res?.meta?.err ?? null, res };
  });
  const pid = PROGRAM_ID.toBase58();
  const ticks: any[] = [];
  let sample: any = null;
  for (const tx of txs) {
    const msg = tx.res?.transaction?.message;
    const keys: string[] = msg?.accountKeys ?? [];
    const logs: string[] = tx.res?.meta?.logMessages ?? [];
    // a tick: every top-level instruction of our program is `tick`, or (crank-wrapped) none is top-level and our program runs
    const progIxs = (msg?.instructions ?? []).filter((i: any) => keys[i.programIdIndex] === pid);
    const isTick = progIxs.length
      ? progIxs.every((i: any) => Buffer.from(bs58.decode(i.data)).subarray(0, 8).equals(TICK_DISC))
      : logs.some((l) => l.startsWith(`Program ${pid} invoke`)) && !logs.some((l) => l.startsWith("Program Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz invoke"));
    if (!isTick) continue;
    const k = { sig: tx.sig, slot: tx.slot, err: tx.res?.meta?.err ?? tx.err, cuTx: tx.res?.meta?.computeUnitsConsumed ?? null, cuProgram: programCu(logs), progLines: programLogLines(logs).length, feePayer: keys[0], otherLines: logs.filter((l) => !/^Program \w+ (invoke \[\d+\]|success|consumed \d+ of \d+ compute units)$/.test(l)) };
    if (!sample) sample = { sig: tx.sig, keys: keys.length, logs };
    ticks.push(k);
  }
  ticks.sort((a, b) => a.slot - b.slot);
  const crank = ticks.filter((x) => !fallbackSigs.has(x.sig));
  // resolving = the tick at a beat's resolve slot (Desk.result_slot, from the desks' own streams)
  const Rset = new Set(R.filter((x) => x > 0));
  const resolving = crank.filter((x) => Rset.has(x.slot));
  const noop = crank.filter((x) => !Rset.has(x.slot));
  const phaseAt = (slot: number) => (slot < pb.hideEndSlot ? "HIDE" : slot < pb.bellSlot ? "LIVE" : "BELL");
  const gaps = R.slice(1).map((s, i) => s - R[i]);
  const liveGaps = gaps.slice(1); // beat b-1 -> b for b >= 2 (the first gap includes the HIDE-end lateness)
  const lateness = R.map((s, b) => (b === 0 ? s - (p0.openSlot + pb.hideSlots) : s - (R[0] + b * pb.beatSlots)));
  const tickSlots = crank.map((x) => x.slot);
  const out = {
    tableListed: sigs.length, tableListedInRound: inRound.length, tickCandidatesFromAllStream: cands.length, readable: txs.filter((x) => !isRedacted(x.res)).length, ticks: crank.length, tickCallsOnTable: pr.tickCalls, houseFallbackTicks: ticks.length - crank.length,
    resolveSlotsComplete: R.every((x) => x > 0), resolveSlotsDistinct: new Set(R).size === R.length,
    resolvingSampled: resolving.length, resolvesOnTable: pb.resolves, bellBeat: pb.beat,
    cuResolving: hist(resolving.map((x) => x.cuProgram)), cuResolvingTx: hist(resolving.map((x) => x.cuTx)),
    cuNoopByPhase: Object.fromEntries(["HIDE", "LIVE", "BELL"].map((ph) => [ph, hist(noop.filter((x) => phaseAt(x.slot) === ph).map((x) => x.cuProgram))])),
    cuNoopTxByPhase: Object.fromEntries(["HIDE", "LIVE", "BELL"].map((ph) => [ph, hist(noop.filter((x) => phaseAt(x.slot) === ph).map((x) => x.cuTx))])),
    programLogLines: crank.reduce((a, x) => a + x.progLines, 0), otherLogLines: [...new Set(crank.flatMap((x) => x.otherLines))].slice(0, 6), errs: crank.filter((x) => x.err).length,
    beatGaps: hist(gaps), liveGaps: hist(liveGaps), lateness, tickIntervals: hist(tickSlots.slice(1).map((s, i) => s - tickSlots[i])),
    ticksAfterReveal: crank.filter((x) => x.slot > pr.revealSlot).length,
    sampleBeats: resolving.map((x) => R.indexOf(x.slot)),
    tickSigs: crank.filter((x, i) => i % 40 === 5).map((x) => x.sig).slice(0, 4),
  };
  evidence("2.ticks", `round ${t}/${r} crank ticks read back by anon after the reveal`, out);
  if (sample && !tickSampleShown) { tickSampleShown = true; evidence("2.ticks", "sample tick tx (anon, after the reveal)", sample); }
  return { ...out, resolvingSlots: R };
}

async function postRevealActs(r: number, sent: Sent[], all: boolean) {
  const url = erUrl();
  const mine = sent.filter((s) => s.round === r && s.sig && (all || s.desk === 0 || s.who !== "own"));
  const got = await mapLimit(mine, 8, async (s) => {
    let res: any = null;
    for (let i = 0; i < 3 && !res; i++) { res = (await getTx(url, s.sig!)).body?.result; if (!res) await sleep(500); }
    return { s, res };
  });
  const byClass: Record<string, Record<string, number>> = {};
  let progLines = 0, unread = 0;
  const cuAll: number[] = [];
  for (const { s, res } of got) {
    if (!res || isRedacted(res)) { unread++; continue; }
    const logs: string[] = res.meta?.logMessages ?? [];
    const cu = res.meta?.computeUnitsConsumed ?? -1;
    progLines += programLogLines(logs).length;
    const cls = `${s.phase}:${s.who}:${["noop", "ping", "requote"][s.kind] ?? `kind${s.kind}`}`;
    byClass[cls] ??= {};
    byClass[cls][cu] = (byClass[cls][cu] ?? 0) + 1;
    cuAll.push(cu);
  }
  const out = { read: got.length - unread, unread, programLogLines: progLines, distinctCu: hist(cuAll), byClass };
  evidence("2.acts", `round ${r} act txs read back by anon after the reveal (${all ? "all desks" : "desk 0 + wrong-key/stale/old-key/joiner"})`, out);
  return out;
}

// ------------------------------------------------------------------ mid-LIVE walletless join
async function midLiveJoin(t: number, r: number, tBot: string[], deskKey: Keypair[], deskTok: string[], seqNow: () => number, setOldKey: (v: boolean) => void) {
  const table = pda.table(t), desk = pda.desk(t, 7);
  const j = newBurner("joiners");
  const tJ = await tokenFor(j);
  const baseLamports = await bal(j.publicKey);
  const beforeRead = !!(await readAccount(erUrl(tJ), desk)).data;
  const name = Buffer.alloc(16); name.write("Guest");
  const t0 = Date.now();
  const r1 = await send(erConn(tJ), [await ix(programOn(erConn(tJ), j).methods.join(7, Array.from(name)).accountsPartial({ player: j.publicKey, table, desk, permission: pda.perm(desk) }))], [j], { cu: 400_000, skipPreflight: false, timeoutMs: 30_000 });
  houseTxs.push({ label: "join (burner)", layer: "tee", ok: r1.ok, sig: r1.sig, err: r1.ok ? undefined : r1.err });
  const joinMs = Date.now() - t0;
  if (!r1.ok) { evidence("join", "join FAILED", { err: r1.err, logs: r1.logs }); return { ok: false, err: r1.err }; }
  deskKey[7] = j; deskTok[7] = tJ;
  setOldKey(true);
  const tb = await readTable(t);
  const dj = await readAccount(erUrl(tJ), desk);
  const dOld = await readAccount(erUrl(tBot[7]), desk);
  const dAnon = await readAccount(erUrl(), desk);
  const d = dj.data ? decodeDeskFull(dj.data) : null;
  // let the joiner act for 4 s, then read its Desk: its acts are acknowledged, the old key's are not
  await sleep(4_000);
  const d2raw = (await readAccount(erUrl(tJ), desk)).data;
  const d2 = d2raw ? decodeDeskFull(d2raw) : null;
  const out = {
    ok: true, sig: r1.sig, joinMs, burner: j.publicKey.toBase58(), burnerBaseLamports: baseLamports, phaseAtJoin: tb.phase, beatAtJoin: tb.beat,
    burnerReadBefore: beforeRead, burnerReadsDesk: !!d && d.key === j.publicKey.toBase58(), oldBotReadsDesk: !!dOld.data, anonReadsDesk: !!dAnon.data,
    seat7: tb.seats[7], deskAfterJoin: d ? { key: d.key.slice(0, 8), lastSeq: d.lastSeq, resting: d.resting, phase: d.phase, round: d.round } : null,
    after4s: d2 ? { lastSeq: d2.lastSeq, joinerSeqSent: seqNow(), acksJoiner: d2.lastSeq > 0 && d2.lastSeq <= seqNow() } : null,
  };
  evidence("join", `round ${t}/${r} walletless join by a fresh 0-SOL burner mid-LIVE (seat 7)`, out);
  return out;
}

// ------------------------------------------------------------------ Tape: settle + claims, close, sweep
async function settleAndClose(t: number, r: number, bettors: { kp: Keypair; desk: number; amount: number }[]) {
  const round = pda.round(t, r), tape = pda.tape(t, r);
  const settleIx = async () => ix(progBase.methods.settleRound().accountsPartial({ caller: house.publicKey, round, tape }));
  const out: any = { calls: bettors.length, claims: [] };
  if (!bettors.length) await baseSend([await settleIx()], `settle_round ${t}/${r}`);
  for (const b of bettors) {
    const callAcc = await readAccount(DEV.base, callPda(tape, b.kp.publicKey));
    const before = await bal(b.kp.publicKey);
    const res = await baseSend([await settleIx(), await ix(progBase.methods.claimCall().accountsPartial({ caller: house.publicKey, tape, call: callPda(tape, b.kp.publicKey), bettor: b.kp.publicKey }))], `settle + claim ${t}/${r}`);
    const after = await bal(b.kp.publicKey);
    const c2 = await readAccount(DEV.base, callPda(tape, b.kp.publicKey));
    const owed = c2.data ? decodeCall(c2.data).owed : 0n;
    out.claims.push({ desk: b.desk, amount: b.amount, paid: after - before - (c2.data ? 0 : callAcc.lamports!), owed: owed.toString(), callOpen: !!c2.data, sig: res.sig, bettorBalanceBefore: before });
  }
  const tp = decodeTape((await readAccount(DEV.base, tape)).data!);
  out.tape = { winner: tp.winner, void: tp.void, resolved: tp.resolved, total: tp.total, paid: tp.paid, openCalls: tp.openCalls, pool: tp.pool };
  // a payout left owed: fund the bettor, claim again
  const owedOnes = out.claims.filter((c: any) => c.callOpen);
  for (const c of owedOnes) {
    const b = bettors.find((x) => x.desk === c.desk)!;
    const rent0 = await base.getMinimumBalanceForRentExemption(0);
    await baseSend([SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: b.kp.publicKey, lamports: rent0 })], "fund owed bettor to the rent minimum");
    const callLam = (await readAccount(DEV.base, callPda(tape, b.kp.publicKey))).lamports!;
    const before = await bal(b.kp.publicKey);
    await baseSend([await ix(progBase.methods.claimCall().accountsPartial({ caller: house.publicKey, tape, call: callPda(tape, b.kp.publicKey), bettor: b.kp.publicKey }))], `claim owed ${t}/${r}`);
    c.paidLater = (await bal(b.kp.publicKey)) - before - callLam;
  }
  const tp2 = decodeTape((await readAccount(DEV.base, tape)).data!);
  const sumPaid = out.claims.reduce((a: number, c: any) => a + c.paid + (c.paidLater ?? 0), 0);
  out.sumPaid = sumPaid;
  out.remainder = Number(tp2.total) - sumPaid;
  out.tapePaid = tp2.paid;
  const hb = await bal();
  const cl = await baseSend([await ix(progBase.methods.closeRound().accountsPartial({ house: house.publicKey, config: pda.config(), round, tape }))], `close_round ${t}/${r}`);
  out.close = { sig: cl.sig, houseDelta: (await bal()) - hb, roundGone: !(await readAccount(DEV.base, round)).data, tapeGone: !(await readAccount(DEV.base, tape)).data };
  // sweep the bettors back (each pays its own fee and ends at 0)
  let swept = 0;
  for (const b of bettors) {
    const x = await bal(b.kp.publicKey);
    if (x <= 5000) continue;
    await baseSend([SystemProgram.transfer({ fromPubkey: b.kp.publicKey, toPubkey: house.publicKey, lamports: x - 5000 })], "sweep bettor", [b.kp]);
    swept += x - 5000;
  }
  out.swept = swept;
  evidence("3.tape", `round ${t}/${r} settle_round + claim_call, close_round`, out);
  return out;
}

// ------------------------------------------------------------------ main
async function main() {
  const b0 = await bal();
  evidence("env", "run", { log: LOG_PATH, base: DEV.base, er: DEV.er, program: PROGRAM_ID.toBase58(), house: house.publicKey.toBase58(), phases: PHASES, pools: POOLS, pool: POOL, rounds: ROUNDS, balanceSol: sol(b0) });
  tHouse = await tokenFor(house);
  const v = await versionOnTee();
  evidence("deploy", "version simulated on the TEE", { version: v, expected: EXPECT_VERSION });
  if (v !== EXPECT_VERSION) throw new Error(`TEE serves version ${v}, expected ${EXPECT_VERSION}: wait (tests/devnet/version-gate.ts)`);
  if (PHASES.includes("config")) await ensureConfig();
  // bettors funded by an interrupted run: back to the house (each pays its own fee and ends at 0)
  for (const sk of st.bettors) {
    const b = kp(sk);
    const x = await bal(b.publicKey);
    if (x > 5000) { await baseSend([SystemProgram.transfer({ fromPubkey: b.publicKey, toPubkey: house.publicKey, lamports: x - 5000 })], "sweep leftover bettor", [b]); evidence("cost", "swept a leftover bettor", { key: b.publicKey.toBase58(), lamports: x - 5000 }); }
  }
  if (PHASES.includes("pools")) for (const t of POOLS) { const x = await bal(); await setupPool(t); evidence("cost", `pool ${t} setup`, { sol: sol(x - (await bal())) }); }
  if (PHASES.includes("perm")) for (const t of POOLS) await permissionMembers(t, "check");
  if (PHASES.includes("rounds")) {
    const { summaries, sent } = await runRounds(POOL, ROUNDS);
    verdicts(summaries, sent);
  }
  const failedHouse = houseTxs.filter((x) => !x.ok);
  evidence("end", "house/admin/bettor transactions of this run", { n: houseTxs.length, failed: failedHouse.length, byLayer: hist(houseTxs.map((x) => x.layer)) });
  const b1 = await bal();
  evidence("end", "balance", { beforeSol: sol(b0), afterSol: sol(b1), spentSol: sol(b0 - b1) });
  console.log("evidence log:", LOG_PATH);
  process.exit(0);
}

/** One PASS/FAIL line per A5 check, over every round of this run. */
function verdicts(S: any[], sent: Sent[]) {
  const V: { line: string; pass: boolean; detail: any }[] = [];
  const add = (line: string, pass: boolean, detail: any) => { V.push({ line, pass, detail }); };
  const merge = (hs: Record<string, number>[]) => hs.reduce((a, h) => { for (const [k, v] of Object.entries(h ?? {})) a[k] = (a[k] ?? 0) + v; return a; }, {} as Record<string, number>);
  const span = (h: Record<string, number>) => { const ks = Object.keys(h).map(Number).filter((x) => !isNaN(x)); return ks.length ? Math.max(...ks) - Math.min(...ks) : null; };
  // (2) constant compute
  const res = merge(S.map((s) => s.ticks.cuResolving)), resTx = merge(S.map((s) => s.ticks.cuResolvingTx));
  add("2 resolving ticks: one CU value", Object.keys(res).length === 1, { n: Object.values(res).reduce((a, b) => a + b, 0), program: res, tx: resTx, maxMinusMin: span(res) });
  for (const ph of ["HIDE", "LIVE", "BELL"]) {
    const h = merge(S.map((s) => s.ticks.cuNoopByPhase[ph])), ht = merge(S.map((s) => s.ticks.cuNoopTxByPhase[ph]));
    add(`2 no-op ticks ${ph}: one CU value`, Object.keys(h).length <= 1, { n: Object.values(h).reduce((a, b) => a + b, 0), program: h, tx: ht, maxMinusMin: span(h) });
  }
  const actCu = merge(S.map((s) => s.acts.distinctCu));
  const classes = Object.keys(merge(S.map((s) => Object.fromEntries(Object.keys(s.acts.byClass).map((k) => [k, 1])))));
  add("2 act: one CU value over every kind, phase, wrong key, stale seq, old key, joiner", Object.keys(actCu).length === 1, { n: Object.values(actCu).reduce((a, b) => a + b, 0), cu: actCu, classes, maxMinusMin: span(actCu) });
  add("2 no program log lines (ticks + acts)", S.every((s) => s.ticks.programLogLines === 0 && s.acts.programLogLines === 0), { ticks: S.map((s) => s.ticks.programLogLines), acts: S.map((s) => s.acts.programLogLines) });
  // (3) lifecycle
  const lat = S.flatMap((s) => s.ticks.lateness.slice(1).filter((x: number) => x > -1000));
  const latOk = lat.filter((x: number) => x >= 0 && x <= 1).length;
  const gaps = merge(S.map((s) => s.ticks.liveGaps));
  add("3 >= 20 live beats per round", S.every((s) => s.bell.bellBeat >= 20), { bellBeats: S.map((s) => s.bell.bellBeat) });
  add("3 beat gaps 150 +- 1 slots", Object.keys(gaps).every((g) => Math.abs(Number(g) - 150) <= 1), { gaps });
  add("3 resolve <= 1 slot after the deadline in >= 95 % of beats", lat.length > 0 && latOk / lat.length >= 0.95, { beats: lat.length, onTime: latOk, share: Number((latOk / Math.max(1, lat.length)).toFixed(4)), hist: hist(lat), hideEnd: S.map((s) => s.ticks.lateness[0]) });
  add("3 no double resolve (Table.resolves = bell beat + 1, one distinct resolve slot per beat)", S.every((s) => s.bell.resolves === s.bell.bellBeat + 1 && s.ticks.resolveSlotsComplete && s.ticks.resolveSlotsDistinct), { perRound: S.map((s) => `${s.bell.resolves}/${s.bell.bellBeat + 1}/${s.ticks.resolveSlotsComplete}/${s.ticks.resolveSlotsDistinct}`) });
  add("3 VRF callback <= 10 slots, exactly one fulfil, no fallback seed", S.every((s) => s.vrf.slots !== null && s.vrf.slots <= 10 && s.vrf.fulfils === 1 && s.vrf.tableFallback === 0 && s.vrf.roundFallback === 0), { slots: S.map((s) => s.vrf.slots), fulfils: S.map((s) => s.vrf.fulfils), fallback: S.map((s) => `${s.vrf.tableFallback}/${s.vrf.roundFallback}`) });
  add("3 0 ticks after the cancel", S.every((s) => s.bell.tickCallsAfter === s.bell.tickCallsAtReveal && s.ticks.ticksAfterReveal === 0), { perRound: S.map((s) => `${s.bell.tickCallsAtReveal}->${s.bell.tickCallsAfter}, listed after reveal ${s.ticks.ticksAfterReveal}`) });
  add("3 Round committed alone, owned by the program on base <= 10 s after the bell", S.every((s) => s.commit.ok && s.commit.bellToBaseMs <= 10_000), { bellToBaseMs: S.map((s) => s.commit.bellToBaseMs), commitToBaseMs: S.map((s) => s.commit.commitToBaseMs), changedBytes: S.map((s) => s.commit.changedBytes), size: S[0]?.commit.size });
  add("3 delegate -> usable <= 5 s (Round records)", S.every((s) => s.record.usableAfterConfirmMs !== null && s.record.usableAfterConfirmMs <= 5000), { ms: S.map((s) => s.record.usableAfterConfirmMs) });
  add("3 re-seal before HIDE (sealed = 1ff before every open)", S.every((s) => s.sealedBeforeOpen === "1ff"), { resealMs: S.map((s) => s.resealMs ?? null) });
  const tp = S.filter((s) => s.tape.calls > 0);
  add("3 settle + claims pay: sum of claims + remainder = pool, remainder < winning calls", tp.every((s) => s.tape.remainder >= 0 && s.tape.remainder < Math.max(1, s.tape.calls) && Number(s.tape.tapePaid) === s.tape.sumPaid), { perRound: tp.map((s) => ({ total: s.tape.tape.total, paid: s.tape.sumPaid, remainder: s.tape.remainder, void: s.tape.tape.void })) });
  const owed = S.flatMap((s) => s.tape.claims.filter((c: any) => c.callOpen));
  add("3 sub-minimum payout left owed (tx ok), paid once funded", owed.length > 0 && owed.every((c: any) => BigInt(c.owed) > 0n && c.paid === 0 && c.paidLater === c.amount), { owed });
  add("3 close_round: Round + Tape closed", S.every((s) => s.tape.close.roundGone && s.tape.close.tapeGone), {});
  const acts = sent;
  add("3 0 failed txs (acts: send, tx error, missing; house)", acts.every((s) => s.sig && !s.status?.err && !s.status?.missing) && houseTxs.every((x) => x.ok), { acts: acts.length, sendFail: acts.filter((s) => !s.sig).length, txErr: acts.filter((s) => s.status?.err).length, missing: acts.filter((s) => s.status?.missing).length, unknown: acts.filter((s) => s.sig && !s.status).length, house: houseTxs.length, houseFailed: houseTxs.filter((x) => !x.ok).length });
  add("3 no rate limiting (no HTTP 429)", !acts.some((s) => s.http === 429), { httpCodes: hist(acts.map((s) => s.http)) });
  // (1) privacy lines come from the per-round evidence (1.mid, 1.L20); the log streams:
  add("1 logsSubscribe(program / table / book) delivers nothing between open and bell", S.every((s) => s.logs.programFilterDeliveries === 0), { perRound: S.map((s) => s.logs.byWho) });
  for (const v of V) console.log(`${v.pass ? "PASS" : "FAIL"}  ${v.line}`);
  evidence("verdict", "A5 lines over this run", V);
}

main().catch((e) => { console.error(e); evidence("fatal", "error", String(e?.stack ?? e)); process.exit(1); });
