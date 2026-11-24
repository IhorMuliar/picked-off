// Offline checks of base-transaction rebroadcast (src/basesend.ts) against a fake RPC, and of the bounded wait for
// a late record before a round opens (Pool.next with a mocked chain). No cluster needed.
//   npx tsx house/test/rebroadcast.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { BaseSender, type BaseRpc, type BaseSendTiming, type Signed } from "../src/basesend.ts";
import { loadConfig } from "../src/config.ts";
import { Chain, PublicKey, SEAT, SEAL_ALL, PHASE } from "../src/chain.ts";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Pool } from "../src/pool.ts";
import { check, summary } from "./harness.ts";

const T: BaseSendTiming = { pollMs: 10, fastPollMs: 5, fastPolls: 5, rebroadcastMs: 40, heightEveryMs: 20, maxAttempts: 3, maxAttemptMs: 5_000 };
const BLOCK_MS = 10; // fake block height advances every 10 ms
const VALID_BLOCKS = 30; // a blockhash is valid for 300 ms

/** Fake base RPC: a sent signature executes once, `landMs` after the first copy the cluster keeps. */
class FakeRpc implements BaseRpc {
  t0 = Date.now();
  sends: { sig: string; preflight: boolean }[] = [];
  executed = new Map<string, { at: number; err: any }>();
  executions = 0;
  constructor(public o: { drop?: (sig: string, k: number) => boolean; landMs?: number; preflightFail?: boolean; failOnChain?: boolean } = {}) {}
  height() { return Math.floor((Date.now() - this.t0) / BLOCK_MS); }
  async sendRaw(bytes: Uint8Array, preflight: boolean) {
    const sig = Buffer.from(bytes).toString();
    const k = this.sends.filter((x) => x.sig === sig).length;
    this.sends.push({ sig, preflight });
    if (preflight && this.o.preflightFail) return { error: { message: "Transaction simulation failed: Error Code: TapeOpen", logs: ["Error Code: TapeOpen"] } };
    if (this.o.drop?.(sig, k)) return { result: sig }; // accepted by the RPC, never forwarded
    const exp = Number(sig.split(":")[1]);
    if (this.height() > exp) return { result: sig }; // blockhash expired: the cluster drops it
    if (!this.executed.has(sig)) { this.executed.set(sig, { at: Date.now() + (this.o.landMs ?? 15), err: this.o.failOnChain ? { InstructionError: [0, { Custom: 6000 }] } : null }); this.executions++; }
    return { result: sig };
  }
  async status(sig: string) {
    const e = this.executed.get(sig);
    return e && e.at <= Date.now() ? { confirmationStatus: "confirmed", err: e.err } : null;
  }
  async blockHeight() { return this.height(); }
}
function builder(rpc: FakeRpc) {
  let k = 0;
  const built: string[] = [];
  const build = async (): Promise<Signed> => {
    const lastValid = rpc.height() + VALID_BLOCKS;
    const sig = `tx${++k}:${lastValid}`;
    built.push(sig);
    return { bytes: Buffer.from(sig), sig, lastValidBlockHeight: lastValid };
  };
  return { build, built };
}
const firstSendsPreflighted = (rpc: FakeRpc) => [...new Set(rpc.sends.map((s) => s.sig))].every((sig) => rpc.sends.find((s) => s.sig === sig)!.preflight);

