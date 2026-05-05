# Spike: sql.js — verdict

**Question (per plan §3.1):** is the `dist/sql-wasm.wasm` ENOENT a tar-extraction-filter
bug (per W6 retro §5) or something else?

## Findings

1. **Tar extraction is fine.** `src/npm-tarball-stream.ts` has no extension filter;
   `.wasm` files extract iff size ≤ 20 MiB and entry is regular-file. `sql-wasm.wasm`
   is 659,730 bytes (verified locally via `bun add sql.js` and `wc -c`). Should extract.

2. **Pre-bundle slice walker is fine.** `src/pre-bundle-facet.ts:buildSliceForSpecifierWithCap`
   walks every file under `pkgDir` via `walkDir(...)` (no extension filter), and
   `inferLoader('.wasm')` returns `'binary'` so esbuild emits the bytes correctly
   into the bundle.

3. **The actual error origin is `src/node-shims.ts:2058`:**
   ```
   "Cannot load module '" + resolvedPath + "': file was not pre-bundled. Add it to the VFS bundle."
   ```
   This fires in the user's runtime facet, NOT during install or pre-bundle. The
   error is thrown when `new Function(code)` fails with "Code generation from
   strings disallowed" — a workerd CSP-like restriction. The fix path is to
   precompile the module into `__compiledModules` at facet startup.

4. **But sql.js's actual runtime ENOENT is different.** Re-read
   `audit/probes/wasm/sql-js.out.txt:43`:
   `ERR: Error: ENOENT: no such file or directory, open '/home/user/app/node_modules/sql.js/dist/sql-wasm.wasm'`.

   That's NOT the "not pre-bundled" error — it's a `fs.readFileSync` returning ENOENT.
   sql.js loads via `dist/sql-wasm.js`, then internally `__dirname`-resolves and reads
   the sibling `.wasm` file via `fs.readFileSync(...)`. The ENOENT means **the file
   didn't make it into the VFS at install time**, despite tar extraction supposedly
   handling it. That contradicts finding #1.

   Resolution: the real bug is somewhere between `streamTarEntries` yielding the
   entry and the supervisor `writeBatch` persisting it. Likely candidates:
   - The supervisor walker is selectively skipping `.wasm` when building the batch
     payload (different from the slice walker — this is the *tarball-write* walker).
   - VFS path normalization mismatch: the tarball entry name might be
     `sql.js/dist/sql-wasm.wasm` (with leading prefix) but the runtime
     `fs.readFileSync` queries `/home/user/app/node_modules/sql.js/dist/sql-wasm.wasm`
     and the inode key in SQLite differs.

## Surface-area gate verdict

**DEFER** to W6.5.x.

- The fix is not in any one src/ file: it spans `npm-install-facet.ts`
  (the file-batch writer), the supervisor's writeBatch RPC handler in
  `nimbus-session.ts`, and possibly the `cirrus-real`/runtime fs shim.
- The runtime path also needs verification — is the file in VFS after install?
  We can't answer that without a live prod session (auth currently unavailable).
- There may *also* be a downstream "not pre-bundled" issue for sql.js when
  user-app runs in workerd CSP mode. That's a second fix.

**Action:** keep `sql.js` REJECT_INSTALL entry. Refine its `suggest:` to reflect
the actual gap shape (not "extraction filter for `dist/*.wasm`" — that's wrong;
it's an installer-or-runtime fs gap).

## Track 2 promotion: NO.
