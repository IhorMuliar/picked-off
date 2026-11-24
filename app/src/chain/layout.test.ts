import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import engineRaw from "../../../crates/ping-core/tests/vectors/engine.json?raw";
import { decodeRoundState, sha256, readRecord } from "../core";
import { DISC, SIZE, decodeBook, decodeCall, decodeConfig, decodeDesk, decodeRound, decodeTable, decodeTape, isAccount, LayoutError, type AccountName } from "./layout";
import { ACT_DISC } from "./wire";
import { IX_DISC } from "./ix";
import { Pdas } from "./pda";
import { PROGRAM_ID } from "./config";
import { buildReveal, recordFromBook, resultsOfBeat, printsOfBeat, bellChance, nextSkim } from "./views";

const enc = new TextEncoder();
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
const engine: { rounds: { table_id: number; round: number; record: string; commit: string; final_state: string }[] } = JSON.parse(engineRaw);

/** A zeroed account of `name` with its discriminator and a writer for LE fields. */
function fixture(name: AccountName) {
  const b = new Uint8Array(SIZE[name]);
  b.set(DISC[name], 0);
  const v = new DataView(b.buffer);
  return {
    b,
    u64: (o: number, x: bigint) => v.setBigUint64(o, x, true),
    i64: (o: number, x: bigint) => v.setBigInt64(o, x, true),
    u32: (o: number, x: number) => v.setUint32(o, x, true),
    u16: (o: number, x: number) => v.setUint16(o, x, true),
    u8: (o: number, x: number) => (b[o] = x),
    key: (o: number, k: PublicKey) => b.set(k.toBytes(), o),
    bytes: (o: number, x: Uint8Array) => b.set(x, o),
  };
}
const K = (n: number) => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n) & 0xff));

describe("discriminators", () => {
  it("accounts are sha256('account:<Name>')[0..8]", () => {
    for (const name of Object.keys(DISC) as AccountName[]) expect(Array.from(sha256(enc.encode(`account:${name}`)).slice(0, 8))).toEqual(DISC[name]);
  });
  it("instructions are sha256('global:<name>')[0..8]", () => {
    expect(Array.from(ACT_DISC)).toEqual(Array.from(sha256(enc.encode("global:act")).slice(0, 8)));
    for (const [n, d] of Object.entries(IX_DISC)) expect(Array.from(sha256(enc.encode(`global:${n}`)).slice(0, 8))).toEqual(d);
  });
  it("rejects short buffers and wrong discriminators", () => {
    expect(() => decodeTable(new Uint8Array(10))).toThrow(LayoutError);
    const f = fixture("Desk");
    expect(() => decodeTable(f.b)).toThrow(LayoutError);
    expect(isAccount(f.b, "Desk")).toBe(true);
    expect(isAccount(f.b, "Table")).toBe(false);
  });
});

