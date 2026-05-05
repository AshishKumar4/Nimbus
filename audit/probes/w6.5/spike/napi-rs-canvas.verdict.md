# Spike: @napi-rs/canvas-wasm32-wasi — verdict

**Question (per plan §3.5):** is `@napi-rs/canvas-wasm32-wasi` viable as a WASM swap target for `canvas`?

## Findings

1. **THE PACKAGE DOES NOT EXIST ON NPM.**
   ```
   curl -sI https://registry.npmjs.org/@napi-rs%2Fcanvas-wasm32-wasi
   HTTP/2 404
   ```
   Confirmed by `bun add @napi-rs/canvas-wasm32-wasi`:
   ```
   error: GET https://registry.npmjs.org/@napi-rs%2fcanvas-wasm32-wasi - 404
   ```

2. **`@napi-rs/canvas` (the parent) has only platform-native binaries.**
   ```
   curl -s "https://registry.npmjs.org/-/v1/search?text=napi-rs+canvas"
     @napi-rs/canvas             - 1.0.0
     @napi-rs/canvas-linux-x64-gnu
     @napi-rs/canvas-linux-x64-musl
     @napi-rs/canvas-darwin-arm64
     @napi-rs/canvas-darwin-x64
     @napi-rs/canvas-android-arm64
     @napi-rs/canvas-linux-arm64-gnu
     @napi-rs/canvas-win32-x64-msvc
     @napi-rs/canvas-linux-arm64-musl
     @napi-rs/canvas-linux-arm-gnueabihf
   ```
   No `wasm32-wasi` variant. Other napi-rs projects DO publish `*-wasm32-wasi`
   binaries (e.g. `@unrs/resolver-binding-wasm32-wasi`, `@tailwindcss/oxide-wasm32-wasi`,
   `@rolldown/binding-wasm32-wasi`), but canvas does not.

3. **The W6.5 task spec listed a non-existent package.**

## Implication

W6.5 cannot add `@napi-rs/canvas-wasm32-wasi` as a swap because the registry
target doesn't exist. We can EITHER:
- (a) add a REJECT entry for it so a user who tries `npm install
  @napi-rs/canvas-wasm32-wasi` gets a useful error pointing to the real
  alternative, OR
- (b) treat this as a clarification needed in the spec — but per
  anti-requirement "DO NOT pause for user input", we proceed with (a).

We ALSO have (per W6 retro §2) `canvas` already in REJECT_INSTALL with
`suggest: 'no Workers-compatible swap; render server-side and ship pixels.'`
— update that suggest to mention the canonical alternatives:
- `canvaskit-wasm` (Skia compiled to WASM; canvas-API-compatible; ~7MB, untested by Nimbus)
- `@resvg/resvg-wasm` (SVG rasterizer; verified in `audit/probes/wasm/resvg-wasm.out.txt`)

## Proposed registry entries

```ts
// New entry — preempts the futile npm install
{
  from: '@napi-rs/canvas-wasm32-wasi',
  reason:
    '@napi-rs/canvas does not publish a wasm32-wasi variant on npm (404). The ' +
    '@napi-rs/canvas project ships only native bindings (linux-x64, darwin-arm64, ' +
    'android-arm64, etc.). No WASM/WASI build exists.',
  suggest:
    'canvaskit-wasm (Skia → WASM, canvas-API-compatible, ~7MB; untested by Nimbus) ' +
    'or @resvg/resvg-wasm (verified — see audit/probes/wasm/resvg-wasm.out.txt) for SVG.',
  transitive: 'fail',
}

// Also: @napi-rs/canvas itself (the parent, native-only)
{
  from: '@napi-rs/canvas',
  reason:
    'Native bindings only (linux-x64-gnu/musl, darwin-arm64/x64, android-arm64, ' +
    'linux-arm64-gnu/musl, win32-x64-msvc, linux-arm-gnueabihf). No WASM build.',
  suggest:
    'canvaskit-wasm (Skia → WASM, canvas-API-compatible; untested by Nimbus) ' +
    'or @resvg/resvg-wasm for SVG (verified).',
  transitive: 'fail',
}
```

## Surface-area gate verdict

**REJECT** + bonus `@napi-rs/canvas` entry. Track 1 — registry-only. Promote
to Phase C.5 commit alongside sharp-wasm32.

## Spec-compliance note for retro

The W6.5 spec asked for `@napi-rs/canvas-wasm32-wasi` as a SWAP candidate.
Honest delivery: the package doesn't exist; cannot swap. Recording in retro:
"Spec listed a non-published package. Closest path: REJECT-with-pointer-to-
canvaskit-wasm, which is the canonical recommendation."
