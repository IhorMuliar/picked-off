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

.PHONY: all setup doctor build build-ping build-spike idl keys test app deploy-devnet deploy-spike-devnet \
        delegate balance knowledge local-stack local-fund spike-local spike-devnet probe-tee clean-ledger \
        hooks internal-status internal-commit internal-push

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

build-ping: keys
	$(SBF) --manifest-path programs/ping/Cargo.toml

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

build: build-ping build-spike idl

test:
	cargo test --workspace
ifneq ($(HAS_SPIKE),)
	cd spike && $(SPIKE_ENV) cargo test --workspace
endif
	@if compgen -G "spike/scripts/*.ts" >/dev/null || compgen -G "scripts/*.ts" >/dev/null \
	  || compgen -G "bots/*.ts" >/dev/null || compgen -G "tests/*.ts" >/dev/null; then \
	  echo "npx tsc --noEmit -p tsconfig.json"; npx tsc --noEmit -p tsconfig.json; \
	else echo "test: no TypeScript sources yet; skipping tsc"; fi

app:
	cd app && npm ci && npm run build

# Rebuild and validate the OKF knowledge bundle indexes (docs/knowledge). Run before committing it.
knowledge:
	$(call local_only,docs/knowledge)
	python3 scripts/okf_index.py docs/knowledge rules=Rule

# ---- devnet (needs SOL in $(WALLET); ~1 SOL for ping, ~3 SOL for the prototype, x2 peak while deploying)
deploy-devnet: build-ping
	solana program deploy target/deploy/ping.so --program-id target/deploy/ping-keypair.json \
	  -k $(WALLET) -u $(DEVNET_RPC) --with-compute-unit-price 1000

deploy-spike-devnet:
	$(call local_only,spike/programs/ping-spike/Cargo.toml)
	$(MAKE) build-spike
	solana program deploy target/deploy/ping_spike.so --program-id target/deploy/ping_spike-keypair.json \
	  -k $(WALLET) -u $(DEVNET_RPC) --with-compute-unit-price 1000

# Devnet setup for the prototype in spike/ (not included in this repository).
delegate:
	$(call local_only,spike/scripts/run.ts)
	SPIKE_ENV=devnet PHASES=setup,er npx tsx spike/scripts/run.ts

balance:
	solana balance -k $(WALLET) -u $(DEVNET_RPC)

# ---- local MagicBlock stack (base :8899, ER :7799, privacy filter :6699). Runs in the foreground;
# start it in its own terminal after `make build`, then `make local-fund` in another.
LOCAL_RPC    ?= http://127.0.0.1:8899
LOCAL_WALLET ?= $(HOME)/.config/solana/blitz-ping-localnet.json
local-stack:
	npx mb-stack --reset \
	  --bpf-program 5eP2A36T97mwaGHf6XoHZU6VoKh1NGxA2QwvtJhAJ6ms target/deploy/ping.so \
	  $(if $(and $(HAS_SPIKE),$(SPIKE_PROGRAM_ID)),--bpf-program $(SPIKE_PROGRAM_ID) target/deploy/ping_spike.so)

# --reset wipes the ledger: the local wallet starts at 0 SOL and every setup tx fails.
# Fund it after each start.
local-fund:
	solana airdrop 100 -k $(LOCAL_WALLET) -u $(LOCAL_RPC)

# ---- spike (local-only prototype, not included in this repository)

spike-local:
	$(call local_only,spike/scripts/run.ts)
	$(MAKE) local-fund
	SPIKE_ENV=local npx tsx spike/scripts/run.ts

spike-devnet:
	$(call local_only,spike/scripts/run.ts)
	SPIKE_ENV=devnet npx tsx spike/scripts/run.ts

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
