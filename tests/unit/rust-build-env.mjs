#!/usr/bin/env bun
// The environment the Rust recipes run cargo and rustc in (packages/worker/
// scripts/rust-build-env.mjs): no ambient setting Cargo or rustc reads, but
// where the caches live; then what the recipe sets.

import assert from 'node:assert/strict';
import { rustBuildEnv } from '../../packages/worker/scripts/rust-build-env.mjs';

const ambient = {
  PATH: '/usr/bin',
  HOME: '/home/ci',
  CARGO_HOME: '/home/ci/.cargo',
  RUSTUP_HOME: '/home/ci/.rustup',
  RUSTUP_TOOLCHAIN: 'nightly',
  RUSTC: '/opt/other/rustc',
  RUSTDOC: '/opt/other/rustdoc',
  RUSTFLAGS: '-C opt-level=0',
  RUSTDOCFLAGS: '--cfg x',
  RUSTC_WRAPPER: 'sccache',
  CARGO_PROFILE_RELEASE_OPT_LEVEL: '0',
  CARGO_BUILD_TARGET: 'x86_64-unknown-linux-gnu',
  CARGO_ENCODED_RUSTFLAGS: '-Cdebuginfo=2',
  CARGO_TARGET_DIR: '/tmp/elsewhere',
  CARGO: '/opt/other/cargo',
  RUST_LOG: 'debug',
};

assert.deepEqual(rustBuildEnv(ambient, { PATH: '/toolchain/bin:/usr/bin', RUSTUP_TOOLCHAIN: '1.89.0' }), {
  PATH: '/toolchain/bin:/usr/bin',
  HOME: '/home/ci',
  CARGO_HOME: '/home/ci/.cargo',
  RUSTUP_HOME: '/home/ci/.rustup',
  RUSTUP_TOOLCHAIN: '1.89.0',
}, 'only the cache locations survive, and the recipe sets the rest');

console.log('rust-build-env: ambient Cargo and rustc settings never reach a recipe');
