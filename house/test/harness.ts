// Test harness: runs the house runner as a child process on its own table and state dir, and
// waits for its log events. Used by restart.ts and liveness.ts against the local stack.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MAIN = path.resolve(here, "..", "src", "main.ts");

export interface Ev { ev: string; [k: string]: any }

export class Runner {
  child: ChildProcess | null = null;
  events: Ev[] = [];
  private waiters: { pred: (e: Ev) => boolean; resolve: (e: Ev) => void }[] = [];
  constructor(public env: Record<string, string>, public label = "runner") {}

  start() {
    const child = spawn(process.execPath, ["--import", "tsx", MAIN], { env: { ...process.env, ...this.env }, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    let buf = "";
    child.stdout!.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let e: Ev | null = null;
        try { e = JSON.parse(line); } catch { continue; }
        this.events.push(e!);
        for (const w of [...this.waiters]) if (w.pred(e!)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(e!); }
      }
    });
    child.stderr!.on("data", (d) => process.stderr.write(`[${this.label}] ${d}`));
    return this;
  }
  /** Resolves with the first event (already seen or future) matching `pred`. */
  wait(pred: (e: Ev) => boolean, timeoutMs: number, what = "event"): Promise<Ev> {
    const seen = this.events.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve: (e: Ev) => { clearTimeout(timer); resolve(e); } };
      const timer = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new Error(`${this.label}: timeout waiting for ${what}`)); }, timeoutMs);
      this.waiters.push(w);
    });
  }
  /** Waits for an event that arrives after this call. */
  waitNext(pred: (e: Ev) => boolean, timeoutMs: number, what = "event"): Promise<Ev> {
    const n = this.events.length;
    return this.wait((e) => this.events.indexOf(e) >= n && pred(e), timeoutMs, what);
  }
  kill(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    return new Promise((r) => {
      if (!this.child || this.child.exitCode !== null) return r();
      this.child.once("exit", () => r());
      this.child.kill(signal);
    });
  }
  exited(timeoutMs: number): Promise<number | null> {
    return new Promise((r) => {
      if (!this.child || this.child.exitCode !== null) return r(this.child?.exitCode ?? null);
      const t = setTimeout(() => r(null), timeoutMs);
      this.child.once("exit", (code) => { clearTimeout(t); r(code); });
    });
  }
}

export function tempState(name: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `house-${name}-`));
  return { STATE_DIR: d, HOUSE_LOG: path.join(d, "house.log"), HOUSE_RPC_LOG: path.join(d, "rpc.jsonl") };
}

const results: { name: string; pass: boolean; detail: string }[] = [];
export function check(name: string, pass: boolean, detail: unknown) {
  const d = typeof detail === "string" ? detail : JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  results.push({ name, pass, detail: d });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}: ${d}`);
}
export function summary(): number {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  return failed.length ? 1 : 0;
}
