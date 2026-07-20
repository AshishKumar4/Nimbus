#!/usr/bin/env bash
# Build the exec-target coreutils (plain wasm32-wasi, no fork/overlay) — the
# M2 exec-into-runner targets bash execve's into. Maintained by Claude, as-is.
set -euo pipefail; cd "$(dirname "$0")"
: "${WASI_SDK:?set WASI_SDK}"
for t in echo tr cat head sort; do
  "$WASI_SDK/bin/wasm32-wasi-clang" -O2 "$t.c" -o "$t.wasm"
  echo "built $t.wasm ($(wc -c <"$t.wasm") bytes)"
done
