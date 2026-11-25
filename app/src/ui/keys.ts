/** Keyboard play: arrows choose a price (↑↓ within a side, ←→ across the spine), Enter pings or hides there,
 *  Space pings your last FILL again, R moves to a random untested price, M toggles Move to…, Esc cancels. */
import { useEffect } from "react";
import { openSheet, useGame, useUi } from "../state/store";
import { actions } from "../state/runtime";
import { sfx, unlockAudio } from "../fx/sound";
import { ASK, BID } from "./Book";
import { moveTo, tapPrice, toggleMoveMode } from "./act";
import { acted, useRound } from "./round";

function step(L: number, key: string): number {
  const bid = BID.indexOf(L);
  const ask = ASK.indexOf(L);
  const col = bid >= 0 ? BID : ASK;
  const i = bid >= 0 ? bid : ask;
  if (key === "ArrowUp") return col[Math.max(0, i - 1)];
  if (key === "ArrowDown") return col[Math.min(11, i + 1)];
  if (key === "ArrowLeft") return BID[i];
  return ASK[i];
}

export function useKeys() {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const onControl = e.target instanceof HTMLButtonElement && !(e.target as HTMLElement).dataset.level;
      if (onControl && (e.key === " " || e.key === "Enter")) return; // the focused control handles it
      const ui = useUi.getState();
      if (e.key === "Escape") {
        if (ui.moveMode) useUi.setState({ moveMode: false });
        else if (ui.sheet) openSheet(null);
        else useUi.setState({ cursorOn: false });
        return;
      }
      const { me, clock } = useGame.getState();
      if (!me || (clock.phase !== "live" && clock.phase !== "hide")) return;
      if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        useUi.setState({ selected: ui.cursorOn ? step(ui.selected, e.key) : ui.selected, cursorOn: true });
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        tapPrice(ui.selected);
        return;
      }
      if (clock.phase !== "live") return;
      if (e.key === " ") {
        e.preventDefault();
        if (me.lastFill !== null && useRound.getState().marks[me.lastFill]?.kind === "fill") {
          unlockAudio();
          actions().ping(me.lastFill);
          sfx.ping();
          acted();
        }
      } else if (e.key === "r" || e.key === "R") {
        moveTo(null);
      } else if (e.key === "m" || e.key === "M") {
        toggleMoveMode();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
}
