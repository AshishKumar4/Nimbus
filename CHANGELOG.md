# Changelog

All notable Nimbus releases are summarized here. Package-level versions are
published independently in the `@nimbus-sh` npm scope.

## Unreleased

- `DELETE /s/<id>/` no longer answers with the session shell. The core
  router served the UI HTML for the session root whatever the method, so a
  DELETE carrying only an attach token got 200 HTML and destroyed nothing.
  With the remote API enabled, a root DELETE is now `box.destroy()` under its
  own authorization and answers the JSON destroy result; without destroy
  scopes it gets the usual 401/403. The root serves the UI to GET and HEAD
  only; other methods are 405. The hosted demo refuses an anonymous session's
  DELETE with 401 (`E_ANON_SESSION_TTL`); its fixed lifetime reaps it. The
  probe target drops its own DELETE route for the core one. Behavioral
  cleanup counts a session as deleted only when the DELETE returned the
  destroy result.

- `kill <pid>` in a hosted session ends the session's resident processes
  again. The shell's `kill` builtin only looked in its own process registry,
  so a resident pid (1000002, …) answered "No such process" and stayed up;
  a numeric pid the shell does not hold now goes to the session's own
  teardown, which releases the port and retires the capability. This also
  covers `kill -9`/`-s` forms, child shells and named programmatic shells.
  `kill -0` only checks that the process is alive; stop, continue and
  ignored signals are refused for a resident, since its teardown can only
  end it. A successful kill prints nothing, as in bash.

- Trusted hosts can register a shared directory on the raw SqliteVFS. Its
  strict descendants couple owner/group permissions on creation, chmod and
  native adoption; ordinary POSIX and confined-owner rules remain unchanged
  outside registered domains. Registration is engine-local, revocable and
  never serialized with snapshots or imports. Descriptor chmod uses the
  original credential without repeating ancestor lookup. Hosts must opt in;
  this does not imply adoption by an embedding application.

- Guessed Node package entries bring their readable literal dependencies on
  the first launch, including relative imports, re-exports and nested package
  resolution. Each root and its new dependency cells fit or decline together;
  transformed-size eviction removes whole optional groups, keeping shared
  dependencies and compiled companions while another retained owner needs them.
  One-hop package selection, required/evidence priority and the 18 MiB limit
  are unchanged. Dynamic imports of guessed roots remain optional. Held bytes
  are reused only after checking current read permission through the same
  process bridge. Unresolvable specifiers keep their existing runtime errors.

- The packed `@nimbus-sh/worker/git` command loads the patched Git module
  shipped with the package, not a consumer's unpatched cf-git dependency.
  Hosts and network facets use the same build output. Fresh Bun-installed
  consumers run on Node and Bun without repository patch hooks; staging a
  2,000-file worktree writes the index once. Runtime code, self-contained
  declarations and the upstream license are packaged and covered by the
  build fixpoint. The raw dependency is now a build-time dependency. The
  typed HTTP facade preserves both namespace and default entry points.

- Node's dependency walk uses the existing launch turn budget, including
  metadata-only work before a closure-size refusal. Scheduling failures and
  cancellation propagate through CJS and ESM resolution without becoming
  missing dependencies. Each recursive or interleaved scan has its own regex
  cursor. Directory-resolution package metadata finishes loading before the
  closure returns. The 18 MiB snapshot limit is unchanged.

- `localFacetHost()` uses JSPI when the engine exposes `WebAssembly.Suspending`
  and `WebAssembly.promising`. On Bun 1.4, a WASI child now waits when its
  output pipe is full. `seq 100000 | cat | head -1` reports GNU's `141 141 0`
  instead of `0 141 0`. `yes | cat | head -1` and
  `yes | head -c 80000000 | wc -c` complete instead of exceeding the pipe budget.
  The tested Node 22.22 host lacks JSPI and keeps its existing `parking: 'none'`
  behavior. The Bash runner, artifacts and pipe rules are unchanged.

- A Node launch's speculative package-entry pass uses the shared resolver in
  the runtime's order: exports under CJS then ESM conditions, `main`, then `index`.
  It now handles root conditional maps without a `"."` key, including
  `on-change@6`'s `{ types, default }` map. The previous collector could miss
  that entry and guess a nonexistent `index.js`.

- WebSocket terminal input passes the async shell command's completion to
  the session or embedder's `waitUntil`, so a rejected command is logged and
  reported to the terminal and shell state is saved when it finishes.
  Previously the terminal discarded the callback's promise when the frame
  returned, and neither happened. Later input, including Ctrl-C, is still
  delivered without waiting for the command. This does not extend a Durable
  Object's lifetime: `DurableObjectState.waitUntil` does not, per Cloudflare's
  documentation.

- Load esbuild's bundled WASM when the service initializes (Kinu N27).
  Importing service constants or constructing a service no longer evaluates
  the WASM binding.

### Test process safety

- Unit timing checks use operation counts, explicit completion handshakes,
  and timer ordering instead of elapsed-time performance thresholds. The
  tests still check blocked work, cancellation, timeout errors, exact output,
  and linear index replacement; hang guards remain finite.

- Unit files have a five-minute deadline and a
  combined 1 MiB stdout/stderr limit. Timeout and output overflow kill the
  subprocess group; failures name the file, exit status or signal, and
  bounded output diagnostics. The bounded workstation wrapper sets one
  worker; the repository's existing pool default remains available to CI.
- The subprocess helper supports an opt-in Linux backend using systemd and
  bubblewrap. Each case gets its own cgroup and PID namespace. This backend
  cleans up detached descendants and isolates process signals. The caller
  configures resource limits; filesystem and network access remain unchanged.
  Signal cancellation settles pending calls so caller
  cleanup runs. Outside systemd, process groups and PID-start-time-checked
  polling provide weaker cleanup with a finite output-pipe drain deadline;
  that fallback is not a memory or detached-descendant containment boundary.
- Launch arguments and environment travel in a size-bounded private request
  file (0700 directory, 0600 file), not in systemd command lines or service
  descriptions. The target still receives exact argument/environment values;
  malformed requests fail before execution and private files are removed.

### Breaking changes for embedders

Unused exports are removed from the new pre-1.0 release:
`parseInstalledPyodidePackageManifest`, `InstalledPyodidePackageManifest`,
`InstalledPyodidePackageManifestSchema`, `readMemoryLimits`,
`createPsCommandFromJobTable`, and `CPYTHON_EXIT_MARKER` from core;
`rpcRouteCapabilityPort` from worker's `session/programmatic` module.
The session's active capability-port route remains unchanged.

The published `@nimbus-sh/core` no longer carries the compiled output of the
modules removed below (`runtime/filesystem-authority.js`, the lifo kernel
VFS, `SandboxFs`, `ServiceManager`, kernel persistence and storage, and
`runtime/vfs-manifest.js`). Before, their stale `dist` files still shipped,
so an import of a removed name type-checked and loaded the old code. Each
package's build now clears its `dist` first, and `dist-integrity` refuses
any output whose source is gone.

The workspace has one filesystem: a `CompositeVFS` rooted at SQLite, with
`/proc` and `/dev` mounted, bound to processes by `ProcessFiles`. The lifo
kernel no longer has a filesystem. Each removed or changed public import or
option, with its replacement:

- `@nimbus-sh/core/runtime/filesystem-authority.js` (`SqliteFilesystemAuthority`)
  is removed. Use `ProcessFiles` from `@nimbus-sh/core/runtime/process-files.js`:
  `new ProcessFiles(sqliteVfs)`, with the same `bind`, `openHost`,
  `releaseProcess` and append-writer methods, plus `vfs` (the mount table),
  `proc`, `mounts(cred)`, `view(binding)` and `withHost(cred, use)`. Do not
  subclass it to add mounts; mount on `vfs` (below).
- `@nimbus-sh/core/substrate/lifo/kernel/vfs/*` is removed, with `VFS`,
  `VFSError`, `ErrorCode`, the Proc, Dev and NativeFs providers,
  `MountProvider`/`VirtualProvider`, and `Stat`/`FileType`:
  - Errors: `VfsError` and `isVfsError(e, code?)` from
    `@nimbus-sh/core/vfs/vfs-error.js`. Commands recognise only `VfsError`; a
    mount that throws another class reports an unexpected failure instead
    of the POSIX error.
  - Types: `VFS`, `VfsStat`, `VfsFileType` and the `S_IF*` bits from
    `@nimbus-sh/core/vfs/vfs.js`.
  - A mount provider: implement `VFS` (`@nimbus-sh/core/vfs/vfs.js`; it may
    be sync, async or both) and mount it (below).
- `NimbusWorkspaceOptions.filesystem` was a hook, `(authority) => authority`.
  It is now an optional `ProcessFiles` instance over the workspace's own
  `SqliteVFS`. To mount a filesystem, call
  `ws.filesystem.vfs.mount(point, source)`, where `source` is a `VFS` or
  `(principal) => VFS | null` for a per-principal source such as Kinu's
  `/context`. The mount then answers `df`, `mount` and `/proc/mounts`.
- `NimbusWorkspaceOptions.mounts` is removed: the top-level directories are
  fixed (`SEEDED_TOP_LEVEL_DIRS` in `@nimbus-sh/core/constants.js`, which
  replaces `DEFAULT_MOUNT_POINTS`). Mount other trees with
  `ws.filesystem.vfs.mount()`.
- `seedBaseFilesystem(vfs, mounts)` is now `seedBaseFilesystem(vfs)`.
- `workspace.kernel.vfs`, `kernel.proc`, `kernel.boot()`,
  `kernel.initFilesystem()` and `kernel.serviceManager` are removed. Read
  the namespace through `ws.filesystem.vfs.as(cred)`, a process's view
  through `ws.filesystem.view({ pid, cred })`, and SQLite directly through
  `ws.vfs.as(cred)`. Add `/proc` files with `ws.filesystem.proc.register()`.
