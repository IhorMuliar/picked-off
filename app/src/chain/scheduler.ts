/**
 * The constant-rate `act` schedule (pure logic; the Worker wraps it).
 *
 * While the desk is in play, exactly one `act` leaves every `intervalMs` (250 ms) on a grid
 * phase-locked to the beat deadlines read from the Table: the last send of each beat leaves
 * `leadMs` before its deadline. A send carries the player's latest choice for that beat, or
 * a no-op. `seq` is strictly increasing and starts above the floor read from `Desk.last_seq`.
 * Every send gets 16 fresh random salt bytes.
 */
export type PlanPhase = "off" | "hide" | "live";
export interface Plan {
  phase: PlanPhase;
  /** epoch ms of the next deadline (HIDE end, or the close of the current live beat) */
  deadline: number;
  beatMs: number;
}
export interface Choice { kind: number; level: number; target: number; at: number }
export interface SendJob { seq: number; kind: number; level: number; salt: Uint8Array; at: number; deadline: number }

export interface SchedulerDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
  random(n: number): Uint8Array;
  send(job: SendJob): void;
  intervalMs?: number;
  leadMs?: number;
}

export interface CadenceStats {
  sent: number;
  /** intervals between consecutive sends inside one run of sending, ms */
  n: number;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  /** sends in the last 60 s */
  last60s: number;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

export class ActScheduler {
  readonly intervalMs: number;
  readonly leadMs: number;
  private plan: Plan = { phase: "off", deadline: 0, beatMs: 1500 };
  private choice: Choice | null = null;
  private seq = 0;
  private timer: unknown = null;
  private armedAt: number | null = null;
  private lastSent: number | null = null;
  private intervals: number[] = [];
  private sentTimes: number[] = [];
  private sentCount = 0;

  constructor(private d: SchedulerDeps) {
    this.intervalMs = d.intervalMs ?? 250;
    this.leadMs = d.leadMs ?? 200;
  }

  get lastSeq() {
    return this.seq;
  }
  get currentChoice() {
    return this.choice;
  }

  /** Raise the seq floor: the next send uses at least `floor + 1`. */
  setSeqFloor(floor: number) {
    if (floor > this.seq) this.seq = floor;
  }

  setPlan(p: Plan) {
    this.plan = { ...p };
    if (p.phase === "off") {
      this.disarm();
      this.lastSent = null; // a new run starts; the gap is not a cadence sample
      this.choice = null;
      return;
    }
    const next = this.nextSendTime();
    if (this.armedAt === null || Math.abs(next - this.armedAt) > 5) this.arm(next);
  }

  /** Deadline of the beat a send (or a choice) at time `t` belongs to. */
  beatOf(t: number): number {
    const { deadline, beatMs } = this.plan;
    const k = Math.ceil((t + this.leadMs - deadline) / beatMs - 1e-9);
    return deadline + k * beatMs;
  }

  /** The player's choice; carried by every remaining send of its beat. */
  choose(kind: number, level: number) {
    const at = this.d.now();
    this.choice = { kind, level, target: this.beatOf(at), at };
  }
  clearChoice() {
    this.choice = null;
  }

  private nextSendTime(): number {
    const t = this.d.now();
    const anchor = this.plan.deadline - this.leadMs;
    let next = anchor + Math.ceil((t - anchor) / this.intervalMs - 1e-9) * this.intervalMs;
    if (this.lastSent !== null) while (next - this.lastSent < this.intervalMs / 2) next += this.intervalMs;
    return next;
  }

  private arm(at: number) {
    this.disarm();
    this.armedAt = at;
    this.timer = this.d.setTimer(() => this.fire(), Math.max(0, at - this.d.now()));
  }
  private disarm() {
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
    this.armedAt = null;
  }

  private fire() {
    this.timer = null;
    this.armedAt = null;
    if (this.plan.phase === "off") return;
    const at = this.d.now();
    const deadline = this.beatOf(at);
    const c = this.choice && Math.abs(this.choice.target - deadline) < this.plan.beatMs / 2 ? this.choice : null;
    if (this.choice && this.choice.target < deadline - this.plan.beatMs / 2) this.choice = null; // its beat is over
    this.seq = (this.seq + 1) >>> 0;
    const job: SendJob = { seq: this.seq, kind: c?.kind ?? 0, level: c?.level ?? 0, salt: this.d.random(16), at, deadline };
    if (this.lastSent !== null) {
      this.intervals.push(at - this.lastSent);
      if (this.intervals.length > 240) this.intervals.shift();
    }
    this.lastSent = at;
    this.sentCount++;
    this.sentTimes.push(at);
    while (this.sentTimes.length && this.sentTimes[0] < at - 60_000) this.sentTimes.shift();
    try {
      this.d.send(job);
    } finally {
      this.arm(this.nextSendTime());
    }
  }

  stats(): CadenceStats {
    const xs = this.intervals;
    return {
      sent: this.sentCount,
      n: xs.length,
      mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null,
      p50: pct(xs, 50),
      p95: pct(xs, 95),
      min: xs.length ? Math.min(...xs) : null,
      max: xs.length ? Math.max(...xs) : null,
      last60s: this.sentTimes.length,
    };
  }

  stop() {
    this.setPlan({ ...this.plan, phase: "off" });
  }
}
