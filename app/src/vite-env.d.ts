/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_DRIVER?: "mock" | "chain";
  /** chain driver (see src/chain/config.ts) */
  readonly VITE_CLUSTER?: "local" | "devnet";
  readonly VITE_BASE_RPC?: string;
  readonly VITE_TEE_RPC?: string;
  readonly VITE_TEE_WS?: string;
  readonly VITE_PROGRAM_ID?: string;
  readonly VITE_TABLE_IDS?: string;
  readonly VITE_SLOT_MS?: string;
  readonly VITE_EXPLORER?: string;
}
