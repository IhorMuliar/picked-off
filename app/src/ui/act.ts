/** Player intent from any control (tap, button, key): one place for the action, its sound and the round memory. */
import { actions } from "../state/runtime";
import { useGame, useUi } from "../state/store";
import { sfx, unlockAudio } from "../fx/sound";
import { acted } from "./round";
import { LEVELS } from "../state/types";

export function tapPrice(L: number) {
  unlockAudio();
  const { me, clock } = useGame.getState();
  if (!me || L < 1 || L > LEVELS) return;
  useUi.setState({ interacted: true });
  if (clock.phase === "hide") {
    actions().place(L);
    sfx.requote();
    acted();
    return;
  }
  if (clock.phase !== "live") return;
  if (useUi.getState().moveMode || L === me.level) {
    if (L === me.level) {
      useUi.setState({ moveMode: !useUi.getState().moveMode });
      sfx.ui();
      return;
    }
    moveTo(L);
    return;
  }
  actions().ping(L);
  sfx.ping();
  acted();
}

export function moveTo(L: number | null) {
  unlockAudio();
  const { me, clock } = useGame.getState();
  useUi.setState({ moveMode: false, interacted: true });
  if (!me || clock.phase !== "live" || L === me.level) return;
  actions().requote(L);
  sfx.requote();
  acted();
}

export function toggleMoveMode() {
  unlockAudio();
  sfx.ui();
  useUi.setState({ moveMode: !useUi.getState().moveMode });
}

export function keepSeat() {
  unlockAudio();
  actions().join();
  acted();
}
