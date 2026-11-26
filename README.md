**PICKED OFF: a 50-second dark pool. Hide your order, ping for everyone else's, pick them off before the closing bell. Only MagicBlock's TEE knows where anyone is.**  
▶ **Play, no wallet: https://picked-off-smoky.vercel.app** · beat → private result **94 ms p95** (n = 354 beats, 10 fresh browser tabs, EU, 2026-11-24)  
▶ **60-s video:** https://x.com/muliark/status/2125924011037032862

A MagicBlock Solana Blitz v10 entry on Solana devnet and MagicBlock's TEE rollup.

![Live on devnet: a FILL and your hidden order](media/picked-off-live.png)
![FILL → ping again → PICKED OFF → Move](media/picked-off-fill.gif) <img src="media/picked-off-phone.png" width="200" alt="On a phone">

## How to play

- Open the link. Your browser makes a burner key, logs in to the rollup and takes a house bot's desk: no wallet, no popup, no SOL. You have **10 lots hidden** on one of 24 prices. Join mid-round and your order moves once to a fresh price; that round is a warm-up.
- Every **1.5-s beat**: tap a price to **ping** it, or **Move** your order; idle, **auto** pings an untested price. One button names the next step: *Tap a price*, *Ping again*, *Move*.
- A ping where rivals hide **takes** 0.5 lot from each, then 1.0, then 1.5 if you keep finding the same order before it moves. Results land on the row: only you see **FILL** or **miss**, only the victim sees **PICKED OFF**, never by whom.
- The **bell** rings after a secret beat between 20 and 29 (VRF). Lights on: every hidden order shows, every desk is paid hidden + taken, results lead with your place, and the browser re-runs the round and checks its hash. Zero rake.

Keys: arrows + Enter ping, Space pings again, R moves to a random untested price, M then a price moves there.

## Why this needs a private rollup

Every beat each desk asks a private question ("is anyone hiding at 100.04?") about positions that keep moving: about 200 private answers per round (8 desks × ~25 beats), each inside its beat.

- **Commit-reveal cannot answer a query.** A commitment hides a level but cannot say whether it equals 100.04 unless its owner reveals it every beat, honestly; a desk just found would stop answering.
- **A public chain cannot hold the book.** Any readable account with levels hands every ping to a script.
- **A plain server could run it**, but its operator could peek. Here the house key gets `null` for the Book like everyone else.

| Take one out | What it does here | Without it |
|---|---|---|
| Private Ephemeral Rollup (TEE + permissions) | the Book has **0 readers**; each Desk has **1 reader**, its seated key (`EphemeralPermission`, [`setup_permissions.rs`](programs/ping/src/instructions/setup_permissions.rs)) | levels public, so no game; or a trusted server |
| Ephemeral Rollup + scheduled crank | beats resolved by a 250-ms `ScheduleCrankCpi` crank against slot deadlines, cancelled with `CancelCrankCpi` after the bell; gasless `act` every 250 ms per desk | Solana fees for 32 tx/s per pool; no constant-rate traffic, so timing would leak |
| VRF (rollup queue) | bell beat, in-beat order, auto pings, default price, last tie-break ([`open_round.rs`](programs/ping/src/instructions/open_round.rs), [`vrf_callback.rs`](programs/ping/src/instructions/vrf_callback.rs)) | a host-chosen bell or order could favour a desk |
| Delegate + commit to Solana | pools are `delegate`d once to the pinned TEE validator ([`delegate.rs`](programs/ping/src/instructions/delegate.rs)); each recorded round's result is `commit_and_undelegate`d alone ([`commit_round.rs`](programs/ping/src/instructions/commit_round.rs)) and `settle_round` pays the Tape from it | settlement by hand; the Tape not tied to the result |
| Burner keys on a gasless rollup | a 0-SOL key signs an `act` every 250 ms ([`burner.ts`](app/src/chain/burner.ts), [`sender.worker.ts`](app/src/chain/sender.worker.ts)) | a wallet popup every beat; no instant join |

## Who can read what

| | During HIDE / LIVE | After the bell |
|---|---|---|
| **You** (your Desk) | your price, hidden and taken lots, your FILL / miss / PICKED OFF per beat, your auto ping | everything |
| **Other players** | nothing about you; only the public Table | everything |
| **Spectators** | seats, bot labels, the round bar, each desk's lots **taken**, recent fills ("GHOST-2 took 0.5", no price), Tape odds | the whole Book replayed |
| **Nobody, the house included** (the Book) | all prices, hidden lots, streaks, ping history, pending actions, the bell beat, the seed | public, replayable to the commit hash |

## What an outsider can and cannot see

Measured on devnet, 2026-11-24, by [`scripts/leak-probe.ts`](scripts/leak-probe.ts) (two clean runs of 3 rounds; as another player, an outsider, no token) and [`tests/devnet/a5-check.ts`](tests/devnet/a5-check.ts) (18 recorded rounds, 23,117 acts).

