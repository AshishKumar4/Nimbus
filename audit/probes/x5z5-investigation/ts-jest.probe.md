# Probe: ts-jest — `Cannot read properties of undefined (reading 'native')`

> Static-analysis probe. The pre-existing claim in X5F-retro / X5G-retro
> ("W2.6b cap evicts typescript.js — out of charter") is **partially
> wrong**. The runtime stack proves typescript.js *is* loading. The
> failure is a missing fs-shim method, not a cap eviction.

## 1. Re-cited runtime evidence

`/workspace/worktrees/verify-90993b3/audit/probes/verify-90993b3/packages-local/ts-jest.out.txt:64-72`

```
TypeError: Cannot read properties of undefined (reading 'native')
    at getNodeSystem (eval at <anonymous> (runner.js:34:34), <anonymous>:8291:43)
    at eval (eval at <anonymous> (runner.js:34:34), <anonymous>:8675:12)
    at eval (eval at <anonymous> (runner.js:34:34), <anonymous>:8681:3)
    at eval (eval at <anonymous> (runner.js:34:34), <anonymous>:201040:3)
    at __loadModule (runner.js:2652:7)
```

The `<anonymous>:8291` site is INSIDE typescript.js (one of the
modules being loaded). If typescript.js were evicted by the W2.6b
cap, the failure would surface earlier as
`Cannot read module: .../typescript.js` from
`src/node-shims.ts:2129`. We never reach `getNodeSystem`.

So **typescript.js is in the bundle**. The cap-eviction hypothesis
in X5F-retro line 147 / X5G-retro line 210 was speculative — the
verbatim stack disproves it.

## 2. Verbatim defect site in TypeScript source

Downloaded typescript-5.6.3.tgz @ `/tmp/ts-probe/package/lib/typescript.js:8230-8247`:

```
8230:   function getNodeSystem() {
...
8232:     const _fs = require("fs");
...
8247:     const fsRealpath = !!_fs.realpathSync.native ? process.platform === "win32" ? fsRealPathHandlingLongPath : _fs.realpathSync.native : _fs.realpathSync;
```

Line 8247 is the `!!_fs.realpathSync.native` access. The `!!`
double-negation evaluates the `.native` property — and that's where
the throw happens **if `_fs.realpathSync` itself is undefined**
(reading `.native` of undefined → exact runtime error message).

Verified the same site exists in TS 6.0.3 (latest):
`/tmp/ts-probe/ts60/package/lib/typescript.js:8289` — same expression.
And at line 8638 a second similar access. The pattern is structural
to TypeScript's getNodeSystem.

## 3. Root cause — `__fsMod` has no `realpathSync`

Inventoried our fs shim's exported symbol set:

`src/node-shims.ts:580-638` — the return value of `__fsMod`'s IIFE.
The keys are:

```
readFileSync, writeFileSync, appendFileSync, existsSync, statSync, lstatSync,
readdirSync, mkdirSync, unlinkSync, rmdirSync, renameSync, copyFileSync,
readFile, writeFile, stat, readdir, exists, mkdir, unlink, access,
promises, constants,
createReadStream, createWriteStream, watch, watchFile, unwatchFile
```

No `realpathSync`. Only `promises.realpath` (async, line 520).

So `_fs.realpathSync` is `undefined` → `_fs.realpathSync.native`
throws "Cannot read properties of undefined (reading 'native')" —
**byte-exact match** with the runtime stack.

## 4. Fix sketch (per §C)

Add to `__fsMod` (alongside the other Sync fns at `src/node-shims.ts:520`-ish):

```js
function realpathSync(p, opts) { return _resolve(String(p)); }
realpathSync.native = realpathSync;  // TS gates on truthiness of .native
```

…and include `realpathSync` in the return object at `src/node-shims.ts:581`.

LOC estimate: ~3 lines + 1 word in the return object.

## 5. Why ts-jest specifically (not just typescript)

ts-jest's `dist/legacy` bootstrap calls `require('typescript')` at
module-eval time. typescript's bundled top-level immediately calls
`sys2 = getNodeSystem()` (line 8653 of typescript.js) which evaluates
the broken `_fs.realpathSync.native` access and throws.

So fixing realpathSync unblocks:
- `ts-jest` (the verify cohort target)
- bare `require('typescript')` (worth a smoke-test probe)
- any package that runs a TS compile via the typescript API
  (e.g. `ts-node` — currently regressed per X.5-J — though
  J's regression fix may have addressed a different part of the
  same chain)

## 6. Predicted ✅ flip

**+1** for ts-jest. Possibly +1 for typescript (if it's in the cohort
and currently warned as ⚠). Likely positive interaction with ts-node
which was flagged in X.5-J retro.

## 7. Risk

`fs.realpathSync` returning `path.resolve(p)` is a no-op symlink
resolver — adequate for VFS (we have no symlinks). TypeScript's
`fsRealPathHandlingLongPath` win32 fallback won't be reached
(`process.platform === 'darwin'` per our shim). Tests that depend on
realpathSync producing a TRULY canonical path could fail, but that's
a fringe case for any code running in the facet today.

## 8. Dependencies

- Independent of the other 3 Z5 packages.
- Does NOT depend on W2.6b cap work — the cap-eviction hypothesis
  was wrong.
- Does NOT depend on X.5-NPQO. Same write-lock concern as express
  (both fixes touch `src/node-shims.ts`); merge order matters but
  the diff is small enough to rebase.
