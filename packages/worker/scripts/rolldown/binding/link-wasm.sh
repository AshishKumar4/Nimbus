#!/usr/bin/env bash
# Linker for the threadless rolldown binding: rust-lld with ONE argument
# rewritten, and a refusal if that argument is not exactly what it expects.
#
# Why: napi-build's build script emits `-zstack-size=64000000` (a 64 MB wasm
# shadow stack, sized for tokio worker threads on shared memory). A cargo
# build-script link arg is placed after every RUSTFLAGS / `cargo rustc --`
# argument, so it cannot be overridden from the command line, and the stack
# is the first region of linear memory: 64 MB of it would be most of a
# 128 MB Worker isolate before rolldown allocated anything. NIMBUS_WASM_STACK
# replaces that one value; nothing else about the link changes.
#
# Seam: fail loud unless the upstream value appears exactly once. A napi-build
# release that changes it stops this build instead of linking silently.
set -euo pipefail
: "${NIMBUS_RUST_LLD:?NIMBUS_RUST_LLD must name the toolchain rust-lld}"
: "${NIMBUS_WASM_STACK:?NIMBUS_WASM_STACK must give the stack size in bytes}"
expected='-zstack-size=64000000'
args=()
hits=0
for arg in "$@"; do
  if [[ "$arg" == "$expected" ]]; then
    args+=("-zstack-size=${NIMBUS_WASM_STACK}")
    hits=$((hits + 1))
  else
    args+=("$arg")
  fi
done
if [[ "$hits" -gt 1 ]]; then
  printf 'link-wasm.sh: %s appeared %d times; expected once (napi-build changed its link line)\n' "$expected" "$hits" >&2
  exit 1
fi
# The dependency cdylibs cargo also links (rolldown_binding, oxc_*_napi) come
# through here too; only the final module carries napi-build's stack line.
if [[ "$hits" -eq 0 ]] && printf '%s\n' "$@" | grep -q 'nimbus_rolldown_binding'; then
  printf 'link-wasm.sh: %s not found in the nimbus_rolldown_binding link line (napi-build changed it)\n' "$expected" >&2
  exit 1
fi
exec "$NIMBUS_RUST_LLD" "${args[@]}"
