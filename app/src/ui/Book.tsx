/**
 * The book: 24 prices as two sides of an order book around a spine. Bids (100.00 ↓ 99.89) on the left, asks
 * (100.01 ↑ 100.12) on the right, best prices on the top row. Every row is one tap. Results land on the row they
 * concern; your own order is always a chip on its row; marks stay for the round so the book becomes your map.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { recordLatency, useGame, useUi } from "../state/store";
import { BEAT_MS, lots, priceOf, type RevealView, type Seat } from "../state/types";
import { sfx } from "../fx/sound";
import { seen, useRound, type Mark } from "./round";
import { useLink } from "./link";
import { moveTo, tapPrice } from "./act";

/** Row i (0 = top) of each side. */
export const ASK = Array.from({ length: 12 }, (_, i) => 12 - i);
export const BID = Array.from({ length: 12 }, (_, i) => 13 + i);

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
      {live && isLastFill && <span className="nx">next +{lots(nextSkim)}{m.orders > 1 ? " each" : ""}</span>}
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

interface RowProps {
  L: number;
  i: number;
  side: "bid" | "ask";
  cls: string;
  label: string;
  disabled: boolean;
  seen: number;
  flash?: { id: number; kind: "fill" | "miss"; algo: boolean };
  ring?: number;
  /** what the row's slot shows */
  slot: "lit" | "mine" | "queued" | "dest" | "joining" | "target" | "mark" | "auto" | "none";
  reveal?: RevealView | null;
  seats?: Seat[];
  mySeat?: number | null;
  wide?: boolean;
  hidden?: number;
  hitTenths?: number;
  hitCount?: number;
  hitId?: number;
  moved?: boolean;
  mark?: Mark;
  age?: number;
  live?: boolean;
  lastFill?: boolean;
  nextSkim?: number;
}

/** One price row. Memoized: a beat or a tap re-renders only the rows whose look changed. */
const Row = memo(function Row(p: RowProps) {
  return (
    <button type="button" className={p.cls} data-level={p.L} aria-label={p.label} disabled={p.disabled} style={{ "--seen": p.seen, "--i": p.i } as React.CSSProperties}>
      <span className="hatch" aria-hidden="true" />
      {p.flash && p.slot !== "mine" && <span key={p.flash.id} className={"burst " + p.flash.kind + (p.flash.algo ? " auto" : "")} aria-hidden="true" />}
      {p.ring !== undefined && <span key={"ring" + p.ring} className="burst ring" aria-hidden="true" />}
      <span className="px">{priceOf(p.L)}</span>
      <span className="slot">
        {p.slot === "lit" ? (
          <LitTags L={p.L} r={p.reveal!} seats={p.seats!} mySeat={p.mySeat ?? null} wide={!!p.wide} />
        ) : p.slot === "mine" ? (
          <>
            <span key={p.hitId ?? "chip"} className={"chip-order" + (p.hitId !== undefined ? " hit" : "")} data-testid="order">
              You{!!p.hidden && <b>{lots(p.hidden)}</b>}
            </span>
            {p.hitId !== undefined ? (
              <span className="hitlbl">
                −{lots(p.hitTenths!)}
                {p.hitCount! > 1 ? ` ×${p.hitCount}` : ""}
              </span>
            ) : p.moved ? (
              <span className="movedlbl">moved here</span>
            ) : null}
          </>
        ) : p.slot === "queued" ? (
          <span className="q">ping</span>
        ) : p.slot === "dest" || p.slot === "joining" ? (
          <span className="q">{p.slot === "joining" ? "hiding here" : "move here"}</span>
        ) : p.slot === "target" ? (
          <span className="tgt">move here</span>
        ) : p.slot === "mark" ? (
          <MarkView m={p.mark!} age={p.age!} live={!!p.live} isLastFill={!!p.lastFill} nextSkim={p.nextSkim ?? 5} />
        ) : p.slot === "auto" ? (
          <span className="mk autonext">auto</span>
        ) : null}
      </span>
    </button>
  );
});

const NO_SEATS: Seat[] = [];

