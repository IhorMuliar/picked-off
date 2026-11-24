/**
 * Devnet drip: tops a browser key up to enough devnet SOL for one Tape call
 * (the 0.01 call + the Call account's rent + fees). Free play never needs it.
 *
 *   POST /api/drip  {"address": "<base58 public key>"}
 *     200 {ok:true, sig, lamports}
 *     4xx/5xx {ok:false, error:<code>, message}
 *   GET  /api/drip  -> {ok, enabled, address, balance, lamports, floor, today, dailyCap}
 *
 * Server-side env (never VITE_*): DRIP_SECRET_KEY (JSON array of 64 bytes, a devnet-only key),
 * optional DRIP_LAMPORTS (12000000: the balance a drip tops up to), DRIP_CALL_COST (11690400: below
 * this a key cannot call), DRIP_FLOOR_LAMPORTS (100000000), DRIP_DAILY_CAP (50), DRIP_IP_DAILY_CAP (3),
 * DRIP_ADDRESS_DAILY_CAP (3), DRIP_RPC (defaults to VITE_BASE_RPC, then the public devnet RPC),
 * DRIP_DISABLED=1 to switch it off.
 *
 * Limits, without a database:
 *  - the address must be a plain ed25519 key (on curve) holding no data and less than one call's cost;
 *    it is topped up to DRIP_LAMPORTS, never more;
 *  - at most DRIP_ADDRESS_DAILY_CAP drips per address per rolling 24 h, counted from its on-chain history;
 *  - a global cap per 24 h, counted from the drip key's own on-chain signatures (shared by all instances)
 *    and re-read immediately before signing;
 *  - a per-IP cap per 24 h, in memory: per function instance, reset on a cold start (weak);
 *  - per instance, drips run one at a time from a short bounded queue (429 beyond it); the IP slot and an
 *    in-flight count are reserved before any RPC work and released if the drip fails, and in-flight drips
 *    count against the daily cap and the floor;
 *  - the drip key keeps a floor balance; below it the drip refuses (the hard stop across instances);
 *  - the cluster must be devnet (genesis hash), or nothing is sent.
 *
 * Plain JSON-RPC + tweetnacl (no web3.js: its websocket dependency does not load in the function runtime).
 * Every transfer is sent with preflight on, so a failing one never lands.
 */
import nacl from "tweetnacl";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";

declare const process: { env: Record<string, string | undefined> };

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const DAY_MS = 86_400_000;
const HISTORY_LIMIT = 100;