describe("decoders by offset", () => {
  it("Table", () => {
    const f = fixture("Table");
    f.u64(8, 7n); f.u64(16, 42n); f.u64(24, 1000n); f.u64(32, 1500n); f.u64(40, 1650n); f.u64(48, 0n); f.i64(64, 123n);
    f.u64(80, 99n); f.u64(88, 3n); f.i64(112, 1_700_000_000n); f.u64(120, 150n); f.u64(128, 500n); f.u32(148, 34);
    f.key(152, K(1)); f.bytes(248, new Uint8Array(32).fill(0xaa)); f.bytes(280, new Uint8Array(32).fill(0xbb));
    // seat 2: human "bright-otter"; seat 5: bot Ghost
    f.key(312 + 56 * 2, K(2)); f.bytes(312 + 56 * 2 + 32, enc.encode("bright-otter")); f.u8(312 + 56 * 2 + 48, 1);
    f.key(312 + 56 * 5, K(5)); f.bytes(312 + 56 * 5 + 32, enc.encode("GHOST-1")); f.u8(312 + 56 * 5 + 48, 2); f.u8(312 + 56 * 5 + 49, 2);
    for (let s = 0; s < 8; s++) { f.u16(760 + 2 * s, s * 5); f.u16(776 + 2 * s, 100 + s); f.u16(792 + 2 * s, s); }
    f.u16(808, 0x1ff); f.u16(810, 3);
    // print ring: slot 33 % 32 = 1 -> beat 3, desk 2, 10 tenths
    f.u16(812 + 6 * 1, 10); f.u16(812 + 6 * 1 + 2, 3); f.u8(812 + 6 * 1 + 4, 2);
    f.u8(1004 + 2 * 3, 8); f.u8(1005 + 2 * 3, 1);
    f.u8(1068, 0); f.u8(1069, 2); f.u8(1072, 4); f.u8(1073, 1); f.u8(1074, 0); f.u8(1078, 1);
    const t = decodeTable(f.b);
    expect(t).toMatchObject({ tableId: 7n, round: 42n, openSlot: 1000n, hideEndSlot: 1500n, nextDeadlineSlot: 1650n, taskId: 123n, tickCalls: 99n, resolves: 3n,
      plannedStartUnix: 1_700_000_000n, beatSlots: 150n, hideSlots: 500n, printCount: 34, house: K(1).toBase58(), sealed: 0x1ff, beat: 3,
      kind: 0, phase: 2, topDesk: 4, recorded: 1, layout: 1 });
    expect(t.chainHead.every((x) => x === 0xaa) && t.commitHash.every((x) => x === 0xbb)).toBe(true);
    expect(t.seats[2]).toEqual({ key: K(2).toBase58(), name: "bright-otter", kind: 1, personality: 0 });
    expect(t.seats[5]).toEqual({ key: K(5).toBase58(), name: "GHOST-1", kind: 2, personality: 2 });
    expect(t.seats[0]).toEqual({ key: null, name: "", kind: 0, personality: 0 });
    expect(t.picked).toEqual([0, 5, 10, 15, 20, 25, 30, 35]);
    expect(t.totals[7]).toBe(107);
    expect(t.beatFill[3]).toBe(3);
    expect(t.prints[1]).toEqual({ tenths: 10, beat: 3, desk: 2 });
    expect(t.beatCounts[3]).toEqual([8, 1]);
    expect(printsOfBeat(t, 3)).toEqual([{ t: 9, desk: 2, tenths: 10 }, { t: 9, pings: 8, fills: 1 }]);
  });

  it("Desk with results[b] at 96 + 16b", () => {
    const f = fixture("Desk");
    f.u64(8, 7n); f.u64(16, 42n); f.u64(24, 555n); f.u64(32, 556n); f.key(40, K(9)); f.u32(72, 4_000_000_000); f.u32(76, 17);
    f.u16(80, 85); f.u16(82, 10); f.u16(84, 2); f.u8(86, 3); f.u8(87, 12); f.u8(88, 2); f.u8(89, 7); f.u8(90, 1); f.u8(91, 9); f.u8(92, 1); f.u8(93, 1);
    // beat 2: algo ping at 9 filled 10 from 2 victims; and lost 5 to one hit
    const o = 96 + 16 * 2;
    f.u16(o, 85); f.u16(o + 2, 10); f.u16(o + 4, 10); f.u16(o + 6, 5);
    [12, 1, 9, 1, 2, 2, 1, 7].forEach((x, i) => f.u8(o + 8 + i, x));
    const d = decodeDesk(f.b);
    expect(d).toMatchObject({ tableId: 7n, round: 42n, ackSlot: 555n, resultSlot: 556n, key: K(9).toBase58(), lastSeq: 4_000_000_000, acts: 17,
      resting: 85, picked: 10, beat: 2, index: 3, level: 12, phase: 2, nextAlgo: 7, pendingKind: 1, pendingLevel: 9, placed: 1, layout: 1 });
    expect(d.results).toHaveLength(30);
    expect(d.results[2]).toEqual({ resting: 85, picked: 10, fillAmt: 10, lostAmt: 5, level: 12, actionKind: 1, actionLevel: 9, actionAlgo: 1, result: 2, victims: 2, hitsTaken: 1, nextAlgo: 7 });
    expect(resultsOfBeat(2, d.results[2])).toEqual([
      { beat: 2, kind: "fill", level: 9, tenths: 10, algo: true, next: 10 },
      { beat: 2, kind: "pickedoff", tenths: 5, count: 1, algo: false, next: 10 },
    ]);
    expect(resultsOfBeat(0, d.results[2])).toEqual([]);
  });

  it("Book embeds RoundState at 40 (engine vector bytes)", () => {
    const r = engine.rounds[0];
    const f = fixture("Book");
    f.u64(8, BigInt(r.table_id)); f.u64(16, BigInt(r.round)); f.u64(24, 77n);
    f.bytes(40, unhex(r.final_state)); f.u8(1184, 1);
    const b = decodeBook(f.b);
    expect(b.tableId).toBe(BigInt(r.table_id));
    expect(b.round).toBe(BigInt(r.round));
    expect(b.vrfSlot).toBe(77n);
    expect(b.layout).toBe(1);
    expect(b.state).toEqual(decodeRoundState(unhex(r.final_state)));
    // a record rebuilt from the unsealed Book equals the engine's record
    expect(Buffer.from(recordFromBook(b.state, b.tableId, b.round)).toString("hex")).toBe(r.record);
  });

  it("Round record at 160 verifies against its commit hash; a flipped byte fails", () => {
    for (const r of engine.rounds.slice(0, 4)) {
      const f = fixture("Round");
      f.u64(8, BigInt(r.table_id)); f.u64(16, BigInt(r.round)); f.i64(24, 1_700_000_000n); f.u64(48, 9000n); f.key(64, K(3));
      f.bytes(96, unhex(r.commit)); f.u8(144, 2); f.u8(146, 3); f.u8(148, readRecord(unhex(r.record)).bellBeat); f.u8(150, 1);
      f.bytes(152, Uint8Array.of(1, 2, 2, 2, 2, 2, 2, 2)); f.bytes(160, unhex(r.record));
      const d = decodeRound(f.b);
      expect(d).toMatchObject({ tableId: BigInt(r.table_id), round: BigInt(r.round), plannedStartUnix: 1_700_000_000n, bellSlot: 9000n, topKey: K(3).toBase58(), status: 2, topDesk: 3, layout: 1 });
      expect(d.seatKind).toEqual([1, 2, 2, 2, 2, 2, 2, 2]);
      expect(d.record).toHaveLength(522);
      const ok = buildReveal(d.record, d.commitHash, r.round)!;
      expect(ok.check.state).toBe("ok");
      expect(ok.view.beats).toHaveLength(ok.view.bellBeat);
      expect(ok.view.totals.reduce((a, b) => a + b, 0)).toBe(800);
      for (const beat of ok.view.beats) {
        expect(beat.actions).toHaveLength(8);
        expect(new Set(beat.actions.map((a) => a.desk)).size).toBe(8);
        for (const x of beat.fills) expect(x.tenths % 5).toBe(0);
      }
      const bad = d.record.slice();
      bad[100] ^= 1;
      expect(buildReveal(bad, d.commitHash, r.round)?.check.state ?? "fail").toBe("fail");
      const badCommit = d.commitHash.slice();
      badCommit[0] ^= 1;
      expect(buildReveal(d.record, badCommit, r.round)!.check.state).toBe("fail");
    }
  });

  it("Tape, Call, Config", () => {
    const t = fixture("Tape");
    t.u64(8, 7n); t.u64(16, 42n); t.i64(24, 1_700_000_020n);
    for (let s = 0; s < 8; s++) t.u64(32 + 8 * s, BigInt(s) * 10_000_000n);
    t.u64(96, 280_000_000n); t.u64(104, 1n); t.u32(112, 5); t.u32(116, 28); t.u8(120, 6); t.u8(121, 1); t.u8(122, 0); t.u8(124, 1);
    expect(decodeTape(t.b)).toEqual({ tableId: 7n, round: 42n, closeUnix: 1_700_000_020n, pool: [0n, 10_000_000n, 20_000_000n, 30_000_000n, 40_000_000n, 50_000_000n, 60_000_000n, 70_000_000n],
      total: 280_000_000n, paid: 1n, openCalls: 5, nCalls: 28, winner: 6, resolved: 1, void: 0, layout: 1 });
    const c = fixture("Call");
    c.u64(8, 10_000_000n); c.u64(16, 3n); c.key(24, K(4)); c.key(56, K(5)); c.u8(88, 6); c.u8(89, 1); c.u8(91, 1);
    expect(decodeCall(c.b)).toEqual({ amount: 10_000_000n, owed: 3n, tape: K(4).toBase58(), bettor: K(5).toBase58(), desk: 6, claimed: 1, layout: 1 });
    const g = fixture("Config");
    g.u64(8, 150n); g.u64(16, 500n); g.u64(24, 10_000_000n); g.u64(32, 1_000_000n); g.u32(40, 250); g.u32(52, 250); g.u32(56, 5); g.u32(60, 15);
    g.key(96, K(8)); g.u8(195, 20); g.u8(196, 29); g.u8(197, 4); g.u8(198, 10); g.u8(199, 8); g.u8(200, 24); g.u8(202, 1);
    expect(decodeConfig(g.b)).toMatchObject({ beatSlots: 150n, hideSlots: 500n, callLamports: 10_000_000n, lotLamports: 1_000_000n, crankIntervalMs: 250, actIntervalMs: 250,
      hideSecs: 5, tapeCloseSecs: 15, house: K(8).toBase58(), bellMin: 20, bellMax: 29, algoMemory: 4, tapeCloseBeat: 10, nDesks: 8, levels: 24, layout: 1 });
  });
});

