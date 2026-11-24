/** The five "try to peek" reads, each a live RPC call whose raw outcome is printed. */
import type { PeekLine, PeekRead, PeekResult } from "../state/types";
import { lots, priceOf } from "../state/types";
import { rawRpc } from "./link";
import { decodeDesk, isAccount } from "./layout";
import { fromBase64 } from "./wire";

export interface PeekContext {
  teeAnon: string;
  teeToken: string | null;
  base: string;
  program: string;
  book: string | null;
  myDesk: string | null;
  otherDesk: { key: string; label: string } | null;
  lastActSig: string | null;
  who: string;
}

type Body = { result?: unknown; error?: { code?: number; message?: string } } | null;
const errText = (http: number, b: Body) => (http === 0 ? `network error: ${b?.error?.message ?? "unreachable"}` : `http ${http}${b?.error ? ` · ${b.error.code ?? ""} ${b.error.message ?? ""}` : ""}`);

async function account(url: string, key: string) {
  const r = await rawRpc(url, "getAccountInfo", [key, { encoding: "base64", commitment: "processed" }]);
  const v = (r.body?.result as { value?: { data: [string, string]; owner: string; lamports: number } | null } | undefined)?.value;
  return { ...r, value: v ?? null, data: v ? fromBase64(v.data[0]) : null };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runPeek(n: PeekRead, ctx: PeekContext): Promise<PeekResult> {
  const t0 = performance.now();
  const lines: PeekLine[] = [];
  const cmd = (text: string) => lines.push({ kind: "cmd", text: "$ " + text });
  const ok = (text: string) => lines.push({ kind: "ok", text: "✓ " + text });
  const no = (text: string) => lines.push({ kind: "no", text: "✗ " + text });
  const dim = (text: string) => lines.push({ kind: "dim", text });
  const readAs = async (label: string, url: string | null, key: string | null, what: string) => {
    cmd(`getAccountInfo(${what}, ${label})`);
    if (!url || !key) return no(url ? "no account to read yet" : "no token yet");
    const r = await account(url, key);
    if (r.http !== 200 || r.body?.error) return no(errText(r.http, r.body));
    if (!r.value) return no("value: null");
    ok(`${r.data?.length ?? 0} bytes · owner ${r.value.owner.slice(0, 8)}… · readable`);
    return r.data;
  };

  switch (n) {
    case 1: {
      await readAs("rollup, no token", ctx.teeAnon, ctx.book, "Book");
      cmd("getAccountInfo(Book, base layer)");
      if (!ctx.book) {
        no("no Book yet");
        break;
      }
      const r = await account(ctx.base, ctx.book);
      if (r.http !== 200 || r.body?.error) no(errText(r.http, r.body));
      else if (!r.value) no("value: null (not on the base layer)");
      else {
        const zero = r.data!.subarray(40, 40 + 1144).every((x) => x === 0); // the embedded round state
        (zero ? no : ok)(`owner ${r.value.owner.slice(0, 8)}… · ${r.data!.length} bytes · ${zero ? "hidden state all zero (never committed)" : "hidden state bytes present"}`);
      }
      break;
    }
    case 2:
      await readAs(`rollup, token=${ctx.who}`, ctx.teeToken, ctx.book, "Book");
      break;
    case 3: {
      const d = await readAs(`rollup, token=${ctx.who}`, ctx.teeToken, ctx.myDesk, `Desk/${ctx.who}`);
      if (d instanceof Uint8Array && isAccount(d, "Desk")) {
        const k = decodeDesk(d);
        dim(`  { level: ${k.level ? priceOf(k.level) : "-"}, resting: ${lots(k.resting)}, picked: ${lots(k.picked)}, beat: ${k.beat}, last_seq: ${k.lastSeq} }`);
      }
      await readAs(`rollup, token=${ctx.who}`, ctx.teeToken, ctx.otherDesk?.key ?? null, `Desk/${ctx.otherDesk?.label ?? "other"}`);
      break;
    }
    case 4: {
      cmd(`getTransaction(<your last act>, rollup, token=${ctx.who})`);
      if (!ctx.teeToken || !ctx.lastActSig) {
        no("no act sent yet");
        break;
      }
      let r = await rawRpc(ctx.teeToken, "getTransaction", [ctx.lastActSig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      for (let i = 0; i < 3 && r.http === 200 && !r.body?.error && !r.body?.result; i++) {
        await sleep(500);
        r = await rawRpc(ctx.teeToken, "getTransaction", [ctx.lastActSig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      }
      if (r.http !== 200 || r.body?.error) {
        no(errText(r.http, r.body));
        break;
      }
      const tx = r.body?.result as { slot?: number; transaction?: { message?: { accountKeys?: unknown[]; instructions?: { data?: string }[] } }; meta?: { logMessages?: string[] | null } } | null;
      if (!tx) {
        no("result: null");
        break;
      }
      const keys = tx.transaction?.message?.accountKeys?.length ?? 0;
      const data = (tx.transaction?.message?.instructions ?? []).filter((i) => i.data).length;
      const logs = tx.meta?.logMessages?.length ?? 0;
      (keys === 0 && data === 0 && logs === 0 ? no : ok)(`slot ${tx.slot ?? "?"} · ${keys} account keys · ${data} instructions with data · ${logs} log lines`);
      dim("every desk sends one act every 250 ms: ping, move or nothing look the same");
      break;
    }
    case 5: {
      cmd("getSignaturesForAddress(program, rollup, anon)");
      const r = await rawRpc(ctx.teeAnon, "getSignaturesForAddress", [ctx.program, { limit: 100 }]);
      if (r.http !== 200 || r.body?.error) {
        no(errText(r.http, r.body));
        break;
      }
      const list = (r.body?.result as { signature: string; err: unknown }[] | undefined) ?? [];
      ok(`${list.length} signatures listed (latest 100)`);
      if (ctx.lastActSig) (list.some((s) => s.signature === ctx.lastActSig) ? ok : no)(`your last act ${list.some((s) => s.signature === ctx.lastActSig) ? "is" : "is not"} in the list`);
      dim("every desk sends the same act at the same rate and no act fails, so even a full listing carries nothing; after the bell the whole round appears, by design");
      break;
    }
  }
  return { read: n, lines, ms: Math.round(performance.now() - t0) };
}
