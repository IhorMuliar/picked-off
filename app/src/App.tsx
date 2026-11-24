import { Header } from "./ui/Header";
import { Pool } from "./ui/Pool";
import { Side } from "./ui/Side";
import { Ticker } from "./ui/Ticker";
import { Peek } from "./ui/Peek";
import { Reveal } from "./ui/Reveal";
import { unlockAudio } from "./fx/sound";
import "./ui/styles.css";

export function App() {
  return (
    <div onPointerDown={unlockAudio} onKeyDown={unlockAudio}>
      <Header />
      <main>
        <Pool />
        <Side />
      </main>
      <Ticker />
      <Reveal />
      <Peek />
    </div>
  );
}
