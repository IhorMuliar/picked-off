/**
 * Chain endpoints and ids from `VITE_*` env, with defaults for the local stack and devnet.
 *
 *   VITE_CLUSTER     local | devnet  (default: local in `vite dev`, devnet in a build)
 *   VITE_BASE_RPC    base-layer HTTP endpoint
 *   VITE_TEE_RPC     private rollup HTTP endpoint (the auth token is appended)
 *   VITE_TEE_WS      private rollup websocket endpoint
 *   VITE_PROGRAM_ID  Ping program id
 *   VITE_TABLE_IDS   comma-separated house pool table ids, e.g. "1,2"
 *   VITE_SLOT_MS     expected slot time on the rollup in ms (measured at runtime; this is the prior)
 *   VITE_EXPLORER    explorer cluster query, e.g. "?cluster=devnet" ("" = none)
 */
export type Cluster = "local" | "devnet";

export interface ChainConfig {
  cluster: Cluster;
  baseRpc: string;
  teeRpc: string;
  teeWs: string;
  programId: string;
  tableIds: bigint[];
  slotMs: number;
  explorer: string | null;
}

const DEFAULTS: Record<Cluster, Omit<ChainConfig, "cluster" | "programId" | "tableIds">> = {
  local: {
    baseRpc: "http://localhost:8899",
    teeRpc: "http://localhost:6699",
    teeWs: "ws://localhost:6700",
    slotMs: 50,
    explorer: null,
  },
  devnet: {
    baseRpc: "https://rpc.magicblock.app/devnet",
    teeRpc: "https://devnet-tee.magicblock.app",
    teeWs: "wss://devnet-tee.magicblock.app",
    slotMs: 10,
    explorer: "?cluster=devnet",
  },
};

export const PROGRAM_ID = "5eP2A36T97mwaGHf6XoHZU6VoKh1NGxA2QwvtJhAJ6ms";

export function parseTableIds(s: string | undefined): bigint[] {
  const out: bigint[] = [];
  for (const part of (s ?? "").split(",")) {
    const t = part.trim();
    if (/^\d+$/.test(t)) out.push(BigInt(t));
  }
  return out;
}

export function makeConfig(env: Record<string, string | boolean | undefined>): ChainConfig {
  const str = (k: string) => {
    const v = env[k];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  };
  const cluster: Cluster = str("VITE_CLUSTER") === "local" ? "local" : str("VITE_CLUSTER") === "devnet" ? "devnet" : env.DEV ? "local" : "devnet";
  const d = DEFAULTS[cluster];
  const ids = parseTableIds(str("VITE_TABLE_IDS"));
  const slotMs = Number(str("VITE_SLOT_MS") ?? d.slotMs);
  const explorer = str("VITE_EXPLORER");
  return {
    cluster,
    baseRpc: (str("VITE_BASE_RPC") ?? d.baseRpc).replace(/\/$/, ""),
    teeRpc: (str("VITE_TEE_RPC") ?? d.teeRpc).replace(/\/$/, ""),
    teeWs: (str("VITE_TEE_WS") ?? d.teeWs).replace(/\/$/, ""),
    programId: str("VITE_PROGRAM_ID") ?? PROGRAM_ID,
    tableIds: ids.length ? ids : [1n],
    slotMs: Number.isFinite(slotMs) && slotMs > 0 ? slotMs : d.slotMs,
    explorer: explorer === undefined ? d.explorer : explorer,
  };
}

export const chainConfig = (): ChainConfig => makeConfig(import.meta.env as unknown as Record<string, string | boolean | undefined>);

/** Base URL with the token as a query parameter (the string, never an object). */
export const withToken = (url: string, token: string | null) => (token ? `${url}?token=${encodeURIComponent(token)}` : url);
