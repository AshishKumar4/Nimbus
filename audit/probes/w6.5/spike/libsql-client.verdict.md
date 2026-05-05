# Spike: @libsql/client — verdict

**Question (per plan §3.3):** does `@libsql/client` work post-W2/W5? If not,
where is the gap?

## Findings

1. **Local install confirms transitive tree extracts correctly.** `bun add
   @libsql/client` produces:
   ```
   node_modules/@libsql/
     client/
     core/         ← present, with subpath exports for /api, /config, /uri, /util
     hrana-client/
     isomorphic-ws/
     linux-x64-musl/  (skip — native; transitive 'warn' bucket would handle)
     linux-x64-gnu/   (same)
   ```

2. **`@libsql/core/package.json` exports** declares subpaths (verified):
   `./api`, `./config`, `./uri`, `./util` — all CJS via `require: "./lib-cjs/<name>.js"`.

3. **`@libsql/client/lib-cjs/http.js` requires:**
   ```
   require("@libsql/core/api")
   require("@libsql/core/config")
   require("@libsql/core/uri")
   require("@libsql/core/util")
   ```
   These are bare-specifier subpath requires. The resolver must:
   - find `@libsql/core` via `node_modules/`
   - parse `@libsql/core/package.json#exports` for `./config`
   - return `./lib-cjs/config.js`

4. **The runtime resolver `src/node-shims.ts` uses
   `src/_shared/exports-resolver.ts` (`getExportsResolverJS()`) since commit
   `1763854` ("route runtime CJS through shared exports/imports resolver",
   `2026-04-29`).** That commit landed the same day as the probe artifact
   (`audit/probes/wasm/libsql-client.out.txt:2` timestamp `2026-04-29T18:41:02.788Z`).

5. **Cannot definitively re-probe without prod auth.** Local-only probing
   won't tell us if the runtime fails today, because the runtime is the
   workerd-side `node-shims.ts` evaluator that needs a live session.

## Best inference

The probe artifact may be stale relative to `1763854` (timestamps suggest
the probe ran AFTER the fix landed but before it had been widely tested with
this exact package). The gap may be closed today; can't confirm without live
re-probe.

## Surface-area gate verdict

**4-WAY DECISION (per plan §3.3 + review SF-2):**

- (a) "Now works in resolver" — POSSIBLE but unverified. Default-assume probe
  is stale; document as "needs prod re-probe before any registry change".
- (b) "Still broken, ≤1-file fix in registry layer" — N/A; the fix is in the
  runtime exports resolver path, which already exists.
- (c) "Still broken, root cause is in W2-resolver territory" — possible but
  unverified.
- (d) "Can't tell" — **this is the honest answer**.

**Action:** zero registry change. Document in retro that:
- @libsql/client was never in REJECT_INSTALL (W6 retro §2 explicitly noted "Not pre-emptively rejecting").
- W6.5 spike could not re-probe live. The probe artifact dated `2026-04-29` may be stale.
- Recommend prod re-probe as part of the next wave with active wrangler auth
  (W6.6 or whichever follow-up has prod-deploy capacity).

## Track 2 promotion: NO (no commit, document in retro per branch (d)).