async function senderChecks() {
  {
    const rpc = new FakeRpc(); const b = builder(rpc); const s = new BaseSender(rpc, T);
    const r = await s.send(b.build);
    check("normal: one send with preflight, confirmed, no rebroadcast", r.ok && rpc.sends.length === 1 && rpc.sends[0].preflight && s.counters.sent === 1 && s.counters.rebroadcasts === 0, { r, counters: s.counters });
  }
  {
    const rpc = new FakeRpc({ drop: (_sig, k) => k === 0 }); const b = builder(rpc); const s = new BaseSender(rpc, T);
    const t0 = Date.now(); const r = await s.send(b.build); const ms = Date.now() - t0;
    const sigs = new Set(rpc.sends.map((x) => x.sig));
    check("dropped first send: same signature rebroadcast without preflight, confirmed within one rebroadcast interval, executed once",
      r.ok && sigs.size === 1 && b.built.length === 1 && rpc.sends.length >= 2 && rpc.sends[0].preflight && rpc.sends.slice(1).every((x) => !x.preflight) && rpc.executions === 1 &&
      s.counters.rebroadcasts >= 1 && s.counters.droppedThenConfirmed === 1 && ms < 4 * T.rebroadcastMs, { ms, sends: rpc.sends.length, counters: s.counters });
  }
  {
    const rpc = new FakeRpc({ landMs: 150 }); const b = builder(rpc); const s = new BaseSender(rpc, T);
    const r = await s.send(b.build);
    check("slow confirmation: rebroadcasts of the same bytes, one execution, one signed tx",
      r.ok && b.built.length === 1 && rpc.executions === 1 && s.counters.rebroadcasts >= 2 && s.counters.sent === 1, { sends: rpc.sends.length, counters: s.counters });
  }
  {
    const rpc = new FakeRpc({ drop: (sig) => sig.startsWith("tx1:") }); const b = builder(rpc); const s = new BaseSender(rpc, T);
    let asked = 0;
    const r = await s.send(b.build, { stillNeeded: async () => { asked++; return true; } });
    check("expiry: no rebuild before the blockhash expired; then re-checked, rebuilt (new signature, preflight on its first send), confirmed",
      r.ok && b.built.length === 2 && asked === 1 && r.sig.startsWith("tx2:") && firstSendsPreflighted(rpc) && s.counters.expired === 1 && s.counters.expiredRebuilt === 1 &&
      rpc.executions === 1, { built: b.built, counters: s.counters });
  }
  {
    const rpc = new FakeRpc({ drop: () => true }); const b = builder(rpc); const s = new BaseSender(rpc, T);
    const r = await s.send(b.build, { stillNeeded: async () => false });
    check("expiry, effect already on chain: not sent again (obsolete)", !r.ok && r.err === "obsolete" && b.built.length === 1 && s.counters.obsolete === 1 && s.counters.expiredRebuilt === 0, { counters: s.counters });
  }
  {
    const rpc = new FakeRpc({ failOnChain: true }); const b = builder(rpc); const s = new BaseSender(rpc, T);
    const r = await s.send(b.build, { stillNeeded: async () => true });
    check("landed and failed: reported, counted, never rebuilt", !r.ok && typeof r.err === "object" && b.built.length === 1 && s.counters.failedOnChain === 1 && s.counters.expiredRebuilt === 0, { r, counters: s.counters });
  }
  {
    const rpc = new FakeRpc({ preflightFail: true }); const b = builder(rpc); const s = new BaseSender(rpc, T);
    const r = await s.send(b.build);
    check("refused at preflight: nothing lands, no rebroadcast", !r.ok && rpc.sends.length === 1 && rpc.executions === 0 && s.counters.refused === 1 && s.counters.rebroadcasts === 0 && /TapeOpen/.test(String(r.err)), { r, counters: s.counters });
  }
  {
    let stop = false;
    const rpc = new FakeRpc({ drop: () => true }); const b = builder(rpc); const s = new BaseSender(rpc, T);
    setTimeout(() => { stop = true; }, 100);
    const r = await s.send(b.build, { abandoned: () => stop, stillNeeded: async () => true });
    const after = rpc.sends.length;
    check("abandoned by the caller: rebroadcasts stop, watched to expiry, never rebuilt", !r.ok && r.err === "abandoned" && b.built.length === 1 && s.counters.abandoned === 1 && after <= 1 + Math.ceil(100 / T.rebroadcastMs) + 1, { sends: after, counters: s.counters });
  }
  {
    const rpc = new FakeRpc(); const b = builder(rpc); const s = new BaseSender(rpc, T, () => {}, 2);
    const r1 = await s.send(b.build); const r2 = await s.send(b.build);
    const s2 = rpc.sends.filter((x) => x.sig === r2.sig);
    check("injected drop (every 2nd): first network send skipped, the first copy that goes out runs preflight, confirmed",
      r1.ok && r2.ok && s.counters.injectedDrops === 1 && s2.length >= 1 && s2[0].preflight && s.counters.droppedThenConfirmed === 1, { s2, counters: s.counters });
  }
  {
    const rpc = new FakeRpc({ preflightFail: true }); const b = builder(rpc); const s = new BaseSender(rpc, T, () => {}, 1);
    const r = await s.send(b.build);
    check("injected drop of a tx that would fail: refused at the first real send (preflight), nothing lands", !r.ok && rpc.executions === 0 && s.counters.refused === 1 && rpc.sends.every((x) => x.preflight), { counters: s.counters });
  }
}

