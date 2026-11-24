import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { ACT_LEN, buildActTx, decodeAct, encodeAct, encodeName, fromBase64, toBase64 } from "./wire";
import { ActScheduler, type SendJob } from "./scheduler";
import { ActSender, type FromWorker } from "./actsender";
import { PROGRAM_ID } from "./config";

describe("act wire format", () => {
  it("is 30 bytes: disc · kind · level · seq u32 LE · salt[16]", () => {
    const salt = Uint8Array.from({ length: 16 }, (_, i) => 0xf0 + i);
    const b = encodeAct(2, 24, 0x01020304, salt);
    expect(b.length).toBe(ACT_LEN);
    expect(Array.from(b.subarray(0, 8))).toEqual([114, 158, 229, 112, 242, 50, 227, 5]);
    expect(b[8]).toBe(2);
    expect(b[9]).toBe(24);
    expect(Array.from(b.subarray(10, 14))).toEqual([4, 3, 2, 1]);
    expect(Array.from(b.subarray(14))).toEqual(Array.from(salt));
    expect(decodeAct(b)).toEqual({ kind: 2, level: 24, seq: 0x01020304, salt });
    expect(() => encodeAct(0, 0, -1, salt)).toThrow();
    expect(() => encodeAct(0, 0, 2 ** 32, salt)).toThrow();
    expect(() => encodeAct(0, 0, 1, new Uint8Array(15))).toThrow();
  });

  it("hand-built transaction parses with web3.js, is signed by the player, touches only desk + book", () => {
    const kp = Keypair.generate();
    const desk = Keypair.generate().publicKey;
    const book = Keypair.generate().publicKey;
    const bh = bs58.encode(nacl.randomBytes(32));
    const salt = nacl.randomBytes(16);
    const tx = buildActTx(
      { player: kp.publicKey.toBytes(), desk: desk.toBytes(), book: book.toBytes(), program: new PublicKey(PROGRAM_ID).toBytes() },
      kp.secretKey, bh, 1, 7, 99, salt,
    );
    const parsed = Transaction.from(Buffer.from(tx.bytes));
    expect(parsed.verifySignatures()).toBe(true);
    expect(bs58.encode(parsed.signature!)).toBe(tx.signature);
    expect(parsed.feePayer?.toBase58()).toBe(kp.publicKey.toBase58());
    expect(parsed.recentBlockhash).toBe(bh);
    expect(parsed.instructions).toHaveLength(1);
    const ix = parsed.instructions[0];
    expect(ix.programId.toBase58()).toBe(PROGRAM_ID);
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [kp.publicKey.toBase58(), true, true],
      [desk.toBase58(), false, true],
      [book.toBase58(), false, true],
    ]);
    expect(Buffer.from(ix.data)).toEqual(Buffer.from(encodeAct(1, 7, 99, salt)));
    expect(fromBase64(toBase64(tx.bytes))).toEqual(tx.bytes);
  });

  it("seat names are 16 bytes, zero padded, cut on a character boundary", () => {
    expect(Array.from(encodeName("ab"))).toEqual([97, 98, ...new Array(14).fill(0)]);
    expect(encodeName("é".repeat(9)).filter((x) => x !== 0)).toHaveLength(16);
    expect(encodeName("€€€€€€").filter((x) => x !== 0)).toHaveLength(15);
  });
});

