# Picked Off (codename Ping): build / test / deploy. Toolchain pins: rust-toolchain.toml,
# Anchor.toml and package.json. Builds call cargo-build-sbf directly so every program shares
# one target/ dir; `anchor build` 1.0.2 only handles members under programs/ correctly.

SHELL         := /bin/bash
TOOLS         ?= v1.52
WALLET        ?= $(HOME)/.config/solana/blitz-ping-devnet.json
PROGRAM_KEYS  ?= $(HOME)/.config/solana/blitz-ping-programs
DEVNET_RPC    ?= https://api.devnet.solana.com
TEE_VALIDATOR := MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo
SPIKE_PROGRAM_ID ?= $(shell awk -F'"' '/^ping_spike *=/{print $$2; exit}' Anchor.toml)
SBF           := cargo build-sbf --tools-version $(TOOLS) --sbf-out-dir target/deploy

.PHONY: all build build-ping build-spike idl keys test app deploy-devnet deploy-spike-devnet \
        delegate balance local-stack spike-local spike-devnet probe-tee clean-ledger

all: build

keys:
	@mkdir -p target/deploy
	@for n in ping ping_spike; do \
	  [ -f target/deploy/$$n-keypair.json ] || cp $(PROGRAM_KEYS)/$$n-keypair.json target/deploy/; \
	done

build-ping: keys
	$(SBF) --manifest-path programs/ping/Cargo.toml

build-spike: keys
	$(SBF) --manifest-path spike/programs/ping-spike/Cargo.toml

idl:
	@mkdir -p target/idl target/types
	anchor idl build -p ping -o target/idl/ping.json -t target/types/ping.ts
	anchor idl build -p ping_spike -o target/idl/ping_spike.json -t target/types/ping_spike.ts

build: build-ping build-spike idl

test:
	cargo test --workspace
	npx tsc --noEmit -p tsconfig.json

app:
	cd app && npm ci && npm run build

# ---- devnet (needs SOL in $(WALLET); ~1 SOL for ping, ~3 SOL for the prototype, x2 peak while deploying)
deploy-devnet: build-ping
	solana program deploy target/deploy/ping.so --program-id target/deploy/ping-keypair.json \
	  -k $(WALLET) -u $(DEVNET_RPC) --with-compute-unit-price 1000

deploy-spike-devnet: build-spike
	solana program deploy target/deploy/ping_spike.so --program-id target/deploy/ping_spike-keypair.json \
	  -k $(WALLET) -u $(DEVNET_RPC) --with-compute-unit-price 1000

# Devnet setup for the prototype in spike/ (not included in this repository).
delegate:
	SPIKE_ENV=devnet PHASES=setup,er npx tsx spike/scripts/run.ts

balance:
	solana balance -k $(WALLET) -u $(DEVNET_RPC)

# ---- spike
local-stack:
	npx mb-stack --reset --bpf-program $(SPIKE_PROGRAM_ID) target/deploy/ping_spike.so

spike-local:
	SPIKE_ENV=local npx tsx spike/scripts/run.ts

spike-devnet:
	SPIKE_ENV=devnet npx tsx spike/scripts/run.ts

probe-tee:
	npx tsx spike/scripts/probe-tee.ts

clean-ledger:
	rm -rf test-ledger
