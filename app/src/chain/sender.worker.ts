// The act sender's Worker. Worker timers are not throttled like a background tab's
// setInterval, so every desk keeps the same cadence whether its tab has focus or not.
import { ActSender, type FromWorker, type ToWorker } from "./actsender";

const scope = self as unknown as { postMessage(m: FromWorker): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null };
const epoch = () => performance.timeOrigin + performance.now();
const sender = new ActSender({
  fetch: (...a) => fetch(...a),
  now: epoch,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  random: (n) => crypto.getRandomValues(new Uint8Array(n)),
  post: (m) => scope.postMessage(m),
});
scope.onmessage = (e) => sender.handle(e.data);
