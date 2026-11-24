/**
 * Picks the data source by `VITE_DRIVER` (mock | chain; default mock).
 * `?demo=1` in the URL always runs the offline mock (no network).
 * The chain driver lives in ../chain/ and must export
 * `createChainDriver(): GameDriver | Promise<GameDriver>` from ../chain/driver.ts.
 */
import type { GameDriver } from "./types";
import { MockDriver } from "./mock/mockDriver";

const demo = typeof location !== "undefined" && new URLSearchParams(location.search).get("demo") === "1";
export const DRIVER_KIND: string = demo ? "mock" : (import.meta.env.VITE_DRIVER ?? "mock");

export async function createDriver(): Promise<GameDriver> {
  if (DRIVER_KIND === "chain") {
    // resolved at build time only when the chain module exists
    const mods = import.meta.glob<{ createChainDriver: () => GameDriver | Promise<GameDriver> }>("../chain/driver.ts");
    const load = mods["../chain/driver.ts"];
    if (load) return (await load()).createChainDriver();
    console.warn("VITE_DRIVER=chain but src/chain/driver.ts is missing; using the mock driver");
  }
  return new MockDriver();
}
