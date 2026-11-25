/** The eight desks as a compact leaderboard (public tallies, bots labelled) and the recent public fills. */
import { useEffect, useRef } from "react";
import { useGame } from "../state/store";
import { lots } from "../state/types";
import { mmss } from "./format";
import { Glyph } from "./glyphs";
import { Sheet } from "./Sheet";

function DeskRow({ i, rank }: { i: number; rank: number }) {
  const seat = useGame((s) => s.table.seats[i]);
  const you = useGame((s) => s.table.mySeat === i);
  const reveal = useGame((s) => s.reveal);
  const ref = useRef<HTMLLIElement>(null);
  const prev = useRef(seat?.picked ?? 0);
  useEffect(() => {
    if (!seat || !ref.current) return;
    if (seat.picked > prev.current) {
      const el = ref.current;
      el.classList.remove("bump");
      void el.offsetWidth;
      el.classList.add("bump");
    }
    prev.current = seat.picked;
  }, [seat?.picked, seat]);
  if (!seat) return null;
  const top = reveal?.topDesk === i;
  return (
    <li ref={ref} className={"desk" + (you ? " you" : "") + (top ? " top" : "")}>
      <span className="rk">{rank}</span>
      <Glyph seat={seat} you={you} />
      <span className="nm">
        <span className="t">{you ? "You" : seat.name}</span>
        {seat.kind === "bot" && <span className="bot">bot</span>}
      </span>
      <span className="tk">+{lots(seat.picked)}</span>
      {reveal && <span className="tot">{lots(reveal.totals[i])}</span>}
    </li>
  );
}

export function DesksList({ inSheet }: { inSheet?: boolean }) {
  const seats = useGame((s) => s.table.seats);
  const reveal = useGame((s) => s.reveal);
  const order = seats
    .map((s, i) => ({ i, v: reveal ? reveal.totals[i] : s.picked }))
    .sort((a, b) => b.v - a.v || a.i - b.i);
  return (
    <div className="desks" data-testid="desks">
      <div className="desks-h">
        <span>{inSheet ? (reveal ? "Ranked by total lots" : "Ranked by lots taken") : "Desks"}</span>
        <span>{reveal ? "taken · total" : "lots taken"}</span>
      </div>
      {seats.length === 0 ? (
        <p className="empty">Reading the table…</p>
      ) : (
        <ol>
          {order.map((o, k) => (
            <DeskRow key={o.i} i={o.i} rank={k + 1} />
          ))}
        </ol>
      )}
      {!reveal && <p className="fine">Hidden lots stay secret until the bell. Bots are the house's; every other desk is a player.</p>}
    </div>
  );
}

export function Prints() {
  const prints = useGame((s) => s.table.prints);
  const seats = useGame((s) => s.table.seats);
  const mySeat = useGame((s) => s.table.mySeat);
  const fills = prints.filter((p) => p.desk !== undefined).slice(0, 6);
  return (
    <div className="prints" data-testid="ticker">
      <div className="desks-h">
        <span>Recent fills</span>
        <span>prices stay hidden</span>
      </div>
      {fills.length === 0 ? (
        <p className="empty">Every fill shows up here, without its price.</p>
      ) : (
        <ul>
          {fills.map((p) => (
            <li key={p.id}>
              <span className="t">{mmss(p.t)}</span>
              <span className="nm">{p.desk === mySeat ? "You" : seats[p.desk!]?.name}</span>
              <span className="tk">took {lots(p.tenths ?? 0)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DesksSheet() {
  return (
    <Sheet id="desks" title="Desks">
      <DesksList inSheet />
      <Prints />
    </Sheet>
  );
}

export function Rail() {
  return (
    <aside className="rail">
      <DesksList />
      <Prints />
    </aside>
  );
}
