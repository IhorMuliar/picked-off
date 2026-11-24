// Simulates `version` on the TEE (house token) and on base until both return EXPECT_VERSION
// (an upgrade reaches the TEE minutes after base). Exits 0 when the TEE serves it, 1 on timeout.
//   EXPECT_VERSION=1 npx tsx tests/devnet/version-gate.ts
import { Connection, Transaction } from "@solana/web3.js";
import { loadKeypair, programOn, rpc, sleep } from "../local/lib.ts";
import { DEV, tokenFor, erConn, erUrl } from "./devnet.ts";

const want = Number(process.env.EXPECT_VERSION ?? 1);
const timeoutMs = Number(process.env.TIMEOUT_MS ?? 15 * 60_000);
const house = loadKeypair(DEV.wallet);
const tok = await tokenFor(house);
const base = new Connection(DEV.base, "confirmed");

async function sim(conn: Connection, url: string) {
  const ix = await programOn(conn, house).methods.version().accountsPartial({ caller: house.publicKey }).instruction();
  const tx = new Transaction().add(ix);
  tx.feePayer = house.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(house);
  const r = await rpc(url, "simulateTransaction", [tx.serialize().toString("base64"), { encoding: "base64", sigVerify: false }]);
  const rd = r.body?.result?.value?.returnData;
  return { version: rd ? Buffer.from(rd.data[0], "base64").readUInt32LE(0) : null, err: r.body?.result?.value?.err ?? r.body?.error ?? null };
}
const t0 = Date.now();
for (;;) {
  const [b, t] = await Promise.all([sim(base, DEV.base), sim(erConn(tok), erUrl(tok))]);
  console.log(`${new Date().toISOString()} base ${JSON.stringify(b)} tee ${JSON.stringify(t)}`);
  if (t.version === want) { console.log(`TEE serves version ${want} (${Math.round((Date.now() - t0) / 1000)} s after the gate started)`); process.exit(0); }
  if (Date.now() - t0 > timeoutMs) { console.log("timeout"); process.exit(1); }
  await sleep(10_000);
}