describe("PDAs", () => {
  const p = new Pdas(PROGRAM_ID);
  const prog = new PublicKey(PROGRAM_ID);
  const le8 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
  const find = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, prog)[0].toBase58();
  it("match the documented seeds", () => {
    expect(p.config().toBase58()).toBe(find([Buffer.from("config")]));
    expect(p.table(1n).toBase58()).toBe(find([Buffer.from("table"), le8(1n)]));
    expect(p.book(1n).toBase58()).toBe(find([Buffer.from("book"), le8(1n)]));
    for (let s = 0; s < 8; s++) expect(p.desk(1n, s).toBase58()).toBe(find([Buffer.from("desk"), le8(1n), Buffer.from([s])]));
    expect(p.round(1n, 9n).toBase58()).toBe(find([Buffer.from("round"), le8(1n), le8(9n)]));
    expect(p.tape(1n, 9n).toBase58()).toBe(find([Buffer.from("tape"), le8(1n), le8(9n)]));
    expect(p.ledger(2n).toBase58()).toBe(find([Buffer.from("ledger"), le8(2n)]));
    const tape = p.tape(1n, 9n);
    expect(p.call(tape, K(1)).toBase58()).toBe(find([Buffer.from("call"), tape.toBuffer(), K(1).toBuffer()]));
  });
  it("permission PDA equals the SDK's", () => {
    const d = p.desk(1n, 3);
    expect(p.permission(d).toBase58()).toBe(permissionPdaFromAccount(d).toBase58());
  });
  it("distinct seats and tables give distinct desks", () => {
    const all = new Set<string>();
    for (const t of [1n, 2n]) for (let s = 0; s < 8; s++) all.add(p.desk(t, s).toBase58());
    expect(all.size).toBe(16);
    expect(bs58.decode(p.table(1n).toBase58())).toHaveLength(32);
  });
});

describe("view helpers", () => {
  it("bell chance follows the uniform bell", () => {
    expect(bellChance(19)).toBe(0);
    expect(bellChance(20)).toBeCloseTo(0.1);
    expect(bellChance(29)).toBe(1);
  });
  it("next skim steps 5 -> 10 -> 15 and caps", () => {
    expect(nextSkim(5, 1)).toBe(10);
    expect(nextSkim(10, 1)).toBe(15);
    expect(nextSkim(15, 1)).toBe(15);
    expect(nextSkim(10, 2)).toBe(10);
  });
});