- Removed from `@nimbus-sh/core/substrate/lifo`: `Sandbox` (use
  `NimbusWorkspace`), `ServiceManager` and `systemctl`, `parseUnitFile`,
  `PersistenceManager` and the persistence backends, `ContentStore`,
  `BlobStore` and `MemoryBlobStore`, `NativeFsProvider`, `VFS` and
  `VFSError`. The mime helpers are still exported.
- A command's `ctx.vfs` is a `ProcessView` (from
  `@nimbus-sh/core/runtime/process-files.js`), not `ExecutionFs`:
  - `stat` returns `null` when nothing is there; `statOrThrow`/`lstatOrThrow`
    from `@nimbus-sh/core/vfs/vfs.js` keep the old throw.
  - `lstat(p)` is `stat(p, { follow: false })`.
  - Stat times are `mtimeMs`, `atimeMs` and `ctimeMs`.
  - `copyFile`/`copyTree` are `copy(from, to, { recursive })`, and
    `rmdirRecursive(p)` is `remove(p, { recursive: true })`.
  - `.authority` is `.process`, and `.local` is gone.
  - Every failure is a `VfsError`.
  - `ExecutionFs`, `bindExecutionFs` and `withHostFilesystem` are
    `ProcessView`, `bindProcessView` and `withHostView`.
- Behaviour change: the probes `exists`, `isFile`, `isDirectory` and
  `isSymlink` (on `ProcessView` and in `@nimbus-sh/core/vfs/vfs.js`) answer
  `false` for a path that runs through a file (`exists('f/g')` where `f` is a
  file), as Node's `existsSync` does. Before, they threw `ENOTDIR`. A denial
  still throws.
