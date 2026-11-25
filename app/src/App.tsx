import { useEffect } from "react";
import { Header } from "./ui/Header";
import { Score } from "./ui/Score";
import { Book } from "./ui/Book";
import { ThumbZone } from "./ui/Action";
import { DesksSheet, Rail } from "./ui/Desks";
import { TapeSheet } from "./ui/Tape";
import { ProofSheet } from "./ui/Proof";
import { ResultsSheet } from "./ui/Results";
import { ResultLog } from "./ui/ResultLog";
import { useKeys } from "./ui/keys";
import { feedRound } from "./ui/round";
import { feedLink } from "./ui/link";
import { feedLastCall } from "./ui/lastcall";
import { openSheet, useGame, useUi } from "./state/store";
import { unlockAudio } from "./fx/sound";
import "./ui/styles.css";

/** Opens the results at the bell (shortly after the book lights up) and closes them when the next round starts. */
function useResultsSheet() {
  const round = useGame((s) => s.reveal?.round ?? null);
  useEffect(() => {
    if (round === null) {
      if (useUi.getState().sheet === "results") openSheet(null);
      return;
    }
    const t = setTimeout(() => {
      if (useUi.getState().resultsClosed !== round) openSheet("results");
    }, 450);
    return () => clearTimeout(t);
  }, [round]);
}

export function App() {
  useKeys();
  useResultsSheet();
  useEffect(() => feedRound(), []);
  useEffect(() => feedLink(), []);
  useEffect(() => feedLastCall(), []);
  const sheet = useUi((s) => s.sheet);
  return (
    <div className={"app" + (sheet ? " has-sheet sheet-" + sheet : "")} onPointerDown={unlockAudio} onKeyDown={unlockAudio}>
      <Header />
      <main className="play" data-testid="pool">
        <div className="stage">
          <Score />
          <Book />
          <ThumbZone />
        </div>
        <Rail />
      </main>
      <ResultLog />
      <DesksSheet />
      <TapeSheet />
      <ProofSheet />
      <ResultsSheet />
    </div>
  );
}
