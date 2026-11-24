/**
 * Maps rollup slots to local `performance.now()` time from periodic getSlot samples
 * (sample time = midpoint of the request). The slot rate is fitted from the samples once
 * they span 5 s; before that the configured prior is used. Beat deadlines are slots, so
 * this is how the beat ring and the measured number get real timestamps.
 */
export interface SlotSample { slot: number; at: number; rtt: number }

export class SlotClock {
  private samples: SlotSample[] = [];
  slotMs: number;
  private offset: number | null = null; // at = offset + slot * slotMs
  constructor(private prior: number, private maxSamples = 40) {
    this.slotMs = prior;
  }
  get ready() {
    return this.offset !== null;
  }
  /** The slot rate has been fitted from samples spanning >= 5 s (before that: the prior). */
  get fitted() {
    const xs = this.samples;
    return xs.length >= 4 && xs[xs.length - 1].at - xs[0].at >= 5000;
  }
  add(slot: number, sentAt: number, receivedAt: number) {
    const s = { slot, at: (sentAt + receivedAt) / 2, rtt: receivedAt - sentAt };
    this.samples.push(s);
    if (this.samples.length > this.maxSamples) this.samples.shift();
    this.fit();
  }
  private fit() {
    const xs = this.samples;
    if (xs.length >= 4 && xs[xs.length - 1].at - xs[0].at >= 5000) {
      const n = xs.length;
      const mx = xs.reduce((a, s) => a + s.slot, 0) / n;
      const my = xs.reduce((a, s) => a + s.at, 0) / n;
      let num = 0;
      let den = 0;
      for (const s of xs) {
        num += (s.slot - mx) * (s.at - my);
        den += (s.slot - mx) ** 2;
      }
      const k = den > 0 ? num / den : this.prior;
      if (k > this.prior / 3 && k < this.prior * 3) this.slotMs = k;
    }
    // median offset of the fastest half of the samples
    const best = [...xs].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, Math.ceil(xs.length / 2)));
    const offs = best.map((s) => s.at - s.slot * this.slotMs).sort((a, b) => a - b);
    this.offset = offs[Math.floor(offs.length / 2)];
  }
  /** Local time at which `slot` starts (null before the first sample). */
  timeOf(slot: number | bigint): number | null {
    if (this.offset === null) return null;
    return this.offset + Number(slot) * this.slotMs;
  }
  /** Current slot estimate. */
  slotAt(t: number): number | null {
    if (this.offset === null) return null;
    return (t - this.offset) / this.slotMs;
  }
}
