/**
 * Screen + sound recorder for the game, used to make the 60-s video from real rounds.
 *
 *   node tests/browser/record.mjs <url> <outDir>
 *
 * One fresh headless Chrome (own profile, so a new burner key and no wallet), laid out at VW×VH CSS pixels with a
 * device scale of ZOOM (default 1280×720 × 1.5: frames of 1920×1080 or a pixel or two taller; crop when editing).
 * The window size includes ≈ 143 px of headless browser chrome, hence VH + 143. It takes a seat through the normal path and plays like a
 * person: places in HIDE, pings a fresh price most beats, re-pings a FILL (Space), re-quotes after
 * PICKED OFF (R), opens "Try to peek" once (reads 1-5), and calls the Tape in up to TAPE_CALLS rounds
 * (the product's own drip funds it). Every compositor frame is saved as <outDir>/frames/<n>.jpg with its
 * wall-clock time; every sound the page synthesises is logged with its parameters (<outDir>/sounds.jsonl);
 * <outDir>/events.jsonl logs the clock, toasts, header number, reveal check and every input sent.
 *
 * Env: ROUNDS=7 (full rounds to record after the join round) · VW=1280 VH=720 ZOOM=1.5 · QUALITY=88 ·
 *      TAPE_CALLS=2 · PEEK_ROUND=3 · CAPTURE_FROM=0 · EVERY_NTH=1 · CHROME=<binary>
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const url = process.argv[2];
const out = process.argv[3];
if (!url || !out) {
  console.error("usage: node tests/browser/record.mjs <url> <outDir>");
  process.exit(2);
}
const env = (k, d) => process.env[k] ?? d;
const ROUNDS = Number(env("ROUNDS", 7));
const VW = Number(env("VW", 1280)), VH = Number(env("VH", 720)), ZOOM = Number(env("ZOOM", 1.5));
const PW = Math.round(VW * ZOOM), PH = Math.round(VH * ZOOM);
const TAPE_CALLS = Number(env("TAPE_CALLS", 2));
const PEEK_ROUND = Number(env("PEEK_ROUND", 3));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(path.join(out, "frames"), { recursive: true });
const evlog = fs.createWriteStream(path.join(out, "events.jsonl"));
const log = (o) => evlog.write(JSON.stringify({ t: Date.now(), ...o }) + "\n");

/**
 * Logs every sound the page starts (oscillator or noise source), with its wall-clock start, waveform, frequency
 * automation and the gain/filter automation of the nodes it feeds, so the same synthesis can be re-rendered
 * offline in sync with the frames (a headless audio clock does not keep wall time under load).
 */
const SOUND_LOG = `(() => {
  const P = AudioParam.prototype, ev = new WeakMap(), next = new WeakMap();
  const rec = (p, k, v, t) => { let a = ev.get(p); if (!a) ev.set(p, (a = [])); a.push([k, v, t]); };
  for (const k of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime']) {
    const o = P[k]; P[k] = function (v, t) { rec(this, k[0], v, t); return o.call(this, v, t); };
  }
  const vd = Object.getOwnPropertyDescriptor(P, 'value');
  Object.defineProperty(P, 'value', { configurable: true, get() { return vd.get.call(this); }, set(v) { rec(this, 'v', v, 0); vd.set.call(this, v); } });
  const oc = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (d, ...r) { if (d instanceof AudioNode) next.set(this, d); return oc.call(this, d, ...r); };
  window.__snd = [];
  const desc = (n) => n instanceof GainNode ? { g: ev.get(n.gain) ?? [] } : n instanceof BiquadFilterNode ? { ft: n.type, q: n.Q.value, f: ev.get(n.frequency) ?? [] } : {};
  for (const C of [OscillatorNode, AudioBufferSourceNode]) {
    const o = C.prototype.start;
    C.prototype.start = function (t = 0, ...r) {
      try {
        const ctx = this.context, chain = [];
        for (let x = next.get(this), i = 0; x && !(x instanceof AudioDestinationNode) && i < 6; x = next.get(x), i++) chain.push(desc(x));
        window.__snd.push({ at: performance.timeOrigin + performance.now() + (t - ctx.currentTime) * 1000, t0: t,
          kind: this instanceof OscillatorNode ? this.type : 'noise', freq: this instanceof OscillatorNode ? ev.get(this.frequency) ?? [] : null, chain });
      } catch {}
      return o.call(this, t, ...r);
    };
  }
})();`;

