// House runner configuration: defaults per cluster, then an optional JSON file (HOUSE_CONFIG),
// then environment variables. Keys and runtime files live outside the repository.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Cluster = "local" | "devnet";

export interface HouseConfig {
  cluster: Cluster;
  baseRpc: string;
  erRpc: string; // rollup endpoint the clients use (privacy filter locally, the TEE on devnet)
  validator: string; // pinned rollup validator identity
  programId: string;
  houseKeypair: string;
  botKeysDir: string;
  stateDir: string;
  pools: number[];
  /** a round without a human (or Tape test calls) is recorded at most this often, per pool */
  recordEverySec: number;
  /** pause between the bell and the next round (the reveal replay) */
  lightsOnMs: number;
  /** overdue time of a beat deadline before the crank is rescheduled */
  stallMs: number;
  /** no beat resolved for this long (after a reschedule) and the round is called off */
  hardStallMs: number;
  /** a round open for longer than this is called off */
  maxRoundMs: number;
  /** wait for a committed Round to be back on base before counting the commit as failed */
  commitWaitMs: number;
  tableFloatLamports: number;
  oracleQueueFallback: string; // passed to open_round when the Table has no VRF queue
  healthPort: number;
  /** place one test call per recorded round from a house test key (local testing only) */
  testCalls: boolean;
  /** stop after this many rounds per pool (0 = forever) */
  maxRounds: number;
  bots: boolean;
  /** initialise Config on a fresh local stack (local only) */
  initConfig: boolean;
  logFile: string;
  rpcLogFile: string;
  /** a log file is rotated (kept: `logKeep` older files) once it passes this size; 0 = never */
  logMaxMb: number;
  logKeep: number;
  /** echo info lines to stdout too (warnings and errors always are) */
  stdoutInfo: boolean;
  /** below this house balance no new records are created (pools keep playing unrecorded); 0 = off */
  minBalanceSol: number;
  /** below this house balance a pool records at most one round per `lowRecordEverySec`, players seated or not; 0 = off */
  softBalanceSol: number;
  lowRecordEverySec: number;
  /** the unseal waits until this long after the last bot send and after the bell (a late act must never land, or be
   *  delivered, once the round is public) */
  unsealQuietMs: number;
  /** a base transaction with no status after this long (and an expired blockhash) counts as dropped and is sent again */
  baseDropMs: number;
}

const home = os.homedir();

function defaults(cluster: Cluster): HouseConfig {
  const stateDir = path.join(home, ".local/state/picked-off");
  const common = {
    cluster,
    programId: "5eP2A36T97mwaGHf6XoHZU6VoKh1NGxA2QwvtJhAJ6ms",
    stateDir,
    botKeysDir: path.join(home, ".config/picked-off", cluster, "bots"),
    recordEverySec: 300,
    lightsOnMs: 8_000,
    stallMs: 3_000,
    hardStallMs: 20_000,
    maxRoundMs: 120_000,
    commitWaitMs: 30_000,
    tableFloatLamports: 50_000_000,
    healthPort: cluster === "local" ? 8787 : 8788,
    testCalls: false,
    maxRounds: 0,
    bots: true,
    logFile: path.join(stateDir, `house-${cluster}.log`),
    rpcLogFile: path.join(stateDir, `house-${cluster}-rpc.jsonl`),
    logMaxMb: 100,
    logKeep: 3,
    stdoutInfo: true,
    minBalanceSol: cluster === "local" ? 0 : 6,
    softBalanceSol: cluster === "local" ? 0 : 10,
    lowRecordEverySec: 120,
    unsealQuietMs: cluster === "local" ? 300 : 2_500,
    baseDropMs: 90_000,
  };
  if (cluster === "local")
    return {
      ...common,
      baseRpc: "http://127.0.0.1:8899",
      erRpc: "http://127.0.0.1:6699",
      validator: "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev",
      houseKeypair: path.join(home, ".config/solana/blitz-ping-localnet.json"),
      pools: [1001],
      oracleQueueFallback: "Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT",
      initConfig: true,
    };
  return {
    ...common,
    baseRpc: "https://rpc.magicblock.app/devnet",
    erRpc: "https://devnet-tee.magicblock.app",
    validator: "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
    houseKeypair: path.join(home, ".config/solana/blitz-ping-devnet.json"),
    pools: [1],
    commitWaitMs: 60_000,
    oracleQueueFallback: "5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc",
    initConfig: false,
  };
}