const num = (name: string, dflt: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
const LAMPORTS = num("DRIP_LAMPORTS", 12_000_000);
const CALL_COST = Math.min(num("DRIP_CALL_COST", 11_690_400), LAMPORTS);
const ADDRESS_DAILY_CAP = num("DRIP_ADDRESS_DAILY_CAP", 3);
const QUEUE_MAX = 4;
const FLOOR = num("DRIP_FLOOR_LAMPORTS", 100_000_000);
const DAILY_CAP = num("DRIP_DAILY_CAP", 50);
const IP_DAILY_CAP = num("DRIP_IP_DAILY_CAP", 3);
const RPC = process.env.DRIP_RPC || process.env.VITE_BASE_RPC || "https://rpc.magicblock.app/devnet";

const byIp = new Map<string, number[]>();
const pending = new Set<string>();
let inFlight = 0;
let queued = 0;
let chain: Promise<unknown> = Promise.resolve();
/** Run `f` after every earlier drip of this instance has finished (one at a time). */
function serial<T>(f: () => Promise<T>): Promise<T> {
  const run = chain.then(f, f);
  chain = run.catch(() => {});
  return run;
}
let devnetChecked = false;
let key: { secretKey: Uint8Array; publicKey: Uint8Array; address: string } | null = null;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const fail = (status: number, error: string, message: string) => json(status, { ok: false, error, message });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let rpcId = 0;
async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? "RPC error"}`);
  return body.result as T;
}

function dripKey() {
  if (key) return key;
  const raw = process.env.DRIP_SECRET_KEY;
  if (!raw) return null;
  try {
    const secretKey = Uint8Array.from(JSON.parse(raw) as number[]);
    const kp = nacl.sign.keyPair.fromSecretKey(secretKey);
    key = { secretKey: kp.secretKey, publicKey: kp.publicKey, address: bs58.encode(kp.publicKey) };
  } catch {
    return null;
  }
  return key;
}

function onCurve(b: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(b);
    return true;
  } catch {
    return false;
  }
}

async function isDevnet(): Promise<boolean> {
  if (!devnetChecked) devnetChecked = (await rpc<string>("getGenesisHash")) === DEVNET_GENESIS;
  return devnetChecked;
}

type Sig = { signature: string; err: unknown; blockTime: number | null };
const signatures = (addr: string, limit: number) => rpc<Sig[]>("getSignaturesForAddress", [addr, { limit, commitment: "confirmed" }]);
const balance = async (addr: string) => (await rpc<{ value: number }>("getBalance", [addr, { commitment: "confirmed" }])).value;

async function sentToday(addr: string): Promise<number> {
  const since = (Date.now() - DAY_MS) / 1000;
  return (await signatures(addr, 1000)).filter((s) => s.err === null && (s.blockTime ?? 0) >= since).length;
}

/** Drips (transactions paid by the drip key) that `to` received in the last 24 h; Infinity if its history is too busy to tell. */
async function dripsToday(to: string, from: string): Promise<number> {
  const since = (Date.now() - DAY_MS) / 1000;
  const sigs = (await signatures(to, HISTORY_LIMIT)).filter((s) => (s.blockTime ?? since) >= since);
  if (sigs.length >= HISTORY_LIMIT) return Infinity;
  const txs = await Promise.all(
    sigs.map((s) =>
      rpc<{ transaction: { message: { accountKeys: string[] } } } | null>("getTransaction", [
        s.signature,
        { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 },
      ]),
    ),
  );
  return txs.filter((tx) => tx?.transaction.message.accountKeys[0] === from).length;
}

/** A legacy transaction with one SystemProgram transfer, signed by the drip key; base64. */
function transferTx(k: NonNullable<typeof key>, to: Uint8Array, lamports: number, blockhash: string): string {
  const data = new Uint8Array(12);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 2, true); // SystemInstruction::Transfer
  dv.setBigUint64(4, BigInt(lamports), true);
  const msg = new Uint8Array([
    1, 0, 1, // header: 1 signer, 0 read-only signed, 1 read-only unsigned (the system program)
    3, ...k.publicKey, ...to, ...bs58.decode(SYSTEM_PROGRAM),
    ...bs58.decode(blockhash),
    1, 2, 2, 0, 1, data.length, ...data, // 1 ix: program 2, accounts [0, 1], data
  ]);
  const sig = nacl.sign.detached(msg, k.secretKey);
  const tx = new Uint8Array([1, ...sig, ...msg]);
  return btoa(String.fromCharCode(...tx));
}

async function confirm(sig: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const st = await rpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [[sig]]);
    const v = st.value[0];
    if (v?.err) throw new Error(`transfer failed: ${JSON.stringify(v.err)}`);
    if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) return;
    await sleep(500);
  }
  throw new Error("transfer not confirmed in 30 s");
}

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "";
  return xff.split(",")[0].trim() || "unknown";
}

/** Reserve one drip for `ip` (released with the returned function if the drip fails); null if over the cap. */
function reserveIp(ip: string): (() => void) | null {
  const t = Date.now();
  const recent = (byIp.get(ip) ?? []).filter((x) => x > t - DAY_MS);
  if (byIp.size > 10_000) byIp.clear();
  if (recent.length >= IP_DAILY_CAP) {
    byIp.set(ip, recent);
    return null;
  }
  byIp.set(ip, [...recent, t]);
  return () => byIp.set(ip, (byIp.get(ip) ?? []).filter((x) => x !== t));
}

export async function GET(): Promise<Response> {
  const k = dripKey();
  if (!k) return fail(503, "not_configured", "the drip has no key");
  try {
    const [bal, today] = await Promise.all([balance(k.address), sentToday(k.address)]);
    return json(200, {
      ok: true, enabled: process.env.DRIP_DISABLED !== "1", address: k.address,
      balance: bal, lamports: LAMPORTS, callCost: CALL_COST, floor: FLOOR, today, dailyCap: DAILY_CAP, addressDailyCap: ADDRESS_DAILY_CAP,
    });
  } catch (e) {
    return fail(502, "rpc_error", (e as Error).message);
  }
}

export async function POST(req: Request): Promise<Response> {
  if (process.env.DRIP_DISABLED === "1") return fail(503, "disabled", "the drip is switched off");
  const k = dripKey();
  if (!k) return fail(503, "not_configured", "the drip has no key");

  let address = "";
  try {
    const body = (await req.json()) as { address?: unknown };
    address = typeof body?.address === "string" ? body.address.trim() : "";
  } catch {
    return fail(400, "bad_request", 'send JSON {"address": "<base58 public key>"}');
  }
  let to: Uint8Array;
  try {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw new Error();
    to = bs58.decode(address);
    if (to.length !== 32) throw new Error();
  } catch {
    return fail(400, "bad_address", "not a base58 public key");
  }
  if (!onCurve(to)) return fail(400, "bad_address", "not a wallet key (off curve)");
  if (address === k.address) return fail(400, "bad_address", "that is the drip itself");

  const ip = clientIp(req);
  if (pending.has(address)) return fail(409, "in_flight", "a drip to this key is already on its way");
  if (queued >= QUEUE_MAX) return fail(429, "busy", "the drip is busy; try again in a few seconds");
  const releaseIp = reserveIp(ip);
  if (!releaseIp) return fail(429, "ip_limit", `at most ${IP_DAILY_CAP} drips per day from one address`);

  pending.add(address);
  queued++;
  let sent = false;
  try {
    return await serial(async () => {
      inFlight++;
      try {
        if (!(await isDevnet())) return fail(403, "devnet_only", "the drip runs on devnet only");
        const acct = await rpc<{ value: { lamports: number; owner: string; data: [string, string] } | null }>("getAccountInfo", [
          address, { commitment: "confirmed", encoding: "base64" },
        ]);
        const a = acct.value;
        if (a && (a.data[0].length > 0 || a.owner !== SYSTEM_PROGRAM)) return fail(400, "bad_address", "not a plain wallet key");
        const has = a?.lamports ?? 0;
        if (has >= CALL_COST) return fail(409, "funded", "this key already holds enough devnet SOL for a call");
        if ((await dripsToday(address, k.address)) >= ADDRESS_DAILY_CAP)
          return fail(429, "address_limit", `this key had its ${ADDRESS_DAILY_CAP} drips for today`);
        const amount = LAMPORTS - has;
        // cross-instance guard: re-read the drip key's own history and balance right before signing
        const [dripBal, today] = await Promise.all([balance(k.address), sentToday(k.address)]);
        if (dripBal < FLOOR + amount * inFlight) return fail(503, "empty", "the drip is out of devnet SOL for now");
        if (today + inFlight > DAILY_CAP) return fail(429, "daily_limit", "the drip's daily limit is reached; try tomorrow");

        const { value } = await rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
        const sig = await rpc<string>("sendTransaction", [
          transferTx(k, to, amount, value.blockhash),
          { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 },
        ]);
        sent = true;
        await confirm(sig);
        return json(200, { ok: true, sig, lamports: amount });
      } finally {
        inFlight--;
      }
    });
  } catch (e) {
    return fail(502, "send_failed", (e as Error).message.slice(0, 300));
  } finally {
    queued--;
    pending.delete(address);
    // a drip that never reached the network does not use up the IP's allowance
    if (!sent) releaseIp();
  }
}
