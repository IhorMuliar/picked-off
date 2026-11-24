# Picked Off (codename Ping): build / test / deploy. Toolchain pins: rust-toolchain.toml,
# Anchor.toml and package.json. Builds call cargo-build-sbf directly so every program shares
# one target/ dir; `anchor build` 1.0.2 only handles members under programs/ correctly.

SHELL         := /bin/bash
TOOLS         ?= v1.52
WALLET        ?= $(HOME)/.config/solana/blitz-ping-devnet.json
PROGRAM_KEYS  ?= $(HOME)/.config/solana/blitz-ping-programs
DEVNET_RPC    ?= https://api.devnet.solana.com
TEE_VALIDATOR := MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo
SPIKE_PROGRAM_ID ?= $(shell awk -F'"' '/^ping_spike *=/{print $$2; exit}' spike/Anchor.toml 2>/dev/null)
SBF           := cargo build-sbf --tools-version $(TOOLS) --sbf-out-dir target/deploy

# Some targets need local-only folders (spike/, docs/) that are not in this repository.
# $(call local_only,<path>) stops the target with a short note when <path> is absent.
local_only = @[ -e $(1) ] || { echo "$@: $(1) is not in this checkout"; exit 1; }
HAS_SPIKE  := $(wildcard spike/Cargo.toml)
# spike/ is its own Cargo + Anchor workspace (the root workspace excludes it); it shares target/.
SPIKE_ENV  := CARGO_TARGET_DIR=$(CURDIR)/target

.PHONY: all setup doctor build build-ping build-ping-local build-spike idl keys test test-svm app deploy-devnet devnet-version devnet-check-a5 \
        balance knowledge local-stack local-fund local-check-a1 local-check-a3 leak-probe-local leak-probe-devnet spike-local probe-tee clean-ledger \
        hooks internal-status internal-commit internal-push house-local house-stop house-i13 house-status house-report

all: build

# First thing in a fresh clone: install exact npm deps (root + app), then check every pin.
setup:
	npm ci
	cd app && npm ci

# Checks the pinned toolchain and repairs the Solana link that any `anchor` command run
# outside this repo breaks. Run `anchor` only in here.
doctor:
	./scripts/doctor.sh

# Copies the program keypairs from $(PROGRAM_KEYS) when present. Without them cargo-build-sbf
# generates a fresh keypair, whose address will not match declare_id! in the program.
keys:
	@mkdir -p target/deploy
	@for n in ping $(if $(HAS_SPIKE),ping_spike); do \
	  if [ -f target/deploy/$$n-keypair.json ]; then :; \
	  elif [ -f $(PROGRAM_KEYS)/$$n-keypair.json ]; then cp $(PROGRAM_KEYS)/$$n-keypair.json target/deploy/; \
	  else echo "keys: no $(PROGRAM_KEYS)/$$n-keypair.json; cargo-build-sbf will generate one"; fi; \
	done

# The devnet binary: target/deploy/ping.so (default features; deploy-devnet and test-svm use it).
build-ping: keys
	$(SBF) --manifest-path programs/ping/Cargo.toml

# The local-stack binary: target/deploy-local/ping.so (feature `local`: also accepts the local test
# admin, the local validator identity and the VRF test queue). local-stack loads this one.
build-ping-local: keys
	@mkdir -p target/deploy-local
	@[ -f target/deploy-local/ping-keypair.json ] || cp target/deploy/ping-keypair.json target/deploy-local/ 2>/dev/null || true
	cargo build-sbf --tools-version $(TOOLS) --sbf-out-dir target/deploy-local --manifest-path programs/ping/Cargo.toml --features local

build-spike: keys
ifneq ($(HAS_SPIKE),)
	$(SPIKE_ENV) cargo build-sbf --tools-version $(TOOLS) --sbf-out-dir $(CURDIR)/target/deploy \
	  --manifest-path spike/programs/ping-spike/Cargo.toml
else
	@echo "build-spike: spike/ is not in this checkout; skipping"
endif

idl:
	@mkdir -p target/idl target/types
	anchor idl build -p ping -o target/idl/ping.json -t target/types/ping.ts
ifneq ($(HAS_SPIKE),)
	cd spike && $(SPIKE_ENV) anchor idl build -p ping_spike -o $(CURDIR)/target/idl/ping_spike.json \
	  -t $(CURDIR)/target/types/ping_spike.ts
endif

build: build-ping-local build-ping build-spike idl

test:
	cargo test --workspace
ifneq ($(HAS_SPIKE),)
	cd spike && $(SPIKE_ENV) cargo test --workspace
