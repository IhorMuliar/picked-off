/** The running driver, set once at boot; the UI calls `actions()` / `peekProbe()`. */
import type { GameActions, GameDriver, PeekProbe } from "./types";

let current: GameDriver | null = null;
export const setDriver = (d: GameDriver) => {
  current = d;
};
const noop: GameActions = { place() {}, ping() {}, requote() {}, tapeCall() {}, join() {} };
export const actions = (): GameActions => current?.actions ?? noop;
export const peekProbe = (): PeekProbe | null => current?.peek ?? null;
