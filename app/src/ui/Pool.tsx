import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { recordLatency, useGame, useUi } from "../state/store";
import { actions } from "../state/runtime";
import { BEAT_MS, DESKS, LEVELS, lots, priceOf, type PrivateResult } from "../state/types";
import { sfx, unlockAudio } from "../fx/sound";
import { DESK_COLORS, mmss } from "./format";

const LEVEL_LIST = Array.from({ length: LEVELS }, (_, i) => i + 1);
const MID = 13; // 100.00

/* ------------------------------------------------------------------ status */

function BeatRing() {
  const arc = useRef<SVGCircleElement>(null);
  const txt = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const c = useGame.getState().clock;
      const t = performance.now();
      let frac = 0;
      let label = "";
      if (c.phase === "live") {
        const left = Math.max(0, c.beatEndsAt - t);
        frac = left / BEAT_MS;
        label = `beat ${(left / 1000).toFixed(1)} s`;
      } else if (c.phase === "hide") {
        const left = Math.max(0, c.phaseEndsAt - t);
        frac = left / 5000;
        label = `live ${(left / 1000).toFixed(1)} s`;
      } else if (c.phase === "lights") {
        const left = Math.max(0, c.phaseEndsAt - t);
        frac = left / 8000;
        label = `next ${Math.ceil(left / 1000)} s`;
      }
      if (arc.current) arc.current.setAttribute("stroke-dashoffset", (62.8 * (1 - frac)).toFixed(1));
      if (txt.current && txt.current.textContent !== label) txt.current.textContent = label;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="beat">
      <svg width="26" height="26" aria-hidden="true">
        <circle cx="13" cy="13" r="10" stroke="#223050" strokeWidth="4" fill="none" />
        <circle ref={arc} cx="13" cy="13" r="10" stroke="#2EF2D0" strokeWidth="4" fill="none" strokeDasharray="62.8" />
      </svg>
      <span className="mono" ref={txt} />
    </div>
  );
}

function Status() {
  const { phase, beat, bellChance } = useGame(useShallow((s) => ({ phase: s.clock.phase, beat: s.clock.beat, bellChance: s.clock.bellChance })));
  const { pool, bots } = useGame(useShallow((s) => ({ pool: s.table.pool, bots: s.table.seats.filter((x) => x.kind === "bot").length })));
  const me = useGame((s) => s.me);
  const reveal = useGame((s) => s.reveal);
  const pct = Math.round(bellChance * 100);
  const clock =
    phase === "hide" ? "0:00 · HIDE" : phase === "lights" ? `${mmss(5 + (reveal?.bellBeat ?? beat) * 1.5)} · bell` : `${mmss(5 + (beat - 1) * 1.5)} · beat ${beat}`;
  return (
    <div className="status">
      <div>
        <div className="pool-id">
          HOUSE POOL #{pool} · {bots} bot{bots === 1 ? "" : "s"}
        </div>
        <div className="clock mono" data-testid="clock">{clock}</div>
      </div>
      <div className={"bell" + (pct > 0 ? " hot" : "")} title="The closing auction ends after a VRF-drawn live beat between 20 and 29">
        <span className="what">🔔 bell after beat 20–29 (secret)</span>
        <span>chance this beat <b className="mono">{pct}%</b></span>
        <span className="meter"><i style={{ width: `${pct}%` }} /></span>
      </div>
      <BeatRing />
      <div className="me" data-testid="mydesk">
        <small>YOUR DESK (private)</small>
        {me ? (
          <div className="big mono">
            {lots(me.resting)}<i>resting</i>+ <span style={{ color: "var(--gold)" }}>{lots(me.picked)}</span><i>picked</i>= {lots(me.resting + me.picked)}
          </div>
        ) : (
          <div className="big mono" style={{ color: "var(--mute)" }}>watching</div>
        )}
      </div>
    </div>
  );
}

