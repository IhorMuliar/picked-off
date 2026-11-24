/**
 * The `act` hot path without web3.js (safe to load in a Worker): the 30-byte instruction
 * data and a signed legacy transaction built by hand.
 *
 *   data = disc[8] · kind u8 · level u8 · seq u32 LE · salt[16]
 *   accounts = player (signer), desk (writable), book (writable)
 */
import nacl from "tweetnacl";
import bs58 from "bs58";

export const ACT_DISC = Uint8Array.from([114, 158, 229, 112, 242, 50, 227, 5]);
export const ACT_LEN = 30;
export const ACT_NOOP = 0;
export const ACT_PING = 1;
export const ACT_REQUOTE = 2;
export const SEQ_MAX = 0xffffffff;

export function encodeAct(kind: number, level: number, seq: number, salt: Uint8Array): Uint8Array {
  if (salt.length !== 16) throw new Error("salt must be 16 bytes");
  if (!Number.isInteger(seq) || seq < 0 || seq > SEQ_MAX) throw new Error("seq out of u32 range");
  const b = new Uint8Array(ACT_LEN);
  b.set(ACT_DISC, 0);
  b[8] = kind & 0xff;
  b[9] = level & 0xff;
  new DataView(b.buffer).setUint32(10, seq >>> 0, true);
  b.set(salt, 14);
  return b;
}

export function decodeAct(b: Uint8Array): { kind: number; level: number; seq: number; salt: Uint8Array } {
  if (b.length !== ACT_LEN || ACT_DISC.some((x, i) => b[i] !== x)) throw new Error("not an act");
  return { kind: b[8], level: b[9], seq: new DataView(b.buffer, b.byteOffset).getUint32(10, true), salt: b.slice(14, 30) };
}

function compactU16(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    let e = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(e);
      return out;
    }
    e |= 0x80;
    out.push(e);
  }
}

/** Legacy message: [player(s,w fee payer), desk(w), book(w), program(ro)], one instruction. */
export function actMessage(player: Uint8Array, desk: Uint8Array, book: Uint8Array, program: Uint8Array, blockhash: Uint8Array, data: Uint8Array): Uint8Array {
  const parts: number[] = [1, 0, 1, ...compactU16(4)];
  const m = new Uint8Array(3 + 1 + 4 * 32 + 32 + 1 + 1 + 1 + 3 + 1 + data.length);
  let o = 0;
  m.set(parts, o);
  o += parts.length;
  for (const k of [player, desk, book, program]) {
    m.set(k, o);
    o += 32;
  }
  m.set(blockhash, o);
  o += 32;
  const ix = [1, 3, 3, 0, 1, 2, ...compactU16(data.length)];
  m.set(ix, o);
  o += ix.length;
  m.set(data, o);
  o += data.length;
  return m.subarray(0, o);
}

export interface SignedTx { bytes: Uint8Array; signature: string }

/** Sign a single-signer legacy message and wrap it as a wire transaction. */
export function signLegacy(message: Uint8Array, secretKey: Uint8Array): SignedTx {
  const sig = nacl.sign.detached(message, secretKey);
  const bytes = new Uint8Array(1 + 64 + message.length);
  bytes[0] = 1;
  bytes.set(sig, 1);
  bytes.set(message, 65);
  return { bytes, signature: bs58.encode(sig) };
}

export interface ActKeys { player: Uint8Array; desk: Uint8Array; book: Uint8Array; program: Uint8Array }
export const actKeysFrom = (k: { player: string; desk: string; book: string; program: string }): ActKeys => ({
  player: bs58.decode(k.player), desk: bs58.decode(k.desk), book: bs58.decode(k.book), program: bs58.decode(k.program),
});

export function buildActTx(keys: ActKeys, secretKey: Uint8Array, blockhash: string, kind: number, level: number, seq: number, salt: Uint8Array): SignedTx {
  const msg = actMessage(keys.player, keys.desk, keys.book, keys.program, bs58.decode(blockhash), encodeAct(kind, level, seq, salt));
  return signLegacy(msg, secretKey);
}

export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Fixed-width seat name for `join`: UTF-8, zero-padded, cut at 16 bytes on a char boundary. */
export function encodeName(name: string): Uint8Array {
  const out = new Uint8Array(16);
  const enc = new TextEncoder();
  let n = 0;
  for (const ch of name) {
    const b = enc.encode(ch);
    if (n + b.length > 16) break;
    out.set(b, n);
    n += b.length;
  }
  return out;
}
