// Buffer for @solana/web3.js and the rollup SDK in the browser; must be the first import.
import { Buffer } from "buffer";
(window as typeof window & { Buffer: typeof Buffer }).Buffer ??= Buffer;
