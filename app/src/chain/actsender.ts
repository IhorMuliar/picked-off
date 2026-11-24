/**
 * The act sender: the constant-rate scheduler plus the transport (raw JSON-RPC over fetch,
 * hand-built transactions, a blockhash refresher). Runs inside the Worker; no web3.js.
 */
import { ActScheduler, type CadenceStats, type Plan, type SendJob } from "./scheduler";
import { actKeysFrom, buildActTx, toBase64, type ActKeys } from "./wire";

export interface SenderSetup {
  secretKey: Uint8Array;
  player: string;
  desk: string;
  book: string;
  program: string;
  url: string;
  seqFloor: number;
}

export type ToWorker =
  | { type: "setup"; setup: SenderSetup }
  | { type: "url"; url: string }
  | { type: "plan"; plan: Plan }
  | { type: "choose"; kind: number; level: number }
  | { type: "clear" }
  | { type: "seqFloor"; floor: number }
  | { type: "stop" };

export interface SentReport { seq: number; signature: string; kind: number; level: number; at: number; deadline: number; ok: boolean; ms: number; err?: string }
export type FromWorker =
  | { type: "sent"; r: SentReport }
  | { type: "unauthorized" }
  | { type: "stats"; stats: CadenceStats; failed: number; blockhashAgeMs: number | null };

export interface SenderEnv {
  fetch: typeof fetch;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
  random(n: number): Uint8Array;
  post(m: FromWorker): void;
}

export const BLOCKHASH_REFRESH_MS = 12_000;

export class ActSender {
  readonly sched: ActScheduler;
  private setup: SenderSetup | null = null;
  private keys: ActKeys | null = null;
  private blockhash: string | null = null;
  private blockhashAt: number | null = null;
  private refreshing: Promise<void> | null = null;
  private failed = 0;
  private intervals: unknown[] = [];

  constructor(private env: SenderEnv) {
    this.sched = new ActScheduler({
      now: env.now,
      setTimer: env.setTimer,
      clearTimer: env.clearTimer,
      random: env.random,
      send: (j) => void this.send(j),
    });
    this.intervals.push(env.setInterval(() => void this.refreshBlockhash(), BLOCKHASH_REFRESH_MS));
    this.intervals.push(env.setInterval(() => this.postStats(), 1000));
  }

  handle(m: ToWorker) {
    switch (m.type) {
      case "setup":
        this.setup = m.setup;
        this.keys = actKeysFrom(m.setup);
        this.sched.setSeqFloor(m.setup.seqFloor);
        void this.refreshBlockhash();
        break;
      case "url":
        if (this.setup) this.setup = { ...this.setup, url: m.url };
        void this.refreshBlockhash();
        break;
      case "plan":
        this.sched.setPlan(m.plan);
        break;
      case "choose":
        this.sched.choose(m.kind, m.level);
        break;
      case "clear":
        this.sched.clearChoice();
        break;
      case "seqFloor":
        this.sched.setSeqFloor(m.floor);
        break;
      case "stop":
        this.sched.stop();
        break;
    }
  }

  dispose() {
    this.sched.stop();
    for (const h of this.intervals) this.env.clearInterval(h);
  }

  private async rpc(method: string, params: unknown[]): Promise<{ status: number; result?: unknown; error?: string }> {
    if (!this.setup) return { status: 0, error: "no setup" };
    const r = await this.env.fetch(this.setup.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (r.status === 401) {
      this.env.post({ type: "unauthorized" });
      return { status: 401, error: "401 unauthorized" };
    }
    const j = (await r.json().catch(() => null)) as { result?: unknown; error?: { message?: string } } | null;
    if (!j) return { status: r.status, error: `http ${r.status}` };
    return { status: r.status, result: j.result, error: j.error ? j.error.message ?? "rpc error" : undefined };
  }

  refreshBlockhash(): Promise<void> {
    if (!this.setup) return Promise.resolve();
    if (!this.refreshing) {
      this.refreshing = this.rpc("getLatestBlockhash", [{ commitment: "confirmed" }])
        .then((r) => {
          const v = (r.result as { value?: { blockhash?: string } } | undefined)?.value?.blockhash;
          if (v) {
            this.blockhash = v;
            this.blockhashAt = this.env.now();
          }
        })
        .catch(() => {})
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }

  private async send(j: SendJob, retried = false): Promise<void> {
    const t0 = this.env.now();
    const report = (ok: boolean, signature: string, err?: string) =>
      this.env.post({ type: "sent", r: { seq: j.seq, signature, kind: j.kind, level: j.level, at: j.at, deadline: j.deadline, ok, ms: this.env.now() - t0, err } });
    if (!this.setup || !this.keys) return report(false, "", "no setup");
    if (!this.blockhash) await this.refreshBlockhash();
    if (!this.blockhash) {
      this.failed++;
      return report(false, "", "no blockhash");
    }
    const tx = buildActTx(this.keys, this.setup.secretKey, this.blockhash, j.kind, j.level, j.seq, j.salt);
    try {
      const r = await this.rpc("sendTransaction", [toBase64(tx.bytes), { encoding: "base64", skipPreflight: true, maxRetries: 0 }]);
      if (!r.error) return report(true, tx.signature);
      if (/already been processed/i.test(r.error)) return report(true, tx.signature);
      if (!retried && /blockhash/i.test(r.error)) {
        this.blockhash = null;
        await this.refreshBlockhash();
        return this.send(j, true);
      }
      this.failed++;
      return report(false, tx.signature, r.error);
    } catch (e) {
      this.failed++;
      return report(false, tx.signature, (e as Error).message);
    }
  }

  private postStats() {
    this.env.post({ type: "stats", stats: this.sched.stats(), failed: this.failed, blockhashAgeMs: this.blockhashAt === null ? null : this.env.now() - this.blockhashAt });
  }
}