function Banners() {
  const notice = useGame((s) => s.joinNotice);
  const canJoin = useGame((s) => s.canJoin);
  const phase = useGame((s) => s.clock.phase);
  const placed = useGame((s) => s.me?.level);
  const bellBeat = useGame((s) => s.reveal?.bellBeat);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const key = notice ? `${notice.name}:${notice.level}` : null;
  return (
    <>
      {notice && dismissed !== key && (
        <div className="join" data-testid="join">
          <span>
            You're in: <b>{notice.name}</b>, desk {notice.seat + 1} of 8, free chips, no wallet. Your {lots(notice.resting)} lots rest dark at{" "}
            <b>{priceOf(notice.level)}</b>. Your algo is already pinging: click any price to ping it yourself.
          </span>
          <button className="go" onClick={() => { unlockAudio(); setDismissed(key); }}>
            GOT IT
          </button>
        </div>
      )}
      {canJoin && (
        <div className="join">
          <span>You're watching this pool. Take a desk: free chips, no wallet, you take over a house bot's order as it stands.</span>
          <button className="go" onClick={() => { unlockAudio(); actions().join(); }}>
            TAKE A DESK
          </button>
        </div>
      )}
      {phase === "hide" && (
        <div className="phase hide">
          HIDE · click a price to rest your 10 lots there{placed ? ` · now at ${priceOf(placed)}` : ""} · not placed by the start = a random level
        </div>
      )}
      {phase === "lights" && <div className="phase lights">🔔 CLOSING BELL{bellBeat ? ` · beat ${bellBeat}` : ""} · LIGHTS ON</div>}
    </>
  );
}

/* ------------------------------------------------------------------ ladder */

interface Fx {
  id: number;
  kind: "ripple" | "thin" | "gold" | "coins";
  x: number;
  y: number;
  text?: string;
}
interface Toast {
  id: number;
  kind: "fill" | "miss" | "pickedoff";
  title: string;
  sub: string;
}

let fxId = 1;
const coachSeen = (k: string) => {
  try {
    if (localStorage.getItem(k)) return true;
    localStorage.setItem(k, "1");
  } catch {
    /* storage unavailable */
  }
  return false;
};

function toastFor(r: PrivateResult): Toast {
  const pre = r.algo ? "ALGO " : "";
  if (r.kind === "fill")
    return {
      id: r.id, kind: "fill", title: `${pre}FILL ${priceOf(r.level!)}`,
      sub: `+${lots(r.tenths)} lot picked off · still resting here · next fill here: ${lots(r.next ?? 5)}`,
    };
  if (r.kind === "miss") return { id: r.id, kind: "miss", title: `${pre}miss ${priceOf(r.level!)}`, sub: "nothing resting there this beat" };
  return {
    id: r.id, kind: "pickedoff", title: `PICKED OFF −${lots(r.tenths)}`,
    sub: `someone found your order · re-quote or the next fill is ${lots(r.next ?? 10)}`,
  };
}

