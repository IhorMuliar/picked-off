/**
 * Tape window in a real browser against the live pools: one fresh visitor (headless Chrome, new burner) presses
 * CALL at set times after a recorded round opens, one target per round, and the harness checks what the panel says
 * and what the page sent. Every base-layer `sendTransaction` the page makes is counted (fetch is wrapped before the
 * app loads), so "nothing sent" is checked, not assumed. Spends devnet SOL from the drip (the first call); a call
 * that only the burner made on its Tape is refunded or paid back to it, so later calls reuse that SOL.
 *
 *   node tests/browser/tape-window.mjs <url>        env: TARGETS=1000,8000,15000,19000,21000,24000  OUT=<file.json>
 *
 * Times are measured from the moment this page sees the new round (Table.round changes), which is a little after
 * the open is confirmed on the rollup; the harness prints that lag when the house log is given (HOUSE_LOG=<path>).
 */
import fs from "node:fs";
import { launch, sleep } from "./cdp.mjs";

const url = process.argv[2] ?? "http://localhost:5188";
const targets = (process.env.TARGETS ?? "1000,8000,15000,19000,21000,24000").split(",").map(Number);
const out = process.env.OUT ?? null;

const SEND_PROBE = `(() => { const f = window.fetch; window.__baseSends = [];
  window.fetch = async (input, init) => {
    let m = null; try { const b = init && typeof init.body === "string" ? JSON.parse(init.body) : null; m = b && (Array.isArray(b) ? b.map((x) => x.method) : [b.method]); } catch {}
    const isSend = m && m.includes("sendTransaction") && !String(input).includes("tee");
    const at = Date.now();
    const r = await f(input, init);
    if (isSend) { let ok = null; try { const j = await r.clone().json(); ok = j.error ? "refused: " + (j.error.message ?? "").slice(0, 120) : "accepted"; } catch {} window.__baseSends.push({ at, ok }); }
    return r;
  };
})();`;

const SNAP = `(() => { const s = window.__poChain?.status?.();
  return { s, label: document.querySelector('[data-testid=tape-window]')?.textContent ?? null,
    buttons: [...document.querySelectorAll('[data-testid=tape] button')].map((e) => (e.disabled ? '-' : '+') + e.textContent),
    toasts: [...document.querySelectorAll('[data-testid=toasts] .toast')].map((e) => e.textContent),
    banner: (() => { const e = document.querySelector('[data-testid=chain-status]'); return e && e.style.display !== 'none' ? e.textContent : null })(),
    sends: window.__baseSends?.length ?? 0, sendLog: window.__baseSends ?? [] } })()`;

const b = await launch();
await b.send("Page.addScriptToEvaluateOnNewDocument", { source: SEND_PROBE });
await b.nav(url);
const results = [];
let lastRound = null;
try {
  // wait until the visitor is seated and its Desk readable (the pool then records every round)
  for (let i = 0; i < 600; i++) { const x = await b.ev(SNAP); if (x?.s?.seat !== null && x?.s?.deskReadable) { lastRound = x.s.round; break; } await sleep(200); }
  if (lastRound === null) throw new Error("not seated within 120 s");
  for (const target of targets) {
    // the next round change
    let t0 = 0, x = null;
    for (let i = 0; i < 1800; i++) { x = await b.ev(SNAP); if (x?.s?.round && x.s.round !== lastRound) { t0 = Date.now(); lastRound = x.s.round; break; } await sleep(50); }
    if (!t0) throw new Error("no new round within 90 s");
    const round = x.s.round, pool = x.s.tableId;
    await sleep(Math.max(0, t0 + 1500 - Date.now()));
    const early = await b.ev(SNAP);
    if (early.label === "no Tape this round") { results.push({ target, pool, round, skipped: "unrecorded round" }); continue; }
    await sleep(Math.max(0, t0 + target - Date.now()));
    const before = await b.ev(SNAP);
    const i = before.buttons.findIndex((t) => t.startsWith("+"));
    const clickAt = Date.now() - t0;
    await b.ev(`document.querySelectorAll('[data-testid=tape] button')[${i >= 0 ? i : 0}].click()`); // a disabled button ignores the click
    let after = before, calledMs = null;
    for (let k = 0; k < 60; k++) {
      await sleep(250);
      after = await b.ev(SNAP);
      if (after.buttons.some((t) => t.includes("CALLED"))) { calledMs = Date.now() - t0 - clickAt; break; }
    }
    const sent = after.sendLog.slice(before.sends);
    const r = { target, pool, round, clickAtMs: clickAt, labelBefore: before.label, enabledBefore: i >= 0, called: calledMs !== null, calledMs, baseSends: sent.length, sendResults: sent.map((s) => s.ok), labelAfter: after.label, toasts: after.toasts.slice(-2), banner: after.banner };
    r.pass = target <= 20_000 ? r.called && sent.every((s) => s.ok === "accepted") : !r.enabledBefore && sent.length === 0 && /closed/.test(before.label ?? "");
    results.push(r);
    console.log(JSON.stringify(r));
  }
} finally {
  const errs = b.errors();
  if (out) fs.writeFileSync(out, JSON.stringify({ url, results, errors: errs }, null, 2));
  b.close();
}
process.exit(0);
