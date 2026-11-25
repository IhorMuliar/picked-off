# Browser checks

Headless Chrome against a running game URL, through the Chrome DevTools protocol (Node 22, no dependencies).
Each browser gets a fresh profile, so it is a first-time visitor with a new burner key and no wallet.

```bash
make browser-check URL=https://picked-off-smoky.vercel.app
# or: CHECKS=join JOIN_N=18 node tests/browser/check.mjs <url>
```

Checks (one `PASS`/`FAIL` line each, exit code 1 if any fails): `join` (own Desk on screen in ≤ 10 s, sequential
and `JOIN_PAR` simultaneous, default 2), `round` (hide, ping, move, private results, bell, replay ✓ for `ROUNDS` full rounds), `cadence`
(send interval p50 240-260 ms, p95 ≤ 300 ms, 0 failed sends over 60 s), `peek` (the 5 live reads return nothing
private), `number` (beat → private result, n ≥ 8), `errors` (no uncaught exceptions or console errors), and with
`TAPE=1` a Tape call through the UI (spends devnet SOL from the drip): it passes when the Tape chip shows the call's outcome (won / lost / refunded) and its payout settled on chain, which the check waits for up to `TAPE_WAIT_S` (240) after the call. The drip accepts only the production origin, so run it against the deployed URL. Env and options are listed at the top of `check.mjs`.
Every run takes seats from the house bots for a round or two; keep `JOIN_N` modest on a busy pool.
