/**
 * Browser checks against a running game URL (fresh headless Chrome, no wallet):
 *
 *   node tests/browser/check.mjs <url>
 *
 *   join   URL -> own Desk on screen in <= 10 s, JOIN_N sequential runs + 2 simultaneous
 *   round  one browser plays ROUNDS full rounds through the UI: place in HIDE, ping, re-quote,
 *          private-result toasts, the bell, "replay ✓ ... matches commit"; send cadence over 60 s;
 *          the 5 peek reads; the header number (beat -> private result); no uncaught errors
 *   tape   (only with TAPE=1: spends devnet SOL from the drip) one Tape call through the UI: "Called ✓", then the outcome
 *          the player sees on the Tape chip (won / lost / refunded) and its payout settled on chain (the house sweep, or the
 *          client's fallback claim 150 s later); after its last round the check keeps watching until TAPE_WAIT_S (default 240) after the call
 *
 * Env: CHECKS=join,round (default) · JOIN_N=5 · JOIN_GAP_MS=12000 · JOIN_PAR=2 (simultaneous joins, 0 = none) · ROUNDS=2 · TAPE=1 · TAPE_WAIT_S=240 ·
 *      SHOTS=<dir for screenshots> · OUT=<file for the JSON report> · CHROME=<binary>
 * Prints one PASS/FAIL line per check and exits 1 if any failed.
 */
import fs from "node:fs";
import path from "node:path";
import { launch, sleep } from "./cdp.mjs";

const url = process.argv[2] ?? process.env.URL;
if (!url) {
  console.error("usage: node tests/browser/check.mjs <url>");
  process.exit(2);
}
const env = (k, d) => process.env[k] ?? d;
const CHECKS = env("CHECKS", "join,round").split(",");
if (env("TAPE", "") === "1" && !CHECKS.includes("tape")) CHECKS.push("tape");
const SHOTS = env("SHOTS", "");
const report = { url, at: new Date().toISOString(), checks: {} };
const results = [];
const line = (name, ok, detail) => {
  results.push(ok);
  report.checks[name] = { ok, ...detail };
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};
const shot = async (b, name) => SHOTS && b.shot(path.join(SHOTS, name));
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null;
};
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

/* ---------------------------------------------------------------- join */
async function joinOnce() {
  const b = await launch();
  try {
    await b.nav(url);
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const at = await b.ev("window.__deskAt ?? null");
      if (at) {
        const s = await b.status();
        return { ms: Math.round(at), table: s?.tableId, seat: s?.seat, exceptions: b.errors().exceptions.length };
      }
    }
    const s = await b.status();
    return { ms: null, joinErrors: s?.joinErrors, link: s?.link };
  } finally {
    b.close();
  }
}

async function checkJoin() {
  const n = Number(env("JOIN_N", 5));
  const runs = [];
  for (let i = 0; i < n; i++) {
    runs.push(await joinOnce());
    await sleep(Number(env("JOIN_GAP_MS", 12000)));
  }
  const par = Number(env("JOIN_PAR", 2));
  if (par > 0) runs.push(...(await Promise.all(Array.from({ length: par }, () => joinOnce()))));
  const ms = runs.map((r) => r.ms ?? Infinity);
  const ok = ms.filter((x) => x <= 10000).length;
  line("join", ok === runs.length, { ok: `${ok}/${runs.length}`, min: Math.min(...ms), p50: pct(ms, 0.5), p95: pct(ms, 0.95), max: Math.max(...ms), simultaneous: par > 0 ? runs.slice(-par).map((r) => r.ms) : [] });
  report.checks.join.runs = runs;
}

/* ---------------------------------------------------------------- round (+ tape) */
// the screen's hooks: the clock carries its phase and beat as data; private results are a screen-reader log
// ([data-testid=toasts] .toast); the Tape's buttons exist while its sheet is open (opened by the check when needed)
const SNAP = `(() => { const q = (s) => document.querySelector(s); const s = window.__poChain?.status?.(); const c = q('[data-testid=clock]');
  return { clock: c ? c.dataset.phase + ' ' + c.dataset.beat : '',
    toasts: [...document.querySelectorAll('[data-testid=toasts] .toast')].map((e) => e.textContent),
    check: q('[data-testid=check]')?.textContent ?? null,
    tape: [...document.querySelectorAll('[data-testid=tape] button.call')].map((e) => (e.disabled ? '-' : '+') + (e.dataset.called ? 'CALLED' : e.textContent)),
    banner: (() => { const e = q('[data-testid=chain-status]'); return e && e.style.display !== 'none' ? e.textContent : null })(),
    number: q('[data-testid=number]')?.textContent ?? '',
    call: (() => { const c = q('[data-testid=tape-chip]'); return c?.dataset.call ? { outcome: c.dataset.call, round: c.dataset.callRound, settled: c.dataset.settled, text: c.textContent } : null })(), s } })()`;

