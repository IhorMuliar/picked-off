// Structured logs: one JSON object per line, to stdout and (when opened) to a file. Files are
// rotated by size (file → file.1 → … → file.<keep>), so a long run never fills the disk.
import fs from "node:fs";
import path from "node:path";

/** An append-only file that rotates itself once it passes `maxBytes` (0 = never). Synchronous appends
 *  (a few lines per second), so a rotation never races a pending write. */
export class RotatingFile {
  private fd: number | null = null;
  private size = 0;
  constructor(readonly file: string, private maxBytes: number, private keep: number, private onError: (e: Error) => void) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.open();
  }
  private open() {
    try {
      this.fd = fs.openSync(this.file, "a");
      this.size = fs.fstatSync(this.fd).size;
    } catch (e: any) { this.fd = null; this.onError(e); }
  }
  write(line: string) {
    if (this.fd === null) return;
    try {
      fs.writeSync(this.fd, line);
      this.size += Buffer.byteLength(line);
    } catch (e: any) { this.onError(e); return; } // e.g. a full disk: keep running
    if (this.maxBytes > 0 && this.size >= this.maxBytes) this.rotate();
  }
  private rotate() {
    try {
      if (this.fd !== null) fs.closeSync(this.fd);
      for (let i = this.keep - 1; i >= 1; i--) if (fs.existsSync(`${this.file}.${i}`)) fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      if (this.keep >= 1) fs.renameSync(this.file, `${this.file}.1`);
      else fs.unlinkSync(this.file);
    } catch (e: any) { this.onError(e); }
    this.open();
  }
}

let file: RotatingFile | null = null;
let quietStdout = false;
process.stdout.on("error", () => {}); // a full disk or closed pipe on stdout must not stop the runner
export function openLog(p: string, maxMb = 0, keep = 3) {
  file = new RotatingFile(p, maxMb * 1048576, keep, (e) => process.stderr.write(`log file error: ${e.message}\n`));
}
/** Stop echoing info lines to stdout (warnings and errors still go there), e.g. when the file is the log of record. */
export function quietStdoutInfo(on: boolean) { quietStdout = on; }

const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
function write(level: string, ev: string, data: Record<string, unknown>) {
  // Rollup login tokens travel in endpoint URLs, and error messages can quote those URLs:
  // never let one reach a log line.
  const line = JSON.stringify({ ts: new Date().toISOString(), level, ev, ...data }, big).replace(/token=[^&\s"\\]+/g, "token=<redacted>");
  if (!quietStdout || level !== "info") process.stdout.write(line + "\n");
  file?.write(line + "\n");
}

export const log = {
  info: (ev: string, data: Record<string, unknown> = {}) => write("info", ev, data),
  warn: (ev: string, data: Record<string, unknown> = {}) => write("warn", ev, data),
  error: (ev: string, data: Record<string, unknown> = {}) => write("error", ev, data),
};