endif
	@if compgen -G "spike/scripts/*.ts" >/dev/null || compgen -G "scripts/*.ts" >/dev/null \
	  || compgen -G "bots/*.ts" >/dev/null || compgen -G "tests/*.ts" >/dev/null; then \
	  echo "npx tsc --noEmit -p tsconfig.json"; npx tsc --noEmit -p tsconfig.json; \
	else echo "test: no TypeScript sources yet; skipping tsc"; fi

# In-process program tests on MagicSVM (base + rollup, crank, VRF) against target/deploy/ping.so:
# full rounds, constant compute of act/tick, act fuzz, engine vectors, reset, crank, join.
# Its own Cargo workspace; MagicSVM needs a newer host toolchain than the program.
test-svm: build-ping
	cd tests-magicsvm-rs && cargo +stable test -- --nocapture --test-threads 4

app:
	cd app && npm ci && npm run build

# Rebuild and validate the OKF knowledge bundle indexes (docs/knowledge). Run before committing it.
knowledge:
	$(call local_only,docs/knowledge)
	python3 scripts/okf_index.py docs/knowledge rules=Rule

# ---- devnet (needs SOL in $(WALLET): about 2x the program rent at peak while deploying)
deploy-devnet: build-ping
	solana program deploy target/deploy/ping.so --program-id target/deploy/ping-keypair.json \
	  -k $(WALLET) -u $(DEVNET_RPC) --with-compute-unit-price 1000

balance:
	solana balance -k $(WALLET) -u $(DEVNET_RPC)

# Simulates `version` on the TEE until it returns EXPECT_VERSION (an upgrade reaches the TEE minutes
# after base). Run after every deploy or upgrade, before anything on the rollup.
devnet-version:
	npx tsx tests/devnet/version-gate.ts

# Devnet checks (tests/devnet/a5-check.ts): Config, the house pools (table ids 1 and 2), then ROUNDS
# recorded rounds on POOL with eight scripted desks: privacy, constant compute, round lifecycle, Tape.
# e.g. make devnet-check-a5 PHASES=rounds ROUNDS=10
devnet-check-a5:
	npx tsx tests/devnet/a5-check.ts

# ---- local MagicBlock stack (base :8899, ER :7799, privacy filter :6699). Runs in the foreground;
# start it in its own terminal after `make build` (it loads the local binary), then `make local-fund` in another.
# LOCAL_STACK_ARGS go to the base validator, e.g. LOCAL_STACK_ARGS="--ledger /big/disk/ledger" (its ledger
# grows by gigabytes per hour).
LOCAL_RPC    ?= http://127.0.0.1:8899
LOCAL_WALLET ?= $(HOME)/.config/solana/blitz-ping-localnet.json
local-stack:
	@[ -f target/deploy-local/ping.so ] || { echo "local-stack: run make build-ping-local first"; exit 1; }
	npx mb-stack --reset \
	  --bpf-program 5eP2A36T97mwaGHf6XoHZU6VoKh1NGxA2QwvtJhAJ6ms target/deploy-local/ping.so \
	  $(if $(and $(HAS_SPIKE),$(SPIKE_PROGRAM_ID)),--bpf-program $(SPIKE_PROGRAM_ID) target/deploy/ping_spike.so) \
	  $(LOCAL_STACK_ARGS)

# --reset wipes the ledger: the local wallet starts at 0 SOL and every setup tx fails.
# Fund it after each start.
local-fund:
	solana airdrop 100 -k $(LOCAL_WALLET) -u $(LOCAL_RPC)

# Program checks against the running local stack (after local-stack + local-fund): sealing and
# re-sealing, one recorded round through the crank, cancel, commit of the Round alone, aborts.
local-check-a1:
	npx tsx tests/local/a1-check.ts

# Base-layer money path against the running local stack: settle, calls, claims, refunds, owed, close.
local-check-a3:
	npx tsx tests/local/a3-check.ts

# Hidden-information leak probes L1-L21 (scripts/leak-probe.ts). Creates its own pool (table id
# >= 70), drives ROUNDS rounds (default 3) and probes the house pool read-only. Exit code != 0 on
# any FAIL. The full output is also written under $(LEAK_LOG_DIR) when that directory's parent exists.
LEAK_LOG_DIR ?= docs/e2e
LEAK_STAMP   := $(shell date -u +%Y%m%dT%H%M%SZ)
leak-probe-local:
	CLUSTER=local LEAK_LOG=$$([ -d $(dir $(LEAK_LOG_DIR)) ] && echo $(LEAK_LOG_DIR)/leak-probe-local-$(LEAK_STAMP).log) \
	  npx tsx scripts/leak-probe.ts

leak-probe-devnet:
	CLUSTER=devnet LEAK_LOG=$$([ -d $(dir $(LEAK_LOG_DIR)) ] && echo $(LEAK_LOG_DIR)/leak-probe-devnet-$(LEAK_STAMP).txt) \
	  npx tsx scripts/leak-probe.ts

