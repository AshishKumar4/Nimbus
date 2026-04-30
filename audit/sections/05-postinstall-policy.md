# Section 05 — Postinstall Policy

> Verified at HEAD `e93b18d` via direct source read.

## Current state: invisible, not "skipped"

```bash
$ grep -rn "postinstall\|preinstall\|scripts" src/npm-installer.ts src/npm-resolver.ts \
    src/npm-tarball.ts src/npm-tarball-stream.ts \
    src/npm-install-batch-facet.ts src/npm-install-facet.ts 2>&1 | grep -v "scripts/\|test"
(zero matches)
```

The `ResolvedPackage` interface at `src/npm-resolver.ts:58-68` does NOT have
a `scripts` field. The registry packument is read but `scripts` is never
captured. The install pipeline (`npm-installer.ts`, `npm-install-facet.ts`,
`npm-install-batch-facet.ts`, `npm-tarball.ts`, `npm-tarball-stream.ts`)
ends at `linkBins` — there is no "phase 8: run lifecycle scripts".

This means: any package whose runtime requires postinstall to have run
silently breaks at first import. The Section 02 `bcrypt` probe shows
exactly this:

```
Error: Cannot find module './node-gyp-build.js' (from home/user/app/node_modules/node-gyp-build)
```

`bcrypt`'s `prebuild-install` postinstall was supposed to fetch the
prebuilt napi binary AND write the `node-gyp-build.js` shim. Neither
happened. The package's tarball doesn't contain `node-gyp-build.js`
because it's normally generated at install time.

## Lifecycle hooks the registry can ship

| Hook | Order | Frequency in top-1k | Use cases | Nimbus impact |
|---|---|---|---|---|
| `preinstall` | 1 | ~0.5% | env checks | Unimportant |
| `install` | 2 | rare; mostly node-gyp default | Native build | **Cannot run** — no compiler |
| `postinstall` | 3 | ~5-10% | Native binary download/dispatch, codegen | **Largest gap** |
| `prepare` | 4 (publish + git install) | common | Build before pack | Mostly dead noise from registry tarballs |

## Postinstall taxonomy (categorical)

| Category | Examples | What it does | Nimbus answer |
|---|---|---|---|
| **A. Platform-binary dispatcher** | `esbuild`, `workerd`, `@biomejs/biome`, `swc`, `turbo`, `prisma` | OS-detect + copy native binary from optional dep | EMULATE if Nimbus has shim (esbuild); else DROP-WITH-WARNING |
| **B. Network downloader** | `puppeteer`, `playwright`, `cypress`, older `@prisma/engines` | https.get → write `<pkg>/.cache/<exe>` | REJECT-INSTALL — binary unusable |
| **C. node-gyp / node-pre-gyp build** | `bcrypt`, `sqlite3`, `better-sqlite3`, `bufferutil`, `utf-8-validate`, `@parcel/watcher`, `fsevents` | spawn python/node-gyp/cc | REJECT-INSTALL — no compiler, dlopen blocked |
| **D. Optional native fallback / detector** | `sharp` (`install/check.js`), `cpu-features` | env check, exit 0/1 | Harmless to skip; SHIM with `exit(0)` |
| **E. JS-only state initializer** | `husky`, `simple-git-hooks`, `cypress` (some) | Write `.git/hooks/*` | DROP-AND-RECORD silently |
| **F. License/motd printer** | `core-js`, `nodemon`, `colors` | `console.log("Thanks for using …")` | Capture first 3 lines of stdout via static-extract; otherwise drop |
| **G. Telemetry phone-home** | (variable) | `fetch('https://collector...')` | REFUSE — supply-chain attack vector |
| **H. Project-level codegen** | `@prisma/client`, `@graphql-codegen/*`, `zenstack` | Read schema, write generated code | Out of dependency-postinstall scope; route via user's own scripts |
| **I. Mystery / arbitrary** | snowflakes (~1-2%) | unknown | DROP-AND-RECORD; surface via `nimbus npm doctor` |

## Recommended policy (W3-deliverable)

