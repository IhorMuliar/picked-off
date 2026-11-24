import "./polyfills";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createDriver } from "./state/driver";
import { setDriver } from "./state/runtime";
import { storeWriter, useGame } from "./state/store";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// dev-only handle for the headless checks
if (import.meta.env.DEV) (window as unknown as { __po: unknown }).__po = useGame;

void createDriver().then((d) => {
  setDriver(d);
  d.start(storeWriter);
  if (import.meta.hot) import.meta.hot.dispose(() => d.stop());
});
