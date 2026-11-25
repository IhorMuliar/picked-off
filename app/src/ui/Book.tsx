/**
 * The book: 24 prices as two sides of an order book around a spine. Bids (100.00 ↓ 99.89) on the left, asks
 * (100.01 ↑ 100.12) on the right, best prices on the top row. Every row is one tap. Results land on the row they
 * concern; your own order is always a chip on its row; marks stay for the round so the book becomes your map.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { recordLatency, useGame, useUi } from "../state/store";
import { BEAT_MS, lots, priceOf, type RevealView, type Seat } from "../state/types";
import { sfx } from "../fx/sound";
import { useRound, type Mark } from "./round";
import { moveTo, tapPrice } from "./act";
import { CrossIcon } from "./icons";

/** Row i (0 = top) of each side. */
export const ASK = Array.from({ length: 12 }, (_, i) => 12 - i);
export const BID = Array.from({ length: 12 }, (_, i) => 13 + i);
/** Static depth silhouette: the dark book is deeper away from the mid. */
const depth = (i: number) => 0.34 + i * 0.05;

export const shortName = (s: Seat | undefined, wide: boolean) => {
  if (!s) return "";
  if (wide) return s.name;
  const m = /^([A-Z])[A-Z]*-(\d+)$/.exec(s.name);
  return m ? `${m[1]}${m[2]}` : s.name.slice(0, 5);
};

function Pips({ step, next }: { step: number; next?: boolean }) {
  return (
    <span className={"pips" + (next ? " next" : "")} aria-hidden="true">
      {[1, 2, 3].map((k) => (
        <i key={k} className={k <= step ? "on" : ""} />
      ))}
    </span>
  );
}

function MarkView({ m, age, live, isLastFill, nextSkim }: { m: Mark; age: number; live: boolean; isLastFill: boolean; nextSkim: number }) {
  if (m.kind === "miss")
    return m.algo ? <span className="mk dot" title="auto miss" /> : <span className="mk miss">miss</span>;
  return (
    <span className={"mk fill" + (m.algo ? " auto" : "") + (age > 6 ? " old" : "")}>
      {m.algo && <span className="lbl">auto</span>}
      <b>+{lots(m.tenths)}</b>
      <Pips step={m.step} />
      {m.orders > 1 && (
        <span className="lbl" title={`from ${m.orders} hidden orders`}>
          ×{m.orders}
        </span>
      )}
      {live && isLastFill && <span className="nx">next +{lots(nextSkim)}</span>}
    </span>
  );
}

function LitTags({ L, r, seats, mySeat, wide }: { L: number; r: RevealView; seats: Seat[]; mySeat: number | null; wide: boolean }) {
  const final = r.beats.at(-1)?.levels ?? r.initialLevels;
  const here = final.map((lv, d) => (lv === L ? d : -1)).filter((d) => d >= 0);
  if (!here.length) return null;
  const max = wide ? 3 : 2;
  return (
    <span className="littags">
      {here.slice(0, max).map((d) => (
        <span key={d} className={"tag" + (d === mySeat ? " you" : "") + (d === r.topDesk ? " top" : "")}>
          {d === mySeat ? "You" : shortName(seats[d], wide)} <b>{lots(r.totals[d])}</b>
        </span>
      ))}
      {here.length > max && <span className="tag more">+{here.length - max}</span>}
    </span>
  );
}