// ------------------------------------------------------------------ Pool.next: bounded wait for a late record
async function poolChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "house-rebroadcast-"));
  const keyFile = path.join(dir, "house.json");
  fs.writeFileSync(keyFile, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  const cfg = loadConfig({ CLUSTER: "devnet", HOUSE_KEYPAIR: keyFile, STATE_DIR: dir, BOT_KEYS_DIR: path.join(dir, "bots"), BOTS: "0", RECORD_WAIT_MS: "400", RECORD_WAIT_PLAYER_MS: "1200", HOUSE_RPC_LOG: "off", HOUSE_LOG: path.join(dir, "h.log") });
  const chain = new Chain(cfg);
  (chain as any).ensureHouseToken = async () => {};
  chain.progEr = chain.program(chain.base, chain.house);
  chain.balanceLamports = 12e9;
  (chain as any).erUnix = async () => null;

  async function scenario(opts: { human: boolean; confirmAfterMs: number | null }) {
    const T0 = 4242, n = 8;
    const pool = new Pool(chain, T0) as any;
    const roundPda = chain.pda.round(T0, n).toBase58();
    let landed = false, abandoned: (() => boolean) | undefined;
    const roundBuf = Buffer.alloc(160); roundBuf.writeBigUInt64LE(BigInt(T0), 8); roundBuf.writeBigUInt64LE(BigInt(n), 16); roundBuf.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) - 10), 24); roundBuf[144] = 0;
    chain.baseRead.account = (async (acc: PublicKey) => acc.toBase58() === roundPda && landed ? { data: roundBuf, owner: DELEGATION_PROGRAM_ID.toBase58(), http: 200 } : { data: null, http: 200 }) as any;
    (chain as any).erRead = { account: async (acc: PublicKey) => acc.toBase58() === roundPda && landed ? { data: roundBuf, owner: chain.programId.toBase58(), http: 200 } : { data: null, http: 200 }, accounts: async () => [] };
    (chain as any).sendBase = async (_ixs: any, o: any) => {
      if (!o.label.endsWith(`/${n}`)) return { sig: "later", ms: 1, err: null, ok: true }; // the pipelined next record
      abandoned = o.abandoned;
      const t0 = Date.now();
      while (true) {
        if (opts.confirmAfterMs !== null && Date.now() - t0 >= opts.confirmAfterMs) { landed = true; return { sig: "created", ms: Date.now() - t0, err: null, ok: true }; }
        if (o.abandoned?.() && Date.now() - t0 > 2_000) return { sig: "x", ms: 0, err: "abandoned", ok: false };
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    let openRoundAcc: string | null | undefined;
    (chain as any).sendEr = async (ixs: any[]) => {
      // open_round: the Round account sits at its place in the account list (absent → the program id placeholder)
      openRoundAcc = ixs[0].keys.some((k: any) => k.pubkey.toBase58() === roundPda) ? roundPda : null;
      return { sig: "open", ms: 1, err: null, ok: true };
    };
    const seats = Array.from({ length: 8 }, (_, i) => ({ key: "", name: "", kind: opts.human && i === 0 ? SEAT.human : SEAT.bot, personality: 1 }));
    const t = { round: n - 1, phase: PHASE.revealed, sealed: SEAL_ALL, seats, vrfQueue: PublicKey.default, recorded: 0 };
    pool.snap = { table: t, slot: 0, at: Date.now(), slotMs: 10 };
    pool.records.lastRecordAt = 0; // cadence due: the round wants a record
    const t0 = Date.now();
    for (let i = 0; i < 100 && openRoundAcc === undefined; i++) await pool.next(t);
    return { ms: Date.now() - t0, // includes next()'s wait for the poller (none here)
      recorded: openRoundAcc === roundPda, opened: openRoundAcc !== undefined, late: pool.lateRecords, abandoned: abandoned?.() ?? false, wait: pool.recordWaitStats };
  }
  const a = await scenario({ human: false, confirmAfterMs: null });
  check("late record, no player: opens UNRECORDED after ≈ RECORD_WAIT_MS (400 ms here); the create stops rebroadcasting",
    a.opened && !a.recorded && a.late === 1 && a.abandoned && a.wait.maxMs >= 400 && a.wait.maxMs < 1_000, a);
  const b = await scenario({ human: true, confirmAfterMs: 700 });
  check("player seated, record confirms at 0.7 s (inside RECORD_WAIT_PLAYER_MS): waits and opens RECORDED", b.opened && b.recorded && b.late === 0 && !b.abandoned && b.wait.maxMs >= 700 && b.wait.maxMs < 1_200, b);
  const c = await scenario({ human: true, confirmAfterMs: null });
  check("player seated, record never confirms: opens unrecorded after ≈ RECORD_WAIT_PLAYER_MS (1.2 s here)", c.opened && !c.recorded && c.late === 1 && c.wait.maxMs >= 1_200 && c.wait.maxMs < 1_800, c);
  const d = await scenario({ human: false, confirmAfterMs: 100 });
  check("record confirms at 0.1 s (a rebroadcast recovered it): opens recorded, wait counted", d.opened && d.recorded && d.late === 0 && d.wait.maxMs >= 100, d);

  // a record whose drive is stuck on a slow base transaction holds up no other record, and is never driven twice
  const recs = (new Pool(chain, 4343) as any).records;
  recs.track(1); recs.track(2);
  const done: number[] = []; const starts: number[] = [];
  recs.drive = async (rec: any) => { starts.push(rec.n); await new Promise((r) => setTimeout(r, rec.n === 1 ? 600 : 20)); done.push(rec.n); };
  const tp = Date.now(); await recs.pass(); const passMs = Date.now() - tp;
  await new Promise((r) => setTimeout(r, 100)); await recs.pass();
  const midAge = recs.driveAgeSec;
  await recs.idle();
  check("record pass: a stalled record does not block the others or the caller; one drive per record at a time",
    passMs < 50 && done.join(",") === "2,2,1" && starts.filter((x) => x === 1).length === 1 && starts.filter((x) => x === 2).length === 2 && midAge === 0, { passMs, done, starts, midAge });
  fs.rmSync(dir, { recursive: true, force: true });
}

async function main() {
  await senderChecks();
  await poolChecks();
  process.exit(summary());
}
main().catch((e) => { console.error(e); process.exit(2); });
