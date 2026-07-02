#!/usr/bin/env bash
#
# sync-to-hookshot.sh — keep the two copies of the pkgxray-guard hook aligned (#3).
#
# Source of truth : pkgxray   examples/hookshot/        (dev + tests happen here)
# Mirror          : hookshot  examples/pkgxray-guard/   (upstream destination)
#
# Everything is kept byte-identical EXCEPT two files that legitimately differ
# per repo and are never synced:
#   - go.mod / go.sum : pkgxray ships a standalone module (with a `replace`
#                       hack); the hookshot copy is part of the hookshot root
#                       module and has no go.mod.
#   - README.md       : each carries its own go.mod / CI notes. The script only
#                       *reports* README drift so you reconcile shared edits
#                       (e.g. a new "Requirements" section) by hand.
#
# Usage:
#   ./sync-to-hookshot.sh            # --check: report drift, exit 1 if any
#   ./sync-to-hookshot.sh --check
#   ./sync-to-hookshot.sh --apply    # copy *.go + configs/ into the hookshot copy
#
# Override the locations (or flip the direction) with env vars:
#   PKGXRAY_HOOK_DIR   HOOKSHOT_GUARD_DIR

set -euo pipefail

SRC="${PKGXRAY_HOOK_DIR:-$HOME/pkgxray/supply-chain-auditor/examples/hookshot}"
DST="${HOOKSHOT_GUARD_DIR:-$HOME/Documents/GitHub/hookshot/examples/pkgxray-guard}"
MODE="${1:---check}"

for d in "$SRC" "$DST"; do
  [ -d "$d" ] || { echo "error: directory not found: $d" >&2; exit 2; }
done

# The files that must stay identical: all Go sources + everything under configs/.
# (go.mod, go.sum and README.md are excluded by construction.)
list_synced() { ( cd "$1" && find . -type f \( -name '*.go' -o -path './configs/*' \) | sed 's|^\./||' | sort ); }

drift=0

# Forward: every source file present and identical in the mirror.
while IFS= read -r f; do
  if [ ! -f "$DST/$f" ]; then echo "MISSING in mirror : $f"; drift=1
  elif ! diff -q "$SRC/$f" "$DST/$f" >/dev/null; then echo "DRIFT            : $f"; drift=1
  fi
done < <(list_synced "$SRC")

# Reverse: a synced file in the mirror that no longer exists in the source
# (catches deletions the forward pass can't see).
while IFS= read -r f; do
  [ -f "$SRC/$f" ] || { echo "EXTRA in mirror  : $f (deleted from source?)"; drift=1; }
done < <(list_synced "$DST")

# README is expected to differ — report only.
if ! diff -q "$SRC/README.md" "$DST/README.md" >/dev/null 2>&1; then
  echo "note: README.md differs (expected go.mod/CI notes) — reconcile shared sections by hand."
fi

if [ "$MODE" = "--check" ]; then
  [ "$drift" -eq 0 ] && echo "OK: code + configs in sync." || echo "drift found — run: $0 --apply"
  exit "$drift"
fi

if [ "$MODE" != "--apply" ]; then
  echo "usage: $0 [--check|--apply]" >&2; exit 2
fi

# --apply: copy source → mirror.
n=0
while IFS= read -r f; do
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
  n=$((n + 1))
done < <(list_synced "$SRC")
echo "synced $n file(s) → $DST"

# Validate the mirror in-tree if the toolchain is available.
if command -v go >/dev/null 2>&1 && root=$(git -C "$DST" rev-parse --show-toplevel 2>/dev/null); then
  echo "validating mirror build/test…"
  ( cd "$root" && go build ./examples/pkgxray-guard/... && go test ./examples/pkgxray-guard/... )
fi
echo "done. Review 'git -C $DST diff', reconcile README.md if a shared section changed, then commit."