function useWide() {
  const q = "(min-width: 1000px)";
  const [wide, set] = useState(() => typeof matchMedia !== "undefined" && matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => set(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

/** Sounds, vibration and the measured number for each new batch of private results. */
function useResultFx() {
  const log = useRound((s) => s.log);
  useLayoutEffect(() => {
    if (!log.length) return;
    const latestBeat = Math.max(...log.map((r) => r.beat));
    for (const r of log) {
      if (r.kind === "pickedoff") {
        sfx.pickedOff();
        try {
          if ((navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive) navigator.vibrate?.([60, 40, 60]);
        } catch {
          /* not supported */
        }
      } else if (!r.algo) {
        if (r.kind === "fill") sfx.fill(r.tenths > 5);
        else sfx.miss();
      }
    }
    // the one number: the beat's scheduled close -> this private result on screen. The chain driver measures it on
    // arrival and marks only genuine samples; the mock has no network, so it measures to the next frame.
    const { clock, table } = useGame.getState();
    if (table.source === "mock") {
      const close = clock.liveStartedAt + latestBeat * BEAT_MS;
      requestAnimationFrame(() => recordLatency(table.round, latestBeat, performance.now() - close));
    } else {
      const ms = log.find((r) => r.latencyMs !== undefined)?.latencyMs;
      if (ms !== undefined) recordLatency(table.round, latestBeat, ms);
    }
  }, [log]);
}

export function Book() {
  const me = useGame((s) => s.me);
  const { phase, beat } = useGame(useShallow((s) => ({ phase: s.clock.phase, beat: s.clock.beat })));
  const reveal = useGame((s) => s.reveal);
  const seats = useGame((s) => s.table.seats);
  const mySeat = useGame((s) => s.table.mySeat);
  const offline = useGame((s) => s.banner?.kind === "offline");
  const { marks, flash, hit } = useRound(useShallow((s) => ({ marks: s.marks, flash: s.flash, hit: s.hit })));
  const { moveMode, selected, cursorOn } = useUi(useShallow((s) => ({ moveMode: s.moveMode, selected: s.selected, cursorOn: s.cursorOn })));
  const wide = useWide();
  const [firstTap, setFirstTap] = useState(() => {
    try {
      return !localStorage.getItem("po.tapped");
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (!firstTap) return;
    const id = setInterval(() => {
      try {
        if (localStorage.getItem("po.tapped")) setFirstTap(false);
      } catch {
        setFirstTap(false);
      }
    }, 300);
    return () => clearInterval(id);
  }, [firstTap]);
  useResultFx();

  // lights on: the hatch lifts row by row, then every order shows
  const [lit, setLit] = useState(0);
  const revealRound = reveal?.round ?? null;
  useEffect(() => {
    if (revealRound === null) return setLit(0);
    setLit(1);
    const t = setTimeout(() => setLit(2), 420);
    return () => clearTimeout(t);
  }, [revealRound]);

  // drag your order chip to a price (a precise move in one gesture)
  const drag = useRef<{ id: number; x: number; y: number; on: boolean } | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const suppress = useRef(false);
  const levelAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-level]");
    return el ? Number(el.dataset.level) : null;
  };

  const live = phase === "live" && !!me;
  const seated = !!me && mySeat !== null;
  const pending = me?.pending;
  const hitNow = !!hit && !!me && me.pickedOffBeat !== null && beat - hit.beat <= 2;

  const row = (L: number, i: number, side: "bid" | "ask") => {
    const mine = seated && me!.level === L && lit < 2;
    const m = marks[L];
    const age = m ? beat - m.beat : 0;
    const f = flash[L];
    const queued = live && pending?.kind === "ping" && pending.level === L;
    const dest = live && pending?.kind === "requote" && pending.level === L;
    const auto = live && pending?.kind === "none" && me!.nextAlgo === L && !mine;
    const cls = [
      "row", side,
      mine && "mine", mine && hitNow && "hurt", mine && me!.resting === 0 && "empty",
      m && (m.algo ? `m-${m.kind} m-auto` : `m-${m.kind}`), m && age > 6 && "aged",
      queued && "queued", dest && "dest", auto && "autonext", auto && firstTap && "suggest",
      cursorOn && selected === L && "cursor", dragOver === L && "over",
    ].filter(Boolean).join(" ");
    const seenFrac = m?.kind === "miss" ? Math.min(1, Math.max(0, age - 1) / 8) : 1;
    let label = `${priceOf(L)}`;
    if (mine) label += ", your order";
    if (m) label += m.kind === "fill" ? `, FILL +${lots(m.tenths)}` : ", miss";
    if (queued) label += ", ping queued";
    return (
      <button
        key={L}
        type="button"
        className={cls}
        data-level={L}
        aria-label={label}
        style={{ "--d": depth(i), "--seen": m?.kind === "fill" ? 0 : seenFrac } as React.CSSProperties}
        onClick={() => {
          if (suppress.current) {
            suppress.current = false;
            return;
          }
          useUi.setState({ cursorOn: false, selected: L });
          tapPrice(L);
        }}
        onPointerDown={(e) => {
          if (!mine || !live || e.button !== 0) return;
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false };
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          if (!d.on && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) d.on = true;
          if (d.on) setDragOver(levelAt(e.clientX, e.clientY));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (!d || !d.on) return;
          setDragOver(null);
          const to = levelAt(e.clientX, e.clientY);
          suppress.current = true;
          setTimeout(() => (suppress.current = false), 400);
          if (to && to !== me!.level) moveTo(to);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragOver(null);
        }}
      >
        <span className="hatch" aria-hidden="true" />
        {f && !mine && <span key={f.id} className={"burst " + f.kind + (f.algo ? " auto" : "")} aria-hidden="true" />}
        <span className="px">{priceOf(L)}</span>
        <span className="slot">
          {lit === 2 && reveal ? (
            <LitTags L={L} r={reveal} seats={seats} mySeat={mySeat} wide={wide} />
          ) : mine ? (
            <span key={hitNow ? hit!.id : "chip"} className={"chip-order" + (hitNow ? " hit" : "")} data-testid="order">
              {hitNow ? (
                <>
                  <CrossIcon size={11} />
                  <b>−{lots(hit!.tenths)}</b>
                  {hit!.count > 1 && <span className="lbl">×{hit!.count}</span>}
                </>
              ) : me!.resting > 0 ? (
                <>
                  You <b>{lots(me!.resting)}</b>
                </>
              ) : (
                <>
                  You <b>0.0</b>
                </>
              )}
            </span>
          ) : queued ? (
            <span className="q">ping</span>
          ) : dest ? (
            <span className="q">move here</span>
          ) : m ? (
            <MarkView m={m} age={age} live={live} isLastFill={me?.lastFill === L} nextSkim={me?.nextSkim ?? 5} />
          ) : auto ? (
            <span className="mk autonext">auto</span>
          ) : null}
        </span>
      </button>
    );
  };

  const cls = ["book", moveMode && live && "moving", lit === 1 && "lighting", lit === 2 && "lit", !seated && "watching", offline && "offline", phase === "connecting" && "dark"]
    .filter(Boolean)
    .join(" ");
  return (
    <section className={cls} data-testid="ladder" aria-label="Order book: 24 prices">
      <div className="side-h bid">Bids</div>
      <div className="side-h ask">Asks</div>
      <div className="col bid">{BID.map((L, i) => row(L, i, "bid"))}</div>
      <div className="spine" aria-hidden="true" />
      <div className="col ask">{ASK.map((L, i) => row(L, i, "ask"))}</div>
    </section>
  );
}


