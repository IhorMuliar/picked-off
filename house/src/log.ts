// Structured logs: one JSON object per line, to stdout and (when opened) to a file.
import fs from "node:fs";
import path from "node:path";

let file: fs.WriteStream | null = null;
process.stdout.on("error", () => {}); // a full disk or closed pipe on stdout must not stop the runner
export function openLog(p: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  file = fs.createWriteStream(p, { flags: "a" });
  file.on("error", (e) => process.stderr.write(`log file error: ${e.message}\n`)); // e.g. a full disk: keep running
}

const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
function write(level: string, ev: string, data: Record<string, unknown>) {
  // Rollup login tokens travel in endpoint URLs, and error messages can quote those URLs:
  // never let one reach a log line.
  const line = JSON.stringify({ ts: new Date().toISOString(), level, ev, ...data }, big).replace(/token=[^&\s"\\]+/g, "token=<redacted>");
  process.stdout.write(line + "\n");
  file?.write(line + "\n");
}

export const log = {
  info: (ev: string, data: Record<string, unknown> = {}) => write("info", ev, data),
  warn: (ev: string, data: Record<string, unknown> = {}) => write("warn", ev, data),
  error: (ev: string, data: Record<string, unknown> = {}) => write("error", ev, data),
};
