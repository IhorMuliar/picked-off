/**
 * Minimal Chrome DevTools Protocol driver: a fresh headless Chrome per browser (own profile,
 * so a fresh burner key), Node 22 built-in WebSocket and fetch, no dependencies.
 * Chrome binary: $CHROME, else google-chrome / chromium on PATH.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Marks the moment this browser's own Desk is on screen (seated, readable, rendered) as window.__deskAt. */
const DESK_PROBE = `(() => { const iv = setInterval(() => {
  try { const s = window.__poChain?.status?.(); const big = document.querySelector('[data-testid=mydesk] .big');
    if (!window.__deskAt && s && s.seat !== null && s.deskReadable && big) { window.__deskAt = performance.now(); clearInterval(iv); }
  } catch {} }, 50); })();`;

let nextPort = 9420 + Math.floor(Math.random() * 400);

export async function launch({ w = 1280, h = 800, mobile = false } = {}) {
  const port = nextPort++;
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "po-browser-"));
  const chrome = spawn(chromeBin(), [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--mute-audio",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, `--window-size=${w},${h}`, "about:blank",
  ], { stdio: "ignore" });
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    try {
      page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
    } catch {
      /* not up yet */
    }
    if (!page) await sleep(150);
  }
  if (!page) throw new Error("Chrome did not start");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const pend = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const j = JSON.parse(m.data);
    if (j.id) {
      pend.get(j.id)?.(j);
      pend.delete(j.id);
    } else events.push(j);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  if (mobile) await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 3, mobile: true });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: DESK_PROBE });
  const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  return {
    send,
    ev,
    nav: (url) => send("Page.navigate", { url }),
    reload: () => send("Page.reload"),
    click: (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true })()`),
    status: async () => JSON.parse((await ev("JSON.stringify(window.__poChain?.status?.() ?? null)")) ?? "null"),
    shot: async (file) => {
      const s = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(file, Buffer.from(s.result.data, "base64"));
    },
    /** Uncaught exceptions, console.error calls and browser error log entries so far. */
    errors: () => ({
      exceptions: events.filter((e) => e.method === "Runtime.exceptionThrown").map((e) => e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text),
      consoleErr: events.filter((e) => e.method === "Runtime.consoleAPICalled" && e.params.type === "error").map((e) => e.params.args.map((a) => a.value ?? a.description).join(" ")),
      logErr: events.filter((e) => e.method === "Log.entryAdded" && e.params.entry.level === "error").map((e) => `${e.params.entry.text} ${e.params.entry.url ?? ""}`.replace(/token=[^&\s]+/g, "token=…")),
    }),
    close: () => {
      try {
        ws.close();
      } catch {
        /* gone */
      }
      chrome.kill("SIGKILL");
      setTimeout(() => fs.rmSync(prof, { recursive: true, force: true }), 1500);
    },
  };
}