function Ladder() {
  const me = useGame((s) => s.me);
  const phase = useGame((s) => s.clock.phase);
  const beat = useGame((s) => s.clock.beat);
  const reveal = useGame((s) => s.reveal);
  const seats = useGame((s) => s.table.seats);
  const mySeat = useGame((s) => s.table.mySeat);
  const { selected, moveMode } = useUi(useShallow((s) => ({ selected: s.selected, moveMode: s.moveMode })));
  const wrap = useRef<HTMLDivElement>(null);
  const ladder = useRef<HTMLDivElement>(null);
  const rungs = useRef<(HTMLDivElement | null)[]>([]);
  const chip = useRef<HTMLDivElement>(null);
  const [fx, setFx] = useState<Fx[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [coach, setCoach] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [litStage, setLitStage] = useState(0);

  const pos = useCallback((level: number) => {
    const r = rungs.current[level - 1];
    const w = wrap.current;
    if (!r || !w) return { x: 0, y: 0 };
    const rb = r.getBoundingClientRect();
    const wb = w.getBoundingClientRect();
    return { x: rb.left - wb.left + rb.width / 2, y: rb.top - wb.top + rb.height / 2 };
  }, []);

  const addFx = useCallback((f: Omit<Fx, "id">, ms: number) => {
    const id = fxId++;
    setFx((a) => [...a, { ...f, id }]);
    setTimeout(() => setFx((a) => a.filter((x) => x.id !== id)), ms);
  }, []);

  // own ping ripple, emitted by the action bar / rung clicks
  useEffect(() => {
    const on = (e: Event) => {
      const L = (e as CustomEvent<number>).detail;
      addFx({ kind: "ripple", ...pos(L) }, 950);
    };
    window.addEventListener("po:ping", on);
    return () => window.removeEventListener("po:ping", on);
  }, [addFx, pos]);

  // sweep line + shiver + beat tick on every beat
  const [sweepTop, setSweepTop] = useState(0);
  useEffect(() => {
    if (phase !== "live" || beat < 1) return;
    const L = ((beat - 1) % LEVELS) + 1;
    const r = rungs.current[L - 1];
    if (r) setSweepTop(r.offsetTop + r.offsetHeight / 2);
    const el = ladder.current;
    if (el && beat > 1) {
      el.classList.remove("shiver");
      void el.offsetWidth;
      el.classList.add("shiver");
      const c = useGame.getState().clock;
      if (useUi.getState().beatTick) sfx.beat(c.bellChance >= 0.2);
    }
  }, [beat, phase]);

  // private results -> toasts, rings, sounds, and the measured number
  const seen = useRef(0);
  const results = useGame((s) => s.results);
  useLayoutEffect(() => {
    const fresh = results.filter((r) => r.id > seen.current);
    if (!fresh.length) return;
    seen.current = Math.max(...fresh.map((r) => r.id));
    const latestBeat = Math.max(...fresh.map((r) => r.beat));
    const batch = fresh.filter((r) => r.beat === latestBeat);
    const ts = batch.map(toastFor).sort((a, b) => (a.kind === "pickedoff" ? -1 : b.kind === "pickedoff" ? 1 : 0));
    setToasts(ts);
    const ids = ts.map((t) => t.id);
    setTimeout(() => setToasts((a) => a.filter((t) => !ids.includes(t.id))), 950);
    for (const r of batch) {
      if (r.kind === "pickedoff") {
        setFlash(true);
        setTimeout(() => setFlash(false), 350);
        const c = chip.current;
        if (c) {
          c.classList.remove("shake");
          void c.offsetWidth;
          c.classList.add("shake");
        }
        sfx.pickedOff();
        try {
          if ((navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive) navigator.vibrate?.([60, 40, 60]);
        } catch {
          /* not supported */
        }
        if (!coachSeen("po.coach.pickedoff")) setCoach("Re-quote (R): move before the next beat");
      } else {
        const p = pos(r.level!);
        if (r.algo) {
          addFx({ kind: "thin", ...p }, 950);
          sfx.algoPing();
        }
        if (r.kind === "fill") {
          addFx({ kind: "gold", ...p }, 950);
          addFx({ kind: "coins", x: p.x + 40, y: p.y - 8, text: `+${lots(r.tenths)}` }, 1150);
          setTimeout(() => sfx.fill(r.tenths > 5), r.algo ? 80 : 0);
          if (!coachSeen("po.coach.fill")) setCoach("Ping it again (Space): they're still there");
        } else setTimeout(() => sfx.miss(), r.algo ? 80 : 0);
      }
    }
    // the one number: beat's scheduled close -> private result. The chain driver measures it on
    // arrival and marks only genuine samples; the mock has no network, so it uses the next frame.
    const { clock, table } = useGame.getState();
    if (table.source === "mock") {
      const close = clock.liveStartedAt + latestBeat * BEAT_MS;
      requestAnimationFrame(() => recordLatency(table.round, latestBeat, performance.now() - close));
    } else {
      const ms = batch.find((r) => r.latencyMs !== undefined)?.latencyMs;
      if (ms !== undefined) recordLatency(table.round, latestBeat, ms);
    }
  }, [results, addFx, pos]);

  useEffect(() => {
    if (!coach) return;
    const t = setTimeout(() => setCoach(null), 3200);
    return () => clearTimeout(t);
  }, [coach]);

  // LIGHTS ON: dim, then show every order at its final level
  useEffect(() => {
    if (!reveal) {
      setLitStage(0);
      return;
    }
    setLitStage(1);
    const t = setTimeout(() => setLitStage(2), 300);
    return () => clearTimeout(t);
  }, [reveal]);

  const live = phase === "live" && !!me;
  const onRung = (L: number) => {
    unlockAudio();
    useUi.setState({ interacted: true });
    const a = actions();
    if (!me) return;
    if (phase === "hide") {
      a.place(L);
      sfx.requote();
      return;
    }
    if (phase !== "live") return;
    if (moveMode) {
      if (L !== me.level) {
        a.requote(L);
        sfx.requote();
      }
      useUi.setState({ moveMode: false });
      return;
    }
    useUi.setState({ selected: L });
    a.ping(L);
    sfx.ping();
    window.dispatchEvent(new CustomEvent("po:ping", { detail: L }));
  };

  const finalLevels = reveal ? (reveal.beats.at(-1)?.levels ?? reveal.initialLevels) : null;
  const pending = me?.pending;

  return (
    <div className="ladderwrap" ref={wrap}>
      <div className={"flash" + (flash ? " on" : "")} />
      <div className={"ladder" + (moveMode ? " move" : "") + (litStage === 1 ? " dim" : "")} ref={ladder} data-testid="ladder">
        {LEVEL_LIST.map((L) => {
          const mine = me?.level === L;
          const mark = me?.marks[L];
          const isAlgo = live && pending?.kind === "none" && me?.nextAlgo === L;
          const queuedPing = live && pending?.kind === "ping" && pending.level === L;
          const dest = live && pending?.kind === "requote" && pending.level === L;
          let label = "";
          if (queuedPing) label = "ping ›";
          else if (dest) label = "re-quote ›";
          else if (mark === "fill") label = "FILL ●";
          else if (mark === "miss") label = "miss ·";
          else if (isAlgo) label = "algo ›";
          const cls =
            "rung" +
            (L === MID ? " mid" : "") +
            (mine ? " mine" : "") +
            (live && selected === L && !mine ? " sel" : "") +
            (mark && !queuedPing && !dest ? " " + mark : "") +
            (isAlgo && !mark ? " algonext" : "") +
            (queuedPing ? " queued" : "") +
            (dest ? " dest" : "");
          const here = finalLevels && litStage === 2 ? finalLevels.map((lv, d) => (lv === L ? d : -1)).filter((d) => d >= 0) : [];
          return (
            <div key={L} className={cls} ref={(el) => { rungs.current[L - 1] = el; }} onClick={() => onRung(L)} data-level={L}>
              <div className="px">{priceOf(L)}</div>
              <div className="depth">
                {mine && !here.length && (
                  <div className="order" ref={chip}>
                    YOUR ORDER <span className="lots">{lots(me!.resting)}</span> lots · dark
                  </div>
                )}
                {here.map((d, k) => {
                  const you = d === mySeat;
                  const top = d === reveal!.topDesk;
                  const c = you ? "var(--you)" : top ? "var(--gold)" : DESK_COLORS[d % DESKS];
                  return (
                    <div key={d} className="lit" style={{ left: 8 + k * 86, border: `1px solid ${c}`, color: c, background: "#0b1020" }}>
                      {you ? "YOU" : seats[d]?.name} {lots(reveal!.totals[d] - (seats[d]?.picked ?? 0))}
                    </div>
                  );
                })}
              </div>
              <div className="mark">{label}</div>
            </div>
          );
        })}
        {phase === "live" && <div className="sweep" style={{ top: sweepTop }} />}
      </div>
      {fx.map((f) =>
        f.kind === "coins" ? (
          <div key={f.id} className="coins" style={{ left: f.x, top: f.y }}>{f.text}</div>
        ) : (
          <div key={f.id} className={"ripple" + (f.kind === "gold" ? " gold" : f.kind === "thin" ? " thin" : "")} style={{ left: f.x, top: f.y }} />
        ),
      )}
      <div className="toasts" data-testid="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={"toast " + t.kind}>
            {t.title}
            <small>{t.sub}</small>
          </div>
        ))}
      </div>
      {coach && <div className="coach">{coach}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ actions */

function ActionBar() {
  const me = useGame((s) => s.me);
  const phase = useGame((s) => s.clock.phase);
  const beat = useGame((s) => s.clock.beat);
  const { selected, moveMode } = useUi(useShallow((s) => ({ selected: s.selected, moveMode: s.moveMode })));
  const live = phase === "live" && !!me;
  const pulse = !!me && me.pickedOffBeat !== null && beat - me.pickedOffBeat <= 2 && me.pending.kind !== "requote";
  const pend = me?.pending;
  return (
    <div className="actions">
      <button
        className={"btn ping" + (pend?.kind === "ping" ? " on" : "")}
        disabled={!live}
        onClick={() => {
          unlockAudio();
          useUi.setState({ interacted: true });
          actions().ping(selected);
          sfx.ping();
          window.dispatchEvent(new CustomEvent("po:ping", { detail: selected }));
        }}
      >
        PING <span className="mono">{priceOf(selected)}</span>
      </button>
      <button
        className={"btn move" + (moveMode ? " on" : "") + (pulse ? " pulse" : "")}
        disabled={!live}
        title="Click, then click a price. Press twice: re-quote to a random untested level."
        onClick={() => {
          unlockAudio();
          useUi.setState({ interacted: true });
          if (moveMode) {
            actions().requote(null);
            sfx.requote();
            useUi.setState({ moveMode: false });
          } else useUi.setState({ moveMode: true });
        }}
      >
        RE-QUOTE (move)
      </button>
      <div className="algo">
        {!me ? (
          "Watching: take a desk to play."
        ) : phase === "hide" ? (
          <>Click a price to hide your order. Pings start when the pool goes live.</>
        ) : phase === "lights" ? (
          <>Lights on: the whole book replays.</>
        ) : pend?.kind === "ping" ? (
          <>This beat: you ping <b>{priceOf(pend.level)}</b>. Click another price to change your mind.</>
        ) : pend?.kind === "requote" ? (
          <>This beat: you re-quote to <b>{priceOf(pend.level)}</b>.</>
        ) : moveMode ? (
          <>Click the price to move your order to (or press RE-QUOTE again for a random one).</>
        ) : (
          <>No click this beat? Your algo pings <b>{priceOf(me.nextAlgo)}</b> for you.</>
        )}
      </div>
    </div>
  );
}

function Keys() {
  const beatTick = useUi((s) => s.beatTick);
  return (
    <span className="keys">
      Space ping last FILL · R re-quote · ↑↓ Enter ·{" "}
      <button className="close" onClick={() => useUi.setState({ beatTick: !beatTick })}>
        beat tick {beatTick ? "on" : "off"}
      </button>
    </span>
  );
}

function useKeys() {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const ui = useUi.getState();
      if (e.key === "Escape") {
        useUi.setState({ peekOpen: false, moveMode: false });
        return;
      }
      if (ui.peekOpen) return;
      const { me, clock } = useGame.getState();
      if (!me || clock.phase !== "live") return;
      const a = actions();
      const ping = (L: number) => {
        unlockAudio();
        useUi.setState({ selected: L, interacted: true });
        a.ping(L);
        sfx.ping();
        window.dispatchEvent(new CustomEvent("po:ping", { detail: L }));
      };
      if (e.key === " ") {
        e.preventDefault();
        ping(me.lastFill ?? ui.selected);
      } else if (e.key === "r" || e.key === "R") {
        unlockAudio();
        useUi.setState({ interacted: true, moveMode: false });
        a.requote(null);
        sfx.requote();
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const d = e.key === "ArrowUp" ? -1 : 1;
        useUi.setState({ selected: Math.min(LEVELS, Math.max(1, ui.selected + d)) });
      } else if (e.key === "Enter") {
        ping(ui.selected);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
}

export function Pool() {
  useKeys();
  return (
    <section className="panel pool" data-testid="pool">
      <Status />
      <Banners />
      <Ladder />
      <div className="legend">
        <span><i style={{ background: "var(--you)" }} />your hidden order (only you see it)</span>
        <span><i style={{ background: "var(--gold)" }} />your FILL: size rests here</span>
        <span><i style={{ background: "#4b5670" }} />your miss (it was empty then)</span>
        <span><i style={{ background: "var(--sonar)" }} />your algo's next ping</span>
        <Keys />
      </div>
      <ActionBar />
    </section>
  );
}