```typescript
// src/npm-postinstall-policy.ts (NEW)
//
// Adds `scripts` field capture (5-line schema migration) +
// 3 allowlist tables + an end-of-install summary.

const EMULATED_BY_NIMBUS: Set<string> = new Set([
  // postinstall is a no-op for us because we shim the package elsewhere
  'esbuild',           // Nimbus ships esbuild-wasm internally
  'workerd',           // not user-relevant
  '@cloudflare/vite-plugin',
]);

const KNOWN_REJECTED: Record<string, string> = {
  'sharp':           'Use @resvg/resvg-wasm (SVG only) or refuse install. ' +
                     'Full sharp pipeline impossible.',
  'better-sqlite3':  'No async-compatible drop-in. Use @libsql/client or ' +
                     'Nimbus SqliteVFS.',
  'sqlite3':         'Same as better-sqlite3.',
  'bcrypt':          'Use bcryptjs (pure JS, drop-in API).',
  'puppeteer':       'Browser binary cannot run in workerd. Use Cloudflare ' +
                     'Browser Rendering.',
  'playwright':      'Same as puppeteer.',
  'electron':        'Embedded Chromium runtime — not applicable to Workers.',
  'node-pty':        'No PTY in workerd. Use Nimbus built-in shell.',
  'robotjs':         'Desktop automation impossible in a sandboxed Worker.',
  'fsevents':        'macOS-only file watcher; no equivalent in workerd.',
};

const ALLOW_ON_REQUEST: Set<string> = new Set([
  // Per-project opt-in via package.json#nimbus.allowBuilds
  // Default-deny; user must explicitly authorize.
]);
```

### Per-project opt-in

```jsonc
// package.json
{
  "nimbus": {
    "allowBuilds": ["husky", "simple-git-hooks"],
    "rejectBuilds": ["puppeteer"]
  }
}
```

Mirrors pnpm's `onlyBuiltDependencies`/`neverBuiltDependencies`. Default-
deny; opt-in is per-project.

### `nimbus npm doctor` summary

After install, emit:
```
Done! 36 packages, 1284 files in 12.3s

Nimbus advisories:
  ❌ 1 package rejected: bcrypt → suggest bcryptjs
  ⚠️ 2 packages have unbuilt postinstall: husky, core-js
     Run `nimbus npm doctor` for details.
```

## Sandbox runner — workerd feasibility

Could a `husky install`-style postinstall run in a capability-restricted
isolate? The pattern matches `NimbusFacetPool` exactly:

| Capability | Workerd | Verdict |
|---|---|---|
| Run arbitrary JS | ✅ already done by NimbusFacetPool | yes |
| Per-isolate memory cap (~128 MiB) | ✅ standard | yes |
| Per-call timeout | ✅ NimbusFacetPoolOptions.timeoutMs | yes |
| Disable fetch | ✅ globalOutbound to 451-service | yes |
| Disable child_process | ✅ trivially throws today | yes |
| Disable .node dlopen | ✅ trivially | yes |
| Restrict fs to `<pkgDir>` | ✅ implementable via PKG_FS RPC binding | yes |
| Catch process.exit(n) | ✅ override in preamble | yes |

**Conclusion:** the runner is feasible but unlocks little — the realistic
postinstall mix is dominated by category B/C (binary downloaders / native
builds) which the sandbox can't help with anyway. Worth a W6 / opt-in
slot, not W3.

## Citations

- `ResolvedPackage` interface: `src/npm-resolver.ts:58-68` (no `scripts`)
- Install pipeline phases: `src/npm-installer.ts:240-359` (ends at `linkBins`)
- `bcrypt` failure evidence: [audit/probes/packages/bcrypt.out.txt](../probes/packages/bcrypt.out.txt) (`Cannot find module './node-gyp-build.js'`)
- npm lifecycle docs: https://docs.npmjs.com/cli/v10/using-npm/scripts
- pnpm `onlyBuiltDependencies`: https://pnpm.io/package_json#pnpmonlybuiltdependencies
