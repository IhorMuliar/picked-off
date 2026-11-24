/**
 * LIGHTS ON replay check: re-run the revealed log from the initial levels and
 * compare the result with the revealed totals, then hash the log. The chain
 * driver compares the hash with the committed Round; the mock compares it with
 * the hash it recorded at the bell.
 */
import { DESKS, type RevealView } from "./types";
import { newBook, resolveBeat, type Act } from "./mock/engine";

export function serializeLog(r: Pick<RevealView, "round" | "bellBeat" | "initialLevels" | "beats">): Uint8Array {
  const out: number[] = [r.round & 0xff, (r.round >> 8) & 0xff, r.bellBeat, ...r.initialLevels];
  for (const b of r.beats) {
    for (let d = 0; d < DESKS; d++) {
      const a = b.actions.find((x) => x.desk === d);
      out.push(a ? (a.kind === "requote" ? 2 : 1) | (a.algo ? 4 : 0) : 0, a?.level ?? 0);
    }
  }
  return Uint8Array.from(out);
}

export async function hashLog(bytes: Uint8Array): Promise<string> {
  try {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
    return "0x" + [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
  } catch {
    // non-secure context fallback: FNV-1a 32
    let h = 0x811c9dc5;
    for (const x of bytes) h = Math.imul(h ^ x, 0x01000193) >>> 0;
    return "0x" + h.toString(16).padStart(8, "0");
  }
}

/** Re-run the revealed actions in their order; true when the totals match. */
export function replayMatches(r: RevealView): boolean {
  const b = newBook(r.initialLevels);
  for (const beat of r.beats) {
    const acts: Act[] = Array(DESKS).fill(null);
    const algo: number[] = Array(DESKS).fill(1);
    for (const a of beat.actions) {
      if (a.algo) algo[a.desk] = a.level;
      else acts[a.desk] = { kind: a.kind, level: a.level };
    }
    // the revealed order is the order of the actions list
    const order = beat.actions.map((a) => a.desk);
    resolveBeat(b, beat.beat, acts, algo, order);
    if (b.level.some((l, d) => l !== beat.levels[d])) return false;
  }
  return b.resting.every((x, d) => x + b.picked[d] === r.totals[d]);
}