function chromeBin() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const c of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try {
      execFileSync("which", [c], { stdio: "ignore" });
      return c;
    } catch {
      /* next */
    }
  }
  throw new Error("no Chrome found: set CHROME=/path/to/chrome");
}

const port = 9820 + Math.floor(Math.random() * 100);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), "po-rec-"));
const chrome = spawn(chromeBin(), [
  "--headless=new", "--no-sandbox", "--no-first-run", "--mute-audio", "--autoplay-policy=no-user-gesture-required",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
  `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, `--force-device-scale-factor=${ZOOM}`, `--window-size=${VW},${VH + 143}`, "about:blank",
], { stdio: "ignore" });
let page;
for (let i = 0; i < 100 && !page; i++) {
  try {
    page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
  } catch {
    /* not up */
  }
  if (!page) await sleep(150);
}
if (!page) throw new Error("Chrome did not start");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let id = 0, nframe = 0;
const pend = new Map();
const frames = fs.createWriteStream(path.join(out, "frames.tsv"));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (m) => {
  const j = JSON.parse(m.data);
  if (j.id) {
    pend.get(j.id)?.(j);
    pend.delete(j.id);
  } else if (j.method === "Page.screencastFrame") {
    const n = nframe++;
    const f = `${String(n).padStart(6, "0")}.jpg`;
    fs.writeFileSync(path.join(out, "frames", f), Buffer.from(j.params.data, "base64"));
    frames.write(`${f}\t${j.params.metadata.timestamp}\n`);
    ws.send(JSON.stringify({ id: ++id, method: "Page.screencastFrameAck", params: { sessionId: j.params.sessionId } }));
  }
};
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send("Runtime.enable");
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: SOUND_LOG });

/** A real mouse click at the centre of the first element matching sel. */
async function click(sel, what, idx = 0) {
  const r = await ev(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${idx}]; if (!e || e.disabled) return null;
    const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`);
  if (!r) return false;
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
  log({ input: "click", sel, what });
  return true;
}
async function key(k, code, vk, what) {
  for (const type of ["keyDown", "keyUp"])
    await send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, text: type === "keyDown" && k.length === 1 ? k : undefined });
  log({ input: "key", key: code, what });
}

const SNAP = `(() => { const q = (s) => document.querySelector(s); const s = window.__poChain?.status?.(); const c = q('[data-testid=clock]');
  return { clock: c ? c.dataset.phase + ' ' + c.dataset.beat : '',
    toasts: [...document.querySelectorAll('[data-testid=toasts] .toast')].map((e) => e.textContent),
    number: q('[data-testid=number]')?.textContent ?? '',
    check: q('[data-testid=check]')?.textContent ?? null,
    reveal: !!q('[data-testid=reveal]'), peek: !!q('[data-testid=peek]'),
    takedesk: !!q('[data-testid=takedesk]'), join: !!q('[data-testid=join]'),
    tape: [...document.querySelectorAll('[data-testid=tape] button.call')].map((e) => (e.disabled ? '-' : '+') + (e.dataset.called ? 'CALLED' : e.textContent)),
    banner: (() => { const e = q('[data-testid=chain-status]'); return e && e.style.display !== 'none' ? e.textContent : null })(),
    seat: s?.seat ?? null, round: s?.round ?? null, readable: !!s?.deskReadable } })()`;

const sounds = fs.createWriteStream(path.join(out, "sounds.jsonl"));
async function pullSounds() {
  const xs = await ev("(window.__snd ?? []).splice(0)");
  for (const x of xs ?? []) sounds.write(JSON.stringify(x) + "\n");
}

const startCapture = () => send("Page.startScreencast", { format: "jpeg", quality: Number(env("QUALITY", 88)), maxWidth: PW + 4, maxHeight: PH + 4, everyNthFrame: Number(env("EVERY_NTH", 1)) });
// CAPTURE_FROM=<n>: play n full rounds before the screencast starts (lighter on the machine while the header's
// beat → private result sample builds up; the header counts every beat since load)
const CAPTURE_FROM = Number(env("CAPTURE_FROM", 0));
let capturing = false;
if (!CAPTURE_FROM) {
  await startCapture();
  capturing = true;
}
await send("Page.navigate", { url });
log({ nav: url });

