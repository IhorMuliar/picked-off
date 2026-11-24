# Picked Off

Hide your order in a dark book. Ping for everyone else's. Pick them off before the closing bell.

Picked Off is a real-time hidden-information game built on MagicBlock's
Private Ephemeral Rollup, made for Solana Blitz v10.

**Status: in development.** What is here today is the project skeleton: an
Anchor workspace with the `ping` program (a single no-op `initialize`
instruction, no game logic yet), a Vite + React app shell, and the pinned
toolchain with build and check scripts. The game itself is not playable yet.

## Layout

- `programs/ping/` - the on-chain game program (Anchor, MagicBlock ephemeral-rollups-sdk)
- `app/` - web client (Vite + React + TypeScript), currently a placeholder page
- `scripts/doctor.sh` - checks every pinned tool version
- `Makefile` - build, test and deploy entry points

## Toolchain

| Tool | Version |
|---|---|
| Rust (host, `rust-toolchain.toml`) | 1.89.0 |
| Solana / Agave CLI | 4.1.2 |
| cargo-build-sbf / platform-tools | 4.1.0 / v1.52 |
| Anchor CLI and `anchor-lang` | 1.0.2 |
| `ephemeral-rollups-sdk` (Rust and npm) | 0.17.3 |
| Node.js | 22.23.2 |
| `@solana/web3.js` / `@coral-xyz/anchor` | 1.98.4 / 0.32.1 |
| React / Vite / TypeScript | 19.3.1 / 8.3.8 / 5.9.3 |

Run `anchor` only inside this repository: `Anchor.toml` pins `solana_version`,
and an `anchor` command run elsewhere can repoint the global Solana install.
`make doctor` checks for that and repairs it.

## Build and test

```sh
make setup     # npm ci for the root and app/
make doctor    # check the pinned toolchain (also lists the deploy keypairs it expects)
make build     # build the program with cargo-build-sbf and its IDL with anchor
make test      # cargo test --workspace
make app       # production build of the web client into app/dist
```

`cd app && npm run dev` serves the client shell locally.

Without the owner's program keypair, `make build` lets cargo-build-sbf generate a
new one, so the program address will differ from the `declare_id!` in the source.