const ENV: Record<string, [keyof HouseConfig, "s" | "n" | "b" | "list"]> = {
  BASE_RPC: ["baseRpc", "s"], ER_RPC: ["erRpc", "s"], VALIDATOR: ["validator", "s"], PROGRAM_ID: ["programId", "s"],
  HOUSE_KEYPAIR: ["houseKeypair", "s"], BOT_KEYS_DIR: ["botKeysDir", "s"], STATE_DIR: ["stateDir", "s"], POOLS: ["pools", "list"],
  RECORD_EVERY_SEC: ["recordEverySec", "n"], LIGHTS_ON_MS: ["lightsOnMs", "n"], STALL_MS: ["stallMs", "n"], HARD_STALL_MS: ["hardStallMs", "n"],
  MAX_ROUND_MS: ["maxRoundMs", "n"], COMMIT_WAIT_MS: ["commitWaitMs", "n"], TABLE_FLOAT_LAMPORTS: ["tableFloatLamports", "n"],
  ORACLE_QUEUE: ["oracleQueueFallback", "s"], HEALTH_PORT: ["healthPort", "n"], TEST_CALLS: ["testCalls", "b"], MAX_ROUNDS: ["maxRounds", "n"],
  BOTS: ["bots", "b"], INIT_CONFIG: ["initConfig", "b"], HOUSE_LOG: ["logFile", "s"], HOUSE_RPC_LOG: ["rpcLogFile", "s"],
  HOUSE_LOG_MAX_MB: ["logMaxMb", "n"], HOUSE_LOG_KEEP: ["logKeep", "n"], HOUSE_STDOUT_INFO: ["stdoutInfo", "b"], MIN_BALANCE_SOL: ["minBalanceSol", "n"], SOFT_BALANCE_SOL: ["softBalanceSol", "n"], LOW_RECORD_EVERY_SEC: ["lowRecordEverySec", "n"], UNSEAL_QUIET_MS: ["unsealQuietMs", "n"], BASE_DROP_MS: ["baseDropMs", "n"],
};

export function loadConfig(env = process.env): HouseConfig {
  const cluster = (env.CLUSTER ?? "local") as Cluster;
  if (cluster !== "local" && cluster !== "devnet") throw new Error(`CLUSTER must be local or devnet, got ${cluster}`);
  let cfg = defaults(cluster);
  const file = env.HOUSE_CONFIG ? JSON.parse(fs.readFileSync(env.HOUSE_CONFIG, "utf8")) : {};
  cfg = { ...cfg, ...file };
  for (const [name, [key, kind]] of Object.entries(ENV)) {
    const v = env[name];
    if (v === undefined || v === "") continue;
    (cfg as any)[key] = kind === "n" ? Number(v) : kind === "b" ? v === "1" || v === "true" : kind === "list" ? v.split(",").map((x) => Number(x.trim())) : v;
  }
  if (cluster !== "local") cfg.initConfig = false;
  // runtime files follow STATE_DIR unless they are set on their own
  if (!env.HOUSE_LOG && !file.logFile) cfg.logFile = path.join(cfg.stateDir, `house-${cluster}.log`);
  if (!env.HOUSE_RPC_LOG && !file.rpcLogFile) cfg.rpcLogFile = path.join(cfg.stateDir, `house-${cluster}-rpc.jsonl`);
  return cfg;
}
