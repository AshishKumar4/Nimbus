#!/usr/bin/env bash
# Linker for the threadless napi-rs bindings (build.mjs): rust-lld with ONE
# argument rewritten, and a refusal if that argument is not exactly what it
# expects.
#
# Why: napi-build's build script emits `-zstack-size=64000000` (a 64 MB wasm
# shadow stack, sized for tokio worker threads on shared memory). A cargo
# build-script link arg is placed after every RUSTFLAGS / `cargo rustc --`
# argument, so it cannot be overridden from the command line, and the stack
# is the first region of linear memory: 64 MB of it would be most of a
# 128 MB Worker isolate before the binding allocated anything. NIMBUS_WASM_STACK
# replaces that one value; nothing else about the link changes.
#
# Seam: fail loud unless the upstream value appears exactly once. A napi-build
# release that changes it stops this build instead of linking silently.
set -euo pipefail
: "${NIMBUS_RUST_LLD:?NIMBUS_RUST_LLD must name the toolchain rust-lld}"
: "${NIMBUS_WASM_STACK:?NIMBUS_WASM_STACK must give the stack size in bytes}"
: "${NIMBUS_WASM_CRATE:?NIMBUS_WASM_CRATE must name the cdylib crate the build produces}"
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
# Other cdylibs cargo links on the way (a wrapped binding's own cdylib target,
# rolldown's oxc_*_napi) come through here too; only the module being built
# must carry napi-build's stack line.
if [[ "$hits" -eq 0 ]] && printf '%s\n' "$@" | grep -q -- "$NIMBUS_WASM_CRATE"; then
  printf 'link-wasm.sh: %s not found in the %s link line (napi-build changed it)\n' "$expected" "$NIMBUS_WASM_CRATE" >&2
  exit 1
fi
exec "$NIMBUS_RUST_LLD" "${args[@]}"
