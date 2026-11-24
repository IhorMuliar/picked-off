/** Program-derived addresses of the Ping accounts (seeds: docs in the program's layout file). */
import { PublicKey } from "@solana/web3.js";

export const PERMISSION_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
export const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
export const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
export const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
export const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

const enc = new TextEncoder();
export const u64le = (n: bigint | number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, BigInt(n)), true);
  return b;
};

export class Pdas {
  readonly program: PublicKey;
  private cache = new Map<string, PublicKey>();
  constructor(programId: string | PublicKey) {
    this.program = typeof programId === "string" ? new PublicKey(programId) : programId;
  }
  private find(tag: string, seeds: Uint8Array[], programId = this.program): PublicKey {
    const k = tag + ":" + seeds.map((s) => Array.from(s).join(",")).join("|");
    let p = this.cache.get(k);
    if (!p) {
      p = PublicKey.findProgramAddressSync(seeds, programId)[0];
      this.cache.set(k, p);
    }
    return p;
  }
  config = () => this.find("config", [enc.encode("config")]);
  table = (t: bigint) => this.find("t", [enc.encode("table"), u64le(t)]);
  book = (t: bigint) => this.find("b", [enc.encode("book"), u64le(t)]);
  desk = (t: bigint, s: number) => this.find("d", [enc.encode("desk"), u64le(t), Uint8Array.of(s)]);
  round = (t: bigint, n: bigint) => this.find("r", [enc.encode("round"), u64le(t), u64le(n)]);
  ledger = (t: bigint) => this.find("l", [enc.encode("ledger"), u64le(t)]);
  tape = (t: bigint, n: bigint) => this.find("tp", [enc.encode("tape"), u64le(t), u64le(n)]);
  call = (tape: PublicKey, bettor: PublicKey) => this.find("c", [enc.encode("call"), tape.toBytes(), bettor.toBytes()]);
  /** Permission account of a delegated PDA (the access-control program's seeds). */
  permission = (acc: PublicKey) => this.find("p", [enc.encode("permission:"), acc.toBytes()], PERMISSION_PROGRAM);
}
