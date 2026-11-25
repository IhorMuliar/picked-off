import { describe, expect, it } from "vitest";
import { hideHint, isLevel } from "./decide";
import { attribute } from "./round";
import type { PrivateResult } from "../state/types";

describe("HIDE hint", () => {
  it("never prints a price for level 0 (no order placed yet)", () => {
    for (const picked of [false, true]) for (const first of [false, true]) expect(hideHint(picked, 0, first)).not.toMatch(/\d+\.\d\d/);
    expect(hideHint(false, 0, false)).toBe("Tap a price to hide your order.");
  });
  it("prints real prices only", () => {
    expect(hideHint(false, 1, false)).toBe("Your order hides at 100.12 unless you tap another price.");
    expect(hideHint(true, 24, false)).toBe("Hidden at 99.89. Nobody else can see it.");
    expect(isLevel(0)).toBe(false);
    expect(isLevel(25)).toBe(false);
    expect(isLevel(1) && isLevel(24)).toBe(true);
  });
});

describe("joining-beat attribution", () => {
  const r = (beat: number, level: number, algo = false): PrivateResult => ({ id: beat * 100 + level, beat, kind: "fill", level, tenths: 5, algo });
  const mem = { late: true, seatedAt: { round: 1, beat: 7, total: 100 }, sent: [] as { beat: number; level: number }[] };

  it("keeps the player's own ping in the joining beat as their own", () => {
    const x = attribute(r(7, 3), { ...mem, sent: [{ beat: 7, level: 3 }] });
    expect(x.algo).toBe(false);
    expect((x as { inherited?: boolean }).inherited).toBeUndefined();
    expect(attribute(r(7, 3), { ...mem, sent: [{ beat: 6, level: 3 }] }).algo).toBe(false);
  });
  it("makes an inherited action quiet but never labels it auto", () => {
    const x = attribute(r(7, 3), mem);
    expect(x.algo).toBe(true);
    expect(x.inherited).toBe(true);
  });
  it("leaves a real auto ping and later beats alone", () => {
    expect(attribute(r(7, 3, true), mem)).toEqual(r(7, 3, true));
    expect(attribute(r(8, 3), mem)).toEqual(r(8, 3));
    expect(attribute(r(7, 3), { ...mem, late: false })).toEqual(r(7, 3));
  });
});