describe("constant-rate scheduler", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  const make = (jobs: SendJob[], salts: Uint8Array[] = []) =>
    new ActScheduler({
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      random: (n) => {
        const s = nacl.randomBytes(n);
        salts.push(s);
        return s;
      },
      send: (j) => jobs.push(j),
    });

  it("sends exactly one act per 250 ms, phase-locked so the last send of a beat leaves 200 ms before its deadline", () => {
    const jobs: SendJob[] = [];
    const s = make(jobs);
    const deadline = Date.now() + 1500;
    s.setPlan({ phase: "live", deadline, beatMs: 1500 });
    // the main thread posts the next deadline ~100 ms after each beat closes
    for (let b = 0; b < 40; b++) {
      vi.advanceTimersByTime(1500);
      s.setPlan({ phase: "live", deadline: deadline + (b + 1) * 1500, beatMs: 1500 });
    }
    expect(jobs.length).toBeGreaterThanOrEqual(239);
    expect(jobs.length).toBeLessThanOrEqual(241);
    for (let i = 1; i < jobs.length; i++) expect(jobs[i].at - jobs[i - 1].at).toBe(250);
    for (const j of jobs) expect(Math.abs((j.at - (deadline - 200)) % 250)).toBe(0);
    const st = s.stats();
    expect(st.p50).toBe(250);
    expect(st.p95).toBe(250);
    expect(st.min).toBe(250);
    expect(st.max).toBe(250);
    expect(st.last60s).toBeGreaterThanOrEqual(239);
  });

  it("seq strictly increases from above the floor; fresh 16-byte salt every send", () => {
    const jobs: SendJob[] = [];
    const salts: Uint8Array[] = [];
    const s = make(jobs, salts);
    s.setSeqFloor(1000);
    s.setPlan({ phase: "hide", deadline: Date.now() + 5000, beatMs: 1500 });
    vi.advanceTimersByTime(2000);
    s.setSeqFloor(500); // lower floors never move seq back
    vi.advanceTimersByTime(2000);
    s.setSeqFloor(jobs.at(-1)!.seq + 50); // a higher ack floor (another tab) lifts it
    vi.advanceTimersByTime(1000);
    expect(jobs[0].seq).toBe(1001);
    for (let i = 1; i < jobs.length; i++) expect(jobs[i].seq).toBeGreaterThan(jobs[i - 1].seq);
    expect(new Set(jobs.map((j) => j.seq)).size).toBe(jobs.length);
    expect(salts.every((x) => x.length === 16)).toBe(true);
    expect(new Set(salts.map((x) => Buffer.from(x).toString("hex"))).size).toBe(salts.length);
    expect(jobs.map((j) => j.salt)).toEqual(salts);
  });

  it("carries the player's latest choice in every remaining send of its beat, no-ops otherwise", () => {
    const jobs: SendJob[] = [];
    const s = make(jobs);
    const t0 = Date.now();
    const deadline = t0 + 1500;
    s.setPlan({ phase: "live", deadline, beatMs: 1500 });
    vi.advanceTimersByTime(400);
    s.choose(1, 9);
    vi.advanceTimersByTime(300);
    s.choose(1, 11); // last one counts
    vi.advanceTimersByTime(3000);
    const inBeat = jobs.filter((j) => j.deadline === deadline);
    expect(inBeat.filter((j) => j.at < t0 + 400).every((j) => j.kind === 0)).toBe(true);
    expect(inBeat.filter((j) => j.at >= t0 + 400 && j.at < t0 + 700).every((j) => j.kind === 1 && j.level === 9)).toBe(true);
    const after = inBeat.filter((j) => j.at >= t0 + 700);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((j) => j.kind === 1 && j.level === 11)).toBe(true);
    // next beats: back to no-ops
    const next = jobs.filter((j) => j.deadline > deadline);
    expect(next.length).toBeGreaterThan(0);
    expect(next.every((j) => j.kind === 0 && j.level === 0)).toBe(true);
    expect(s.currentChoice).toBeNull();
  });

  it("a choice made after the beat's last send goes to the next beat", () => {
    const jobs: SendJob[] = [];
    const s = make(jobs);
    const deadline = Date.now() + 1000;
    s.setPlan({ phase: "live", deadline, beatMs: 1500 });
    vi.advanceTimersByTime(900); // past deadline - 200
    s.choose(2, 5);
    vi.advanceTimersByTime(1600);
    expect(jobs.filter((j) => j.deadline === deadline).every((j) => j.kind === 0)).toBe(true);
    const nxt = jobs.filter((j) => j.deadline === deadline + 1500);
    expect(nxt.length).toBe(6);
    expect(nxt.every((j) => j.kind === 2 && j.level === 5)).toBe(true);
  });

  it("stops when the plan is off and does not count the pause as a cadence sample", () => {
    const jobs: SendJob[] = [];
    const s = make(jobs);
    s.setPlan({ phase: "live", deadline: Date.now() + 1500, beatMs: 1500 });
    vi.advanceTimersByTime(1000);
    const n = jobs.length;
    s.setPlan({ phase: "off", deadline: 0, beatMs: 1500 });
    vi.advanceTimersByTime(10_000);
    expect(jobs.length).toBe(n);
    s.setPlan({ phase: "hide", deadline: Date.now() + 5000, beatMs: 1500 });
    vi.advanceTimersByTime(1000);
    expect(jobs.length).toBeGreaterThan(n);
    expect(s.stats().max).toBe(250);
  });

  it("small deadline corrections keep the cadence", () => {
    const jobs: SendJob[] = [];
    const s = make(jobs);
    let d = Date.now() + 1500;
    s.setPlan({ phase: "live", deadline: d, beatMs: 1500 });
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(250);
      if (Date.now() > d + 100) d += 1500; // the next beat's deadline
      d += i % 2 ? 2 : -2; // slot-clock jitter
      s.setPlan({ phase: "live", deadline: d, beatMs: 1500 });
    }
    const gaps = jobs.slice(1).map((j, i) => j.at - jobs[i].at);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(125);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(375);
  });
});

