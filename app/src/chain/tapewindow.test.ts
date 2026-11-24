import { describe, expect, it } from "vitest";
import { BASE_SEND_OPTIONS, MIN_CALL_LEAD_MS, WindowClosed, baseClockOffsetMs, canStartCall, closesAtLocal, remainingMs, sendGuarded, windowLabel, type SendConn } from "./tapewindow";

describe("Tape window on the base clock", () => {
  // the base clock is real time; the visitor's clock runs `skew` ms ahead of it
  const sample = (realMs: number, skew: number, rttMs = 200) => ({ unix: Math.floor((realMs + rttMs / 2) / 1000), sentAt: realMs + skew, recvAt: realMs + skew + rttMs });

  it("estimates the offset of a skewed local clock to within a second", () => {
    for (const skew of [-90_000, -4_300, 0, 2_750, 61_000]) {
      const real = 1_795_555_000_000;
      const samples = [0, 370, 740].map((d) => sample(real + d, skew));
      const off = baseClockOffsetMs(samples)!;
      expect(Math.abs(off - -skew)).toBeLessThanOrEqual(1_000);
    }
    expect(baseClockOffsetMs([])).toBeNull();
  });

  it("closes when the base clock reaches close_unix, whatever the local clock says", () => {
    const skew = 7_000; // local clock 7 s fast
    const real = 1_795_555_000_000;
    const off = baseClockOffsetMs([0, 400, 800].map((d) => sample(real + d, skew)))!;
    const closeUnix = Math.floor(real / 1000) + 20;
    const at = closesAtLocal(closeUnix, off);
    // in local time the close is ≈ 7 s later than close_unix read as a local time
    expect(at - closeUnix * 1000).toBeGreaterThan(6_000);
    expect(at - closeUnix * 1000).toBeLessThan(8_000);
    // local "now" = real + skew: 10 s of real time before the close → ≈ 10 s left
    const left = remainingMs(at, closeUnix * 1000 - 10_000 + skew);
    expect(Math.abs(left - 10_000)).toBeLessThanOrEqual(1_000);
  });

  it("starts a call only with at least 3 s left, and labels the window", () => {
    expect(MIN_CALL_LEAD_MS).toBe(3_000);
    expect(canStartCall(3_000)).toBe(true);
    expect(canStartCall(2_999)).toBe(false);
    expect(canStartCall(-1)).toBe(false);
    expect(windowLabel(15_000)).toBe("closes in 10 beats · 15 s");
    expect(windowLabel(1_400 + 3_000)).toBe("closes in 3 beats · 5 s");
    expect(windowLabel(2_500)).toBe("closing · 3 s");
    expect(windowLabel(0)).toBe("calls closed");
    expect(windowLabel(-5)).toBe("calls closed");
  });
});

describe("guarded base send", () => {
  const fake = (statuses: (null | { err: unknown; confirmationStatus?: string })[]) => {
    const sends: (typeof BASE_SEND_OPTIONS)[] = [];
    let i = 0;
    const c: SendConn = {
      sendRawTransaction: async (_raw, opts) => { sends.push(opts); return "sig"; },
      getSignatureStatuses: async () => ({ value: [statuses[Math.min(i++, statuses.length - 1)]] }),
    };
    return { c, sends };
  };
  const fast = { pollMs: 10, rebroadcastMs: 20, timeoutMs: 400, sleep: async () => {} };

  it("always sends with preflight on and no RPC-side retries", async () => {
    expect(BASE_SEND_OPTIONS.skipPreflight).toBe(false);
    expect(BASE_SEND_OPTIONS.maxRetries).toBe(0);
    const { c, sends } = fake([null, null, null, null, { err: null, confirmationStatus: "confirmed" }]);
    await expect(sendGuarded(c, new Uint8Array(1), fast)).resolves.toBe("sig");
    expect(sends.length).toBeGreaterThan(1); // re-sent while no status
    for (const o of sends) expect(o.skipPreflight).toBe(false);
  });

  it("sends nothing when the window is already closed", async () => {
    const { c, sends } = fake([{ err: null, confirmationStatus: "confirmed" }]);
    await expect(sendGuarded(c, new Uint8Array(1), { ...fast, gate: () => false })).rejects.toBeInstanceOf(WindowClosed);
    expect(sends.length).toBe(0);
  });

  it("stops re-sending once the window closes", async () => {
    let open = true;
    const { c, sends } = fake([null]);
    const p = sendGuarded(c, new Uint8Array(1), { ...fast, gate: () => open, sleep: async () => { if (sends.length >= 2) open = false; } });
    await expect(p).rejects.toThrow("not confirmed");
    expect(sends.length).toBe(2);
  });

  it("reports a refused or failed transaction", async () => {
    const c: SendConn = { sendRawTransaction: async () => { throw new Error("Simulation failed: CallsClosed"); }, getSignatureStatuses: async () => ({ value: [null] }) };
    await expect(sendGuarded(c, new Uint8Array(1), fast)).rejects.toThrow("CallsClosed");
    const { c: c2 } = fake([{ err: { InstructionError: [0, { Custom: 6017 }] } }]);
    await expect(sendGuarded(c2, new Uint8Array(1), fast)).rejects.toThrow("transaction failed");
  });
});
