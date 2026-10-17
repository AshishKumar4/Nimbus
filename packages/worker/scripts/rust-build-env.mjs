/**
 * rust-build-env.mjs — the environment a pinned Rust build runs Cargo in,
 * for every recipe that builds Rust to wasm (napi-wasm/build.mjs,
 * oxc-wasm/build.mjs).
 *
 * Cargo and rustc read settings from the environment that Cargo.toml and a
 * recipe's own flags pin (RUSTC, RUSTDOC, CARGO_PROFILE_RELEASE_*,
 * CARGO_BUILD_*, RUSTFLAGS, RUSTC_WRAPPER, …): every rustc and cargo a recipe
 * runs, its toolchain checks and lockfile pruning included, sees none of
 * them but where its caches live, then exactly what the recipe sets.
 */

const KEPT = new Set(['CARGO_HOME', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN']);
const OVERRIDES = /^(CARGO|RUST|RUSTC|RUSTDOC)(_|$)|^RUSTFLAGS$|^RUSTDOCFLAGS$/;

/**
 * `ambient` (the process's environment) without any Cargo or rustc setting
 * but the cache locations, then `pinned`, what the recipe sets (the pinned
 * toolchain's PATH, say).
 *
 * @param {NodeJS.ProcessEnv} ambient
 * @param {Record<string, string | undefined>} pinned
 * @returns {NodeJS.ProcessEnv}
 */
export function rustBuildEnv(ambient, pinned) {
  return { ...Object.fromEntries(Object.entries(ambient).filter(([name]) => KEPT.has(name) || !OVERRIDES.test(name))), ...pinned };
}