describe("scheduler stops on a stale plan (bell, sleeping tab, lost Table feed)", () => {
  beforeEach(() => vi.useFakeTimers({ now: 2_000_000 }));
  afterEach(() => vi.useRealTimers());
  const make = (jobs: SendJob[]) =>
    new ActScheduler({
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      random: (n) => nacl.randomBytes(n),
      send: (j) => jobs.push(j),
    });

  it("extrapolates at most one beat past the plan's deadline, then stops by itself", () => {
    const jobs: SendJob[] = [];
    const s = make(jobs);
    const deadline = Date.now() + 1500;
    s.setPlan({ phase: "live", deadline, beatMs: 1500 });
    vi.advanceTimersByTime(30_000); // no fresh plan ever arrives (e.g. the bell was never read)
    expect(jobs.length).toBe(12); // 6 sends in the planned beat + 6 in the next one
    expect(Math.max(...jobs.map((j) => j.at))).toBe(deadline + 1500 - 200);
    expect(jobs.every((j) => j.at <= s.sendLimit)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resumes only on a plan with a newer deadline; a re-post of the stale plan does not restart it", () => {
    const jobs: SendJob[] = [];
    const s = make(jobs);
    const deadline = Date.now() + 1500;
    const plan = { phase: "live" as const, deadline, beatMs: 1500 };
    s.setPlan(plan);
    vi.advanceTimersByTime(10_000);
    const n = jobs.length;
    s.setPlan(plan);
    vi.advanceTimersByTime(5_000);
    expect(jobs.length).toBe(n);
    const fresh = Date.now() + 1200;
    s.setPlan({ phase: "live", deadline: fresh, beatMs: 1500 });
    vi.advanceTimersByTime(1000);
    expect(jobs.length).toBe(n + 5); // +0, 250, 500, 750, 1000 ms on the new grid
    // the pause is not a cadence sample
    expect(s.stats().max).toBe(250);
  });

  it("a timer that fires late (throttled tab) past the limit sends nothing", () => {
    const jobs: SendJob[] = [];
    const s = make(jobs);
    const deadline = Date.now() + 1500;
    s.setPlan({ phase: "live", deadline, beatMs: 1500 });
    vi.advanceTimersByTime(1000);
    const n = jobs.length;
    vi.setSystemTime(Date.now() + 10_000); // the tab slept: the clock moved, the timer did not run
    vi.runOnlyPendingTimers();
    expect(jobs.length).toBe(n);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops the player's choice on a stall: it never carries into the next round's HIDE", () => {
    const jobs: SendJob[] = [];
    const s = make(jobs);
    const deadline = Date.now() + 1500;
    s.setPlan({ phase: "live", deadline, beatMs: 1500 });
    vi.advanceTimersByTime(1400); // past the beat's last send: the choice targets the next beat
    s.choose(2, 7);
    vi.advanceTimersByTime(20_000);
    expect(s.currentChoice).toBeNull();
    const before = jobs.length;
    s.setPlan({ phase: "hide", deadline: Date.now() + 5000, beatMs: 1500 });
    vi.advanceTimersByTime(4000);
    const hide = jobs.slice(before);
    expect(hide.length).toBe(16);
    expect(hide.every((j) => j.kind === 0 && j.level === 0)).toBe(true);
  });

  it("the off plan at the bell clears the choice; nothing is sent until a fresh plan", () => {
    const jobs: SendJob[] = [];
    const s = make(jobs);
    s.setPlan({ phase: "live", deadline: Date.now() + 1500, beatMs: 1500 });
    vi.advanceTimersByTime(300);
    s.choose(1, 4);
    const n = jobs.length;
    s.setPlan({ phase: "off", deadline: 0, beatMs: 1500 });
    expect(s.currentChoice).toBeNull();
    vi.advanceTimersByTime(8000);
    expect(jobs.length).toBe(n);
    s.setPlan({ phase: "hide", deadline: Date.now() + 5000, beatMs: 1500 });
    vi.advanceTimersByTime(2000);
    expect(jobs.slice(n).every((j) => j.kind === 0)).toBe(true);
  });
});

describe("act sender transport", () => {
  beforeEach(() => vi.useFakeTimers({ now: 2_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("refreshes the blockhash, sends base64 txs with skipPreflight, reports 401 and retries a stale blockhash once", async () => {
    const kp = Keypair.generate();
    const calls: { method: string; params: unknown[] }[] = [];
    let mode: "ok" | "401" | "stale" = "ok";
    let stale = 0;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      if (mode === "401") return new Response("", { status: 401 });
      if (body.method === "getLatestBlockhash") return Response.json({ result: { value: { blockhash: bs58.encode(nacl.randomBytes(32)) } } });
      if (mode === "stale" && stale++ === 0) return Response.json({ error: { message: "Blockhash not found" } });
      return Response.json({ result: "sig" });
    }) as unknown as typeof fetch;
    const posts: FromWorker[] = [];
    const sender = new ActSender({
      fetch: fakeFetch,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
      random: (n) => nacl.randomBytes(n),
      post: (m) => posts.push(m),
    });
    sender.handle({
      type: "setup",
      setup: { secretKey: kp.secretKey, player: kp.publicKey.toBase58(), desk: Keypair.generate().publicKey.toBase58(), book: Keypair.generate().publicKey.toBase58(), program: PROGRAM_ID, url: "http://tee?token=x", seqFloor: 10 },
    });
    sender.handle({ type: "plan", plan: { phase: "live", deadline: Date.now() + 1500, beatMs: 1500 } });
    await vi.advanceTimersByTimeAsync(1000);
    const sends = calls.filter((c) => c.method === "sendTransaction");
    expect(sends.length).toBe(4);
    const [b64, opts] = sends[0].params as [string, { encoding: string; skipPreflight: boolean }];
    expect(opts).toMatchObject({ encoding: "base64", skipPreflight: true });
    const tx = Transaction.from(Buffer.from(b64, "base64"));
    expect(tx.verifySignatures()).toBe(true);
    const sent = posts.filter((p) => p.type === "sent").map((p) => (p as Extract<FromWorker, { type: "sent" }>).r);
    expect(sent.map((r) => r.seq)).toEqual([11, 12, 13, 14]);
    expect(sent.every((r) => r.ok)).toBe(true);

    mode = "stale";
    await vi.advanceTimersByTimeAsync(250);
    const last = posts.filter((p) => p.type === "sent").at(-1) as Extract<FromWorker, { type: "sent" }>;
    expect(last.r.ok).toBe(true);
    expect(last.r.seq).toBe(15);

    mode = "401";
    await vi.advanceTimersByTimeAsync(250);
    expect(posts.some((p) => p.type === "unauthorized")).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(posts.some((p) => p.type === "stats")).toBe(true);
    sender.dispose();
  });
});