let last = {}, full = -1, lastRound = null, lastBeat = -1, calls = 0, peeked = false, lastPull = Date.now();
const done = new Set();
const t0 = Date.now();
try {
  while (Date.now() - t0 < (ROUNDS + 2) * 80000) {
    await sleep(120);
    const x = await ev(SNAP);
    if (!x) continue;
    for (const k of ["clock", "number", "check", "reveal", "peek", "takedesk", "join", "banner", "seat", "round"])
      if (x[k] !== last[k]) log({ [k]: x[k] });
    const newToasts = x.toasts.filter((t) => !(last.toasts ?? []).includes(t));
    for (const t of newToasts) log({ toast: t });
    if (JSON.stringify(x.tape) !== JSON.stringify(last.tape)) log({ tape: x.tape });
    last = x;
    if (Date.now() - lastPull > 2000) {
      lastPull = Date.now();
      await pullSounds();
    }
    if (x.takedesk) {
      await click("[data-testid=takedesk]", "take a desk");
      continue;
    }
    if (x.seat === null || !x.readable) continue;
    if (x.round !== lastRound) {
      lastRound = x.round;
      full++;
      log({ fullRound: full, round: x.round });
      if (!capturing && full >= CAPTURE_FROM) {
        await startCapture();
        capturing = true;
        log({ capture: "start" });
      }
      if (full > ROUNDS) break;
    }
    const r = x.round;
    const hide = x.clock.startsWith("hide");
    const beat = x.clock.startsWith("live") ? Number(x.clock.split(" ")[1]) : 0;
    // the Tape call goes first in HIDE: on chain, calls can close earlier than the panel says
    if (hide && full >= 1 && calls < TAPE_CALLS && full % 2 === 0 && !done.has(`tape:${r}`)) {
      if (!x.tape.length) await click(".chip.tape", "open the Tape");
      const i = x.tape.findIndex((t) => t.startsWith("+"));
      if (i >= 0) {
        done.add(`tape:${r}`);
        calls++;
        await click("[data-testid=tape] button.call", "tape call (own desk)", x.seat);
        await key("Escape", "Escape", 27, "close the Tape");
      }
    }
    if (hide && !done.has(`place:${r}`)) {
      done.add(`place:${r}`);
      await sleep(600);
      await click(`[data-level="${4 + Math.floor(Math.random() * 17)}"]`, "place");
    }
    if (!hide && !x.reveal && beat !== lastBeat && beat >= 1) {
      lastBeat = beat;
      if (x.peek) continue;
      if (full === PEEK_ROUND && !peeked && beat >= 4) {
        peeked = true;
        await click(".chip.peek", "peek open");
        await sleep(700);
        for (const n of [1, 3, 4, 2, 5]) {
          await click(`[data-peek="${n}"]`, `peek ${n}`);
          for (let i = 0; i < 40; i++) {
            await sleep(250);
            if (await ev(`![...document.querySelectorAll('[data-peek]')].some((e) => e.disabled)`)) break;
          }
          await sleep(900);
        }
        await sleep(2500);
        await key("Escape", "Escape", 27, "peek close");
        continue;
      }
      await sleep(250 + Math.random() * 500);
      // the result log: "FILL …", "auto FILL …", "miss …", "auto miss …", "PICKED OFF …"
      if (x.toasts.some((t) => t.startsWith("PICKED OFF"))) await key("r", "KeyR", 82, "move");
      else if (x.toasts.some((t) => t.startsWith("FILL"))) await key(" ", "Space", 32, "ping the fill again");
      else if (x.toasts.some((t) => t.startsWith("auto FILL"))) await key(" ", "Space", 32, "ping the auto fill again");
      else if (Math.random() < 0.8) await click(`[data-level="${1 + Math.floor(Math.random() * 24)}"]`, "ping");
    }
  }
} finally {
  await pullSounds().catch(() => {});
  await send("Page.stopScreencast").catch(() => {});
  await sleep(500);
  sounds.end();
  frames.end();
  evlog.end();
  try {
    ws.close();
  } catch {
    /* gone */
  }
  chrome.kill("SIGKILL");
  setTimeout(() => fs.rmSync(prof, { recursive: true, force: true }), 1500);
  console.log(`frames ${nframe}, ${Math.round((Date.now() - t0) / 1000)} s`);
}