# ---- house runner (house/): pools, bots, records. Local: after local-stack + local-fund.
# Runs in the foreground; settings come from the environment (house/README.md), e.g.
#   make house-local POOLS=1001 RECORD_EVERY_SEC=120 TEST_CALLS=1
HOUSE_STATE ?= $(HOME)/.local/state/picked-off
house-local:
	CLUSTER=local npx tsx house/src/main.ts

# Stops a runner started in the background, through the pid file the runner writes.
house-stop:
	@f=$(HOUSE_STATE)/house-$${CLUSTER:-local}.pid; if [ -f $$f ]; then kill -TERM $$(cat $$f) && echo "stopped $$(cat $$f)"; else echo "no pid file at $$f"; fi

# I13: on the rollup the runner read nothing but each bot's own Desk and the public Table.
house-i13:
	npx tsx house/src/i13-check.ts $(HOUSE_STATE)/house-$${CLUSTER:-local}-rpc.jsonl

# Installed runner (house/picked-off-house.service): unit state, /healthz, the last warnings.
HOUSE_PORT ?= 8788
house-status:
	@systemctl --no-pager --lines=0 status picked-off-house picked-off-house-watchdog.timer || true
	@curl -s 127.0.0.1:$(HOUSE_PORT)/healthz | jq -c '{ok, uptimeSec, balanceSol, recording, baseTxs, pools: [.pools[] | {pool, round, phase, lastRoundAgeSec, rounds, aborts, reschedules, bots}]}'
	@journalctl -u picked-off-house -u picked-off-house-watchdog --no-pager -n 5 -o cat

# Rounds, timings, bots and records from the runner's log.
house-report:
	npx tsx house/test/run-report.ts $(HOUSE_STATE)/house-$${CLUSTER:-devnet}.log

# ---- spike (local-only prototype, not included in this repository)

spike-local:
	$(call local_only,spike/scripts/run.ts)
	$(MAKE) local-fund
	SPIKE_ENV=local npx tsx spike/scripts/run.ts

probe-tee:
	$(call local_only,spike/scripts/probe-tee.ts)
	npx tsx spike/scripts/probe-tee.ts

clean-ledger:
	rm -rf test-ledger

# ---- second git directory for the local-only folders, sharing this working tree.
# Its own exclude file (.git-internal/info/exclude) decides which paths it tracks; this
# repository keeps those paths out through .git/info/exclude (see `hooks`).
GIT_LOCAL      := git --git-dir=.git-internal --work-tree=.
INTERNAL_PATHS := HANDOFF.md docs spike
LOCAL_ONLY     := /HANDOFF.md /docs/ /spike/ /.git-internal/

# Installs pre-commit guards: this repository refuses the local-only paths and key material;
# the internal one refuses key material. Also makes sure .git/info/exclude ignores the local-only
# paths. Safe to re-run.
hooks:
	@for p in $(LOCAL_ONLY); do grep -qxF -- "$$p" .git/info/exclude || echo "$$p" >> .git/info/exclude; done
	@printf '#!/bin/sh\nexec scripts/guard-commit.sh --deny HANDOFF.md --deny docs/ --deny spike/ --deny .git-internal/\n' > .git/hooks/pre-commit
	@chmod +x .git/hooks/pre-commit
	@if [ -d .git-internal ]; then \
	  printf '#!/bin/sh\nexec scripts/guard-commit.sh\n' > .git-internal/hooks/pre-commit; \
	  chmod +x .git-internal/hooks/pre-commit; fi
	@echo "hooks: pre-commit guards installed"

internal-status:
	$(call local_only,.git-internal)
	@$(GIT_LOCAL) status --short --branch --untracked-files=no
	@$(GIT_LOCAL) ls-files --others --exclude-from=.git-internal/info/exclude | sed 's/^/?? /'

internal-commit:
	$(call local_only,.git-internal)
	@[ -n "$(m)" ] || { echo 'usage: make internal-commit m="message"'; exit 1; }
	$(GIT_LOCAL) add -A -- $(INTERNAL_PATHS)
	@GIT_DIR=.git-internal scripts/guard-commit.sh || { \
	  echo "internal-commit: aborted, key-like material is staged (listed above)"; exit 1; }
	$(GIT_LOCAL) commit -m "$(m)"

internal-push:
	$(call local_only,.git-internal)
	$(GIT_LOCAL) push origin main

# browser-check: headless Chrome checks against a game URL (tests/browser)
.PHONY: browser-check
browser-check:
	@test -n "$(URL)" || (echo 'usage: make browser-check URL=https://...' && exit 2)
	node tests/browser/check.mjs $(URL)
