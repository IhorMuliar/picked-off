# House runner

One Node 22 process (`npx tsx house/src/main.ts`) that keeps the house pools of PICKED OFF running
round after round, seats labelled house bots in every empty desk, and takes recorded rounds through
to settlement on Solana.

## What it does, per pool
1. **Setup, once** (idempotent, finishes a half-done setup): `create_pool`, `create_desk` ×8,
   `delegate` ×10 (one account per transaction, pinned validator), `setup_permissions` for the
   Table, the Book and each Desk on the rollup, `join_bot` for the eight seats.
2. **Every round**, driven only from what the chain says:
   - recorded rounds: `create_record` + `delegate` of the Round in one base transaction, pipelined
     during the previous round so it is visible on the rollup before its round opens;
   - re-seal (`setup_permissions` for the Book and the Desks), `open_round` (reset, VRF request,
     crank scheduled with `ScheduleCrankCpi`);
   - a recorded round opens only once the rollup's clock has reached the record's planned start;
   - watch the crank's ticks to the bell; `reveal` (cancels the crank), then for a recorded round
     `commit_round` at once (the Round alone, `commit_and_undelegate`; before the unseal, so the record
     is back on base about 3 s after the bell), then `unseal`; the round stays public for
     `LIGHTS_ON_MS` for the replay, then the next round opens;
   - recorded rounds, in the background: wait until the Round is owned by the program on base →
     `settle_round` together with the first claims in one transaction (each later claim transaction
     carries `settle_round` too, so no claim ever meets an unsettled Tape; a payout below the rent
     minimum stays owed and is retried) → `close_round`.
3. **Record cadence:** every round with a player seated, otherwise one round per `RECORD_EVERY_SEC`
   (300 s) per pool.
4. **Liveness:** when a beat deadline is overdue by `STALL_MS` (3 s) the runner sends
   `reschedule_crank` (fresh task id); a round that still makes no progress for `HARD_STALL_MS`, or
   is open for longer than `MAX_ROUND_MS`, is called off with `abort_round` (its Tape is refunded).
   A pid lock stops a second runner from driving the same rounds.
5. **Restart:** kill it at any point and start it again: it reads each pool's Table and every
   unclosed record from the chain and continues (mid-round, revealed, committed, unsettled,
   unclaimed, unclosed). No database is needed.

Every base-layer transaction is sent with preflight on, so failing transactions never land
(`src/basesend.ts`). While it has no status, the same signed transaction (same signature, so it can
execute at most once) is sent again every `BASE_REBROADCAST_MS` (2 s), until it is confirmed, fails,
or its blockhash expires; only then is a new one signed, after re-reading the chain so that a
transaction whose effect already happened is not sent again. A record is never created, and a Round
never committed, twice at the same time; each record is driven on its own, so one slow transaction
holds up no other record and no round.

**Late record:** a round whose record is not confirmed when the round is due waits for it at most
`RECORD_WAIT_MS` (6 s), or `RECORD_WAIT_PLAYER_MS` (15 s) with a player seated, then opens
unrecorded; a create that still lands later is committed, settled (void) and closed like any record.

**Low-balance guard:** the house balance is read every minute; below `MIN_BALANCE_SOL` (6 SOL on
devnet) no new records are created (an error line `low_balance` every minute, `recording: false` in
`/healthz`); the pools keep playing unrecorded rounds, which cost nothing on base. Below
`SOFT_BALANCE_SOL` (10) a pool records at most one round per `LOW_RECORD_EVERY_SEC` (120 s) even
with a player seated (the rounds in between are played unrecorded, with no Tape).

## Bots
Each bot is an ordinary desk with its own key (`BOT_KEYS_DIR`, written before the key is used) and
its own rollup token. It reads only its own Desk and the public Table, and sends one `act` every
250 ms while its round is in HIDE or LIVE: its latest choice, otherwise a no-op. It stops sending the moment the house sees the bell (and
whenever its view of the Table is older than 700 ms); the house unseals a round only after every bot
send is answered and 300 ms have passed, so every bot act lands while the round is still private. It never sends
before it has read its own re-sealed Desk of the new round. A bot uses a private result only after a
sampled reaction time (lognormal, median 0.9 s, σ 0.35) and is present on a share of beats, with
absences in streaks; when it is absent the program's algo pings for it, as for any silent desk.

| | Shark | Ghost | Minnow |
|---|---|---|---|
| present on (share of beats; mean absence) | 90 %; 2 beats | 90 %; 2 beats | 75 %; 3 beats |
| re-quote after being PICKED OFF | 0.3 | 1.0 | 0.5 |
| otherwise idle re-quote | 0 | 0.10 | 0.03 |
| re-ping its last FILL level (until it misses) | 1.0 | 0.6 | 0.7 |
| otherwise ping a level ≠ own not pinged within | 8 beats | 6 beats | 3 beats |

Seats of an all-bot pool: 0 SHARK-1, 1 GHOST-1, 2 MINNOW-1, 3 SHARK-2, 4 GHOST-2, 5 MINNOW-2,
6 GHOST-3, 7 MINNOW-3. When a player `join`s a desk, the program hands the desk to the player; the
runner sees the seat change in the Table and stops that bot at once. Empty seats are refilled with
bots between rounds. Bots never sit at staked tables.

## Run
```sh
make local-stack            # own terminal
make local-fund
make house-local            # CLUSTER=local; e.g. POOLS=1001 RECORD_EVERY_SEC=120 TEST_CALLS=1
curl -s 127.0.0.1:8787/healthz
make house-stop             # SIGTERM through the runner's pid file
make house-i13              # account-read check over the runner's log
npx tsx house/test/restart.ts     # kill/restart test (local stack)
npx tsx house/test/liveness.ts    # stalled crank → reschedule; stuck round → abort (local stack)
npx tsx house/test/guards.ts      # offline: low-balance guard, single create/commit in flight, log rotation
npx tsx house/test/rebroadcast.ts # offline: rebroadcast, expiry + rebuild, late record → unrecorded round, record pass
npx tsx house/test/run-report.ts <house log>                 # rounds, timings, bots, records
npx tsx house/test/wallet-report.ts <since ISO time> [house log]   # house wallet txs, failures, SOL spent
```
Settings: environment variables (`house/.env.example`) or a JSON file in `HOUSE_CONFIG`.
The account-read log for the I13 check (`HOUSE_RPC_LOG`, about 4 MB per pool-hour) can be turned off with `HOUSE_RPC_LOG=off`.
Both log files rotate at `HOUSE_LOG_MAX_MB` (100), keeping `HOUSE_LOG_KEEP` (3) older files.
Logs: one JSON object per line on stdout and in `HOUSE_LOG`; one `round` line per round (round, beats,
bell slot, timings, record signature), one `bots` line per round (per bot: acts sent and acknowledged,
pings, re-quotes, presence, reaction time, total), one `record` line per closed record.
`GET /healthz` (localhost) returns each pool's last round time and stuck flags (HTTP 503 when stuck),
the house balance, whether records are being created, and base-transaction counters.

## Service
`house/picked-off-house.service` runs the runner under systemd (`Restart=always`; info lines go only
to the rotated log file, warnings and errors also to the journal). `house/watchdog.sh`, run every
minute by `house/picked-off-house-watchdog.timer`, restarts the runner when a pool has finished no
round for more than 3 minutes or `/healthz` stops answering, and repeats the low-balance alarm.
A restart or a crash at any point resumes from chain state.