| Side channel | Defence | Measured on devnet |
|---|---|---|
| Read the Book or another Desk | 0-member / 1-member permissions | `null` from `getAccountInfo`, `getProgramAccounts` and `accountSubscribe` (0 events) for every non-member |
| Read a ping transaction | the TEE redacts private txs | `getTransaction` of an `act` or crank tick: slot only, 0 keys, 0 data, 0 logs, **for the sender too** |
| List someone's transactions | not listed while private | 0 of a desk's acts in 15 signature lists (program, Table, Book, Desk, burner) |
| Log streams | `logsSubscribe` | 0 private txs delivered before the reveal on program, Table, Book or `"all"` streams (9 rounds, 63 subscriptions) |
| Timing of clicks | every desk sends one fixed-size `act` every 250 ms; ping, move and no-op look the same | identical act counts on all 8 desks; 0 failed acts in 23,117 |
| Compute units | constant-work `act` and `tick` (fixed loops, masks read through `read_volatile`, [`mask.rs`](crates/ping-core/src/mask.rs), [`engine.rs`](crates/ping-core/src/engine.rs)) | every `act` **4,767 CU** (n = 12,321, every kind, phase, wrong key, stale seq); every resolving tick **75,881 CU** (n = 447); every no-op tick **27,658 CU** (n = 2,615); max − min = 0; 0 program log lines (no `msg!` in the program) |
| Squatting the crank | task id = hash(table, round, current slot hash), computed on chain ([`utils.rs`](programs/ping/src/utils.rs)) | 5 squatted ids per round; beats ran on time |
| Last round's history | re-seal, then reset every private field, before the next HIDE | after the re-seal the revealed round's txs are shells again; levels are drawn fresh |

In the game, **Proof** (the ms chip in the header) runs five of these reads live from your browser ([`peek.ts`](app/src/chain/peek.ts)).

## The money

- **Zero rake.** Chips are conserved: every lot a desk loses, another desk took. Free house pools pay chips, no value.
- **The Tape**: parimutuel on "Top Desk at the bell" for rounds with a human seated; one 0.01-devnet-SOL call per burner, closes after live beat 10, settled on Solana from the committed round, refunded if nobody called the winner. Callers get devnet SOL from a capped drip ([`drip.ts`](app/api/drip.ts)).
- Staked tables are not built.

## Skill: model and live

Payout in stakes (1.00 = you keep your 10 lots). Model: 4,000 simulated rounds per cell. Live: scripted players at a house pool on devnet, 90 rounds each, 2026-11-24 ([`humans.ts`](scripts/humans.ts)).

| Seat-0 behaviour, vs house bots | Model | Live |
|---|---|---|
| Ping fills again, move when picked off | 1.34 | 1.56 |
| Same, present on half the beats | 0.97 | 1.24 |
| Best play using only public information | 0.75 | not run |
| Random pings, never move | 0.44 | 0.58 |
| Script reading results at machine speed | 1.40 | 1.70 |

Information beats random by about one stake, live as in the model. A machine-speed reader gains 0.03-0.07 stakes over a typical human in the model; live it gained 0.14 ± 0.14, too few rounds to separate the two.

## Nearest past entries

| Entry | What it was | How PICKED OFF differs |
|---|---|---|
| Cayed (Blitz v0) | 1v1 Battleship, ships hidden in an Ephemeral Rollup | 8 desks at once, each hides *and* hunts, money moves on every fill, simultaneous 1.5-s beats, no wallet |
| Private Battleship (Blitz v3) | 1v1 turn-based Battleship in a TEE | not turn-based or 1v1; orders move, and every private answer moves money |
| magic-ship | Private Ephemeral Rollup Battleship demo | the same, plus a settled money loop (the Tape) |
| HoldOut (Blitz v8) | 10 players, 60 s, fold or hold against a public SOL price | the same one-minute tension, but the information is private per player, not a public price |
| Herd (Blitz v8) | one question, 30 s, match the crowd; answers sealed in a private rollup | sealed choices too, but 20-29 times a round, live, about *where*, not *how many* |
| Blackout (Blitz v9) | fog-of-war battle royale in a private rollup | the same "only the TEE sees positions" idea on an order book, one action per 1.5 s so reflexes don't decide |

## Architecture

```mermaid
flowchart LR
  B[Browser: burner key, 0 SOL] -- act every 250 ms --> R
  subgraph R[MagicBlock TEE rollup, devnet]
    T[Table: public] --- K[Book: 0 readers]
    K --- D[Desk x8: 1 reader each]
    C[crank tick 250 ms] --> K
    V[VRF] --> K
  end
  H[House runner: rounds, labelled bots, records] --> R
  R -- commit Round --> S[Solana devnet: settle, Tape, claims]
  B -- Tape call --> S
```

- Program: [`programs/ping`](programs/ping/src) (Anchor, `ephemeral_rollups_sdk`: `#[ephemeral]`, `#[delegate]`, `commit_and_undelegate`, `ScheduleCrankCpi`, `EphemeralPermission`, `#[vrf]`). Beat resolution: [`crates/ping-core`](crates/ping-core/src), the same engine ported to TypeScript for the replay check ([`app/src/core`](app/src/core)).
- House runner and labelled bots: [`house/`](house/src). Bots are ordinary desks that read only their own Desk and act at human speed ([`bots.ts`](house/src/bots.ts)).