async function checkRound(withTape) {
  const rounds = Number(env("ROUNDS", 2));
  const b = await launch();
  const seen = { toasts: new Set(), bells: 0, replays: 0, places: 0, pings: 0, requotes: 0, headerFirst: null };
  let full = -1, last = null, cad = null, peek = null, call = null, claimed = false, mark = null;
  const done = new Set();
  const trace = [];
  report.trace = trace;
  try {
    await b.nav(url);
    const t0 = Date.now();
    while (Date.now() - t0 < (rounds + 2) * 75000 + (withTape ? Number(env("TAPE_WAIT_S", 240)) * 1000 : 0)) {
      await sleep(300);
      const x = await b.ev(SNAP);
      const tk = `${x?.s?.round}|${x?.s?.seat}|${x?.s?.deskReadable}|${x?.banner ?? ""}`;
      if (tk !== trace.at(-1)?.k) trace.push({ t: Math.round((Date.now() - t0) / 1000), k: tk });
      if (!x?.s || x.s.seat === null || !x.s.deskReadable) continue;
      const r = x.s.round;
      if (r !== last) {
        full++;
        last = r;
      }
      if (full > rounds) {
        // the Tape payout settles after its round: keep watching the player's chip for a while
        if (!withTape || !call || claimed || Date.now() - call.at > Number(env("TAPE_WAIT_S", 240)) * 1000) break;
        continue;
      }
      const hide = x.clock.startsWith("hide");
      const beat = x.clock.startsWith("live") ? Number(x.clock.split(" ")[1]) : 0;
      const key = (k) => `${k}:${r}`;
      for (const t of x.toasts) seen.toasts.add(`${r}:${t}`);
      if (x.clock.startsWith("lights") && !done.has(key("bell"))) {
        done.add(key("bell"));
        seen.bells++;
        if (seen.bells === 1) await shot(b, "browser-bell.png");
      }
      if (x.check?.includes("✓") && !done.has(key("replay"))) {
        done.add(key("replay"));
        seen.replays++;
        if (seen.replays === 1) await shot(b, "browser-reveal.png");
      }
      if (/\d+ ms/.test(x.number) && !seen.headerFirst) seen.headerFirst = x.number;
      if (/settled and (claimed|paid)/.test(x.banner ?? "")) claimed = x.banner;
      if (call && x.call && /^(won|lost|refunded)$/.test(x.call.outcome) && /^(settled|claimed|owed)$/.test(x.call.settled ?? "")) claimed = `${x.call.text}: ${x.call.outcome}, ${x.call.settled} (round ${x.call.round})`;
      if (call && x.call?.outcome && x.call.outcome !== call.lastSeen) {
        call.lastSeen = x.call.outcome;
        (call.seen ??= []).push(`${Math.round((Date.now() - call.at) / 1000)}s ${x.call.text} ${x.call.outcome}/${x.call.settled || "-"}`);
        if (call.seen.length <= 4) await shot(b, `browser-tape-${call.seen.length}.png`);
      }
      if (full < 1) continue; // the join round is not a full round
      if (hide && !done.has(key("place"))) {
        done.add(key("place"));
        if (await b.click(`[data-level="${3 + Math.floor(Math.random() * 18)}"]`)) seen.places++;
        if (seen.places === 1) await shot(b, "browser-hide.png");
      }
      if (withTape && hide && full >= 2 && !call) {
        if (!x.tape.length) await b.click(".chip.tape"); // open the Tape sheet; its buttons show on the next snapshot
        const i = x.tape.findIndex((t) => t.startsWith("+"));
        if (i >= 0) {
          call = { round: r, at: Date.now() };
          await b.ev(`document.querySelectorAll('[data-testid=tape] button.call')[${i}].click()`);
        }
      }
      if (call && !call.calledMs && x.tape.some((t) => t.includes("CALLED"))) call.calledMs = Date.now() - call.at;
      if (!hide && beat >= 2 && !done.has(key("ping"))) {
        done.add(key("ping"));
        // a tap on a price is the ping
        if (await b.click(`[data-level="${2 + Math.floor(Math.random() * 20)}"]`)) seen.pings++;
      }
      if (!hide && beat >= 5 && !done.has(key("requote"))) {
        done.add(key("requote"));
        // Move to… (or a tap on your own order, which opens the same mode when that button shows Ping again), then the price
        if (!(await b.click("[data-testid=move][data-state=moveto]"))) await b.click(".row.mine");
        if (await b.click(`[data-level="${2 + Math.floor(Math.random() * 20)}"]`)) seen.requotes++;
        if (seen.requotes === 1) await shot(b, "browser-live.png");
      }
      if (!cad && (hide || beat >= 1)) cad = { at: Date.now(), start: x.s };
      if (cad && !cad.end && Date.now() - cad.at >= 60000) cad.end = x.s;
      if (!peek && !hide && beat >= 6 && full >= Math.min(2, rounds)) {
        await b.click(".chip.peek");
        await sleep(400);
        for (let n = 1; n <= 5; n++) {
          await b.click(`[data-peek="${n}"]`);
          for (let i = 0; i < 40; i++) {
            await sleep(250);
            if (await b.ev(`![...document.querySelectorAll('[data-peek]')].some((e) => e.disabled)`)) break;
          }
        }
        peek = await b.ev(`document.querySelector('[data-testid=console]')?.innerText ?? ''`);
        await shot(b, "browser-peek.png");
        await b.click("[data-testid=peek] .close");
      }
    }
    const fin = (await b.ev(SNAP))?.s;
    const errs = b.errors();
    line("round", full >= rounds && seen.places >= rounds && seen.pings >= rounds && seen.requotes >= rounds && seen.bells >= rounds && seen.replays >= rounds && seen.toasts.size > 0,
      { fullRounds: Math.max(0, Math.min(full, rounds)), places: seen.places, pings: seen.pings, requotes: seen.requotes, toasts: seen.toasts.size, bells: seen.bells, replays: seen.replays });
    if (cad?.end) {
      const c = cad.end.cadence;
      const sent = c.sent - cad.start.cadence.sent;
      const failed = cad.end.sendFailed - cad.start.sendFailed;
      line("cadence", failed === 0 && c.p50 >= 240 && c.p50 <= 260 && c.p95 <= 300,
        { windowSec: 60, sent, intervalP50: Math.round(c.p50), intervalP95: Math.round(c.p95), failed, ackP50: Math.round(cad.end.ackP50), ackP95: Math.round(cad.end.ackP95), note: "no acts are sent between the bell and the next HIDE" });
    } else line("cadence", false, { error: "no 60-s window" });
    if (peek !== null) {
      const expect = {
        bookAnon: /no token\)\n✗ value: null/.test(peek),
        bookToken: /# 2[^#]*✗ value: null/.test(peek),
        ownDesk: /# 3[^#]*✓ \d+ bytes[^#]*readable/.test(peek),
        otherDesk: /# 3[^#]*\$ getAccountInfo\(Desk\/[^\n]*\n✗ value: null/.test(peek),
        actShell: /# 4[^#]*0 account keys · 0 instructions with data · 0 log lines/.test(peek),
        actNotListed: /# 5[^#]*your last act is not in the list/.test(peek),
      };
      line("peek", Object.values(expect).every(Boolean), expect);
      report.checks.peek.text = peek;
    } else line("peek", false, { error: "peek not reached" });
    const lags = fin?.resultLags ?? [];
    line("number", fin?.resultLagN >= 8 && fin?.resultLagP95 !== null,
      { n: fin?.resultLagN, p50: Math.round(fin?.resultLagP50), p95: Math.round(fin?.resultLagP95), firstShown: seen.headerFirst, header: (await b.ev(SNAP))?.number, recent: lags.slice(-10) });
    if (withTape)
      line("tape", !!call?.calledMs && !!claimed, { calledMs: call?.calledMs ?? null, settled: claimed || null, seen: call?.seen ?? [] });
    line("errors", errs.exceptions.length === 0 && errs.consoleErr.length === 0, { exceptions: errs.exceptions.slice(0, 5), consoleErr: errs.consoleErr.slice(0, 5), logErr: errs.logErr.slice(0, 5) });
  } finally {
    await shot(b, "browser-end.png").catch(() => {});
    b.close();
  }
}

if (CHECKS.includes("join")) await checkJoin();
if (CHECKS.includes("round") || CHECKS.includes("tape")) await checkRound(CHECKS.includes("tape"));
if (env("OUT", "")) fs.writeFileSync(env("OUT", ""), JSON.stringify(report, null, 1));
process.exit(results.every(Boolean) ? 0 : 1);
