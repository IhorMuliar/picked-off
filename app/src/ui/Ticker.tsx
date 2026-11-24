import { useGame } from "../state/store";
import { lots } from "../state/types";
import { mmss } from "./format";

export function Ticker() {
  const prints = useGame((s) => s.table.prints);
  const seats = useGame((s) => s.table.seats);
  const mySeat = useGame((s) => s.table.mySeat);
  return (
    <div className="ticker" data-testid="ticker">
      <div className="lab">TAPE</div>
      <div className="stream">
        {prints.length === 0 && <span className="idle">prints land here every beat: who filled, how much, price withheld</span>}
        {prints.map((p, k) => (
          <span key={p.id} className={k === 0 ? "new" : ""}>
            {mmss(p.t)}{" "}
            {p.desk !== undefined ? (
              <>
                {p.desk === mySeat ? "YOU" : seats[p.desk]?.name} filled <b>{lots(p.tenths ?? 0)}</b> · price withheld
              </>
            ) : (
              <>
                {p.pings} pings this beat · {p.fills} fill{p.fills === 1 ? "" : "s"}
              </>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}