## Verify it yourself

- Base layer: the [program on Solana Explorer](https://explorer.solana.com/address/5eP2A36T97mwaGHf6XoHZU6VoKh1NGxA2QwvtJhAJ6ms?cluster=devnet) shows per recorded round a delegation, the validator's commit, `settle_round` and `close_round`. Play itself never touches the base layer.
- Rollup: [house pool 1's Table on the TEE](https://explorer.solana.com/address/C9F937UM7d254jBMp1kNh1MnpSRcw6TcP2GkBUiXxq27?cluster=custom&customUrl=https%3A%2F%2Fdevnet-tee.magicblock.app). Its ticks and acts are readable between a bell and the next re-seal, not during play.
- After each bell Proof shows "replay ✓ … matches commit": the browser re-runs the revealed log from the seed ([`replay.ts`](app/src/core/replay.ts)).

Measured on devnet, 2026-11-24 (program version 1, TEE validator in Singapore):

| What | Result |
|---|---|
| Beat timing | 430 live beats over 18 rounds: 418 resolved on the deadline slot, 12 one slot late, none twice |
| VRF | request → callback 2 slots in 17 of 18 rounds (6 on the first after deploy); no fallback seed |
| Round record | 384 recorded rounds in a row committed, re-verified, settled and closed on Solana; bell → on Solana p50 2.8 s, max 5.8 s |
| Round length | open → next open p50 52.8 s (n = 376) |
| Tape | 22 live rounds, 66 calls: every payout and refund exact to the lamport; 12 refunded |
| Failures | 0 of 60,212 scripted player acts over 360 rounds |
| Walletless join | link → own Desk on screen: p50 3.8 s, max 5.1 s, 20/20 incl. 2 at once (fresh browsers, EU) |

## Build and test

```sh
make setup doctor build   # Anchor 1.0.2, Agave 4.1.2, ephemeral-rollups-sdk 0.17.3
make test                 # Rust + TypeScript tests, golden vectors
make test-svm             # program in MagicSVM: rounds, compute, security
make leak-probe-devnet    # side-channel probes on devnet
make browser-check URL=https://picked-off-smoky.vercel.app
```

## Review

Before the deploy, a reviewer who did not write the program attacked it. The checks are tests in [`security_static.rs`](tests-magicsvm-rs/tests/security_static.rs), [`security_base.rs`](tests-magicsvm-rs/tests/security_base.rs), [`security_rollup.rs`](tests-magicsvm-rs/tests/security_rollup.rs), [`cu.rs`](tests-magicsvm-rs/tests/cu.rs) and [`lifecycle.rs`](tests-magicsvm-rs/tests/lifecycle.rs) (all passing). They cover: permissions only by the program's rules; only the house commits, only a finished Round; delegation only to the pinned TEE validator; seed-checked accounts, look-alikes refused; `tick` harmless at any time; one action per desk per beat; one VRF result per round from the pinned identity; a uniform bell; `act` and `tick` never fail; claims pay each owner once; constant compute, no logs; an unpredictable crank id; nothing carried into the next round.

Found and fixed:
- Any burner could brick a desk for every later holder by acting with the largest sequence number. Now the counter restarts when the desk changes hands.
- Aborting a recorded round without its record left the record stuck on the rollup. Now abort requires it.
- The devnet build accepted local-test admin, validator and VRF keys. Now they exist only in a `local` build.
- Crank iterations were unbounded. Now capped at 10,000.

Left open:
- Free seats can be squatted (see Limits).
- A Tape not settled within 30 minutes of its close turns void (refunds). The house settles right after each commit, and clients send settle and claim together.
- Replacing a stalled crank does not cancel the old task; its ticks are no-ops and the iteration cap bounds them.

## Limits

- **Devnet only.** Money is devnet SOL; free pools pay chips.
- **The TEE is trusted** for privacy: the hardware and MagicBlock's validator see everything.
- **The house key is trusted for liveness**: it opens, reveals and commits rounds, seats bots, reseats idle seats, and can abort a round (Tape refunded). It cannot read the Book or a player's Desk before the bell, unseal early, commit anything but a Round, or pay a call to anyone but its bettor.
- **Everything is public after the bell**, by design: the round's transactions, keys and data, until the next re-seal. Nothing in it helps the next round.
- **Seated players know more than spectators** on the Tape, and one person can call from a second burner. In the model, calling with your own exact total is right 44.4% vs 42.5% for the public favourite.
- **No sybil resistance in free pools.** Anyone can take free seats, and several burners can sit at one pool; a takeover hands over that desk's results so far. In the model, two desks sharing everything gain about 0.03 stakes each.
- **Bots were tuned in the model, not on humans**, and live they are easier: they miss about 8 % of the beats they mean to act on, so live payouts run higher.
- **Latency is from one region** (EU). The game shows each visitor their own number.
- **Log streams replay a round once it is public.** In 30 minutes on both house pools (68 rounds) no stream delivered a private transaction before its round was revealed; afterwards the `"all"` stream replays some acts and ticks, with constant CU and no logs.

MIT licence.
