# Spike: @img/sharp-wasm32 — verdict

**Question (per plan §3.4):** is sharp-wasm32 viable in workerd?

## Findings

1. **Hard install-time block.** `npm install @img/sharp-wasm32@0.34.5` fails on
   any non-wasm32 host with:
   ```
   npm error code EBADPLATFORM
   npm error notsup Unsupported platform for @img/sharp-wasm32@0.34.5:
   wanted {"cpu":"wasm32"} (current: {"cpu":"x64"})
   ```
   Verified locally with npm 10. Bun installs it via lockfile-coercion but
   the package directory is empty (no files extracted). This is per the
   packument:
   ```
   curl -s https://registry.npmjs.org/@img/sharp-wasm32/0.34.5
   { "cpu": ["wasm32"], "os": undefined, ... }
   ```

2. **Even if installed, two known runtime blockers:**
   - **No pthread support in workerd.** `audit/sections/07-workerd-hard-limits.md`
     documents libvips `initThreads()` failing under workerd's no-pthread runtime.
     sharp-wasm32 ultimately wraps libvips and triggers the same init path.
   - **Native loader path.** sharp-wasm32 exports `./sharp.node` via a JS shim
     `./lib/sharp-wasm32.node.js` which loads a `.node` binary — workerd does
     not load `.node` files.

3. **There IS a viable alternative: `wasm-vips`.**
   - `audit/probes/wasm/wasm-vips.out.txt` shows `ok:true` for install.
   - W6 retro §2 caveat: "partial export shape (`default` only) but installs and loads."
   - For typical sharp use-cases (resize, format-convert, compose), wasm-vips covers
     90% via `vips.Image.newFromBuffer(...).resize(...)`.

## Surface-area gate verdict

**REJECT** — and add a new entry to REJECT_INSTALL.

`@img/sharp-wasm32` is the canonical WASM-fallback name sharp itself recommends
when native install fails (per `audit/probes/packages-prod-w26a/sharp.out.txt:67-74`),
but it ALSO doesn't work in our runtime. Adding it as a REJECT entry pre-empts the
"npm install @img/sharp-wasm32" footgun a user hits after their `sharp` install
fails.

### Proposed registry entry

```ts
{
  from: '@img/sharp-wasm32',
  reason:
    'WASM build of sharp; package is wasm32-cpu-only (npm refuses install on x64) ' +
    'and libvips initThreads() fails under workerd (no pthread support).',
  suggest:
    'wasm-vips (default-export only — see audit/probes/wasm/wasm-vips.out.txt). ' +
    'For complex pipelines: render server-side and ship pixels.',
  transitive: 'fail',
}
```

## Track 2 promotion: N/A (this is Track 1 — registry-only).

Promote to Phase C.5 commit.
