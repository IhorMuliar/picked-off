/** Every sound is synthesised with WebAudio (GAME-SPEC 4.9); no audio files. */
import { useUi } from "../state/store";

let ac: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;

/** Create/resume the context on the first user gesture (autoplay policy). */
export function unlockAudio() {
  try {
    if (!ac) {
      const C = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ac = new C();
      master = ac.createGain();
      master.gain.value = 0.5;
      master.connect(ac.destination);
    }
    if (ac.state === "suspended") void ac.resume();
  } catch {
    ac = null;
  }
}

function ready(): AudioContext | null {
  if (useUi.getState().muted || !ac || !master || ac.state !== "running") return null;
  return ac;
}

function tone(type: OscillatorType, f0: number, f1: number, dur: number, peak: number, delay = 0) {
  const a = ready();
  if (!a) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.linearRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master!);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function whoosh(dur = 0.15, peak = 0.12) {
  const a = ready();
  if (!a) return;
  if (!noise) {
    noise = a.createBuffer(1, a.sampleRate * 0.3, a.sampleRate);
    const ch = noise.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  }
  const t = a.currentTime;
  const s = a.createBufferSource();
  s.buffer = noise;
  const f = a.createBiquadFilter();
  f.type = "bandpass";
  f.Q.value = 1.2;
  f.frequency.setValueAtTime(400, t);
  f.frequency.exponentialRampToValueAtTime(2400, t + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + dur * 0.4);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(master!);
  s.start(t);
  s.stop(t + dur + 0.02);
}

export const sfx = {
  ping: () => tone("triangle", 880, 880, 0.05, 0.18),
  algoPing: () => tone("triangle", 880, 880, 0.05, 0.09),
  miss: () => tone("sine", 220, 210, 0.04, 0.14),
  fill: (escalated: boolean) => {
    const notes = escalated ? [660, 880, 1175] : [660, 990];
    const peak = escalated ? 0.26 : 0.18;
    notes.forEach((f, i) => tone("triangle", f, f, 0.12, peak, i * 0.07));
    tone("sine", 1980, 2200, 0.25, 0.04, notes.length * 0.07); // shimmer
  },
  pickedOff: () => {
    tone("sawtooth", 180, 175, 0.14, 0.16);
    tone("sawtooth", 140, 120, 0.22, 0.16, 0.13);
  },
  requote: () => whoosh(),
  beat: (bellRisk: boolean) => {
    tone("sine", 1200, 1200, 0.02, 0.025);
    if (bellRisk) tone("sine", 1800, 1800, 0.02, 0.03, 0.06);
  },
  bell: () => [523.25, 659.25, 783.99].forEach((f) => tone("sine", f, f, 1.6, 0.14)),
  fanfare: () => [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone("triangle", f, f, i === 3 ? 0.5 : 0.14, 0.16, i * 0.12)),
  register: () => {
    tone("square", 1500, 1500, 0.02, 0.06);
    tone("square", 2200, 2200, 0.03, 0.05, 0.04);
  },
  ui: () => tone("triangle", 500, 500, 0.03, 0.06),
};

export function setMuted(m: boolean) {
  useUi.setState({ muted: m });
  try {
    localStorage.setItem("po.muted", m ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
  if (!m) unlockAudio();
}

/** For tests: whether the context exists and is running. */
export const audioState = () => ac?.state ?? "none";
