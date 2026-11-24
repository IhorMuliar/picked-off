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
        // the store updates the deadline when the next beat lands; until then keep turning
        let end = c.beatEndsAt;
        if (end > 0 && end < t) end += Math.ceil((t - end) / BEAT_MS) * BEAT_MS;
        const left = end > 0 ? Math.min(BEAT_MS, end - t) : 0;
        frac = left / BEAT_MS;
        label = `next beat ${(left / 1000).toFixed(1)} s`;
      } else if (c.phase === "hide") {
        const left = Math.max(0, c.phaseEndsAt - t);
        frac = Math.min(1, left / 5000);
        label = left > 0 ? `live in ${(left / 1000).toFixed(1)} s` : "going live…";
      } else if (c.phase === "lights") {
        const left = Math.max(0, c.phaseEndsAt - t);
        frac = Math.min(1, left / 8000);
        label = `next round ${Math.ceil(left / 1000)} s`;
      } else label = "connecting…";
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
    phase === "connecting" ? "–:–– · joining" : phase === "hide" ? "0:00 · HIDE" : phase === "lights" ? `${mmss(5 + (reveal?.bellBeat ?? beat) * 1.5)} · bell` : `${mmss(5 + (beat - 1) * 1.5)} · beat ${beat}`;
  return (
    <div className="status">
      <div>
        <div className="pool-id">
          HOUSE POOL #{pool} · {bots} bot{bots === 1 ? "" : "s"}
        </div>
        <div className="clock mono" data-testid="clock">{clock}</div>
      </div>
      <div className={"bell" + (pct > 0 ? " hot" : "")} title="The closing auction ends after a VRF-drawn live beat between 20 and 29">
        <span className="what">🔔 bell: secret beat 20–29</span>
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

/** The join notice stays up for this many live beats after it is first seen, then goes away on its own. */
const NOTICE_BEATS = 2;

/** One notice line under the status strip: join notice, spectator offer, or the phase hint. */
function Notice() {
  const canJoin = useGame((s) => s.canJoin);
  const phase = useGame((s) => s.clock.phase);
  const beat = useGame((s) => s.clock.beat);
  const round = useGame((s) => s.table.round);
  const mySeat = useGame((s) => s.table.mySeat);
  const name = useGame((s) => (s.table.mySeat !== null ? s.table.seats[s.table.mySeat]?.name : undefined));
  const seated = useGame((s) => s.me !== null && s.table.mySeat !== null);
  const me = useGame(useShallow((s) => (s.me ? { level: s.me.level, resting: s.me.resting } : null)));
  const bellBeat = useGame((s) => s.reveal?.bellBeat);
  // "You're in": announced each time this browser gets a desk, from the live view (not a snapshot),
  // hidden during the bell, gone after NOTICE_BEATS live beats or on GOT IT
  const [announce, setAnnounce] = useState<{ seat: number; until: { round: number; beat: number } | null } | null>(null);
  useEffect(() => {
    if (!seated || mySeat === null) {
      if (announce) setAnnounce(null);
      return;
    }
    if (!announce || (announce.seat !== mySeat && announce.seat !== -1 - mySeat)) {
      setAnnounce({ seat: mySeat, until: null });
      return;
    }
    if (announce.seat < 0 || phase !== "live") return;
    if (!announce.until) setAnnounce({ seat: mySeat, until: { round, beat: beat + NOTICE_BEATS - 1 } });
    else if (round !== announce.until.round || beat > announce.until.beat) setAnnounce({ seat: -1 - mySeat, until: null });
  }, [seated, mySeat, phase, beat, round, announce]);
  const showJoin = !!announce && announce.seat >= 0 && phase !== "lights" && phase !== "connecting";
  const dismiss = () => mySeat !== null && setAnnounce({ seat: -1 - mySeat, until: null });

  let body: React.ReactNode = null;
  let kind = "hint";
  if (canJoin) {
    kind = "join";
    body = (
      <>
        <span>You're watching. <b>Take a desk</b>: free chips, no wallet, you take over a house bot's order as it stands.</span>
        <button className="go" data-testid="takedesk" onClick={() => { unlockAudio(); actions().join(); }}>
          TAKE A DESK
        </button>
      </>
    );
  } else if (showJoin) {
    kind = "join";
    const placed = me && me.level > 0;
    body = (
      <>
        <span data-testid="join">
          You're in{name ? <>: <b>{name}</b></> : null}, desk {mySeat! + 1} of 8 · free chips, no wallet.{" "}
          {placed && me!.resting > 0 ? (
            <>Your {lots(me!.resting)} lots rest dark at <b>{priceOf(me!.level)}</b>. </>
          ) : null}
          {phase === "hide" ? "Click a price to hide your order." : "Your algo pings for you: click any price to ping it yourself."}
        </span>
        <button className="go" onClick={() => { unlockAudio(); dismiss(); }}>
          GOT IT
        </button>
      </>
    );
  } else if (phase === "hide") {
    kind = "hide";
    body = (
      <span>
        <b>HIDE</b> · click a price to rest your 10 lots there{me?.level ? <> · now at <b>{priceOf(me.level)}</b></> : null} · not placed = a random level
      </span>
    );
  } else if (phase === "lights") {
    kind = "lights";
    body = <span>🔔 CLOSING BELL{bellBeat ? ` · beat ${bellBeat}` : ""} · LIGHTS ON · the whole book replays</span>;
  } else if (phase === "live" && me) {
    body = (
      <span>
        <b>LIVE</b> · click a price to ping it · <b className="g">FILL</b>: ping it again · <b className="r">PICKED OFF</b>: re-quote
      </span>
    );
  } else if (!me && mySeat === null && phase !== "connecting") {
    body = <span><b>Watching</b> · a desk is on its way to you · every desk pings one price per beat; orders stay dark until the bell</span>;
  } else body = <span>{phase === "connecting" ? "connecting to the pool…" : "opening your desk…"}</span>;
  return <div className={"notice " + kind}>{body}</div>;
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
            ((live || (phase === "hide" && !!me)) && selected === L && !mine ? " sel" : "") +
            (mark && !queuedPing && !dest ? " " + mark : "") +
            (isAlgo && !mark ? " algonext" : "") +
            (queuedPing ? " queued" : "") +
            (dest ? " dest" : "");
          const here = finalLevels && litStage === 2 ? finalLevels.map((lv, d) => (lv === L ? d : -1)).filter((d) => d >= 0) : [];
          return (
            <div key={L} className={cls} ref={(el) => { rungs.current[L - 1] = el; }} onClick={() => onRung(L)} data-level={L} role="button" aria-label={`price ${priceOf(L)}${label ? ` · ${label}` : ""}`}>
              <div className="px">{priceOf(L)}</div>
              <div className="depth">
                {mine && !here.length && (
                  <div className="order" ref={chip}>
                    {me!.resting > 0 ? (
                      <>YOUR ORDER <span className="lots">{lots(me!.resting)}</span> lots · dark</>
                    ) : (
                      <>YOUR ORDER · all picked off</>
                    )}
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
        onClick={(e) => {
          if (e.detail > 0) e.currentTarget.blur();
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
        onClick={(e) => {
          if (e.detail > 0) e.currentTarget.blur();
          unlockAudio();
          useUi.setState({ interacted: true });
          if (moveMode) {
            actions().requote(null);
            sfx.requote();
            useUi.setState({ moveMode: false });
          } else useUi.setState({ moveMode: true });
        }}
      >
        RE-QUOTE
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
      <kbd>Space</kbd> re-ping FILL · <kbd>R</kbd> re-quote · <kbd>↑</kbd><kbd>↓</kbd><kbd>Enter</kbd> ping ·{" "}
      <button className="linkbtn" aria-pressed={beatTick} title="quiet tick on every beat" onClick={() => useUi.setState({ beatTick: !beatTick })}>
        tick {beatTick ? "on" : "off"}
      </button>
    </span>
  );
}

function useKeys() {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const onControl = e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement;
      if (onControl && (e.key === " " || e.key === "Enter")) return; // the focused control handles it
      const ui = useUi.getState();
      if (e.key === "Escape") {
        useUi.setState({ peekOpen: false, moveMode: false });
        return;
      }
      if (ui.peekOpen) return;
      const { me, clock } = useGame.getState();
      if (!me) return;
      if (clock.phase === "hide") {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const d = e.key === "ArrowUp" ? -1 : 1;
          useUi.setState({ selected: Math.min(LEVELS, Math.max(1, ui.selected + d)) });
        } else if (e.key === "Enter") {
          unlockAudio();
          actions().place(ui.selected);
          sfx.requote();
        }
        return;
      }
      if (clock.phase !== "live") return;
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
      <Notice />
      <Ladder />
      <div className="legend">
        <span><i style={{ background: "var(--you)" }} />your hidden order</span>
        <span><i style={{ background: "var(--gold)" }} />FILL</span>
        <span><i style={{ background: "#5b6680" }} />miss</span>
        <span><i style={{ background: "var(--sonar)" }} />algo's next ping</span>
        <Keys />
      </div>
      <ActionBar />
    </section>
  );
}
