// Player-join test on the local stack:
//  1. a burner takes a bot's desk with `join` between rounds: the runner stops that bot, keeps the
//     other seven playing, and records the round while a player is seated;
//  2. a second burner takes another bot's desk mid-round (LIVE): the runner stops that bot within
//     one beat (1.5 s);
//  3. a player seated for a whole round whose Desk accepted no act in it gets the seat back to a bot
//     before the next round (needs a program whose join_bot may replace an idle player).
//   npx tsx house/test/join.ts        (after make local-stack + make local-fund)
import { Connection } from "@solana/web3.js";
import { Runner, tempState, check, summary } from "./harness.ts";
import { loadConfig } from "../src/config.ts";
import { Chain, Keypair, Reader, decodeTable, decodeDesk, PHASE, SEAT, sleep } from "../src/chain.ts";

const T = Number(process.env.TABLE_ID ?? 60_000 + (Math.floor(Date.now() / 1000) % 100_000));
const env = { CLUSTER: "local", POOLS: String(T), RECORD_EVERY_SEC: "100000", HEALTH_PORT: "8793", ...tempState("join") };
const chain = new Chain(loadConfig({ ...process.env, ...env }));

async function join(seat: number, label: string) {
  const player = Keypair.generate();
  const { token } = await chain.token(player);
  const erP = new Connection(chain.erUrl(token), "confirmed");
  const name = Buffer.alloc(16); name.write(label);
  const ix = await chain.program(erP, player).methods.join(seat, Array.from(name)).accountsPartial({ player: player.publicKey, table: chain.pda.table(T), desk: chain.pda.desk(T, seat), permission: chain.pda.perm(chain.pda.desk(T, seat)) }).instruction();
  const r = await chain.send(erP, [ix], [player], { cu: 400_000 });
  return { player, token, r, at: Date.now() };
}
async function table() {
  await chain.ensureHouseToken();
  return decodeTable((await chain.erRead.account(chain.pda.table(T))).data!);
}

async function main() {
  console.log(`join test on table ${T}`);
  const r = new Runner(env, "join").start();
  await r.wait((e) => e.ev === "round" && e.round === 1, 120_000, "round 1 revealed");
  // 1. between rounds
  const a = await join(1, "tester-a");
  check("player join between rounds", a.r.ok, { sig: a.r.sig, err: a.r.ok ? undefined : a.r.err });
  const stopped = await r.wait((e) => e.ev === "bot_stopped" && e.seat === 1, 10_000, "bot 1 stopped").catch(() => null);
  check("runner stops the bot whose seat a player took", stopped?.reason === "seat taken by a player", stopped ? { reason: stopped.reason, msAfterJoin: Date.parse(stopped.ts) - a.at } : "no bot_stopped event");
  const open2 = await r.wait((e) => e.ev === "round_open" && e.round === 2, 60_000, "round 2 open");
  check("round with a player seated is recorded", open2.recorded === true, { round: 2, recorded: open2.recorded });
  const t2 = await table();
  check("Table shows the player in the seat", t2.seats[1].kind === SEAT.human && t2.seats[1].key === a.player.publicKey.toBase58(), { kind: t2.seats[1].kind, name: t2.seats[1].name });
  const d = await new Reader(chain.erUrl(a.token), "test-player", "er").account(chain.pda.desk(T, 1));
  check("the player's own Desk is readable with the player's token", !!d.data && decodeDesk(d.data).key === a.player.publicKey.toBase58(), { readable: !!d.data });
  // 2. mid-round, once LIVE
  for (;;) { const t = await table(); if (t.round === 2 && t.phase === PHASE.live && t.beat >= 3) break; await sleep(200); }
  const b = await join(4, "tester-b");
  if (b.r.ok) {
    const st = await r.wait((e) => e.ev === "bot_stopped" && e.seat === 4, 10_000, "bot 4 stopped").catch(() => null);
    const ms = st ? Date.parse(st.ts) - b.at : null;
    check("mid-round takeover: the bot stops within one beat (1.5 s)", ms !== null && ms <= 1_500, { msAfterJoinConfirmed: ms, reason: st?.reason });
  } else {
    console.log(`info  mid-round join not allowed by this program build (${String(JSON.stringify(b.r.err)).slice(0, 80)}); skipped`);
  }
  const bots2 = await r.wait((e) => e.ev === "bots" && e.round === 2, 120_000, "round 2 bots line");
  check("the remaining bots played round 2 at 4 acts/s, none on a player's seat", bots2.bots.every((x: any) => x.seat !== 1 && x.ackPerSec >= 3.8), { seats: bots2.bots.map((x: any) => `${x.seat}:${x.ackPerSec}`) });
  // 3. player A sat through round 2 and sent nothing: its seat goes back to a bot before round 3
  const ps = await r.wait((e) => e.ev === "player_seat" && e.round === 2 && e.seat === 1, 60_000, "idle check").catch(() => null);
  const seated = await r.wait((e) => e.ev === "bots_seated" && e.round === 2 && e.ok && e.seats.some((x: string) => x.startsWith("1:")), 30_000, "seat 1 reclaimed").catch(() => null);
  const t3 = await table();
  check("idle player (whole round, 0 accepted acts) replaced by a bot before the next round", !!ps?.reclaim && !!seated && t3.seats[1].kind === SEAT.bot,
    { idleCheck: ps ? { acts: ps.acts, reclaim: ps.reclaim } : null, reseated: !!seated, seat1Kind: t3.seats[1].kind, err: r.events.find((e) => e.ev === "bots_seated" && e.round === 2 && !e.ok)?.err });
  const restarted = await r.wait((e) => e.ev === "bot_started" && e.seat === 1 && Date.parse(e.ts) > Date.parse(stopped?.ts ?? "0"), 30_000, "bot 1 restarted").catch(() => null);
  const bots3 = await r.wait((e) => e.ev === "bots" && e.round === 3, 120_000, "round 3 bots line").catch(() => null);
  const b1 = bots3?.bots.find((x: any) => x.seat === 1);
  check("the reclaimed seat's bot plays the next round", !!restarted && !!b1 && b1.ackPerSec >= 3.8, { restarted: !!restarted, round3seat1: b1 ? { acked: b1.acked, ackPerSec: b1.ackPerSec } : null });
  await r.kill("SIGTERM");
  process.exit(summary());
}
main().catch((e) => { console.error(e); process.exit(2); });
