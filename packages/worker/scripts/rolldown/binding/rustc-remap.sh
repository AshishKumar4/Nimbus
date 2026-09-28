#!/usr/bin/env bash
# RUSTC_WRAPPER for the reproducible binding build: appends the two
# --remap-path-prefix flags that take machine paths (the work directory and
# CARGO_HOME) out of panic messages and debug strings.
#
# Why a wrapper and not RUSTFLAGS: cargo hashes RUSTFLAGS into every crate's
# -C metadata, so a flag that names the work directory would change symbol
# hashes, and with them the fat-LTO output, whenever the build ran somewhere
# else. Flags added here are invisible to that hash: two builds in different
# directories produce the same bytes.
set -euo pipefail
: "${NIMBUS_REMAP_WORK:?NIMBUS_REMAP_WORK must name the build work directory}"
: "${NIMBUS_REMAP_CARGO_HOME:?NIMBUS_REMAP_CARGO_HOME must name CARGO_HOME}"
rustc="$1"
shift
exec "$rustc" "$@" \
  "--remap-path-prefix=${NIMBUS_REMAP_WORK}=/build" \
  "--remap-path-prefix=${NIMBUS_REMAP_CARGO_HOME}=/cargo"
