#!/usr/bin/env bash
# Toolchain check for blitz-ping. Run from the repo root: `make doctor`.
# Checks every toolchain pin and repairs the one known silent breakage
# (any `anchor` command run OUTSIDE this repo repoints the global Solana install).
set -u
cd "$(dirname "$0")/.."
fail=0
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=1; }
want() { # name expected actual
  if [ "$2" = "$3" ]; then ok "$1 $3"; else bad "$1: want $2, got ${3:-missing}"; fi
}

echo "Solana / Agave"
SOL_REL="$HOME/.local/share/solana/install/releases/4.1.2/solana-release"
active=$(readlink "$HOME/.local/share/solana/install/active_release" 2>/dev/null || true)
if [ -d "$SOL_REL" ] && [ "$active" != "$SOL_REL" ]; then
  echo "  repairing active_release ($active -> 4.1.2)"
  ln -sfn "$SOL_REL" "$HOME/.local/share/solana/install/active_release"
  sed -i 's/^explicit_release: !Semver .*/explicit_release: !Semver 4.1.2/' "$HOME/.config/solana/install/config.yml" 2>/dev/null || true
fi
want "solana" "4.1.2" "$(solana --version 2>/dev/null | awk '{print $2}')"
want "cargo-build-sbf" "4.1.0" "$(cargo-build-sbf --version 2>/dev/null | head -1 | awk '{print $2}')"
[ -d "$HOME/.cache/solana/v1.52" ] && ok "platform-tools v1.52 cached" \
  || echo "  note  platform-tools v1.52 not cached yet; the first 'make build' installs it"

echo "Rust"
want "rustc (repo toolchain)" "1.89.0" "$(rustc --version 2>/dev/null | awk '{print $2}')"
if rustup run stable rustc --version >/dev/null 2>&1; then ok "stable toolchain present (MagicSVM tests: cargo +stable test)"; else bad "rustup stable toolchain missing (needed only for MagicSVM tests)"; fi

echo "Anchor (run inside the repo only)"
want "anchor" "1.0.2" "$(anchor --version 2>/dev/null | awk '{print $2}')"
for c in anchor-lang anchor-derive-accounts anchor-syn anchor-attribute-program; do
  v=$(awk -v n="$c" '$0=="name = \""n"\""{getline; gsub(/version = |"/,""); print; exit}' Cargo.lock)
  want "Cargo.lock $c" "1.0.2" "$v"
done
v=$(awk '$0=="name = \"ephemeral-rollups-sdk\""{getline; gsub(/version = |"/,""); print; exit}' Cargo.lock)
want "Cargo.lock ephemeral-rollups-sdk" "0.17.3" "$v"

echo "Node"
want "node" "v22.23.2" "$(node --version 2>/dev/null)"
if [ -d node_modules ]; then
  for p in @solana/web3.js:1.98.4 @magicblock-labs/ephemeral-rollups-sdk:0.17.3 @coral-xyz/anchor:0.32.1 @magicblock-labs/ephemeral-validator:1.1.1; do
    n=${p%%:*}; e=${p##*:}
    want "npm $n" "$e" "$(node -p "require('./node_modules/$n/package.json').version" 2>/dev/null)"
  done
else
  bad "node_modules missing: run 'make setup'"
fi
if [ -d app/node_modules ]; then
  for p in react:19.3.1 vite:8.3.8 typescript:5.9.3; do
    n=${p%%:*}; e=${p##*:}
    want "app npm $n" "$e" "$(node -p "require('./app/node_modules/$n/package.json').version" 2>/dev/null)"
  done
else
  bad "app/node_modules missing: run 'make setup'"
fi

echo "Keys (outside the repo, never committed)"
keys="blitz-ping-devnet.json blitz-ping-localnet.json blitz-ping-programs/ping-keypair.json"
[ -d spike ] && keys="$keys blitz-ping-programs/ping_spike-keypair.json"
for f in $keys; do
  [ -f "$HOME/.config/solana/$f" ] && ok "~/.config/solana/$f" || bad "~/.config/solana/$f missing (create it with solana-keygen new -o ~/.config/solana/$f)"
done

if [ $fail -eq 0 ]; then echo "doctor: all pins match"; else echo "doctor: mismatches above"; fi
exit $fail
