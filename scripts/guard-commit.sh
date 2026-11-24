#!/usr/bin/env bash
# Refuses a commit whose index holds key material or paths that must stay out of this repository.
# Checks every path in the index of the repository selected by GIT_DIR (default: .git), so it
# also catches a key staged in an earlier, uncommitted `git add`.
#   scripts/guard-commit.sh [--deny <path-prefix>]...
# Used by `make internal-commit` and by the pre-commit hooks `make hooks` installs.
set -euo pipefail
cd "$(dirname "$0")/.."
deny=()
while [ $# -gt 0 ]; do
  case "$1" in
    --deny) deny+=("$2"); shift 2 ;;
    *) echo "guard-commit: unknown argument $1" >&2; exit 2 ;;
  esac
done

bad=0
flag() { echo "guard-commit: REFUSED $1 ($2)" >&2; bad=1; }

while IFS= read -r -d '' path; do
  base=${path##*/}
  for p in "${deny[@]}"; do
    case "$path" in "$p"|"$p"*) flag "$path" "path not allowed in this repository" ;; esac
  done
  case "$base" in
    .env.example) ;;
    *keypair*.json|id.json|*.key|*.pem|.env*) flag "$path" "key-like file name" ;;
  esac
  case "/$path" in */magicblock-test-storage/*) flag "$path" "local validator storage" ;; esac
  case "$base" in
    *.json)
      # A Solana secret key file is a bare JSON array of 64 integers.
      c=$(git show ":$path" 2>/dev/null | head -c 65536 | tr -d '[:space:]' || true)
      re='^\[([0-9]{1,3},){63}[0-9]{1,3}\]$'
      if [[ $c =~ $re ]]; then flag "$path" "content is a 64-integer array (secret key)"; fi ;;
  esac
done < <(git ls-files -z --cached)

if [ $bad -ne 0 ]; then
  echo "guard-commit: nothing committed. Unstage with: git ${GIT_DIR:+--git-dir=$GIT_DIR }rm --cached -- <path>" >&2
  exit 1
fi
