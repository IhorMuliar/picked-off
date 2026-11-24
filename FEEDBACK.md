# Feedback for the MagicBlock team

Notes from building PICKED OFF on the Private Ephemeral Rollup (devnet TEE `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`, `ephemeral-rollups-sdk` 0.17.3 for Rust and TypeScript, Anchor 1.0.2), November 2026. Each point is something the build ran into, with how to see it again. What worked well is at the end.

## 1. Document what each read path exposes for a private transaction

Redaction works: `getTransaction` of a transaction that touches a private account returns a slot-only shell for every caller, the sender included, and such transactions are missing from every `getSignaturesForAddress` list. But a game has to know about every other path too, and we had to measure each one:

- `logsSubscribe("all")`: once a round's accounts become public, it delivers that round's earlier transactions with full logs and compute units. In our runs it delivered nothing before the accounts turned public.
- Visibility is decided at read time from the current permissions. When an account becomes public, its whole past history becomes readable (keys, instruction data, errors). When it is made private again, that history turns back into shells.
- `getBlock` answers HTTP 403.

**Ask:** one page listing every RPC and websocket method and what it returns for a private transaction, before and after a permission change. Also say plainly that compute units and log lines are visible to anyone on some paths. A program that branches on hidden data leaks through its CU count, so private-state programs need constant-work code. We did that with fixed loops and `read_volatile` masks: [`crates/ping-core/src/mask.rs`](crates/ping-core/src/mask.rs). A short note and an example in the docs would save the next team a day.

**Reproduce:** [`scripts/leak-probe.ts`](scripts/leak-probe.ts) (`make leak-probe-devnet`) runs all of these as another member, an authenticated outsider and an anonymous caller.

## 2. Crank task ids are first-come

A crank task id chosen by a program can be scheduled first by anyone who can predict it, and the first schedule wins. We derive ours on chain from the current slot hash ([`programs/ping/src/utils.rs`](programs/ping/src/utils.rs), `task_id`) and checked it by pre-scheduling 5 guessed ids per round: the real crank always ran.

**Ask:** namespace task ids by the scheduling program (or its signer PDA) inside the Magic program, or document the risk next to `ScheduleCrankCpi`.

## 3. `CancelCrankCpi` needs the magic context

Replacing a stalled crank from an instruction that has no magic-context account cannot cancel the old task. We had to leave the old task running (its ticks are no-ops) and cap iterations.

**Ask:** a way to cancel by task id with only the scheduling authority's signature, or a docs note that cancel needs the context account so instruction layouts include it from the start.

## 4. TEE permission account layout vs the TypeScript SDK

Read through a member's token, a permission account on the TEE is laid out as `disc u8, bump u8, account [32], is_private u8`, then `{flags u8, key [32]}` repeated to the end. The SDK's TypeScript deserializer did not decode it, so we wrote our own ([`tests/devnet/devnet.ts`](tests/devnet/devnet.ts)). A permission account is readable only by its members, which is right, but it would also help to document that a client can check its own membership this way.

## 5. Local stack vs devnet

- The local stack cannot commit an account with about 1 KB of changed data (`TransactionTooLarge`, 2,040 > 1,232 bytes; the account stays delegated). Devnet commits the same 816-byte record, 460-604 bytes changed, every time (18 of 18). We test full commits on devnet only. Either match devnet or document the limit.
- The local stack lists private transactions in `getSignaturesForAddress`; devnet does not. Tests that pass locally can therefore depend on data that devnet never shows.

## 6. Program upgrades reach the TEE late

After our first deploy, `version` simulated on the TEE returned the new build 3 min 14 s after the base-layer deploy (an upper bound; the gate started late). Until then the TEE runs the old binary. Our deploy gate simulates a `version` instruction on the TEE before any rollup step ([`tests/devnet/version-gate.ts`](tests/devnet/version-gate.ts)).

**Ask:** an RPC method or docs note giving the program build the TEE is running, and the expected lag.

## 7. Small things

- **Clocks:** the TEE's `Clock.unix_timestamp` ran up to about 1 s ahead of the base layer's in our reads (−0.19 to +0.96 s over 18 reads). Anything that closes on base time and opens on TEE time has to allow for it. One sentence in the docs would do.
- **Signature lists right after delegation:** in the first round after a pool was created, the Table's signature list held none of the crank ticks after the round turned public. From the second round on it held all of them.
- **Rent floor on payouts:** a payout below the rent-exempt minimum (650,240 lamports today) to a fresh key fails the whole base transaction. That is Solana, not MagicBlock, but every settle-after-commit design hits it. Leave such amounts owed and read the minimum at runtime; that could go in a settlement example.

## What worked well

- Delegation → usable on the TEE in 174-582 ms after base confirmation (38 delegations, devnet).
- The 250-ms crank against slot deadlines: 430 live beats, 418 resolved on the deadline slot and 12 one slot late, none twice; 0 ticks after `CancelCrankCpi`.
- Rollup VRF: request → callback in 2 slots in 17 of 18 rounds.
- `commit_and_undelegate` of a single 816-byte account: 18 of 18, commit → base median 1.5 s.
- 23,117 player transactions at 32 tx/s per pool with 0 failures and no rate limiting.
- Walletless play: a 0-SOL burner key logs in to the TEE and signs every action without a popup.
