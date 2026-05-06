# Probe: @tailwindcss/oxide — `Cannot find native binding. npm has a bug related to optional dependencies (#4828)`

> Static-analysis probe. The error message is **emitted by oxide
> itself** at `package/index.js:559-562`, not by our resolver. We're
> seeing it because oxide's WASM fallback is unreachable in our
> facet — and section 04 (`audit/sections/04-native-mitigation.md`)
> already pinned the deeper blocker: `node:wasi`.

## 1. Re-cited runtime evidence

`/workspace/worktrees/verify-90993b3/audit/probes/verify-90993b3/packages-local/tailwindcss-oxide.out.txt:56-62`

```
Error: Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). Please try `npm i` again after removing both package-lock.json and node_modules directory.
    at eval (eval at <anonymous> (runner.js:34:34), <anonymous>:561:11)
```

`<anonymous>:561:11` is line 561 of the precompiled wrapper for
oxide's `index.js`. The verbatim throw site is in oxide v4.2.4 at
`/tmp/ts-probe/ox5/package/index.js:557-569`:

```
557: if (!nativeBinding) {
558:   if (loadErrors.length > 0) {
559:     throw new Error(
560:       `Cannot find native binding. ` +
561:         `npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). ` +
562:         'Please try `npm i` again after removing both package-lock.json and node_modules directory.',
...
```

So the ERROR comes from oxide's runtime fallback after both:
- platform-specific `.node` requires fail
- the wasm32-wasi require fails

## 2. Why the wasm32-wasi fallback fails

oxide's index.js at lines 540-548 tries:
```
541:       wasiBinding = require('@tailwindcss/oxide-wasm32-wasi')
```

That subpkg has `cpu: ["wasm32"]` in its package.json — see
`/tmp/ts-probe/oxw/package/package.json:4-7`:

```
"name": "@tailwindcss/oxide-wasm32-wasi",
"cpu": [ "wasm32" ],
```

Our resolver classifies this as a "native shard" via two paths in
`src/wasm-swap-registry.ts`:

- Line 640: `if (Array.isArray(p.cpu) && p.cpu.length > 0) return true;`
  → matches `cpu: ["wasm32"]`.
- Line 611: `'@tailwindcss/oxide-'` is in `NATIVE_SHARD_PREFIXES`,
  matched at lines 644-651.

So `isOptionalNativeBinding(@tailwindcss/oxide-wasm32-wasi)` returns
**true** → the package is silent-skipped at install time
(probe log lines 27-38 confirm). When oxide's runtime tries
`require('@tailwindcss/oxide-wasm32-wasi')` it gets "Cannot find
module" and falls through to the verbatim error at line 559-562.

## 3. The deeper blocker — `node:wasi`

If we DID install oxide-wasm32-wasi, it would still fail. From
`audit/sections/04-native-mitigation.md:41,47-56`:

> `@tailwindcss/oxide-wasm32-wasi` requires `node:wasi`. Even though
> the package's own loader uses `@emnapi/wasi-threads` (a userland
> WASI shim), it DOES `require('node:wasi')` somewhere in its chain.
>
> The runtime resolver returns `Cannot find module 'node:wasi'`
> because:
> - The shim's builtins table at `src/node-shims.ts:771-849` doesn't
>   include `wasi`
> - Even if it did, workerd's `node:wasi` constructor throws
>   `ERR_METHOD_NOT_IMPLEMENTED('WASI')` — verified at
>   https://raw.githubusercontent.com/cloudflare/workerd/main/src/node/wasi.ts

This is upstream-blocked. Neither shimming `node:wasi` nor adding a
swap entry can resolve it without workerd shipping a real WASI
implementation.

## 4. Confirmation: section 04's recommendation

`audit/sections/04-native-mitigation.md:145`:

```
'@tailwindcss/oxide-wasm32-wasi': 'workerd node:wasi is a stub. Wait for upstream fix.',
```

The recommendation was to add the WASM shard to REJECT_INSTALL with
a clear message. **That hasn't been wired into
`src/wasm-swap-registry.ts:REJECT_INSTALL`.** Status check:

```
$ grep -n "tailwindcss/oxide" src/wasm-swap-registry.ts
611:  '@tailwindcss/oxide-',
```

Only the prefix-skip — no REJECT entry for `@tailwindcss/oxide` (the
parent package) and no REJECT entry for the WASM shard.

## 5. Fix sketch (per §C)

There are TWO honest options:

### Option (R) — REJECT the parent (recommended)

Add `@tailwindcss/oxide` to REJECT_INSTALL with `transitive: 'fail'`
in `src/wasm-swap-registry.ts:108`-ish:

```ts
{
  from: '@tailwindcss/oxide',
  reason: 'NAPI Rust binding. WASM-WASI fallback (@tailwindcss/oxide-wasm32-wasi) requires node:wasi, which workerd implements as a throwing stub (audit/sections/04-native-mitigation.md §F1).',
  suggest: 'No drop-in. Use Tailwind CSS v3 (which is pure-JS and works in Workers) or run Tailwind v4 in a build-time step outside the Worker and ship the resulting CSS.',
  transitive: 'warn',
},
```

`transitive: 'warn'` (not 'fail') because `@tailwindcss/vite` /
`@tailwindcss/postcss` legitimately transitively-depend on oxide;
auto-failing those installs would over-block. With `'warn'` the
parent install proceeds, oxide's runtime throw is the same as today,
but the user sees a clearer reject message at install time.

LOC estimate: ~6 lines (one entry).

### Option (S) — Carve out wasm32-wasi from the native-shard skip

Modify `src/wasm-swap-registry.ts:isOptionalNativeBinding` to NOT
classify `cpu: ["wasm32"]` shards as native skips when the parent
prefix is one with a known-good wasm32-wasi target (oxide isn't one
because of node:wasi — but the carve-out plumbing is needed for
future packages where the wasm32-wasi shard IS workerd-loadable).

NOT recommended for oxide specifically. **Sequence:** ship (R) for
oxide; defer (S) until we identify a wasm32-wasi shard that
DOESN'T transitively touch node:wasi (none in the current verify
cohort).

## 6. Predicted ✅ flip

**0** ✅ flips — this is an honest REJECT, not a fix.

The status changes from ⚠ ("install ok, runtime fail") to ⛔
("loud-reject at install with clear message"). That's a Bucket-W6
healthy state, not a Bucket Z5 unfixed state. The verify cohort
counts ⛔ as healthy (per VERIFY-90993B3.md §"Healthy total
(✅+⛔)").

## 7. Risk

- (R)'s `transitive: 'warn'` means `npm install @tailwindcss/vite`
  still installs oxide. The runtime error message is unchanged from
  today (the throw is in oxide's index.js, not our resolver). The
  install-time delta is just a warning line.
- If we pick `transitive: 'fail'`, then any package that depends
  on oxide (vite, postcss) would refuse to install. That's
  over-blocking — `@tailwindcss/vite` works fine for users who
  pre-build their CSS outside the Worker.

## 8. Dependencies

- Independent of the other 3 Z5 packages.
- Independent of W2.6b.
- Independent of X.5-NPQO.
- **Independent of `@tailwindcss/vite` (Z5 #3)** — the vite plugin's
  failure is a separate ESM-detection bug (see tailwindcss-vite.probe.md);
  fixing that doesn't fix oxide because oxide is invoked at runtime
  by the user's tailwind config and hits the node:wasi wall.