export function Book() {
  const me = useGame((s) => s.me);
  const { phase, beat } = useGame(useShallow((s) => ({ phase: s.clock.phase, beat: s.clock.beat })));
  const reveal = useGame((s) => s.reveal);
  // the seat list changes on every table update; the book needs it only for the lights-on tags
  const seats = useGame((s) => (s.reveal ? s.table.seats : NO_SEATS));
  const mySeat = useGame((s) => s.table.mySeat);
  const stale = useLink((s) => s.stale);
  const r = useRound(
    useShallow((s) => ({ marks: s.marks, flash: s.flash, hit: s.hit, moved: s.moved, joinMove: s.joinMove, hidePick: s.hidePick, late: s.late, seatedAt: s.seatedAt })),
  );
  const { marks, flash, hit } = r;
  const { moveMode, selected, cursorOn } = useUi(useShallow((s) => ({ moveMode: s.moveMode, selected: s.selected, cursorOn: s.cursorOn })));
  const wide = useWide();
  const [firstTap, setFirstTap] = useState(() => !seen("po.tapped"));
  useEffect(() => {
    if (!firstTap) return;
    const id = setInterval(() => seen("po.tapped") && setFirstTap(false), 300);
    return () => clearInterval(id);
  }, [firstTap]);
  useResultFx();

  // "Tap a price" pressed: the rows answer with one soft pulse
  const [nudge, setNudge] = useState(0);
  useEffect(() => {
    const on = () => setNudge((x) => x + 1);
    window.addEventListener("po:nudge", on);
    return () => window.removeEventListener("po:nudge", on);
  }, []);

  // lights on: the hatch lifts row by row from the spine, then every order shows
  const [lit, setLit] = useState(0);
  const revealRound = reveal?.round ?? null;
  useEffect(() => {
    if (revealRound === null) return setLit(0);
    setLit(1);
    const t = setTimeout(() => setLit(2), 420);
    return () => clearTimeout(t);
  }, [revealRound]);

  // one set of handlers for the whole book (rows stay memoized): tap, and drag your chip for a precise move
  const drag = useRef<{ id: number; x: number; y: number; on: boolean } | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const suppress = useRef(false);
  const levelAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-level]");
    return el ? Number(el.dataset.level) : null;
  };
  const rowOf = (t: EventTarget | null) => {
    const el = (t as HTMLElement | null)?.closest?.<HTMLElement>("[data-level]");
    return el ? Number(el.dataset.level) : null;
  };

  const live = phase === "live" && !!me && !stale;
  const seated = !!me && mySeat !== null;
  const pending = me?.pending;
  const joinBeat = r.late && r.seatedAt ? r.seatedAt.beat : -1;
  const hitNow = phase === "live" && !!hit && !!me && me.pickedOffBeat !== null && beat - hit.beat <= 2 && hit.beat > joinBeat;
  const orderAt = phase === "hide" && r.hidePick !== null ? r.hidePick : (me?.level ?? 0);
  const movedHere = phase === "live" && !!r.moved && beat <= r.moved.beat + 1;

  const row = (L: number, i: number, side: "bid" | "ask") => {
    const mine = seated && orderAt === L && lit < 2;
    const m = marks[L];
    const age = m ? beat - m.beat : 0;
    const queued = live && pending?.kind === "ping" && pending.level === L;
    const dest = live && pending?.kind === "requote" && pending.level === L;
    const joining = dest && r.joinMove?.level === L;
    const auto = live && pending?.kind === "none" && me!.nextAlgo === L && !mine;
    const target = live && moveMode && !mine;
    const cls = [
      "row", side,
      mine && "mine", mine && hitNow && "hurt", mine && movedHere && !hitNow && "justmoved",
      m && (m.algo ? `m-${m.kind} m-auto` : `m-${m.kind}`), m && age > 6 && "aged",
      queued && "queued", dest && "dest", auto && "autonext", auto && firstTap && "suggest",
      target && "target", cursorOn && selected === L && "cursor", dragOver === L && "over",
    ].filter(Boolean).join(" ");
    const seenFrac = m?.kind === "miss" ? Math.min(1, Math.max(0, age - 1) / 8) : m ? 0 : 1;
    let label = `${priceOf(L)}`;
    if (mine) label += ", your order";
    if (m) label += m.kind === "fill" ? `, FILL +${lots(m.tenths)}` : ", miss";
    if (queued) label += ", ping queued";
    const slot: RowProps["slot"] =
      lit === 2 && reveal ? "lit" : mine ? "mine" : queued ? "queued" : joining ? "joining" : dest ? "dest" : target ? "target" : m ? "mark" : auto ? "auto" : "none";
    const props: RowProps = {
      L, i, side, cls, label, disabled: stale && phase !== "connecting", seen: seenFrac, flash: mine ? undefined : flash[L], slot,
      ring: mine && hitNow ? hit!.id : undefined,
    };
    if (slot === "lit") Object.assign(props, { reveal, seats, mySeat, wide });
    if (slot === "mine")
      Object.assign(props, { hidden: me ? me.resting : 0, moved: movedHere, ...(hitNow ? { hitTenths: hit!.tenths, hitCount: hit!.count, hitId: hit!.id } : {}) });
    if (slot === "mark") Object.assign(props, { mark: m, age: age > 6 ? 7 : 0, live, lastFill: me?.lastFill === L && !m!.algo, nextSkim: me?.nextSkim ?? 5 });
    return <Row key={L} {...props} />;
  };

  const cls = [
    "book", moveMode && live && "moving", lit === 1 && "lighting", lit === 2 && "lit", !seated && "watching",
    stale && phase !== "connecting" && "offline", phase === "connecting" && "dark",
  ].filter(Boolean).join(" ");
  return (
    <section
      key={"n" + nudge}
      className={cls + (nudge ? " nudge" : "")}
      data-testid="ladder"
      aria-label="Order book: 24 prices"
      onClick={(e) => {
        const L = rowOf(e.target);
        if (L === null) return;
        if (suppress.current) {
          suppress.current = false;
          return;
        }
        useUi.setState({ cursorOn: false, selected: L });
        tapPrice(L);
      }}
      onPointerDown={(e) => {
        const L = rowOf(e.target);
        if (L === null || L !== orderAt || !live || e.button !== 0) return;
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false };
        (e.target as HTMLElement).closest<HTMLElement>("[data-level]")?.setPointerCapture?.(e.pointerId);
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
        if (to && me && to !== me.level) moveTo(to);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragOver(null);
      }}
    >
      <div className="col bid">{BID.map((L, i) => row(L, i, "bid"))}</div>
      <div className="spine" aria-hidden="true" />
      <div className="col ask">{ASK.map((L, i) => row(L, i, "ask"))}</div>
    </section>
  );
}