- The mount listing (`mounts(cred)`, `df`, `mount`, `/proc/mounts`) is in
  mount order (`/`, `/proc`, `/dev`, then the embedder's), as on Linux.
- `ws.fs` is a `VFS`: the session user's view of the namespace (a
  `ProcessView`, the shell process's own), with the same lease checks a
  command gets. The hosted runtime's `files` and `files(cred)` are the same
  kind of view for a credential, with `.as(cred)`. `SandboxFs`,
  `SandboxFsImpl` and the `SandboxFs` type export are gone. Paths are
  absolute (a relative path is no longer resolved against the shell's
  cwd). Method by method:
  - `readFile(p)` (text) is `readText(ws.fs, p)`, and `readFile(p, null)` is
    `ws.fs.readFile(p)` (bytes).
  - `writeFile(p, text)` is `writeText(ws.fs, p, text)`; bytes go to
    `ws.fs.writeFile(p, bytes)`.
  - `writeFiles(list)` is one `writeFile`/`writeText` per entry.
  - `stat(p)` answers `null` for a missing path (use `statOrThrow` for the
    old throw), and its times are `mtimeMs`, `atimeMs` and `ctimeMs`.
  - `rm(p)` is `unlink(p)` or `rmdir(p)`, and `rm(p, { recursive: true })`
    is `removeRecursive(p)`.
  - `cp(a, b)` is `copy(a, b, { recursive })`.
  - `exists`, `readdir`, `mkdir` and `rename` are unchanged.
  - `storeStats()` leaves the user's handles: the kernel's
    `ws.vfs.storeStats()` has it, and a user sees its storage through `df`
    (`usage()` on the namespace root).
  `readText`, `writeText`, `statOrThrow` and `exists` are in
  `@nimbus-sh/core/vfs/vfs.js`. The SDK's `box.files` is unchanged.
- `ws.fs` no longer has `exportSnapshot()`/`importSnapshot()` (a tar.gz of
  the whole tree). The content store is the embedder's, with kernel
  authority, on `ws.vfs` (the workspace's `SqliteVFS`):
  `snapshot(name, { quiesce })`, `snapshots()`, `dropSnapshot(name)`,
  `diff(from, to, { after, limit })`, `at(name, cred?)`, `restore`/
  `restoreAsync(name, { subtree })`, `exportPage`/`exportChunks`/
  `importPage`/`pageDigest`, and `storeStats()`. Snapshots hold the
  SQLite-rooted tree, not mounts.
- `df` reports the session's storage ledger for `/`: Used is everything
  the 10 GB limit counts (this database, every process facet's, and
  reservations), and Available leaves out the kernel's reserve, as ext4's df
  leaves out root's reserved blocks.
- `snapshot(name, { quiesce: true })` waits for spanning work (writeStream,
  restoreAsync, sliced copyTree) and for exclusive leases, and holds
  spanning work that starts meanwhile until the snapshot is taken. It
  waits; it never answers EBUSY.
- The content store's schema is 3. A database a schema-2 build wrote (staging
  and throwaways only) is reset when it opens, and `legacyReset` tells the
  session once.
- The host's `sql.exec` must return the rows of a statement with
  `RETURNING` (`INSERT`, `UPDATE`), not only of `SELECT`: the filesystem reads
  its clock and job ids that way. An adapter that returns rows only for
  `SELECT`/`WITH`/`PRAGMA` breaks every write.
- The host must report `sql.databaseSize` (workerd has it). The storage ledger
  measures the session's database with it; without it the ledger falls back to
  SQLite's page count.
- The store's tables changed. Removed: `inodes`, `file_chunks`,
  `content_lifecycle`, `vfs_schema_migrations`, `vfs_ino_allocator`. Added:
  `vfs_state`, `vfs_inodes`, `vfs_chunks`, `vfs_contents`,
  `vfs_content_chunks`, `vfs_inode_history`, `vfs_gc_queue`, `vfs_jobs`,
  `vfs_snapshots`, `vfs_tombstones`, `vfs_cold_trash`, and the storage
  ledger's `nimbus_storage_ledger`, `nimbus_storage_reservation`,
  `nimbus_facet_storage`. `NimbusWorkspace.destroy()`
  drops the `vfs_*` tables and keeps every `nimbus_*` table.
- `EsbuildService`, `supervisorEsbuildService`, `installPathExecResolver`
  (`shell/exec-dispatch`) and `countPackageFiles` take a `NamespaceFs`:
  pass `filesystem.namespaceFs(cred)`, the namespace as that principal.
- The SDK runs commands through the session stub's `_rpcExecStream`. A host
  that answers the SDK must expose it.
- `/` is 0755 root:root. A fixture that creates top-level directories as the
  session user gets EACCES; create them as the kernel (`vfs.as(CRED_KERNEL)`).
- Creating a file never creates its directory. `touch`, a shell redirect
  (`echo hi > dir/f`), `tee`, `ws.fs.writeFile`, the SDK's `files.write` and
  a process's `writeFile`/`writeRange`/`open(O_CREAT)` answer ENOENT under a
  missing parent, as open(2) does. Make the directory first (`mkdir -p`), or
  pass `createParents: true` to the bridge's `writeFile`/`writeRange`.
- A path beneath a root (a WASI preopen) that climbs out of it answers
  ENOTCAPABLE, as does an absolute path or an absolute link beneath it.
  Kinu's own bridge answered EPERM.
- A bridge's `stat` answers null for a missing path in any form, a path
  beneath a root whose middle component is missing included. It used to throw
  ENOENT for that one. EACCES, ENOTCAPABLE, ENOTDIR and ELOOP still throw.

- `@nimbus-sh/core/substrate/lifo` no longer exports `isBinaryMime` or
  `getFileCategory`, the file-name guess the text commands used to skip files.

### Session agent

- SECURITY: the OAuth callback is routed only for a `state` this deployment
  signed (HMAC-SHA256 under the agent cookie secret), and only before its
  signed expiry, 10 minutes after the flow started. An unsigned, altered or
  expired state gets 400 without naming a Durable Object. Before, any client
  could wake or create a session DO under any tenant segment.

### Not carried from Kinu's N26 patch

These stay Kinu's policy, applied by Kinu after its own move or chmod with its
kernel credential, because Nimbus follows POSIX here:

- Renaming an entry into a shared directory keeps the entry's group. POSIX
  rename(2) does not change ownership.
- chmod in a setgid directory sets exactly the mode asked for. A default ACL
  governs creation, not chmod.
- A confined principal still cannot widen modes (N11).

### filesystem

- The shared read profile (what node processes read synchronously and did
  not have, per installed package) lives in the npm tarball cache bucket
  (`NPM_TARBALL_CACHE`, under `read-profiles/v3/`); the
  `NIMBUS_READ_PROFILES` binding is gone. Nothing a program reports is
  trusted: a miss is learned only when this supervisor served the process an
  async read of that path afterwards and it is a regular file in the package.
  Observers and vouchers are principals, the verified tenant and subject in
  the session's Durable Object name, never session ids, which anyone can
  mint; anonymous sessions (legacy-public, or the `anon` tenant) read
  profiles and never write them (nor does any DO name the router does not
  mint from a verified token, such as a fanout peer's); a principal writes
  one package's profile at most 8 times an hour. Each write is a
  compare-and-swap on the object's etag, retried from a fresh read, so
  concurrent writers no longer drop each other's observations or votes. An entry is shared only once two different
  principals observed it, what a
  shared profile adds to one launch is bounded in bytes (an eighth of the
  module map's budget), and entries are pruned: a launch that held an entry
  and never had to fault it in raises it, once per principal, so a score
  counts the distinct principals that vouched for it; a program saying it never read
  one lowers it; a launch that reported nothing changes nothing; one that
  names no regular file is dropped. A learned module joins the launch's module
  map with its imports (nuxt's `on-change` failed with "not in this launch's
  module map" before), in the room the require closure leaves under the
  snapshot bound, after the session's own misses: neither can make a launch
  fail. Only the closure itself past the bound fails one, naming the file
  that crossed it.
- A mount with no synchronous face (an embedder's Drive, `/pc`, `/sandbox`)
  works for every caller that can wait: shell commands (`ls /`, `cat`, `find
  /`, redirects), node's `fs.promises`, the supervisor RPC, and bash under
  JSPI, including paths beneath a WASI preopen and descriptors opened on the
  mount. Before, any of these that touched the mount got EAGAIN (`ls /`
  failed as a whole). Only a caller that cannot wait (node's sync fs, WASI
  without JSPI) still gets EAGAIN, naming the mount.
- `find /` prints `/home`, not `//home`, as GNU find does.
- A pipe's closed read end ends only the command that writes to it, as
  SIGPIPE does in bash: `{ cat big; touch mark; } | head -1` runs `touch`, a
  loop goes on after its `cat` dies (status 141), and a builtin writing there
  ends its own pipeline element. Before, the whole left side stopped when the
  last command exited. `PIPESTATUS` holds each element's status, and a writer
  that exits with more than a pipe's capacity unread gets 141, as on Linux
  (`head` reads 8 KiB at a time, as GNU's does). Loops let the event loop run
  every 64 iterations, so Ctrl-C and `kill` reach one that never waits on
  I/O. The workspace shell has `kill`, and job numbers are reused as bash
  reuses them (`wait`, `wait %N` and `wait PID` reap). A command killed this
  way ends silently (`yes | head -2` prints no EPIPE), and a bash builtin
  served as a command (`printf`) ends its element, as `echo` does. A
  background job's `[N] PID` notice appears only in the interactive shell,
  in bash's form.
- Shell job operands accept `%N`, `%%`, `%+`, `%-`, command prefixes and
  `%?substring`; ambiguous names are refused. `kill -s` and `-n` select the
  signal, `kill -l` converts names and numbers, and `jobs` shows current and
  previous markers with `-p`/`-l` output. An explicit wait keeps its status
  for repeated waits until the job number is reused; bare `wait` returns 0.
  Child shells have their own job-table membership, so `jobs | cat` cannot
  reap a parent's jobs. Noninteractive `fg` and `bg` report no job control.
  Signal defaults are shared with delivery: CHLD, URG and WINCH are ignored;
  STOP, TSTP, TTIN and TTOU mark jobs stopped; CONT resumes their state.
  Ignored and stop/continue signals do not abort a process.
- A subshell, each pipeline element, `$( )` and a background job run in a
  child shell, as bash forks one: variables, arrays, cwd, `set` options,
  traps, aliases and functions changed there stay there, `exit` ends only
  the child, and the child runs its own EXIT trap (inherited traps reset,
  ignored ones stay ignored). Before, `(cd /)` moved the parent,
  `x=$(x=2)` changed `x`, and a finished background subshell put back the
  variables it had saved, so `(exit 4) & p=$!; sleep 1; wait $p` lost `$p`
  and returned 0. Every command of an `&&`/`||` list but the last runs with
  `set -e` ignored, and a status carried past a skipped command does not
  trigger it (`set -e; false && true; echo reached` reaches `echo`).
- New: `md5sum`, `sha1sum`, `sha224sum`, `sha384sum`, `sha512sum`, `b2sum`,
  `cksum` (CRC, `-a` any of them, tagged, `--base64`, `--raw`) and `sum`
  (BSD and System V), with `sha256sum` on the same engine: `--tag`, `-b`,
  `-z`, GNU's escaping of names with `\` or newlines, and `-c` with
  `--quiet --status --strict --warn --ignore-missing` (one last-wins mode),
  as GNU coreutils 9.7. `cksum -c` takes each tagged line's own algorithm.
  GNU's usage errors for option combinations come before any work, and file
  names in messages are quoted as GNU quotes them. Input is hashed as it
  streams; BLAKE2b runs in 32-bit arithmetic (about 43 MB/s here).
- `cat`, `head`, `tac` and `tee` keep bytes and answer as GNU coreutils
  9.7's do: `cat -A -b -e -E -n -s -t -T -v` (M- and ^ notation), `head -n/-c`
  with negative counts and every GNU suffix (`b`, `K`/`KB`/`KiB` through
  `Q`, blanks and `+` before the digits, an overlarge count taken as all),
  `tac -b -r -s`, and a streaming `tee -a`
  that reports a file it cannot open and still writes the rest. `cat
  /dev/zero | head -c N` works (cat used to refuse endless devices), and a
  writer whose reader closed the pipe ends silently with status 141, as
  SIGPIPE ends it. `scripts/record-gnu-fixtures.mjs` re-records the GNU
  fixtures from their specs on a host with the reference tools.
- The GNU fixture recorder limits each oracle, version probe and locale
  probe to 30 seconds and 8 MiB of combined output. Timeout, signal, spawn
  failure or output overflow kills the child tree and leaves the fixture
  unchanged. Normal nonzero exits remain valid reference results. Each
  fixture is replaced only after all its cases finish normally.
- `sed` is GNU sed 4.9's language: every command except `e` (`{}`, `=`,
  `a`, `b`, `c`, `d`, `D`, `F`, `g`, `G`, `h`, `H`, `i`, `l`, `n`, `N`, `p`,
  `P`, `q`, `Q`, `r`, `R`, `s`, `t`, `T`, `w`, `W`, `x`, `y`, `z`, labels),
  GNU's addresses (`first~step`, `0,/re/`, `addr,+N`, `addr,~N`, `I`/`M`),
  `s` flags `g p N i m w` and `\L \U \l \u \E` in replacements, and `-s`,
  `-i[SUFFIX]`, `-f`, `-z`, `-l`, with GNU's messages and exit statuses (2
  for an unreadable input file, 4 for a missing label). Before, it had `s`,
  `d` and `p` only.
- `sort`, `uniq`, `tail`, `wc`, `nl`, `tr`, `rev` and `sed` keep bytes: a
  byte that is not valid UTF-8 (Latin-1 text, binary data) passes through
  unchanged, as GNU's tools pass it. Before, input was decoded as UTF-8 and
  every such byte came out as U+FFFD (three different bytes). Each has one
  implementation, shared by the workspace shell and the lifo registry, and
  each answers as GNU coreutils 9.7 does (`rev` as util-linux 2.41, `sed` as
  GNU sed 4.9), checked on the fixtures in `tests/fixtures/gnu/`. Also:
  `wc -l` counts newlines (a last line without one is not counted), `tail`
  prints the input's own last bytes and adds no newline, `sort` collates as
  glibc's en_US.UTF-8 does (punctuation and symbols ignored first, lower case
  first) with `-n -g -h -M -V -k -t -s -c -o`, `uniq` has `-f -s -w -D
  --group -z`, `tr` has `-c -t [c*n] [=c=]`, and a sed regex's `.` never
  matches an invalid byte while `[a-z]` takes glibc's collated range.
  Known limit: `sort` can order two lines that differ only in punctuation
  differently from glibc.
- `grep`, `od` and `cut` answer as GNU's do, byte for byte, checked against
  GNU grep 3.12 and GNU coreutils 9.7 on 415 cases (`tests/fixtures/gnu/`).
  grep: basic and extended POSIX patterns (a `+` is literal in a basic
  pattern), `-F`, `-P`, `-e`, `-f`, `-i`, `-w`, `-x`, `-v`, `-c`, `-l`, `-L`,
  `-m`, `-o`, `-q`, `-s`, `-b`, `-n`, `-H`, `-h`, `--label`, `-T`, `-Z`,
  `-z`, context (`-A`, `-B`, `-C`, `-NUM`, group separators), `-r`, `-R`,
  `--include`, `--exclude`, `--exclude-dir`, `-d`, and binary input: a NUL
  in what one read brings, or a line with an encoding error, is held back and
  "binary file matches" follows on stderr; `-a`/`--binary-files=text` prints
  it, `-I` skips the file. An error (an unreadable file, a directory without
  `-r`) exits 2. od: every `-t` type (`a`, `c`, `d`, `o`, `u`, `x` in 1, 2,
  4 or 8 bytes, `f` in 2, 4 or 8, the `z` suffix), the one-letter forms,
  `-A`, `-j`, `-N`, `-S`, `-v`, `-w`, `--endian`, and GNU's lowercase final
  hex address. cut: `-b`, `-c` and `-f` lists and ranges, `--complement`,
  `-s`, `-z`, `--output-delimiter`, streamed in bounded reads.
- `sed`, `nl`, `rev` and the lifo `grep`, `wc`, `uniq`, `cut`, `awk`, `sort`
  and `tail` read every file. They skipped a file as "binary" by its name, so
  `sed -i s/a/b/ f` left a file with no known text extension unedited. GNU's
  tools have no such skip. `diff` decides binary by content, as GNU does (a
  NUL byte), and exits 1 when binary files differ (it exited 2).
- SECURITY: `/` is 0755 root:root, and adding, removing or renaming a name
  directly in it needs write permission on `/`, as on Linux. Before, the
  filesystem skipped that check at the root, so any user (a confined agent
  uid included) could create top-level entries, rename or remove kernel
  directories, and unlink kernel files there. The session user can no
  longer `mkdir /foo`; the top-level directories a session has (`/home`,
  `/tmp`, `/usr`, `/var`, `/opt`, `/bin`) are made by the kernel at boot
  and owned by the session user, as before.
- An entry made, removed or versioned through a directory link (for example
  `/home/user` -> `/home/main`) is placed where the link resolves, in
  batches and `mkdir -p` too (Kinu N22).
- A setgid directory gives what is made in it its group, and a directory
  made there is setgid too. `setfacl -d -m u::,g::,o::` sets a directory's
  default ACL base entries: what is made there then gets those permissions
  instead of the umask, and new directories inherit them. `setfacl -k`
  removes it, and `getfacl` shows it (Kinu N26).
- `rename` follows Linux's order and error codes. A directory may replace an
  empty directory, and moving a directory to another parent needs write
  permission on it.
- Storage admission (Kinu N18). One 10 GB limit covers the session and every
  process facet under it. At the wall an ordinary write failed as
  `SQLITE_FULL`, and a facet clone past it reset the object and emptied the
  destination. Now every write is admitted before it is made, and a write
  that would cross the limit fails with `ENOSPC` and changes
  nothing. The ledger counts the session's database, each facet's database
  (live, dead or kept for a durable app, until `facets.delete`), and running
  operations' reservations. Nothing in it is evictable: the per-principal
  namespace image cache the design proposed never gained a producer and is
  not shipped. A sliced `copyTree` and an `importPage` reserve their room when they
  start, so a writer between their slices can't leave them half done. A
  copy resumed after a reset reserves again, or ends and removes what it
  had copied. A running node process's store asks for room before it grows;
  what it can't hold it reads from the session. The last 1% of the limit
  (at least 16 MiB) is kept for the kernel. `ws.vfs.storeStats().ledger`
  reports used, the limit and each part; `df` shows the totals.
- Lazy imports (Kinu N17). `ProcessFiles(vfs, { hydration: { fetch } })` and
  `importPage(dst, page, chunks, { lazy: true })` commit an import's rows at
  once and fetch the bytes it did not carry in the background, through your
  `fetch(hashes)`. An asynchronous read of such a file waits for its bytes.
  A synchronous one fails with `EIO` ("still being imported") and moves the
  file to the front. A WASI launch (bash, python, ruby, clang, a .wasm) waits
  up to 30 s for the files it names, then fails with `EIO`; a launch naming
  none of them starts at once. A fetch that fails, returns wrong bytes or leaves
  hashes out is retried with backoff. After 8 tries a chunk has failed: its
  readers get `EIO` naming the file, the chunk and the cause, and
  `hydrator.retryFailed()` tries again. An asynchronous reader also waits
  at most 30 s.
- `head -c N /dev/zero` and `/dev/urandom` work under bash. A device was read
  whole on open, which fails for an endless one.
- `realpath` takes GNU's options (`-e`, `-m`, `-L`, `-P`, `-s`, `-q`, `-z`,
  `--relative-to`, `--relative-base`), and `find -name` matches bracket
  classes, `\` escapes and a lone `[` as GNU does.
- `touch` sets times to "now" with write permission alone, as GNU does, and
  `touch -h` sets a link's own times.
- SECURITY: a lookup rooted at a WASI preopen (or any `beneath` path) checks
  search permission on each directory it leaves and refuses every absolute
  link and every `..` above its root, across mounts too.

### node

- One-shot namespace metadata shares the existing heap allowance with file
  cells and pending own projections. Row costs include retained path and
  symlink-target text. Listings stop accumulating before exceeding that
  allowance; startup refuses by name before user code rather than publishing
  a partial synchronous view. Runtime quota failures seal the sync view while
  authoritative asynchronous reads remain usable. Replacements charge only
  their delta, and optional data fills reserve room for mandatory metadata.

- Dynamic imports inside required `.cjs` files use the process loader too.
  JSON `data:` URLs require the JSON import attribute and load when it is
  supplied. ESM source lookup uses the file path, while evaluation caching
  uses the complete URL: distinct queries/fragments evaluate separately,
  and importing the same URL again reuses its evaluation. Queryless imports,
  `require`, and transformed static imports share the canonical evaluation.
  `import.meta.url` receives that evaluation's complete URL, not a source-path
  literal; extracted `import.meta.resolve` retains its module's parent.
  Metadata rewriting visits actual `import.meta` syntax in the transform
  facet, not user object properties with similar names. TypeScript is emitted
  as JavaScript first, keeping the module format as written, so a module with
  `import` syntax that assigns `module.exports` still exports what it assigned
  (`require()` no longer answers `{ default: ... }` for it); module strictness
  and local binding names are preserved.
  Dot access, computed access and destructuring share the same per-evaluation
  metadata object; its existing `url` and `resolve` behavior is consistent.
- The transform facet consumes Acorn trees one completed top-level statement
  at a time, keeping edit spans and binding names instead of the whole module
  AST. Grammar, scope, exports and directives still use Acorn's parser. This
  reduces retained parsing memory for large bundled modules; it does not
  change the session's closure bound or dependency coverage.
- Bounded module conversion addresses the actual CommonJS wrapper arguments,
  not user variables named `module`, `require` or `exports`. Nested bundled
  wrappers no longer force a large otherwise-supported module through Go.
  Rewrite-only requests do not initialize the esbuild wasm heap.
- A transient transform-isolate failure aborts launch before bundle or
  Worker Loader cache publication. The next launch can transform again;
  it no longer inherits a cached diagnostic shim from an infrastructure
  failure. Permanent source errors remain lazy errors when required.
  Eval-only entry rewrites also fail before worker publication; a failed
  transform cannot fall back to workerd's native `import()`.

- A program's dynamic `import()` loads what Node's loads and fails as Node's
  fails. It was workerd's own `import()`, resolved against a module registry
  that holds none of the session's files: `import('/usr/local/lib/
  node_modules/<pkg>/dist/index.js')` from a CommonJS script (how pi's SDK
  is loaded) failed with "No such module". Each `import()` now goes to the
  process's ESM loader, which is Node 22's resolver (`import` conditions in
  the map's key order, `exports`/`imports`, self-reference, `file:` URLs, no
  extension or index probing, `ERR_UNSUPPORTED_DIR_IMPORT`,
  `ERR_MODULE_NOT_FOUND` and the rest with Node's messages and "Did you
  mean" hints, the JSON import-attribute rule) and returns Node's namespace
  (a CommonJS module's `module.exports` as `default`). A literal
  `import('dual')` of a package with `import` and `require` conditions now
  loads its `import` build, as in Node, where before it was lowered to
  `require`. `import.meta.resolve` is the same resolver's, synchronous as in
  Node. The `import()` calls are found by parsing (acorn), in the esbuild
  facet, and the result is cached by content.

### WASM bash

- `kill` of a virtual child now delivers terminating signals instead of
  returning success without doing anything. `wait` reports SIGTERM as 143
  and SIGKILL as 137; `kill -0` probes virtual process existence. Pending
  child work cannot publish a second exit after signal termination. These
  operations never target host process IDs. Process-group signal delivery
  and stop/continue/trap handling are not added by this change.
- Bash build `5.2.37-3` and runner `bash-runner@3` expose the guest's signal
  disposition: ignored signals stay ignored, default terminating signals
  terminate, and unsupported custom-handler delivery returns an error.
  Exec preserves ignored dispositions and resets caught handlers; SIGKILL
  remains uncatchable. The runtime package requires core `>=0.13.0` and must
  be published before that core release. Existing runtime-2 catalog objects
  are not overwritten.

## 2026-09-24

### filesystem

- The SQLite filesystem stores content by sha256: every chunk is stored once
  per database. A file up to 64 KiB is one chunk named from its inode row; a
  larger file is a manifest of FastCDC chunks (16/32/64 KiB), so an edit
  re-cuts and stores only the chunks around it. Writing a second identical
  node_modules tree stores no chunk (measured: 167 MB then 10.7 MB for a
  20,000-file corpus written twice, against 263 MB each time before).
- `stat()` reports the row's generation (`gen`), and `contentKey(path)` gives
  a key that is equal only for equal bytes.
- `copyFile` copies the inode row, not the bytes; a later write to either
  file copies on write.
- Garbage collection works from a queue written in the same transaction as
  every dereference, and deletes a chunk only after probing every reference
  to it. A reset in the middle of a large write leaves no chunk behind.
- `cp -r`, `-R` and `-a` copy directories. A copy to a new destination
  within the filesystem copies inode rows in bounded transactions and no
  bytes (`copyTree`, measured below); one into an existing directory merges
  entry by entry. `cp -p` preserves mode and times, and a directory without
  `-r` is omitted with GNU cp's message. A reset mid-copy resumes to the
  complete tree the next time the filesystem opens.
- Snapshots: `SqliteVFS.snapshot(name)` pins the current tree in one
  row, whatever its size (0.07 ms at 100k files); `snapshot(name,
  { quiesce: true })` waits for streamed writes first. `at(name)` is a
  read-only view with the usual permission checks, `diff(a, b)` lists what
  changed between two snapshots or the live tree, `restore(name,
  { subtree })` puts the tree back and `dropSnapshot(name)` releases what
  only it held. Restore, diff and drop cost the changes since the snapshot,
  not the tree, and a reset during restore or drop finishes at the next
  open. The first write to a path after a snapshot keeps its previous row;
  later writes keep nothing. `copyTree(src, dst, { at })` forks a snapshot.
  `storeStats()` reports chunks, history rows, the GC queue, snapshots and
  jobs.
- A session whose files a pre-v2 Nimbus wrote now says so. Schema v2
  does not read that filesystem, so the session starts in a fresh tree, and
  its terminal prints "This session's files were created by an older Nimbus
  and were reset" once. The persisted shell state (a cwd into the lost
  tree) is dropped with it. The notice is recorded durably at the first v2
  open, so a restart before a terminal attaches still shows it.
- Long filesystem jobs yield. `copyTreeAsync` (used by `cp -r` over RPC),
  `restoreAsync` and `dropSnapshotAsync` run 200 transactions at a time
  with a yield between, and a job a reset interrupted resumes the same way
  at open. workerd reset an object that forked 1M files in one synchronous
  turn; sliced, the same fork took 28 s (27.5 us a row).
- Snapshot history can live in a cold store: with `coldStore` (an R2
  bucket binding or anything with get/put/delete) `tierColdChunks()` moves
  chunks that only snapshots reference out of the database, so the quota
  bounds the live tree and history is unbounded. The live tree never names
  a cold chunk and always reads synchronously. `await prepareSnapshot(name)`
  brings a snapshot's chunks back before `at(name)` reads, `restore(name)`
  or `copyTree(..., { at })`, which fail ENODATA otherwise; a write of a cold
  chunk's bytes makes it local again; GC deletes cold objects too.
- Trees move between databases by hash: `exportPage({ at, root, after })`
  lists a snapshot's rows with their chunk hashes, `wantChunks(page)` says
  which chunks the importer lacks, `exportChunks(hashes)` sends those in
  bounded frames, `importChunks(dst, chunks)` stores them (re-hashed) and
  `importPage(dst, page)` writes the rows. Only missing chunks travel (a
  second import of the same tree moved 0 bytes); a file of any size imports
  in frames; an import a reset interrupts resumes from `importCursor(dst)`;
  a non-empty target, another schema and a chunk that does not hash to its
  name are refused. `pageDigest(...)` compares two databases page by page.
  Measured between two Durable Objects: 17-21 MB/s of unique content, the
  storage write rate (the same frames alone move at 60-64 MB/s).
- The revision clock survives a supervisor restart. The epoch is the
  database's incarnation and revisions are its generations, so a facet
  holding a cursor from before a restart gets a delta instead of a poison:
  deltas older than the in-memory log are answered from the rows and a
  tombstone per deleted path (poisoning only past 16,384 paths or below the
  oldest of the 65,536 tombstones kept). An untouched file keeps its
  revision across the restart, so a facet's reconcile keeps its rows.
  `list()` entries carry `contentKey`. `rotateIncarnation()` starts a new
  epoch, for a storage restore to an earlier point in time.
- The revision clock is the durable generation, so revisions jump by more
  than one between publications. Existing filesystems start empty: the
  pre-v2 tables are ignored and deleted in bounded pages.

### git

- `git rev-parse` answers `--show-toplevel`, `--git-dir`,
  `--is-inside-work-tree`, `--verify` (with `-q`), `--abbrev-ref` and
  revision names, from any directory of the repository or from inside
  `.git`. It used to be "not a git command". Revision syntax such as
  `HEAD~1` is refused with an error.
- `git ls-files` lists the index, `--others` (with `--exclude-standard`),
  `--modified` and `--deleted`, relative to the working directory, with
  git's path quoting or `-z`.
- `git diff` prints a unified patch of the worktree against the index,
  against a commit (`git diff HEAD --`), or of the index (`--cached`), and
  `git diff --no-index` compares two paths, either of them `/dev/null`.
  `--stat`, `--name-only`, `--name-status`, `-z` and `-U<n>` work;
  `--exit-code` and `--quiet` are refused. It used to print the first 50
  lines of each changed file. Headers, hunk ranges,
  `\ No newline at end of file`, mode lines, binary files and `--stat`
  match git byte for byte. The hunks come from jsdiff's Myers diff, so where
  an edit has more than one minimal form, a hunk can sit somewhere else
  than git would put it. The patch still applies.
- `git diff` finds renames the way git does by default: `R100 old new` in
  `--name-status`, `old => new` in `--stat`, and `rename from`/`rename to`
  in the patch. `--no-renames` turns it off and `-M<n>` sets the similarity
  bar. Copies are not detected.
- `git add`, `commit` and `diff` see a symlink as a link. It is committed
  as mode 120000 holding its target, as git stores it, and checkout rewrites
  a link in place. They used to commit the file a link pointed at and show
  every link as modified, and a dangling link made `git diff` fail.
- A file rewritten with the same size and its mtime set back shows in
  `git diff`, `git status` and `git add -A`: git's stat cache now gets each
  file's real ctime and inode number. The first `git status` in an existing
  repository refreshes its index once, in one write.
- `-q` works on `init`, `commit`, `checkout`, `fetch`, `pull` and `push`.
  `commit` reads bundled short options, so `git commit -qm msg` commits
  "msg". It used to commit with the message "commit". `commit -a` stages
  tracked changes.
- `git add -A` of 10,000 2 KiB files takes 15 to 18 s in a deployed session,
  and 1,000 take 1.4 to 1.7 s. It used to rewrite the whole index once per
  file: 1,000 files took 34.5 s, and 10,000 were cut off after 283 s with
  half of them staged. The index is now written once, files are added one at
  a time, and objects are deflated with pako instead of `CompressionStream`,
  which costs about 9 ms a call in workerd.
- `git init` and `git clone` write the `.git/config` git writes, byte for
  byte: `core.filemode = true`, with no `symlinks = false` or
  `ignorecase = true`, and the remote and branch keys in git's order. A clone
  records the one branch or tag it fetched, as `git clone --depth 1` does. A
  `chmod +x` now shows in `git status` and `git diff`, and `git add -A`
  stages it. Repositories made earlier keep their config. Where it says
  `filemode = false`, the exec bit is ignored, as git ignores it, and
  `git status` no longer stages a mode change by itself.
- `git clone -b <tag>` and `git checkout <tag>` of an annotated tag detach
  HEAD at the commit the tag points to, as git does. HEAD used to name the
  tag object itself.
- A path that is a symlink on one branch and a directory on the other
  switches the way git switches it, through `checkout`, `reset --hard`,
  `merge` and `pull`: the link is replaced by a real directory, and the
  directory by the link. Nimbus used to keep the link and write the
  directory's files into whatever it pointed at, outside the repository,
  and a dangling link was never removed. Below the top of the worktree,
  checkout never writes through a link, as git does not. A directory the
  branch no longer has goes once its files have.
- `git checkout [<tree-ish>] -- <path>...` restores files from the index
  (or from `<tree-ish>`, staging them). Paths are relative to the working
  directory and may climb with `..`. One outside the repository, or one
  that names no tracked file, fails with git's message before anything is
  written.
- `git merge` updates the worktree and index to the merged commit. It used
  to move the branch only. `git reset --hard` keeps HEAD on its branch; it
  used to detach it.
- `git pull` writes only below the top of the repository. It used to
  rewrite every directory above it too, which fails with `EACCES` for a
  user who does not own them.
- `git ls-files --others` lists a file or link that sits where the index
  has a directory.
- A file rewritten with the same size in the second it was staged shows in
  `git diff`, `git status` and `git commit -am`. Its stat data still matched
  the index entry, and Nimbus trusted it. Now, as in git, an entry whose
  mtime is not older than the index file is compared by content, and writing
  the index marks such an entry whose file no longer matches it, so a later
  write cannot hide the change.

### Mounts: df, mount, /proc/mounts

- `NimbusFilesystemAuthority` gains an optional `mounts(cred)` listing of
  `NimbusMountEntry` (`mountPoint`, `source`, `type`, `options`, async
  `usage()` giving `{ size, used, available }` bytes or `null`).
  `SqliteFilesystemAuthority` derives it from the kernel mount table: the
  SQLite directories are one `/` entry, `/proc`, `/dev` and embedder kernel
  mounts follow, described by the provider's optional `describeMount()`. A
  wrapper adds its own mounts by overriding `mounts` and calling `super`.
- The `/` entry's numbers are real: size is the Durable Object storage limit
  (10,000,000,000 bytes), used is the file bytes stored, available is the
  limit less `ctx.storage.sql.databaseSize` (less the stored bytes on a host
  without it). `getStats().capacityBytes` and `stat -f` use the same limit;
  they used 10 GiB.
- One `df`, for hosted and local workspaces, reads the listing in GNU
  coreutils' format, with `-a`, `-h`, `-T`, `-k` and `df FILE...` (the mount
  a path lives on, by longest prefix). The hosted `df` printed one `sqlite`
  row plus cache and process lines; the local one printed a fixed 256 MB
  `vfs` after walking every file.
- `mount` lists the same table in util-linux's format (`-t` filters by type);
  it does not mount. `/proc/mounts` lists it in the kernel's format, for the
  reading process's credential.

### VFS

- Security: a confined principal can no longer follow a symlink out of its
  private `/tmp`. Its `/tmp` is stored at a private root such as
  `var/agents/a/tmp`, and symlinks were resolved against that storage path.
  So `/tmp/out -> ../../../../tmp/x` climbed out of the private root and read
  or rewrote the shared `/tmp/x`. A link to `/`, or to a directory above the
  root, let the rest of any path continue into the shared tree, and so did a
  relative link someone else had left outside `/tmp`. In a check of 5 link
  shapes and 21 operations, 39 of the 85 combinations reached the shared tree
  or another user's directory: reads, `stat`, copies, opened descriptors,
  in-place writes, and the creations described below. Links now resolve in
  the caller's own view, relative targets against the link's directory as the
  caller names it, so every link lands where naming its target directly
  would. `realpath` and descriptor-relative (WASI) lookups report the caller's
  names, so a confined process's links under a preopened `/tmp` no longer
  fail `ENOTCAPABLE`. Legacy registry symlinks are looked up by storage key,
  so a shared-`/tmp` entry is no longer visible to, or removable by, a
  confined caller.
- `mkdir` and `symlink` through a link to a directory now create inside that
  directory. They put the new entry under the link itself, where no lookup
  reached it, after checking permission on the link's target. A link in
  another user's directory let any caller put entries there, though it could
  not write that directory, and a symlink left that way made every later
  `list()` page fail. A batch or stream write places each entry at its
  literal path, so it now refuses a parent that is a link with `ENOTDIR`.
  `readdir` and `rmdir` through a link act on the link's target, which is the
  directory their permission checks already used.
- Opening a filesystem no longer reads its inodes. `SqliteVFS` used to load
  every inode into memory at construction and scan the table three more
  times. In bun that took 15-32 ms and 4.8 MiB of heap at 10,000 files, and
  1.45-1.65 s and 440 MiB at 1,000,000. It now opens in 2.2-5.3 ms (10 ms on
  a cold page cache) with 0.3 MiB of heap at every size. Inodes load by path
  through a cache of at most 65,536 entries (`inodeCacheEntries` in a new
  options argument). An inode that an open file description holds stays
  cached, so descriptions still share one inode object.
- A `list()` page of 8,192 entries is a range read of the path index and
  takes 8-19 ms at every size. At 1,000,000 files it took 243-329 ms, most of
  it sorting every path. `readdir` of 100 entries reads SQLite and takes
  36-61 µs up to 500,000 files and 49-78 µs at 1,000,000, against 32-43 µs
  with every inode in memory.
- `removeRecursive` reads its subtree 4,096 rows at a time, in descending
  path order, so each entry still goes before the directory holding it.
- The stats counters load with one aggregate on the first `getStats()`
  (67-113 ms at 1,000,000 files, over a second on a cold page cache) and are
  kept by delta after that.
  `getStats().inodes` gains `resident` and `cacheCapacity`; `total` still
  counts every inode in the filesystem.
- An npm-shaped `writeStream` of 6,188 files is 4-8% slower, because it
  reads SQLite for the paths it creates. Medians of interleaved runs:
  1,007 to 1,052 ms and 1,556 to 1,630 ms over 10,000 files, and 1,575 to
  1,637 ms and 1,237 to 1,334 ms over 1,000,000, on a loaded machine.
- When a `rename` fails partway through retiring its source, the counters
  and the cache now describe the groups that committed. They used to keep
  every source entry, so the counters overstated what SQLite held.
- Per-path revisions are held under a 16 MiB budget (`pathRevisionBytes`).
  Past it the oldest quarter is dropped, and a dropped path reports the
  newest revision dropped: never 0, and never below its own last change.
  Writing 300,000 files in one lifetime used to keep a revision for every
  path, and held 81.6-98 MiB of bun heap even with the inode cache bounded;
  it now holds 69.6 MiB, 91,718 revisions of them. A dropped path can report
  a higher revision with nothing under it changed, so a resident store
  repairing a poison refetches the rows dated below the floor.
  `getStats().pathRevisions` reports the paths and bytes held, the budget
  and the floor.
- A confined caller's private `/tmp` files are dated by their own revisions:
  in `list()`, in the filesystem bridge's `stat()` and `revision()`, in the
  checks behind conditional reads and writes, and in mutation receipts. All
  of these took the shared `/tmp` file's revision, looked up under the
  caller's name for its own file. ACQUIRE deltas now name paths as the caller
  does: its private `/tmp/x` as `tmp/x`, and a path it has no name for, such
  as the shared `/tmp/x`, not at all. They named the storage key, so a peer's
  write to a confined process's `/tmp` file never evicted the copy the
  process held, and a write to the shared file evicted it instead.
- An ACQUIRE delta names only the paths its caller may see, and still
  covers every change to what it holds. It named every path the caller had a
  name for, so a resident process was told the names of files in another
  principal's private `/tmp` and in directories it cannot read. Now a path
  the caller may not see (below a directory it cannot enter, or in a
  directory that has since been removed or renamed) is reported as the
  nearest directory above it that the caller may see, marked `subtree`, and
  a directory removed, renamed away, or given another mode, owner or group
  is marked `structural`. The resident store and the Node shims evict
  everything at or under an entry with either flag. So a directory made
  private stops a store serving what it held there, a private `rm -rf`
  costs one entry and names nothing inside it, and a directory made private
  and then removed still evicts the files it held. `list()` checks a
  confined caller's own directories, not the storage directories that hold
  its `/tmp`.
- A watch (`subscribe`, under `fs.watch`) follows the caller's view. A
  confined caller watching `/tmp/x` watched the shared `/tmp/x`: its own
  writes never fired, and the shared file's did. Events now carry the
  caller's names, and only for paths it may see.
- The W7 write-batch checksums are computed by `node:zlib`'s `crc32` where
  the host has it (bun, node, workerd with `nodejs_compat`), for inputs of
  128 bytes or more, and by a slicing-by-8 table otherwise. The checksum
  loop used to iterate each byte with `for..of`. Encoding plus decoding
  5,000 files of 4 KiB in bun went from 760-860 ms to 100 ms, and in
  workerd from 916 ms to 375 ms. With 512-byte files workerd is unchanged.
  The checksums on the wire are the same values. Zip archives
  (`createZip`) use the same function, `@nimbus-sh/platform/crc32.js`, and
  core has no CRC-32 of its own.

### Runtimes

- `NimbusWorkspace.create({ facets, runtimes })` throws when a supplied
  runtime package names a runner this core does not register, and the error
  names the package and version, the runner it needs and the runners core
  provides. It used to install the package and leave its bins as "command not
  found": core 0.11.0 and 0.12.0 with `@nimbus-sh/runtime-bash@5.2.37` (built
  for `bash-runner`, while core registers `bash-runner@2`) answered every
  `bash` with exit 127. A workspace without `facets` is unchanged, because its
  host binds runners after create. So are `nimbus install`, which falls back
  to the newest catalog version whose runners are registered, and
  rehydration of installed trees.
- `@nimbus-sh/core` no longer publishes ahead of its runtime packages.
  `prepublishOnly` runs `scripts/check-runtime-packages.mjs`, which builds
  every runtime package with `bundle-runtime.mjs --npm-package` and fails
  unless each one is on npm at its version, with the same `manifest.json`,
  as `dist-tags.latest`, and installs through the core being published. Each
  failure prints the command that fixes it.
- Publishing no longer builds. config, platform, core, fabric, loom, sdk,
  react, cli and worker dropped `prepack: bun run build`; their
  `prepublishOnly` runs `scripts/dist-integrity.mjs --publish`, which refuses
  a package directory that differs from HEAD or a dist that is not the
  fixpoint of its src. The tarball used to come from a fresh publish-time
  build that git never saw. react and cli joined dist-integrity's packages.

## 2026-09-23

### esbuild

- `esbuild` in the shell is the real esbuild CLI, 0.24.2's own Go program, run
  in the session's esbuild facet (the one that already ran its transforms) as
  the calling user from the working directory, with its output streamed back
  as it is written. Its flags, defaults and messages are esbuild's: entry points,
  `--outfile`, `--outdir` and `--tsconfig` resolve against the cwd, outputs
  belong to the user, and a build with neither output flag writes to stdout.
  It used to write `/dist/...` as root.
- The build no longer runs in the session's isolate. esbuild-wasm's memory
  (28 MiB at init, 76 MiB after one React bundle, never released) used to stay
  there, and `nimbus install python` after a few bundles reset the session
  with exceededMemory.
- `--watch` and `--serve` are refused, because each invocation is one build.
- `vite build` bundles in that facet too, each build with a fresh esbuild
  that is dropped afterwards. Resolving and loading still read the session's
  files. Three React builds in a row used to take the session isolate to
  150-186 MiB, and on main one run in three reset. Now it peaks at
  101-109 MiB.
- A launch sends its ESM modules to the esbuild facet in 4 MiB slices. A
  slice whose call fails (the facet reset, the connection dropped) is sent
  once more to a fresh facet. If it fails again, only its own modules fail,
  and only for that launch. It used to fail every module of the launch,
  including the ones already transformed.

### Runtimes

- `node main.mts` and `node main.cts` compile their entry as TypeScript, as
  `.ts` and `.tsx` entries already did. A `.cts` entry is CommonJS TypeScript
  even in a `"type": "module"` package. Both used to reach the facet
  uncompiled and fail on their first type annotation or `import`.

## 2026-09-21

core 0.11.0, worker 0.9.0, sdk 0.8.0, fabric 0.7.0, platform 0.5.0,
cli 0.1.11, react 0.1.7, loom 0.1.3.

### One filesystem authority

- Every filesystem call from the shell, Node, Python, Ruby, Clang and Bash
  goes through one credential-bound authority with live descriptors. The
  per-process snapshot and diff transport is gone; a guest reads and writes
  the same inodes the shell does, and permission denials come from the same
  check.
- Read-only opens of regular files are resident descriptors keyed by inode
  and validated by stat revision: one stat per open, one read per revision.
  CPython's `import urllib.request` went from 1,330 supervisor round trips
  to 254.
- Descriptor reads, writes and closes are native supervisor ops; the worker's
  read accounting is a `readLease` hook on the op tools.
- `unlink` on a missing name answers ENOENT again; `rm` and `rm -f` differ.

### Runtimes and catalog

- A runtime rebuilt against a new runner contract publishes under a new
  version whose manifest names a new runner key (`bash-runner@2`,
  `BASH_RUNNER` in `os-contracts`). `RuntimeManager` resolves a bare name to
  the newest catalog version this workspace can bind; an explicit
  `name@version` is refused rather than substituted. `bundle-runtime.mjs`
  gained `--keep-default` and lists versions in publish order.
- bash 5.2.37-2: every WASI and `nimbus_proc` import instrumented for
  Asyncify, cwd capture, real `F_GETFD`.

### Platform fixes measured on workerd

- Durable Objects SQLite binds at most 100 parameters per statement
  (`SQL_MAX_BOUND_PARAMETERS`); every batch and IN-list is sized from it.
  A 12-column inode row had crossed it and broken npm installs of nine or
  more files.
- A facet's fixed-length Response returned as-is across the port hop fails
  "disconnected prematurely" on workerd 1.20260811.1+ and truncates under
  gzip; the hop now relays bodies through an isolate-owned stream.
- workerd's RPC promise is a callable thenable, not a Promise; the
  supervisor adapter detects it by shape and never takes a synchronous view
  from a stub.
- WASI guests keep POSIX semantics: absolute paths under the cwd preopen,
  directory opens with write rights requested, `fd_allocate`, `path_link`.
- `node:module` answers `enableCompileCache` and `isBuiltin` (pi's CLI
  entry calls the former unconditionally).

### Deploy

- The Worker ships minified with its source map uploaded: 4.12 MB raw,
  1.12 MB gzipped.

## 2026-09-22

For embedders that host Nimbus under their own Durable Object namespace.
Ships in the same versions as the release below (core 0.12.0, worker
0.10.0, platform 0.5.1, fabric 0.7.1), which had not been published yet.

### Fabric

- The route back to the host (namespace binding, dispatch method,
  supervisor entrypoint) is minted into every binding the fabric hands a
  program, in the host's isolate, and the entrypoints that answer those
  bindings (`SupervisorRPC`, `NimbusAssetsRPC`, `NimbusDOStub`,
  `NimbusLoadedEntrypoint`, `CirrusHmrRPC`) read it from their props. A
  facet whose call landed in an isolate with no composition, or another
  host's, was refused with "env.NIMBUS_SESSION is not a Durable Object
  namespace"; it now reaches the host that minted its binding. Fan-out peers
  and peer process hosts mint the coordinator's route, not their own.
- `composeFabric` called again with different values throws, naming both
  compositions. It was first-write-wins and silent, so a Worker that
  imported Nimbus's own entry and composed its own host ran against a host
  it never named.
- The bare workspace's refusal of a host op names the contract: forward
  `supervisorOp` to a hosted runtime on every instance of the namespace,
  the siblings Nimbus opens by name included.

### git

- `git -C <path> …` runs the subcommand from `<path>` (repeatable, each
  relative to the previous). `--no-pager`/`-P` are accepted. Any other
  leading option is refused instead of being run as the subcommand.
- `git branch --show-current` prints the current branch (nothing on a
  detached HEAD). It used to create a branch named `--show-current`; an
  unrecognized option is now refused rather than taken as a branch name.
- `git clone -q`/`--quiet` clones without progress output; `-v`/`--verbose`
  is accepted.

### Signatures

- `HostRoute` and `hostRoute()` are exported from
  `@nimbus-sh/platform/composition.js` (re-exported by the fabric).
- `hostNamespaceBinding(env, usage, route?)` and
  `hostOpDispatch(stub, usage, route?)` take an optional route.
- `supervisorEntrypoint(exports?, name?)` takes the entrypoint name.
- `ResidentSupervisorProps.route: HostRoute` is required;
  `HostProcessOpts.route: HostRoute` is required;
  `IsolatePoolOptions.supervisorRoute?: HostRoute`.
- `SupervisorOpDispatch` names the handler type
  `createSupervisorOpHandler` returns (was `ReturnType<…>` at consumers).
- `parseCloneArgs` returns `quiet: boolean`; `parseGitGlobals(args, cwd)`
  is exported from the worker's git commands.

## 2026-09-21 (third release)

For embedders composing the hosted runtime. Every public signature that
changed is listed under "Signatures". Published as core 0.12.0, worker
0.10.0, platform 0.5.1, fabric 0.7.1, sdk 0.8.1, cli 0.1.12, loom 0.1.4;
the carets are minor-strict, so every range moves.

### npm

- `NPM_REGISTRY` is honoured end to end: the hosted `npm install`, `npm
  install -g`, `npx` and `npm create` paths read packuments from that
  origin; the resolve facet asks the supervisor for that origin; the shared
  R2 packument cache keys per origin, so a mirror never serves, nor fills,
  the npmjs entries. The value is normalized once, where the command reads
  it (blank is unset, a trailing slash is trimmed).

### VFS

- Construction writes nothing to a store that is already current. The
  identity row, the device row, the inode allocator seed, the ino backfill
  and the schema migration marker are each preceded by the read that
  decides them, and every DDL step is `IF NOT EXISTS`. A `SqliteVFS` opens
  over a readonly SQLite handle and reads; a write on it is refused by
  SQLite, not by the open.

### Hosted runtime

- `composeHostedRuntime(...)` returns `facets()`, the composed facet
  manager, beside `files`, `runtimes` and `terminal`.
- `@nimbus-sh/worker/workspace-host` re-exports the
  `LongRunningWorkerSpawnOptions` type with `WorkerRecipe` and
  `ResolvedWorkerLaunch`.
- Five subpaths join the `@nimbus-sh/worker` export map, under the paths an
  embedder was deep-importing: `./session/programmatic`, `./session/rpc`,
  `./session/supervisor-rpc`, `./session/routes` and
  `./runtime/package-manager`.

### Signatures

- `NpmInstallPort.install(spec)`: `spec.registry: string` is required (the
  normalized origin). Core and worker.
- `NpmInstaller.install(cwd, opts)`: `opts.registry?: string`.
- `resolveNpxBinary(installer, vfs, cwd, args, log, pid?, registry?)`: one
  trailing optional parameter.
- `R2CacheClient.getPackument(name, registry?)`,
  `putPackument(name, json, registry?)`,
  `readThroughPackument(name, { retries?, timeoutMs?, registry? })`;
  `packumentUrl`, `packumentKey`, `packumentL2Url` take `registry?` last.
  The default is unchanged.
- `npmRegistryOrigin(configured)` and `NPM_REGISTRY_ORIGIN` are exported from
  `@nimbus-sh/core/substrate/lifo/commands/system/npm.js` and re-exported
  from the worker's `npm/r2-cache.js`.
- `composeHostedRuntime(options)`: `options.resolveWorkerLaunch` is a flat
  option (it moved out of `hooks` in the 0.9.0 line); `facets()` is added to
  the return. `composeFacetManager(deps)` requires `deps.filesystem`
  (unchanged this release, listed because the previous handoff omitted it).

## 2026-09-21 (second release)

### npm: nested placements

- A dependency whose range the root copy does not satisfy is installed
  under its dependent (`<dep>/node_modules/<name>`) instead of being
  hoisted broken; peer dependencies reuse whatever the host's walk finds
  and never nest. The lockfile keys placements by path; a tarball placed
  twice in one batch is fetched once.

### Node facets

- One compile helper for the one-shot and long-running facets: a required
  module that keeps its shebang (pi 0.87.0's `cli-runtime.js`) compiles in
  both.
- A facet's own partial mutation (ranged write, truncate, utimes, chmod,
  chown) holds its resident cell under a lease until the authority's
  receipt settles it; a barrier answered ahead of the write no longer
  evicts the bytes the program just wrote.
- The ESM transform cache is bounded by bytes and reported to the heap
  model; the two retained caches share the room the ceiling leaves. A
  pi-sized tool's second launch no longer resets the session.
- `node -` runs the program on stdin, arguments after `process.argv[1]`.

### Session

- A session with a running resident process holds itself in memory on an
  alarm cycle while a client is present (an attached socket, or a request
  within the last sixty seconds), instead of being evicted after ten idle
  seconds. Past that, it idles out as before and the launch journal
  re-drives the process when the client returns. (Bounded 2026-09-22; the
  first cut held every abandoned dev server forever.)
- `wait $!` answers a successful job's status instead of 127.
- `/api/_diag/memory` reports the prefetch cache's entries, revisions and
  miss profiles.

### Deploy

- The esbuild-wasm JS adapter is a staged asset beside its wasm, digest
  checked; the Worker bundle drops back under the repo's 7.0 MB tripwire.

## 2026-09-19

core 0.10.0, fabric 0.6.0, worker 0.8.0, sdk 0.7.0, loom 0.1.2, cli 0.1.10,
react 0.1.6.

- Add supported runtime composition for application-owned Durable Objects through
  `@nimbus-sh/worker/workspace-host` and `@nimbus-sh/worker/facet-host`.
  Hosts retain ownership of storage, alarms, and lifecycle.
- Share workspace commands, runtimes, processes, terminals, and port routing
  with NimbusSession. No private Session adapter or fake WebSocket boot is required.
- Add instance-scoped runtime provisioning with eager and on-demand installation,
  verified rehydration, and interrupted-install recovery.
- Fix opencode byte output and dynamic-import analysis. Bundled provided packages
  now use the same runtime adapter as ordinary package imports.
- Fixed compiler privilege escalation: `EsbuildService` now accepts a
  `CredentialedVfs` instead of a raw `SqliteVFS`. Embedders compiling authored
  code must pass the author's view (`new EsbuildService(vfs.as(authorCred))`);
  kernel callers explicitly pass `vfs.as(CRED_KERNEL)`. Transform-only use
  still needs no VFS. Absolute and transitive imports cannot read beyond the
  supplied view's authority.
  (Superseded in Unreleased: it now takes a `NamespaceFs`,
  `filesystem.namespaceFs(cred)`.)
- Fixed failed VFS metadata writes publishing uncommitted times, modes or
  ownership in memory. Added `SqliteVFS.withTransaction(callback)` for embedders
  committing their SQL rows together with filesystem writes: rollback restores
  the inode/content mirror, and revisions/watch events publish only on commit.

## 2026-09-15

worker 0.7.0, sdk 0.6.0, core 0.9.0, fabric 0.5.0, platform 0.4.0,
config 0.2.1.

### @nimbus-sh/core (breaking)

- **Bytes, not text, on process output hooks.** `onStdout`/`onStderr` on
  lifo `Sandbox`'s `CommandOptions`, the shell's `ExecuteOptions`, and the
  shell-entrypoint/programmatic surfaces now receive `Uint8Array`, not
  `string`. Migrate with `new TextDecoder().decode(data)` or the exported
  `textSink` from `@nimbus-sh/core/_shared/bytes.js`. This fixes binary
  protocols (esbuild's service packets, image/archive pipes) mangling to
  U+FFFD through the parent→child stdin and child→parent stdout relays.
- `NpmInstallPort` shape change: `install` takes a spec
  (`{ projectDir, packages, global, globalBinDir, production, npmLog,
  onProgress }`) — the arg parsing, prefix derivation, and end-of-install
  summary moved into the core command; the port owns only the installer
  and bin materialisation. `registerLocalBins` is gone from the port path.
- `npm install` parity: policy refusals become advisories, platform gates
  stay refusals — a package the runtime cannot run is refused with its
  reason instead of silently skipped; transitive 'warn' rejects retired;
  toolchain installs like plain JS; devDependencies are required roots;
  unsupported native packages are skipped without aborting the install.
- `exec` lifetime: a user-invoked program has no wall-clock lifetime —
  the 30s internal cap and its deadline machinery are removed; Ctrl-C now
  wires to the run's abort signal so a kill ends the run as a signal, not
  a crash.

### @nimbus-sh/worker

- Child stdout/stdin carry `Uint8Array` end to end (see core breaking note):
  process output hooks, the durability stub, and the terminal/log-ring
  decoders all consume bytes, decoding at the edge per stream.
- Cell `import()` resolves through the cell's own require — fixes Vite's
  dynamic `import("node:http")` returning a server that bound no port.
- Every wasm image in a program's closure is a module-map entry by digest,
  and a `WebAssembly.Module`/`compile`/`instantiate` seam answers
  registered bytes (tagged by path or by content) — so a package's own
  synchronous wasm compile works instead of being refused at request time.
- `box.files.as(cred)` — a credential-bound view of the session file plane
  for embedders.
- `composeFacetManager` — one facet-manager composition shared by the
  session and embedders; worker launches carry text modules and a main
  module and return their facet.
- Public URL per process: `nimbus expose <port> --public` serves with the
  capability alone (no Authorization); removal releases it.
- The durability stub decodes the byte relay before inspecting it; a kill
  reports exit as a signal; a hibernated object's shell rebuilds on the
  waking socket; exec bundle builds page across DO turns so `node -e` in
  a 752-package tree starts without a bundle deadline.

### @nimbus-sh/sdk

- `exec`/`startProcess` resolve a relative `cwd` against the sandbox root
  before the RPC leaves the client; the session rejects a non-absolute cwd
  with a field-named error.
- Command output hooks consume `Uint8Array` (see core breaking note).

### @nimbus-sh/fabric

- `materialize` takes images one at a time (async iterable) instead of all
  at once — a resident launch no longer holds the whole image set.
- Loader cache key carries the baked supervisor identity; IsolatePool
  dispatches serialize per slot.

### @nimbus-sh/platform

- A credit claim that can never be granted is refused, not parked — the
  FIFO no longer stalls the whole isolate behind one oversized request.

### @nimbus-sh/config

- Patch bump; no user-visible change.

## 2026-08-11

The first publish since 2026-06-06. Everything on npm until now was built from
that day's tree, so the jump is large — this entry covers only what changes for
someone consuming the packages, not the several hundred commits behind it.

### Background Processes (breaking)

- `startProcess` now returns as soon as the command has a pid, instead of
  waiting for it to finish. Until now it awaited the command to completion and
  then guessed which pid it had started by diffing the process table, so
  `sleep 5` took five seconds and dev servers, watchers, and anything else
  long-running were impossible.
- `NimbusStartResult` changed shape to match: it is now
  `{ command, pid, process, ports, startedAt }`. The exec fields it used to
  carry — `exitCode`, `stdout`, `stderr`, `success`, `duration`, `timestamp` —
  are gone, because they described a finished command and cannot describe one
  that has just started. `pid` and `process` are no longer nullable.
- Read the output and the exit through `processes.logs(pid)`, which returns a
  cursor, the chunks since that cursor, and the exit record once it lands. Or
  use `processes.attach(pid)`, which is async-iterable and can also write to
  stdin, resize, signal, and kill.
- **If you read `exitCode` or `stdout` off a `startProcess` result, that code
  needs updating.** This is the reason both packages move to `0.2.0` rather
  than a patch: a `^0.1.x` range will not pick the new versions up, which is
  deliberate.

### Files

- Added `files.lstat`, `files.rename`, `files.chmod`, and `files.readRange`.
  `readRange` reads a window of a file without materializing the whole thing.
- `processes.logs` is now typed as `NimbusProcessLogsResult` instead of
  `unknown`.

### Port Previews

- Added preview host URLs — `<port>--<session>.<suffix>` — alongside the
  existing path-style previews. Set `NIMBUS_PREVIEW_HOST_SUFFIX` on the
  deployment; `Nimbus.fromEnv` reads it off the bindings, and remote clients
  pass `previewHostSuffix` in config. A preview host reaches the port forward
  and nothing else.
- Added `isPreviewHostRequest` and the `@nimbus-sh/worker/preview-host`
  subpath.

### Session Agent

- Added the session agent and its Cloudflare OAuth surface, with the
  credentials held in encrypted cookies. `@nimbus-sh/config` takes an optional
  `agent` block; the secrets stay out of it and belong in
  `wrangler secret put`.

### Fixes

- Fixed remote `files.write` throwing after the write had already landed. The
  client validated the result against `z.undefined()` while the Durable Object
  answers with the byte count it wrote. This one never reached npm — it was
  introduced and fixed between releases — but it is here because anyone
  tracking `main` in that window hit it.
- `nimbus session new` authenticates with a bearer token.

### Packages

- Published:
  - `@nimbus-sh/worker@0.2.0`
  - `@nimbus-sh/sdk@0.2.0`
  - `@nimbus-sh/cli@0.1.8`
  - `@nimbus-sh/react@0.1.4`
  - `@nimbus-sh/config@0.1.4`
- Unchanged, not republished: `create-nimbus-app@0.1.6`.
- `@nimbus-sh/react@0.1.4` is a range fix and nothing else — every shipped
  file is byte-identical to `0.1.3`. Its peer on the SDK was `^0.1.4`, which
  npm cannot satisfy with `0.2.0`, so installing the new SDK beside the React
  component failed to resolve. It now accepts `^0.1.4 || ^0.2.0`. The
  component imports nothing from the SDK — it is an iframe wrapper — so the
  breaking type change does not reach it.
- `@nimbus-sh/sdk` needs `@nimbus-sh/worker` at the matching major-equivalent
  range: it imports `@nimbus-sh/worker/preview-host` at runtime, and that
  subpath does not exist before `0.2.0`.

## 2026-06-05

### Open-source Alpha

- Added root and package-level MIT license files.
- Added third-party notices for runtime and package dependencies.
- Added contribution, security, code-of-conduct, issue-template, and
  pull-request-template docs.
- Updated public README positioning for the free self-hostable alpha and the
  hosted demo limits.
- Switched the public workspace lockfile to `bun.lock` and removed the old
  npm lockfile.
- Removed wall-clock timestamps from generated worker bundles.

### Packages

- Published:
  - `@nimbus-sh/worker@0.1.3`
  - `@nimbus-sh/config@0.1.2`
  - `@nimbus-sh/sdk@0.1.3`
  - `@nimbus-sh/react@0.1.2`
  - `@nimbus-sh/cli@0.1.6`
  - `create-nimbus-app@0.1.5`

## 2026-06-04

### Sandbox SDK

- Added the programmatic sandbox SDK in `@nimbus-sh/sdk/sandbox`.
- Added direct Worker/Durable Object binding support with `Nimbus.fromEnv(...)`.
- Added authenticated remote sandbox access with `Nimbus.connect(...)`.
- Added sandbox lifecycle, command execution, code execution, files, runtimes,
  processes, preview ports, capability reporting, and tool-provider helpers.
- Added runtime policy enforcement for allowed, preinstalled, and on-demand
  runtimes.

### Worker Embedder

- Added the public remote SDK API route under `/api/nimbus/v1`.
- Added tenant-scoped session IDs and SDK-safe sandbox IDs.
- Updated the hosted-demo app to use the same SDK-facing Worker entrypoint that
  generated apps use.
- Added live SDK smoke routes for direct-binding and remote-client paths.

### Packages

- Published:
  - `@nimbus-sh/worker@0.1.2`
  - `@nimbus-sh/config@0.1.1`
  - `@nimbus-sh/sdk@0.1.2`
  - `@nimbus-sh/react@0.1.1`
  - `@nimbus-sh/cli@0.1.5`
  - `create-nimbus-app@0.1.4`

## 2026-05-16

### Workspace And Auth

- Restructured Nimbus as a Bun workspace with packages for the Worker runtime,
  SDK, React bindings, CLI, config helper, and hosted-demo app.
- Added HS256 JWT session tokens with tenant and subject isolation.
- Added authenticated and legacy-public Worker handler modes.

### Worker Assets

- Moved large runtime assets out of the Worker bundle and into the Workers
  Assets binding.
- Added asset loading helpers with isolate-local caching and concurrent request
  deduplication.

## 2026-05-11

### Runtime Surface

- Added Python and Ruby runtime support.
- Added Node and Bun REPL surfaces appropriate for the Workers runtime.
- Expanded WASI preview1 support, including file metadata, symlinks, outbound
  TCP, socket shutdown, and polling.
- Added clang support for WASI programs, multi-file compilation, user headers,
  and WASI execution.

### Shell And Compatibility

- Expanded shell behavior across redirects, pipelines, command substitution,
  heredocs, symlinks, process variables, and common Unix utilities.
- Improved package resolution for `package.json` `main`, `exports`, and
  `imports` fields.
- Added behavioral probes for runtimes, package installation, shell behavior,
  WASI, framework execution, and preview routing.

## Earlier

- Established the Durable Object session model.
- Added the SQLite-backed virtual filesystem.
- Added npm install support with R2-backed package caching.
- Added Worker Loader based execution facets.
- Added process logs, preview routing, Vite integration, and session recovery.
