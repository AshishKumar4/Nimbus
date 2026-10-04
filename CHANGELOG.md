# Changelog

All notable Nimbus releases are summarized here. Package-level versions are
published independently in the `@nimbus-sh` npm scope.

## Unreleased

- Fixed: a process whose release failed (a descriptor's buffered bytes lost
  to an abort) stopped the prune of a session's or workspace's ended
  processes: that pid and every one after it stayed bound to the
  filesystem, and an unrelated launch that pruned first failed with the
  other process's error. Every ended entry is now released and forgotten.
  A prune by age writes a failure to the failed process's own stderr log; a
  workspace exec reports its own tree's failures after all of it is gone.

## 2026-10-03

Published as core 0.15.0, worker 0.13.0, fabric 0.10.0, sdk 0.11.0, cli
0.2.2, loom 0.2.2, react 0.2.2; platform 0.7.0 and config 0.2.3 are
unchanged. The carets are minor-strict, so every range on core, worker,
fabric and sdk moves. Breaking for embedders: `NimbusWorkspace.fs` is a
`WorkspaceFs`, no longer a `ProcessView`; and core's
`PYTHON_SITE_PACKAGES_ROOT`, `PYTHON_PYODIDE_PACKAGE_MANIFEST` and
`defaultGemHome` give way to `pythonSitePackages(home)` and
`gemHomeFor(home)`; and a mount's readdir type `file` now means a regular
file, so a mount that cannot tell must answer `unknown`; and
`NimbusWorkspace.exec` without a `shellId` is one-shot, so a caller that
relies on `cd` or `export` persisting passes a `shellId`; as described
below.
- `@nimbus-sh/core`: the library host's `node` runs each program in a realm
  of its own, a worker thread, where it ran in the host's realm through
  `new Function` (Kinu ask 17). A program that rebound `globalThis.Array`,
  installed fake timers or patched `Object.prototype` changed them for the
  embedder too: in Kinu's CLI, `Array.isArray = () => true` broke the host's
  SQLite filesystem. Now its globals and built-ins are its own. With it: an ES
  module is strict, as in Node (a write to a frozen property throws where it
  was silent); an aborted call (kill, Ctrl-C, `signal`) terminates the
  program even in a loop that never yields, where it held the host for good;
  `readFileSync(0)` waits for stdin to end, also when it arrives in pieces,
  where it threw; and timers the program leaves run before the command ends,
  where they were dropped (`process.exit()` in one exits with its code, and
  a rejection nothing handles exits 1, as in Node, a server listening or
  not; an ES module whose top-level await never settles exits 13). A
  program lives as long as its event loop has work: its timers, a server it
  listens with (a server a timer starts included), a request it is waiting
  on; a trivial ES module no longer waits 150 ms, nor one that loads `http`
  without serving up to 10 s. The host answers only the realm's own calls,
  so a program cannot end it. It needs `node:worker_threads` (Bun and Node).
  Each run takes about 16 ms more to start, and each synchronous filesystem
  call about 0.1 ms more.
- Under `wrangler dev`, a Worker calls a classic Durable Object binding as on
  Cloudflare. `env.P.get(env.P.idFromName('x')).hello()` threw "Could not
  serialize object of type "RpcPromise"": `env.P` was a WorkerEntrypoint, so
  `idFromName` answered an RpcPromise that `get()` could not take, and its
  stub had no method but `fetch`. Now the bundle's first import replaces
  `env.P`, in the env every handler, entrypoint and object of the Worker's
  isolate sees, with a local namespace: ids and stubs are made at once, and
  a stub is an RPC stub of a local target that relays each member its caller
  reaches (a call, a read, a path through both, fetch included) to the
  session, which reaches it on the object's facet. Checked against plain
  workerd with a real namespace, Nimbus answers the same for calls,
  arguments and answers, a thrown error, pipelining, KV and SQL storage, the
  object's env, getters (`await stub.value`, `stub.obj.nested.y`,
  `stub.obj.f()`), `Object.keys` of a namespace, id and stub, RpcTargets,
  stubs (an object's own included) and functions passed and returned,
  streams and responses returned, dup, dispose, `using`, a namespace refused
  in a Worker Loader env, default exports whose fetch is on the prototype or
  not enumerable, a Worker that exports `NimbusDurableObjectClasses` itself,
  and what RPC does not reach: Symbol keys, `constructor`, `__proto__`, a
  private field, `then` on a member, and the stub's tag ("[object
  DurableObject]"). Two differences remain, documented as limits in the
  fabric README: `typeof stub` is 'function', and a Worker Loader env cannot
  carry a stub ("RpcStub cannot be serialized in this context because it is
  not a persistent stub"), since Nimbus's loader loads a child again in each
  later request. The Worker is loaded once, with its full env, and a binding
  whose class it does not export fails the build (the check runs the
  Worker's module code, so an error there is the build's too); before, a
  probe load without env came first, and a missing class failed only the
  object's first call.

- Fixed: `vite build` printed its entry as a storage key ("Entry:
  home/user/app/src/main.tsx", and the same in "Bundling" and its timeout),
  and `vite`'s "Root:" and "Config:" lines did too. They print the path
  ("/home/user/app/src/main.tsx").
- A read or write through a SQLite link that leads into a mount below its
  point (`/home/user/dir -> /s/top`) reaches the mount. A process's bridge
  resolved such a link's target inside SQLite, where `/s` is nothing, so
  every read and write through it answered ENOENT, on a synchronous mount
  as on an asynchronous one; a link to the mount point itself worked. The
  bridge now walks the target component by component, as it walks the rest
  of the path, naming a relative target from the link's directory as the
  engine names it.
- An exclusive-mutation lease holds on an asynchronous-only mount where a
  mutation lands, as on a synchronous one. A process's mutation there is
  awaited through the namespace once the synchronous walk refuses it, and
  that path checked no lease at the name its lookup reaches: with a lease
  on `m/leased`, a write, rename, unlink, mkdir, chmod, truncate, symlink,
  remove, copy or open for writing through `/home/user/alias -> /m`, or
  relative to a descriptor open on the mount, went through, and so did a
  write, truncate, chmod, chown or utimes through a descriptor opened before
  the lease. The namespace now refuses them itself: `CompositeVFS.guardMutations`
  takes a guard that every mutation a credentialed view makes is checked
  against, at the name it was given and on the route the namespace resolved,
  right before the backend is called, so what is checked is where the
  mutation goes even if a link on the way is repointed meanwhile. Each raw
  backend mutation is checked, after the reads it waited on: every write,
  link and directory of a copy across filesystems, every unlink of a walked
  removal (a refused entry is kept and reported, as rm -r does), and rmdir's
  unlink on a backend without rmdir. A process
  namespace's guard is the engine's lease (`SqliteVFS.mutationRefusal`, the
  one definition its own mutations use too). A write through a dangling link
  into the lease is refused, and unlinking that link is not. An awaited write
  with `createParents` makes the directories above where it lands (a link's
  target's, as the synchronous bridge does), not the link's own; the
  namespace's `writeFile` and `writeRange` take `parents` for that. An
  awaited `open` with O_NOFOLLOW on a trailing link answers ELOOP, as the
  synchronous bridge does, and a descriptor opened on an asynchronous mount
  keeps the file it opened: it re-resolved its path on every call, so a
  link on the way repointed after the open moved its writes to another
  file. A process's release and a host lease's disposal finish their
  teardown (every descriptor, the scope, the process's binding and its
  append writers) before they report a descriptor whose last flush failed,
  as `EIO: its buffered writes are lost (...), close '<path>'`; they stopped
  at that flush, which an aborted binding's own view refuses, and left the
  scope open to every other bridge on it. A node program's write-back refused with EROFS or
  EBUSY is the authority's verdict (nothing landed), no longer a durability
  failure reported at exit.
- A link on a `resolvesPaths` mount whose target a mount nested in it
  covers belongs to that backend. With `/pc` read-only holding
  `/link -> /inner/x`, and a writable mount at `/pc/inner`, the namespace
  named the target `/pc/inner/x`, the nested mount's file: a node program's
  `fs.promises.writeFile('/pc/link')` wrote the nested `x` past `/pc`'s
  EROFS, and the shell's `realpath` and `readlink -f` named it. The backend
  follows the link to its own `/inner/x`, which the namespace has no name
  for, so `CompositeVFS.linkLeadsTo` (and a process's `linkLeadsTo`) now
  answers null there, and each caller hands the link's own path to the
  namespace instead: the write is `/pc`'s EROFS, a read is the backend's
  bytes, `realpath /pc/link` names `/pc/link` (as the namespace's realpath
  does), a launch takes what the link leads to as unknown rather than absent,
  and a lookup beneath a preopen inside the mount refuses it (ENOTCAPABLE;
  VFS-COMP-006 refuses it too). A node program's asynchronous write to a
  name its launch did not list is now parked and written back like any
  other, the authority answering for it as for its asynchronous rename,
  where it answered EAGAIN: a synchronous read after it is the bytes
  written, and a refused one drops them.
- The `python3` prompt starts in the shell's working directory, as the
  `ruby` prompt does: once per interpreter, keeping the directory the
  program's own `os.chdir` left on later lines, and refusing one it cannot
  enter (`python3: can't enter working directory '/x': [Errno 44] No such
  file or directory`). It started in `/`, so `open("hello.txt")` at the
  prompt looked in the root.

- Fixed: a filesystem refusal kept its reason only in its `cause`. A
  confined principal's widening `chmod` reached the caller as "EPERM:
  operation not permitted, chmod" and lost "use u+x". Every SqliteVFS
  refusal now carries its reason as its own field, kept when a layer
  rewords the error for its call (`VfsError.detail`).
- Fixed: `normalizeVfsPath('/../home/main/SOUL.md')` kept the leading `..`
  (`../home/main/SOUL.md`), and `resolveVfsPath` too. `..` now stops at the
  root, as POSIX resolves it, and Composite's `normalizePath` is the same
  normalizer. A symlink whose target climbs past `/` now lands at the
  caller's own `/`, as on Linux, where it led nowhere before; a confined
  principal's view is unchanged in what it can reach (its own `/`).
- Fixed: shell errors named a storage key and Node's message:
  `ls /tmp/spoon` printed "ENOENT: no such file or directory, stat
  'tmp/spoon'". `ls`, `chmod`, `cp` and `mv` now print GNU's words with the
  operand as written ("ls: cannot access '/tmp/spoon': No such file or
  directory"), and a refusal's own reason where it gives one; so do `rm`
  ("cannot remove"), `ln -s` ("failed to create symbolic link"), `cd` (as
  bash words it) and `chown` ("cannot access" for a name it cannot look
  up, "changing ownership of" for a change the filesystem refuses). The shell's four
  strerror tables are one, `strerror` in `@nimbus-sh/core/vfs/vfs-error.js`;
  `EPERM` now reads "Operation not permitted", not "Permission denied". The
  shell had two `chown` commands; one remains. The shell's own path
  resolver gave storage keys (`tmp/x`), which reached any error a command
  printed whole; it now gives absolute paths. `tree DIR` without `-L`
  listed the current directory instead of `DIR`; it lists `DIR`, prints it
  as written, and exits 2 with tree's `[error opening dir]` for one it
  cannot open.
- A mount whose backend resolves a whole path itself, as a network
  filesystem's server does, can say so: `vfs.mount('/pc', source,
  { resolvesPaths: true })`. Every operation on a path inside it (stat,
  lstat, readdir, read, write, `mkdir -p`, rename, unlink, realpath) is then
  one call to the backend with the mount-relative path. The namespace
  resolved a mounted path a component at a time, with a stat of each
  directory on the way: `readFile('/pc/home/me/a/b/c.txt')` made 7 backend
  calls (6 stats and the read), each a round trip on a device tunnel, a
  container or a Drive. A device that refuses a stat of the directories
  above the one its user consented to (EACCES) could serve none of its
  files, and a backend that makes a write's missing parents got ENOENT from
  the walk's parent check. Now the backend follows its own links and answers
  for each component itself; `..` inside the mount is lexical. `readlink`
  answers a link's text as written, so `cp` copies a link as the same link.
  Where the namespace follows one of its links itself (a node launch's
  staged view and data plan, a process's walks, the shell's `realpath` and
  `readlink -f`), `CompositeVFS.linkLeadsTo` answers where it leads, as the
  backend reads it: an absolute target re-rooted at the mount point, a
  relative one climbing no higher than it. A process's bridge answers the
  same (`RuntimeFsBridge.linkLeadsTo`, over the supervisor RPC as
  `fsLinkLeadsTo`). So a node launch that stages `/ro/link -> /home/user/x`
  reads the mount's `/home/user/x`, and `realpath -e /pc/l` with
  `/pc/l -> /f` names `/pc/f`, the file `cat /pc/l` reads.
  A WASI program (`python3`, `ruby`, the shell's wasm commands) reads such a
  mount too: its lookup beneath a preopen hands the rest of the path to the
  backend the same way, so `cat /pc/home/me/f` in the wasm shell reads the
  consented file instead of failing with "Permission denied" at
  `/pc/home`. Only when the preopen holds the mount point, though: the
  backend follows links anywhere in its own tree, so beneath a preopen
  inside the mount every component is looked up here, links read, and one
  leading out is ENOTCAPABLE. A lookup hands a path over by where it goes:
  a directory on the way to a mount nested in it is the backend's when the
  lookup stays on the backend, and looked up here when it goes on into the
  nested mount. The model (VFS-COMP-005, VFS-COMP-006) hands over the same
  paths, by the mount each is in and where the lookup goes, and still
  proves the lookup stays beneath the preopen. The namespace
  still owns the way in: root links into the mount, ENXIO with
  `absentReason`, the mount point (EBUSY, EISDIR, `mkdir -p` has nothing to
  do), EROFS under `readOnly`, EXDEV across mounts (so `mv`, `cp` and
  `ws.fs.move` copy), and mounts nested in it: the backend never sees a path
  into one, so the directories on the way are looked up, and searched with
  the caller's credential, here. A process's synchronous bridge
  hands such a path over whole too (`CompositeVFS.resolvedByBackend`). A node
  launch in a device's consented directory lists it, with a stat of each
  directory whose parent the device will not list, so its synchronous `fs`
  and `require` work there; and a denied package.json probe above that
  directory no longer fails the launch, since Node's module lookup reads
  EACCES as absent. A mount without the option resolves as before.
- `cat`, `head`, `tail` and a process's descriptor read a mount whose backend
  has no `readRange`. They failed with "ENOTSUP: this filesystem does not
  support readRange": a process's reader read the whole file only when the
  namespace had no `readRange`, and a `CompositeVFS` always has one. It now
  reads the whole file when the ranged read answers ENOTSUP (a VfsError,
  or a plain `{ code }` error from across RPC), through
  `readRangeOrWhole` (`@nimbus-sh/core/vfs/vfs.js`), which an embedder's
  reader can use too. `CompositeVFS.readRange` itself still answers ENOTSUP
  for such a mount, on purpose: a ranged read done as a whole read is not a
  ranged read (a 4 GB file read to serve 64 KiB), and a caller that must not
  read whole, such as Kinu's bounded preview, refuses on that answer. The
  fallback reads the whole file for each range, as the old one did; neither
  has a size bound.
- A WASI program (`python3`, `ruby`, the shell's wasm commands) follows an
  absolute symlink. With `/home/user -> /home/main`, every path through the
  link failed with errno 76, "Capabilities insufficient":
  `os.chdir('/home/user/site')` raised, `os.path.exists` behind it answered
  False, and `cd`, `cat` and `ls` in the wasm shell failed, while node
  resolved the link. A lookup beneath a WASI preopen refused any absolute
  link target. Now an absolute target resolves from the namespace's `/`, as
  every other lookup resolves it, and what the lookup reaches must still lie
  at or under the preopen's root (ENOTCAPABLE otherwise, as `..` at the root
  and an absolute path still are). A dangling one is ENOENT. The model
  (VFS-COMP-006, `Nimbus.Vfs.CompositeBeneath`) proves the lookup still
  stays beneath the root, finds every directory it passes searchable, the
  ones an absolute link walks from `/` included, and agrees with the
  unrestricted walk.
- `python3` and `ruby` fail when they cannot enter the shell's working
  directory, naming it (`python3: can't enter working directory '/x':
  [Errno 44] No such file or directory`, exit 1), instead of running the
  program in `/`. `cd /home/user/site && python3 -m http.server` served
  "Directory listing for /".
- The `ruby` prompt (`ruby` with no arguments) runs over the session
  filesystem, under the caller's credential, from the shell's working
  directory: `File.read("here.txt")` reads the file the shell sees there,
  and a file it writes is the shell's. It had no filesystem at all, so once
  `ruby` refused a working directory it could not enter, every prompt
  printed "undefined: can't enter working directory '/home/user': [Errno 8]
  Bad file descriptor" and evaluated nothing; before that it evaluated in an
  empty `/`.

- An error from a mounted filesystem names the caller's path. A backend's
  own error left `CompositeVFS` naming the path the backend was handed:
  `readFile('/m/nope')` failed with "ENOENT: no such file or directory,
  open '/nope'", a rename on a mount named both paths without the mount
  point, and a call through a root link named the link's target. Now every
  filesystem error a backend throws is reported as Node's error for the
  caller's call: its syscall and the paths the caller gave, the reason in
  the backend's own words (`VfsError.detail`, which a layer re-naming an
  error keeps), the backend's error as the cause, and an asynchronous
  mount's refusal still marked as one. An error that is not a filesystem
  error is passed on as the backend threw it.
- The runtime fs bridge, which node programs and the shell reach, fails with
  Node's error for its own call. The SQLite engine's errors carry a code and
  no call, and name a storage key, and they left the bridge as they were:
  `fs.realpathSync` and `readdirSync` of '/home/user/w/nope/x' failed with
  "ENOENT: home/user/w/nope", and `writeFile`, `symlink` and `mkdir` the
  same with no path at all, which is how vite printed its entry as a
  storage key. Each public call now names an engine error with its syscall
  and the caller's paths (`ENOENT: no such file or directory, scandir
  '/home/user/w/nope/x'`), the engine's error as the cause. Where the
  engine states a reason (a move into itself, a widening chmod), it stays
  the message's words, and its marks (a pending import's) stay on the
  error.
- Breaking for embedders: `NimbusWorkspace.exec` without a `shellId` is
  one-shot, as a session's programmatic exec has been since 2026-10-01.
  Every call ran on the workspace's one shell, one at a time, so a `cd`,
  `export`, function, alias, `set` option or `umask` in one call reached
  the next, and of two calls made at once, one doing `cd /tmp`, both
  printed `/tmp`. Each call now runs as a process of its own with the
  workspace shell's credential, in a shell of its own built from
  `ws.shell`'s cwd and environment; the aliases and functions `ws.start()`
  sources from the login files stay in `ws.shell`. What it changes ends
  with it: its cwd, environment and umask no longer carry to the next call
  or to `ws.shell`, and calls made at once run at once without seeing each
  other's state. A caller that needs state to persist passes a `shellId`:
  `ws.exec(cmd, { shellId })` runs in a named shell whose cwd and
  environment persist between calls, one call at a time per name, saved in
  the workspace's new `vfs_shells` table, which `destroy()` drops. The
  call's process, and its child processes that have ended (`sudo`'s, say),
  leave `ws.processes` when the result is returned, and each first lets go
  of what it bound in the filesystem (the files it held open, its
  watches), so a bare workspace no longer grows by one process entry and
  one descriptor scope per call. For a host that runs its own process
  around a shell, `ws.shellFor(pid, { cwd, env })` and
  `ws.withNamedShell(id, options, body)` are the two parts `exec` is made
  of.
- A session's and a hosted runtime's named shells are the workspace's:
  `exec(cmd, { shellId })` through the SDK and `ws.exec(cmd, { shellId })`
  run in the same shell, and calls on a name run one at a time whichever
  door they come through. Its state moves from the Durable Object's
  key-value storage to the workspace's `vfs_shells` table. A named shell
  an earlier release saved is moved there by the first named call, unless
  the workspace already has a shell of that name. A name's first call
  saves where it started, a background one (`startProcess`) too, which
  saves nothing else.
- Fixed: a wasm program, or a node program (one-shot, resident, worker or
  opencode), started by a principal other than the session user ran as the
  session user. Its process was entered at the top of the process table,
  which gave it the table's default credential, and a Durable Object host
  answers a program's file syscalls under the credential the table holds
  for its pid, so `sudo -u agent ./prog.wasm` or `sudo -u agent node x.js`
  could write where only the session user may. Each is now a child of the
  command that ran it, under that command's credential, and in its process
  tree, so an unnamed `ws.exec` also removes an ended wasm run with the
  call.
- Fixed: a resident server re-driven after an instance reset came back as
  the session user, whoever had started it. Its journal entry now records
  the credential it ran under, with its exec id, and the re-drive runs
  under it. An entry an earlier release wrote names no credential and is
  not re-driven; the terminal says why ("could not be restarted"), and the
  server starts again when its command is run again.
- Fixed: `vite` and `vite preview` served every file as root, whoever ran
  them, so a file the principal who started the server may not read was
  served to anyone with the preview URL. The in-process servers, and the
  real-vite server's snapshot reads, now read and write as the command
  that started them, and a refused file answers 403. A dev server
  persisted for a hibernation restore records who it ran as; one an
  earlier release persisted is not restored, and `vite` starts it again.
- `@nimbus-sh/fabric`: a caller can wait for room on the Dynamic Worker
  ledger instead of polling for it. `beginLoaderFetchWhenFree(ctx, key,
  { signal, claim })` resolves with the end function `beginLoaderFetch`
  returns, once `key` is already in flight or one more distinct worker
  fits. Waits are let in in the order they asked, one per freed slot, by
  any hold's end, a claim's release or the end of a refusal's pause, so a
  wait sees Nimbus's releases as well as its own; an aborted `signal`
  rejects the wait, which then holds nothing. The end function takes the
  error a call failed with: a "Dynamic worker concurrency limit exceeded"
  refusal stops the ledger admitting new workers for 50 ms, doubling to
  2 s while refusals continue, because the platform counts a worker for a
  moment after its call returns. `IsolatePool` now waits this way: a
  refused call is sent again as soon as a hold ends or the pause passes,
  where it used to sleep on a timer of its own (50 ms doubling to 2 s), so
  a call refused behind ten busy workers no longer waits up to 2 s past the
  release that would let it in. The 15 s bound is unchanged. A fan-out's
  own dispatches count inside its claim (`beginLoaderFetch(ctx, key,
  claim)`, `IsolatePool`'s `claim` option) rather than on top of it, so a
  5-wide fan-out leaves 5 slots free, not 0. `loaderLedgerStats` adds
  `waiting` and `pauseMs`, and `dynamicWorkerHeadroom` is 0 while a pause
  lasts.
- A filesystem call a process makes and the host refuses (an error with a
  `code`: ENOENT, ENOTDIR, EEXIST) is answered by `SupervisorRPC` as a
  value and rethrown in the process, instead of being thrown across the
  entrypoint. The platform recorded every thrown refusal as an invocation
  with outcome "exception" and "The Workers runtime canceled this request
  because it detected that your Worker's code had hung", though its caller
  was answered at once, so the noise hid real hangs. Node and opencode
  processes, bash, and the WASI runtimes (python, ruby, clang, wasm) make
  their filesystem calls through the new `SupervisorRPC.answer(method,
  args)`, which resolves `{ value }` or `{ refusal }`, and core's
  `answeringSupervisor` rethrows a refusal as exactly the error the program
  got before: the same class, name, message and own properties (`code`,
  `errno`, `syscall`, `path`, `dest`, `detail`, `cause`). A failure without
  a code, such as a dropped connection, still throws. npm's and git's
  facets still call the methods directly, which throw as before. A
  supervisor entrypoint written from scratch (composeFabric's
  `supervisorEntrypoint`) must implement `answer`; one that extends
  `SupervisorRPC` inherits it.

- `node:http2` exports exactly Node 22's names. `Http2ServerRequest` and
  `Http2ServerResponse` are real classes, so `res instanceof
  Http2ServerResponse` is false for an HTTP/1 response instead of throwing
  "Right-hand side of 'instanceof' is not an object", which made every Astro
  dev request a 500. The settings functions compute what Node computes;
  servers and sessions still answer `ERR_HTTP2_NOT_SUPPORTED`. One module
  now serves both node runtimes.
- A node program's first launch stages more of what it reads, so fewer
  launches fail until the next one: the tool's config file and what it
  imports or names by string (Vite, PostCSS plugins), the entry files of
  the project's dependencies, a package's bins when the code locates the
  package by its manifest, a module's only `import()` of its own package,
  and a one-shot's static data reads (lightningcss's wasm). Each stays
  within the launch's module bound, and what is only a guess is evicted
  first.
- A command name nothing registers is searched for on the PATH of the
  environment that invokes it, as execvp searches it, by the shell (a
  `PATH=x cmd` prefix included), a script's commands, `sudo`,
  `find -exec`, `xargs`, `npx`, `nimbus start`, `watch` and a Worker
  program's `child_process.spawn`. With `HOME=/home/main`, a CLI installed
  only in `/home/main/.local/bin` runs by its bare name from anywhere.
  Before, the Worker's search used the default home's PATH, so a bin it
  found there could run a different file, and a workspace without the
  Worker (the SDK) ran nothing from PATH by its bare name. Any executable
  on PATH runs this way (a `#!` script, a wasm binary, an npm bin shim),
  the first one in PATH order; a file that is not executable is passed
  over, and is `Permission denied` (126) when nothing else is found; an
  empty PATH entry is the current directory. A caller with no environment
  searches the default PATH. `type`, `command -v` and `which` report the
  file that runs (`tool is /home/main/.local/bin/tool`), where `type`
  called it a builtin or missed it.
- Fixed: an ES module entry script's `import.meta` had only `url` and
  `resolve`; `import.meta.dirname`, `import.meta.filename`, and
  `import.meta` as an object or destructured were undefined. A module the
  program loaded already had them. So `npx sv create` (sv 1.0 finds its
  package.json from `import.meta.dirname`) failed with "Could not locate
  the package.json of sv". The entry now gets the same metadata object as
  every loaded module. Also fixed on the way: in a module that reads
  `import.meta`, an import binding spelled `__nimbusDynamicImport` captured
  its `import()` calls; `import()` is now routed after the module's
  imports are lowered.
- Fixed: a chunk written to a `child_process` child's stdin while the child
  waited for input was read twice.
- `find` behaves as GNU findutils 4.10 does for the expression language
  scripts and agents use, checked line for line against the host's GNU find
  over the same tree (381 command lines: same stdout, stderr and exit
  status, in readdir order). It parses GNU's grammar (`( )`, `!`, `-a`, `-o`,
  `,`, the implicit `-print`) with GNU's messages; implements -H/-L/-P with
  loop detection, -maxdepth, -mindepth, -depth, -xdev/-mount, the name,
  path, type, size, time (-newerXY with dates), permission, owner and link
  tests, -printf, -prune, -quit, -delete, and -exec/-execdir with `;` and
  `{} +` as child processes; and reports unreadable directories and goes
  on. What it does not implement it refuses by name, exit 1: -regex,
  -fstype, -ls, -fprint*, -files0-from, -ok, -okdir, -O2 and above, and
  the -printf directives Nimbus has no facts for (%b %k %S %F %Z).
  Before, an unknown flag's value became the search path, `-xdev` was
  refused, and every unreadable directory was skipped in silence. Its
  walk keeps what fts keeps, the directories it is inside, so its memory
  does not grow with the tree: 2 MiB over 200,000 entries, and a
  read-ahead window of 4,096 entries on top. It answers -type from the
  listing, as GNU does from d_type, and stats only what fts stats (start
  points, directories, followed links, and entries a backend cannot
  type). It is still slower than the find it replaces on a local tree,
  as it stats every directory: over 10,525 entries in SQLite, a plain
  walk takes 18-21 ms where it took 12, and `-type f` 24-28 ms where it
  took 10-17.
- `find -xdev` stays on the start point's file system, so `find / -xdev`
  never lists a mounted container file system such as Kinu's /sandbox.
  Without it, find reads directories (16 calls at once) ahead of what it
  prints, in walk order, when the expression only looks. That helps only
  where the mount serves calls concurrently: on a test mount (a
  MemoryVFS whose every call sleeps 10 ms), `find` over 156 directories
  took 990 ms where it took 7.7 s; on a 31-directory mount whose calls
  take 5 ms, `-type f` takes 100 ms where it took 615, with 171 stats
  where it made 86, since the composite resolves each component of a
  path with a stat of its own. It is not a measurement of /sandbox,
  and a mount that answers one call at a time (as Kinu's MountedSyncVFS
  is reported to) gains nothing from it; there, -xdev is the remedy.
  Under -L or -H it never reads ahead into a link the loop check will
  refuse.
- readdir's entry types are exact, as d_type: a device is listed as a
  character device rather than a file, and a backend that cannot tell
  says `unknown`. Node's `Dirent` reports `isCharacterDevice()` and
  `isSymbolicLink()` (it said false for every entry), and WASI's
  `fd_readdir` the matching file type.
- `chmod` takes gnulib's whole mode grammar (`u=g`, `+t`, `g+s`,
  `u+rw-x`, `+111`, five-digit octal), as find -perm does.
- `sudo`, `su` and `find -exec`/`-execdir` start the program they name as
  execvp does, in the caller's directory with its streams: a shell
  function or alias of that name is not what runs, and a program that is
  not there is `sudo: x: command not found` or `find: 'x': No such file
  or directory`. A program whose reader goes away dies of SIGPIPE and the
  command that started it goes on, so `find … -exec echo {} \; | head -n 1`
  runs every -exec and reports `find: 'echo' terminated by signal 13`, as
  GNU does. `pwd` is a program too (coreutils', `-P` by default) for them
  to start.
- `touch -d` and `find -newerXt` read a date with gnulib's ranges: an
  epoch's fraction keeps its sign (`@-1.5`) and may follow a comma, a
  number, field or result that overflows and a zone past 24 hours are
  refused, as is second 60, a date with nothing in it is midnight, and
  a year before 100 or after 275760 is the year it names.
- Fixed: a command `sudo` or `find -exec` started from a `sh -c` or
  `bash -c` script ran in the directory the script started in and wrote
  to the outer shell's stdout, past the script's `cd`, redirections and
  pipes. It now inherits the script command's directory, descriptors and
  environment.
- Fixed: functions and aliases a `sh -c` or `bash -c` script defined
  stayed defined in the session after it, and `unset -f` removed a
  variable rather than the function. `unset` takes bash's -f, -v and -n.
- Code a node program produces while it runs now runs in the same launch.
  Before, Workers' ban on compiling code at runtime meant such code (a
  `Function` or `AsyncFunction` constructor's text, `vm.runInThisContext`, a
  module file written after the launch) was refused with
  `ERR_NIMBUS_CODE_NEXT_LAUNCH` and ran from the next launch, so a Vite or
  Nuxt dev server failed its first run. Nimbus now runs it in its own
  JavaScript interpreter, and still records it so the next launch compiles
  it natively. Interpreted code observes what V8 would: test262 passes on
  39,152 of the 39,191 tests V8 passes, and neither the interpreter nor its
  parser calls a built-in a program can replace. Nimbus rewrites acorn's
  syntax tree at build time to use built-ins captured when the launch
  starts, and the build fails if anything in the parser still reaches the
  program's. It loads only when a program first produces such code; each
  launch's map carries it (240 KiB). Measured locally, it runs 1.1 to 1.9
  times slower than native on framework code and about 45 times slower on
  tight generated code such as a JSON-schema validator, for that first
  launch only. TypeScript or JSX text and `using` still wait
  for the next launch. `import()` of a module that uses top-level await
  waits for it; `require()` of one, and a static import of one, return its
  exports at once.
- Builds run on rolldown 1.2.11 instead of esbuild-wasm: `wrangler dev`'s
  Worker bundle, the built-in `vite build`, real Vite's config bundle, and
  the Vite dev server's cold-module fallback. They run in a build facet of
  their own, on the threadless rolldown binding Nimbus already stages for
  Vite 8, with rolldown's JavaScript staged beside it; the session's VFS
  plugin and every caller are unchanged (`EsbuildService.build`,
  `supervisorEsbuildService` keep their contract), and a failed build still
  rejects with esbuild's "Build failed with N errors:" message and its
  diagnostics, labels as notes. `vite build`'s stylesheet is bundled by
  esbuild's rules (`@import` inlined with its conditions, a file imported
  twice keeping its last place, external imports and `@charset` hoisted,
  `url()` assets emitted, legal comments at the end) and its assets by
  esbuild's loaders; the sheet is minified by whitespace and comments only,
  so it is somewhat larger than esbuild's, never different in meaning.
  Parse errors are worded by Oxc's parser, and esbuild-wasm's spurious
  "Cannot read directory" error beside an unresolved import is gone. The
  esbuild facet keeps the `esbuild` command and the transforms too deep for
  Oxc's stack.
- Builds keep esbuild's semantics where rolldown's defaults differed: a
  `binary` import (a `.wasm` or `.node`) is its bytes whole (they were
  stored as UTF-8, so a non-ASCII byte became two); an imported constant
  stays a reference, so a cycle reads `undefined` before the constant's
  module runs, as it did; every import that does not resolve is reported,
  at its own string literal with esbuild's byte columns, and errors come in
  esbuild's order (file, line, column); and overlapping failed builds no
  longer place their diagnostics in each other's files.
- A build that runs rolldown's binding out of stack (a module nested too
  deeply, such as a 10,000-term expression) or traps it no longer leaves
  that build, and every build after it, waiting forever: the napi-wasm
  loader reports the binding's death (`onFatal`), every build on it is
  rebuilt by esbuild in the esbuild facet (as transforms too deep for Oxc
  are), and the next build gets a fresh build facet. A Node host is no
  longer kept alive by a dead binding.
- The build facet starts loading when `wrangler dev` starts, while it
  reads its config, rather than when its first build asks for it.
- npm pre-bundles (the install's `Pre-bundling N modules…` step and the
  Vite dev server's on-demand `/@modules/` bundles) run on rolldown in the
  build facet instead of esbuild-wasm in an isolate pool: the supervisor
  still walks each specifier's slice of package files and sends it with
  the call, so a pre-bundle makes no calls back, and they still run one at
  a time. rolldown's runtime loads from the facet's staged module map, so
  no pre-bundle dispatches any source; `EsbuildBundlePool` and the
  pre-bundle preamble are gone. On 32 real specifiers (React, framer-motion,
  @mui/material, recharts, three, date-fns, lodash-es, vue, …) the served
  modules export the same names with the same types as esbuild's; each
  bundle took 2-454 ms where esbuild-wasm took 7-1,078 ms. Cached
  pre-bundles are rebuilt once (`BUNDLER_VERSION` v12). The binding keeps
  what the largest bundle grew it to (60 MiB after @mui/material), so a
  build facet whose binding passes 64 MiB is replaced by a fresh one after
  the call. An asset module (`file`, `dataurl`, `base64`, `binary`) that is
  required rather than imported is its value, as esbuild's is, and a build
  with no output path refuses a stylesheet import as esbuild does.
- A build facet left behind with calls still in flight (its binding past
  64 MiB) and its successor's are now counted as two Dynamic Workers on the
  Durable Object's ledger, as the platform counts them, not one, so a
  fan-out no longer dispatches locally past the limit; it is aborted once.
  An unresolved import is placed where rolldown's own resolver places it:
  once the failed build is closed, each failing importer is built again
  alone, with the build's own platform, target, define and JSX, its other
  imports external and these left unresolved, so a call of a `require` the
  code binds itself (a parameter, a declaration, a catch binding, a class
  static block's `var`, a named function or class expression) or one a
  define makes dead is never taken for the import. Placement is bounded: an
  importer over 256 KiB, or past 1 MiB of importers per build, is named
  without a line, and a 1.2 MB importer's failed build leaves the binding
  at the size its successful build would (26.4 MiB; placing it beside the
  build had grown it to 91.1 MiB).
- The Worker no longer bundles esbuild-wasm: its 11.36 MiB wasm was a
  compiled module of the Worker, which workerd compiled at startup in
  every isolate, every session's Durable Object included, whether or not it
  ever ran esbuild. esbuild.wasm is now a staged, digest-checked asset that
  only the esbuild facet loads, when the `esbuild` command, a module too
  deep for Oxc or a build whose rolldown binding died needs it. The Worker
  upload falls from 19,119 KiB to 7,358 KiB (gzip 4,752 to 1,621 KiB): the
  wasm and esbuild's 133 KiB JS adapter, which core no longer imports.
  `EsbuildService` runs a call without a host on an engine its caller
  supplies (`EsbuildServiceOptions.engine`), and rejects without one; core
  imports no part of esbuild-wasm.
- `vite build`'s stylesheets are read and written by css-tree 3.2.1 (its
  parser, generator, walker and tokenizer; not its lexer or grammar data),
  with esbuild 0.24.2's import order and cascade rules ported from its
  linker above that: each sheet resolved, loaded and parsed once per build
  (a 13-sheet chain importing each next sheet twice made 8,190 resolve and
  8,190 load calls; now 13, as esbuild), layer-ordering statements before
  `@import` kept, an earlier duplicate keeping the layer order it set,
  external imports keeping their importers' conditions (nested through
  `data:` sheets as esbuild does) and their last place, conditions compared
  by token (whitespace inside a string counts), escaped at-keywords, bad
  url() tokens left alone, comments that are not whitespace, a no-break
  space in a name, and an `@import` of a non-CSS module refused as esbuild
  refuses it. Emitted assets are named by their bytes before any script or
  stylesheet names them, the stylesheet by its own bytes, so a changed image
  or rule changes every name that depends on it (the script's and sheet's
  names stayed put before); an asset's path is written into the script as
  an escaped string, not substituted into its text, and two different files
  at one output path fail the build as in esbuild. Data URLs keep every byte
  (a UTF-8 BOM was dropped) and take esbuild's MIME table and Go's content
  sniffing. A url() in what css-tree keeps as written (a custom property's
  value, a declaration it cannot parse) is loaded and rewritten like any
  other, as esbuild does, but not one in an at-rule's prelude, parsed or
  kept as written (an unknown at-rule's), which esbuild never loads; a
  malformed `@import` (no URL, a url() of more
  than one string, a block) is kept as written with esbuild's warning,
  never followed, and ends the imports after it, as does a `@layer`
  statement after an `@import`. The Vite dev server inlines a stylesheet's
  `@import`s with the
  same layer, conditions and nesting included, and roots each url() so an
  inlined sheet's url()s still name their files.
- `vite build`'s stylesheet reads each `@import`'s conditions from its
  tokens: a `)` or `,` inside a string or a url(), an escape, a comment, or
  a `layer()` name directly followed by media no longer cut a `supports()`
  condition short or turn it into media. Strings and URLs in a condition
  are printed as esbuild prints them, and a `supports()` condition is always
  parenthesized, as esbuild does.
- Two more fixes for builds whose binding dies: the facet is aborted only
  once every call still on it is answered (workerd's abort cancels calls in
  flight, which left a sibling of the crashed build to fail instead of
  falling back to esbuild), and a call on that dead generation that gets an
  error instead of an answer falls back too. An unresolved import is placed
  at the first literal of its own kind (import, require, dynamic import),
  as esbuild reports each.
- A `NimbusWorkspace` no longer holds a lazily built esbuild service: its
  only runtimes are bash, python and wasm-runner, which reads its `.wasm`
  itself, so nothing in it ever transformed source.

- Transforms run on Nimbus's own build of Oxc instead of esbuild-wasm: every
  TypeScript, JSX and ES-module-to-CommonJS transform a session makes (a
  launch's module cells and entry, the built-in Vite dev server's modules,
  the Vite config read, the supervisor transform RPC). The engine is a
  2.15 MiB wasm module (`packages/worker/scripts/oxc-wasm`: Oxc 0.152's
  parser, TypeScript/JSX transformer and printer, plus a module pass that
  writes CommonJS in esbuild's shape, helpers and `__esModule` included),
  built reproducibly from a pinned toolchain, staged under `/_assets/oxc/`
  and digest-checked like every staged artifact. It runs in a transform
  facet of its own; the esbuild facet keeps builds and the `esbuild`
  command. On pi 0.99.1's 66 bundle chunks plus 23 TypeScript sources, a
  cold pass takes 280 ms where esbuild-wasm took 3,647 ms; the wasm starts
  at 4.25 MiB where esbuild's starts at 28 MiB, and peaks at 62 MiB where
  esbuild's reached 336 MiB. Stored launch transforms are redone once,
  since the transform host's identity changed. Output is printed
  differently (formatting only); `supervisorEsbuildService` keeps its name,
  signature and contract.
- Lowering a module with top-level await (the transform's ESM output run as a
  CommonJS cell) now evaluates every module the source requests before the
  body, re-exports included, in source order, as Node does; and each export
  is a live getter installed before the body runs, so `export let db; db =
  await connect()` exports the connected value, wherever the transform
  printed the export. The cell's top level holds only generated names, so a
  module's own `import Object from "dep"` cannot reach the lowering's code.
- A module nested deeper than Oxc's recursive passes can run on the host's
  stack (under V8: about 4,800 concatenated terms, a 1,950-arm ternary, 1,400
  chained calls or arrays 585 deep) is transformed by esbuild in the esbuild
  facet, that module alone: every such module of a batch, in calls of at most
  four, each call with a 30 s deadline, each module logged with its path and
  reason. Only the driver's own RangeError marks a module so, never
  message text. Stored launch transforms are keyed by both engines' code.
  esbuild's own wasm grows with depth too (268 MiB for 5,000 concatenated
  terms), so past its own limit neither transforms it.
- `jsx: "preserve"` with `format: "cjs"` is refused: preserved JSX would name
  imports that the conversion to CommonJS moved onto records.
- Fixed: on the SQLite filesystem, renaming a directory over an empty
  directory counted the replaced directory as a file, so `df` and the
  filesystem's stats reported one file too few and one directory too many
  until the counters were next reloaded from the store.
- Changed: a workspace's per-user defaults follow the `HOME` its host
  configures (`NimbusWorkspace.create({ env: { HOME } })`). The home
  directory and `~/.nimbusrc` are seeded there, `/etc/passwd` names it, and
  `PATH`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` are under it. So are gems
  and pip packages, as runtimes already were. Before, all of these named
  `/home/user` whatever HOME was. `/etc/profile` now spells the user's bins
  as `$HOME/...`. A passwd or profile that is still exactly the one Nimbus
  seeded before (naming `/home/user`) moves to the configured home; one the
  user changed stays. A gem's command runs the script under the invoking
  HOME's gem home, and the Python prompt chooses its interpreter from the
  invoking HOME's packages. A relative HOME is refused. With no HOME
  configured, nothing changes.
- `exec`, `execStream`, `startProcess` and `runCode` take an `execId`: a
  name for the call. Every process the command starts carries it in the
  process table (`node`, `bun`, npm bins and `opencode`, python and ruby
  servers, wasm programs, the `vite` builtin, package scripts), and so does
  everything those processes spawn, so a port's listener names the call that
  started its server. `processes.list()`, `ports.list()`, `apps.list()`,
  `apps.expose()`, `ports.expose()` and `startProcess`'s `process` report it
  as `execId`, over the SDK, the remote API and a hosted runtime's session,
  as does the session's own `/api/processes` listing; a record about a
  process no call named is unchanged. A resident server keeps
  it across a platform reset (its journal row carries it), and a `vite` dev
  server across a hibernation. An `execId` is 1 to 160 characters from
  `A-Z a-z 0-9 . _ : -`, starting with a letter or digit; anything else is
  refused before the command runs, as `400 E_ARG_SHAPE` over the remote API.
- Fixed: a package script run by `bun run <script>` ran as the workspace
  shell rather than as the process that ran `bun`, so under a hosted session
  scoped to an identity it acted as the session user. It now runs as the
  command that ran it, as an `npm run` script does.
- Fixed: a real-vite dev server restored after a hibernation was given an
  empty argv at its root instead of the identity persisted with its config,
  so the app verbs could derive a different owner for it.
- `ws.fs` takes a relative path from a working directory of its own, as a
  process does: the one the workspace starts in (`create`'s `cwd`, else
  `HOME`), which a `cd` in the shell does not move. On 0.14.0 a workspace
  created with `cwd: '/home/user'` answered `ws.fs.readFile('a.txt')` with
  `ENOENT` while /home/user/a.txt existed, so every embedder resolved
  paths itself. `ws.fs.cwd` and `ws.fs.resolve(path)` say where a path
  leads: the cwd, then the path as spelled, with `.` and `..` left to the
  walk. An empty path is `ENOENT` (`readdir('')` listed `/`), and
  removing or renaming a last component of `.` or `..` is refused with
  Linux's code (`remove('/a/b/.', { recursive: true })` removed /a/b).
  `ws.fs` has every method it had except `process`, the root-relative
  bridge. The session shell's `ProcessView`, which Nimbus's own code hands
  root-relative keys such as `etc/passwd`, is still `ws.shell.getVfs()`;
  the two types are not assignable to each other.
- `ws.fs.move(from, to)` is mv's move, and `move(vfs, from, to)` in
  `@nimbus-sh/core/vfs/move.js` is the same move over any `VFS`; the
  shell's `mv` uses it. Within one filesystem it is one rename. Between
  two, and on a backend that cannot rename in place, it stages a copy
  beside the destination and confirms it, removes the source, and renames
  the copy over the destination, which keeps its bytes until then. A
  failure at any step puts the source back and leaves no copy behind;
  `mv` copied straight onto the destination, so a failure mid-copy left
  part of a tree there, or a destination file already overwritten. A
  failed final rename is decided by its own answer: a refusal made before
  anything changed (`RENAME_REFUSALS`) puts the source back and is the
  answer, a filesystem saying it renamed all of it (`renameOutcome`) has
  moved it, and anything else is `EIO` with nothing undone or removed,
  naming where what was moving is. What it makes is private until complete:
  `mv` made a copy at the default mode and narrowed it after, so a 0600
  file moved into /tmp was readable by other users meanwhile. Directories
  move too. `rename` still answers `EXDEV` between mounts. A directory
  moved onto a file now answers `ENOTDIR`, where `mv` said `ENOTEMPTY`,
  and `mv` no longer makes a missing destination directory.
- A rename on the SQLite filesystem that fails says what it did: an error
  carrying `renamed: 'none'` when its store shows the destination as it
  was, and `EIO` with `renamed: 'all'` when the tree was published whole
  and only removing the old name failed. A commit that was durable and
  still threw, or a tree published in part, is `EIO`; before, each of
  these rethrew the storage error unchanged, so a caller could not tell
  a rename that did nothing from one that did some of it.
- Fixed: renaming a tree large enough to take several transactions onto
  an empty directory, on the SQLite filesystem, removed that directory
  when a later transaction failed: the unwind took away the published
  root, and with it the directory the root had replaced, while the inode
  cache and the file counts still had it. The unwind now puts the
  directory back as it was, with its inode, mode, owner and times.
- Fixed: a file a process creates on a synchronous mount with a mode
  (`open` with `O_CREAT`, `writeFile` with `mode`) was made at the
  backend's default mode. It is now made at the mode asked for, as on an
  asynchronous mount.
- Fixed: a process's rename within one mount answered `EXDEV` even where the
  mounted backend renames, so `mv /m/a /m/b`, a node process's `fs.rename`
  and `ws.fs.rename` copied, or failed, where the namespace renames in
  place. Within one mount a rename is now that mount's own. Between two
  filesystems, and on a backend with no rename in place, it still answers
  `EXDEV`; renaming a mount point answers `EBUSY`, as on Linux. A
  mutation on a mount reached through a link is checked against leases at
  the name it reaches, as one on SQLite is.
- Fixed: `rm -r` of a tree on a mount whose backend has no removal of its
  own exited 0 when an entry in the tree could not be removed, and left the
  entry there. It now fails with that entry's error, as the asynchronous
  path already did.

## 2026-10-01

Published as core 0.14.0, worker 0.12.0, fabric 0.9.0, platform 0.7.0,
sdk 0.10.0, config 0.2.3, cli 0.2.1, loom 0.2.1, react 0.2.1; the carets
are minor-strict, so every range on core, worker, fabric, platform and sdk
moves. Breaking for embedders: `toVfsError`'s signature and the `VfsError`
message shape, VFS export schema 3 (its pages carry `source`), and the
`enhanced_error_serialization` requirement; each is described below.

- Fixed: a programmatic exec without a `shellId` ran on the session's one
  shared shell, so an `export`, function, alias or `set` option in one call
  reached the next unnamed call, from any caller, and two unnamed calls
  running at once read and overwrote each other's variables mid-run. Each
  unnamed call now runs in a shell of its own, built from the session
  shell's cwd and environment and discarded when it ends, as the SDK
  documents. Named shells are unchanged.
- Fixed: in a named shell, `./task.sh`, a relative script path, an npm bin
  and `command -v` resolved from the session shell's directory, not the
  named shell's, so `cd build` then `./task.sh` ran the wrong file or none.
  Commands now resolve from the cwd of the shell that runs them.
- Fixed: in the shell, `exec 3>file` or `exec 3>&-` inside a subshell
  closed the parent's fd 3, so the parent's next write through it failed
  with `EBADF`. A background job lost an inherited descriptor, or the file
  its enclosing redirection opened, when the parent let go of it first. A
  file a subshell opened with `exec`, or one opened before a redirection
  that failed to open or to expand (`( : ) >out <${X:?}`), was never
  closed. Every file a redirection opens is now
  counted the way the kernel counts an open file: by the command, by each
  descriptor `exec` keeps on it, and by each child shell that inherited it.
  It closes when the last of them lets go. A programmatic call's shell ends
  with the call, so a file an `exec` left open in it is closed too.
- Fixed: `git clone <url> /tmp/x` by a principal with a private `/tmp`
  failed with `EPERM: … is outside exclusive mutation root tmp/x`. The
  clone held the shared name while its writes landed in the private `/tmp`.
  An exclusive lease taken through a credential now holds where that
  credential's writes land, and every write is checked against leases at
  the path it reaches: a write to a private `/tmp/x` is no longer refused by
  a lease on the shared `tmp/x`, and a `cp -r` through a symlink into a held
  tree is refused.
- `npm install` no longer installs optional peer dependencies the project
  does not list, as npm, pnpm and bun do not. A fresh Vite 8 react-ts app
  installed ~456 packages (sass, less, stylus, terser, tsx, Babel and their
  trees) where npm installs 70. A project that uses one of those tools
  lists it, as it would on a real machine (`npm i -D sass`).
- `npm install` removes packages the project no longer needs, as npm does:
  a dependency dropped from package.json, what only it needed, and its
  bins. This also clears the optional peers earlier installs added.
- A package's `bin` names and targets are normalized as npm normalizes
  them: a key links under its last path component (`../../x` links `x`) and
  a target stays inside its package. Linking and pruning read installed
  `package.json` files and the bin manifest only through that rule, so no
  bin map can write or remove a file outside `node_modules/.bin`.
- An async `fs.promises.writeFile` in a node process is one call to the
  session where it was two: the session answers the write with the file's
  stat (`writeFileStat`), which the synchronous view keeps. A session
  deployed before it is asked for the write and the stat separately.
- Fixed: after a node process overwrote a file it had never listed (one
  created by another user after it started), `fs.statSync` reported the
  process as the file's owner until the next barrier.
- Fixed: an async read or write whose answer came back after a barrier had
  reported the file deleted brought the name back into the synchronous
  view, permanently. A stat a barrier overtook is now dropped.
- Fixed: an async `fs.promises.readFile` through a symlink made
  `fs.statSync` of the link a directory.
- Fixed: a node process reading or writing a file through a symlink held
  the bytes under the link's own name. After a write landed, `lstat` saw a
  regular file where the link is and `realpath` named the link, and a later
  write to the file the link names, by anyone, never reached what the
  process read through the link. Reads, writes, appends, truncates and
  descriptors now follow every link on the path as open(2) does, a dangling
  link creates the file it names, a loop is `ELOOP`, and `wx` on a dangling
  link is `EEXIST`.
- Fixed: a symlink a node process renamed was a regular file to `lstat`
  under its new name until the rename was reported back.
- An async `fs.promises.readFile`, `stat` or `lstat` in a node process is one
  call to the session where it was two or three: the read takes its
  consistency barrier with it (`fsAcquired`), and a file's stat for the
  synchronous view rides in the same read batch. Each call cost 7-8 ms on
  Cloudflare, nearly all of it the hop to the session.
- A workspace loads its bash, Python, Ruby, clang and wasm runners when the
  first command needs one, not at create. Loading all of them cost every
  workspace isolate 0.65 MB (measured by Kinu).
- `@nimbus-sh/worker/facet-host` exports `supervisorEsbuildService`, so a host
  that bundles in its own Durable Object runs esbuild in the object's esbuild
  facet instead of its own isolate. A failed build keeps esbuild's `errors`
  and `warnings` wherever esbuild ran; across RPC they were lost. Every
  diagnostic is esbuild's `Message` with its `id`, `pluginName` and `notes`,
  less `detail`, which a plugin sets to anything and may not clone.
- Installing a runtime writes each blob in one pass (`writeFileFrom`) instead
  of appending it piece by piece, which re-copied the file's manifest on
  most appends: about 234 SQLite transactions of re-copying for clang.
  A mounted target takes the file whole, and a failed source changes nothing.
- A directory renamed by a node process takes the files it wrote into it
  along. Vite's dependency optimizer writes `deps_temp_<hash>/` and renames
  it to `deps/`, and the first request to a new Vite dev server answered 502
  `ENOENT … deps_temp_<hash>`. The moved files read and stat under the new
  name at once; a rename Node refuses (into its own subtree, onto a non-empty
  directory, a file onto a directory) is refused before anything moves, and
  one the session refuses writes nothing under the destination. The old name
  no longer reads a file's unsaved bytes after the rename.
- ES modules have `import.meta.dirname` and `import.meta.filename`, as in
  Node 20.11 and later. Vinext's dev server needs them.
- `node` no longer dies at launch when an installed package inlines a
  WebAssembly module this runtime cannot compile. wasm-feature-detect inlines
  one per proposal it probes.

- A workspace no longer holds memory for every file it writes or removes.
  `SqliteVFS` kept each written file's inode in its cache and a revision
  stamp for every path written or removed, about 350 B per file, up to
  64k inodes and 16 MiB of stamps: a workspace kept for an isolate's life
  grew by 21 MiB of heap over 100,000 files. A write now replaces a cached
  inode but admits none, the cache holds 8,192 entries (about 2.4 MiB), and
  only directories hold revision stamps (1 MiB at most): a file or a
  removed path reports the generation SQLite wrote with it, its row's or
  its tombstone's. Writing 100,000 files grows the heap by 0.1 MiB.
  `revision(path)` keeps its contract: never below the last change at or
  under the path, never above the clock, a directory never below anything
  under it. A pruned tombstone raises the floor, as a dropped stamp does,
  and only a published one is pruned. An operation of several transactions
  (a rename, an embedder's `withTransaction`) publishes each path at the
  generation SQLite holds for it, which is what `revision(path)`, `list()`,
  `stat` and the delta from SQLite name too: an atomic write (write a temp
  file, rename it over) no longer leaves a resident reader fetching at a
  revision the path does not report, which `readRange` refused with ESTALE.

- A pipe or redirect is a Node program's stdin: `echo hi | node x.js` and
  `node x.js < in.txt` deliver it to `fs.readFileSync(0)` (and
  `/dev/stdin`), `process.stdin` `'data'`/`'end'` and
  `for await (const c of process.stdin)`, with chunks as Buffers. The
  runtime handler used to drop it, so every read saw an empty stdin and
  `readFileSync(0)` threw ENOENT on a file named "0". The pipe streams
  through the process's input channel as it arrives, never held for its end:
  a program that ignores `yes` or `tail -f` exits at once. Bytes arrive
  exactly as written (binary input is not decoded as text). A `< file`
  redirect's fd 0 is the file itself: `process.stdin` streams it, with no
  bound, and for a program that reads stdin synchronously its first 16 MiB
  is read in before it starts, so a large redirect (`< dump.sql`) is never
  held whole; a synchronous read past that fails naming the bound and
  pointing at `process.stdin`. A one-shot program whose code (the entry or its own modules it
  loads directly) reads stdin synchronously — `readFileSync(0)`,
  `readFileSync('/dev/stdin')` (or `/dev/fd/0`, `/proc/self/fd/0`),
  `readFileSync(process.stdin.fd)`, `readSync` of fd 0 — has up to 16 MiB
  of a pipe read before it starts, as Node's blocking read would wait for
  a slow writer; a pipe that ends within that is delivered whole
  (`cat package-lock.json | node -e "JSON.parse(fs.readFileSync(0))"`).
  The 16 MiB is one budget for the session, since the read ahead is held in
  its Durable Object: it counts the bytes concurrent launches hold, charged
  as each piece is read, so one waiting on a slow writer does not starve
  another, and a launch the budget cannot cover streams the rest of its
  pipe. Past it a synchronous read fails with EAGAIN
  naming the bound and suggesting `< file`, while `process.stdin` still
  reads the pipe. All
  those forms, `fs.read` of fd 0 and `process.stdin` share one position in
  stdin, so a program can read a header synchronously and stream the rest.
  `process.stdin.listeners('data')` lists a `once` listener as the
  program's function, as in Node.

- http-server serves text files. `stream.Readable.from` is Node's: object
  mode by default, and a string or Buffer is emitted whole instead of being
  iterated, so http-server's `Readable.from(bytes)` no longer writes byte
  numbers into the response.

- `npx sirv-cli` serves files. `path` is workerd's native `node:path`
  (Node's own implementation), with `resolve`/`relative` starting from the
  process's cwd. The hand-rolled `join` kept empty segments, so totalist's
  `join("", "hello.txt")` was "/hello.txt", sirv mapped every file under
  "//name" and answered 404; `normalize` also dropped trailing slashes and
  answered "" for "".

- express.static serves files. `require('stream')` is a function
  constructor, as Node's legacy Stream is, so send's `Stream.call(this)` no
  longer throws "Class constructor Stream cannot be invoked without 'new'".

- express 4 apps (`express.static`, `npx serve-static` setups) start from
  their second launch. depd, loaded by express 4's body-parser, builds each
  deprecated wrapper with `new Function` as its module loads, which a
  Worker refuses at request time; the plain `Function` constructor was left
  native, so every launch crashed the same way and never bound its port.
  It now answers text an earlier launch staged and stages one refused text
  per failed launch, the one the failure is attributable to: the refusal an
  uncaught error is, or, for a non-zero exit, the latest refusal the program
  reported (read its message or stack; serve 14 prints ajv's refusal and
  exits 1). A silent capability probe (TypeBox's `Function("null")`) is
  never staged, even when the launch later fails for another reason.
  `process.stdin.off`/`removeListener` remove wrapped `data` listeners again
  (native `node:events` unwraps only `.listener`).

- `npx http-server` serves. Node guests use workerd's native `node:events`
  instead of a hand-rolled `class EE`, so `EventEmitter.call(this)` with
  `util.inherits` (union, and many older packages) works, native HTTP
  servers are instances of the `EventEmitter` userland requires, and the
  static `once`/`on`/`captureRejections`/`setMaxListeners` helpers are
  Node's. Shim streams no longer emit `'error'` after being destroyed
  (Node's errorOrDestroy); with a real emitter that error would throw.
  `url.parse`/`format`/`resolve` are workerd's native `node:url` legacy API:
  the hand-rolled parse answered only `{ href }` for a relative URL, so
  http-server's `url.parse(req.url).pathname` was undefined and every
  request was a 400.

- Node HTTP guests see full request header values again. workerd's native
  server keeps only the text before the first unquoted comma of Host,
  Content-Type, User-Agent, Referer, Authorization, Proxy-Authorization,
  If-Modified-Since, If-Unmodified-Since, From, Location and Max-Forwards
  (`If-Modified-Since: Tue`, a Chrome User-Agent ending at "(KHTML", a
  Digest Authorization cut after its first parameter), so conditional GETs
  never answered 304. Nimbus restores those fields, in `req.headers` and
  `req.rawHeaders`, from the request it hands the native server.

- `npx sirv-cli` starts. `require` of a package without `exports` reads
  `main`, as Node does; the bundlers' `module` field is honoured only under
  the `module` condition (browser/bundle resolution). tinydate@1's `module`
  is `export default fn`, so `require('tinydate')` returned its namespace
  and sirv-cli threw "tinydate is not a function". Legacy subpath
  directories (`pkg/sub/package.json`) are Node's LOAD_AS_DIRECTORY through
  `main`; the prefetch walk's synthetic re-export stubs for them are
  deleted.

- `npx serve` starts. An ES module with top-level await (serve 14's
  `build/main.js`, nuxi's bin) is emitted by esbuild as ESM and now lowered
  to a CommonJS body from Acorn's parse of its declarations. The previous
  line-regex converter left esbuild's multi-line `import {…} from` clauses
  inside the async function ("Cannot use import statement outside a
  module"); it, its classifiers and the comment scanner's literal-blanking
  mode are deleted.

- Removing an import's destination abandons the import, so an interrupted
  import can be started again there. An import whose sender stopped after a
  page kept its `vfs_jobs` row after its destination was removed, and
  `importCursor(dst)` still answered the old cursor, so every later import
  into that path was taken for a replay and refused with `EINVAL: replay
  metadata differs`. An import now records where it stands: the inode dst's
  parent directory resolved to when it began, and dst's own once dst
  exists. At every page, chunk frame and cursor, every directory above dst
  must still be one and those paths must still resolve to those inodes, so
  the removal that commits is what ends the import: `unlink`, `rmdir`,
  `removeRecursive`, a rename away or over dst, of dst or any directory
  above it (a sliced restore's too, part-way), a directory made again or
  renamed into its place. A restore whose subtree holds dst, or lies inside
  it, ends the import as it begins, since it rewinds what the import wrote.
  A job that records no parent (from an earlier build) is never taken for
  an import. No page, frame or cursor sees an ended import, and a new import
  into dst starts clean. A sweep after the removal commits (never inside an
  embedder's `withTransaction`, whose rollback keeps the import whole)
  deletes its row and queues the staging it held (a manifest cut off
  mid-import, chunks sent ahead of their pages) for collection, within the
  maintenance pass's transaction allowance, in bounded transactions that
  only free storage, so a full store never refuses them; a crash before the
  sweep leaves the import ended, and the next open sweeps it. The job rows
  name that staging, and GC reads its pins from them, so no in-memory state
  outlives a rolled-back transaction. Every export page also names its snapshot
  (`VfsExportPage.source`, export schema 3), and an import takes pages only
  from the export its first page came from, so a late page of an abandoned
  import is refused even when a new import of another export is open at
  dst. An import nobody removed still resumes after a reset. An embedder
  that carries pages through its own schema must carry `source` too.

- A filesystem error's message is Node's: `ENOENT: no such file or
  directory, open 'x'`, with libuv's description, the syscall, the path
  after a space, and `-> 'dest'` for a call that names two paths.
  `VfsError` joined a supplied path with a comma (`..., open, 'x'`), the
  runtime bridge and hosted node's `fs` left the description out
  (`ENOENT: open 'x'`), and the shell printed the engine's bare
  `ENOENT: home/user/w/nope`. Every `VfsError` now names its syscall
  (`err.syscall`, and `err.dest` for a rename, copy or symlink), including
  the namespace's own refusals, which report the call that met them. The
  new `syscallError(code, syscall, path, { dest, detail })` makes one.
  `toVfsError(error, syscall, path, dest?)` takes the call it converts for,
  and keeps an error's own syscall, path and `dest` where it names them.
  Hosted node's `rename`, `symlink`, `copyFile` and `link` errors carry
  `dest` as Node's do; `symlink`'s `path` is the target and `dest` the link.
  A call naming two paths reports both as its caller gave them, whichever
  one's check failed (a rename into a missing directory names the source,
  then the destination), from the runtime bridge and hosted node alike.

- A resident node or bun process ends as Node's does: when it holds no live
  handle (a timer, an operation in flight, a listening server that is not
  unref'd, a held stdin), and its exit is reported as `process.exit`'s is.
  It used to end only on `process.exit`, so a program run resident that
  simply finished (a CLI whose serve path was not taken, `--help`, a server
  that closed its last listener) kept running and never reported an exit.
  One that finishes during its boot reports before the boot answers, so the
  shell prints its exit code instead of "started (long-running)". The
  resident waits on handle releases rather than polling. `--watch` and
  `--inspect-brk` still hold a process with nothing left, as in Node. An
  open connection is a handle too: an HTTP exchange a server is answering
  holds the process until its response closes, even after `server.close()`
  (a handler that closed the server and was still streaming its reply to an
  upload used to see the process exit under it), and so do a WebSocket
  client and a `tls.connect` socket until they close or are unref'd. A
  request body the handler never reads does not hold it. A handle is counted
  only once it exists: a `setTimeout` given a delay it refuses, or a
  `WebSocket` given a bad protocol, throws, and when the program catches the
  throw it holds nothing (either used to leave a count behind, so the process
  never ended, one-shot runs included).

- node-static sends a file's body; after the `url` fix below it answered 200
  with an empty body. node-static pipes a file with `{ end: false }` and ends
  the response on the file stream's `'close'`, which a guest stream never
  emitted. Guest streams now keep Node's lifecycle, in Node 22's order:
  - A stream that is done is destroyed and emits `'close'` (`autoDestroy`):
    a readable after `'end'`, a writable after `'finish'`, a Duplex once both
    sides are done. So a copy that waits on the destination's `'close'`
    (`src.pipe(fs.createWriteStream(f)).on('close', …)`) completes.
  - Writes run one at a time, and `end()` waits for every write to call back
    before `_final` and `'finish'`. An asynchronous Transform's output is
    delivered and an asynchronous write completes before `'finish'`; `end()`
    used to run `_final` at once.
  - A failed write, or `destroy()`, answers every queued write and `end()`
    callback; a failed write then destroys the stream, as in Node.
  - `autoDestroy: false` keeps a stream open, `emitClose: false` destroys it
    without `'close'`, and fs streams read them from `autoClose` and
    `emitClose`.

- `npx static-server` serves instead of holding the terminal in the
  foreground with its port unreachable, and so do `npx sirv-cli` and
  `npx live-server`. A port is reachable only from a resident process, which
  is chosen before the program runs, and a program that finishes there is
  never reported ended. Whether `node <file>` (or `bun`, `node -e`,
  `node -`) starts a server was a text match on the entry (`.listen(`,
  `createServer(`, `serve(`), so these bins, which hand off to their
  package's server module, were missed, while a comment or a server started
  only for another subcommand made a script resident. It is now judged by
  walking the code this invocation runs (core `runtime/server-launch.ts`):
  branches known false for its argv, code after `process.exit()`, and
  functions only defined or exported do not run; the package's own modules
  are followed as they are loaded and used, through aliases
  (`const make = http.createServer`) and re-exporting modules. An argument
  decides only where the program branches on it, as in Node: its own
  `process.argv` tests, and a CLI parser (commander, yargs, sade, cac),
  whose actions run only when it parses: none for `--help`/`--version`,
  which it answers (`dev --help` too), and a command's only when argv names
  it. An ES module entry decides as its CommonJS form does (a parser is
  known through the transform's `__toESM(require(...))`), and a parser one
  module configures and exports dispatches where another parses it. A server that does
  not read `--help` or `build` still binds. `.listen`
  binds unless it is the program's own `listen` method or its first
  argument is provably not a port (a callback, `this`, a socket path;
  constants resolved, so `const p = 3000; app.listen(p)` binds). Measured
  on 48 bins of 37 packages: the same servers are promoted, except `vercel`
  (its bundle is past the 2 MiB a walk reads) and `cf-wrangler` (it serves
  from a child process); degit, concurrently, nx, firebase and `vitest run`
  are not. `docsify` is resident only for `serve`, and `sirv` and
  `static-server` answer `--help`/`--version` one-shot.

- node-static (`npx node-static`) serves its files; it answered 404 for every
  one. The guest's `url` module imitated Node's legacy API over WHATWG
  `new URL()`, which throws for the path-only URL a server receives as
  `req.url`, so `url.parse("/hello.txt")` had no `pathname` and node-static
  looked for `<root>/undefined`. The legacy `parse`, `format`, `resolve`,
  `resolveObject` and `Url` are now workerd's own `node:url`; the guest keeps
  its `pathToFileURL` and `fileURLToPath`, which resolve against its cwd.

- Vite preview transforms share one esbuild instance in the session's facet.
  It is recycled once its measured wasm memory exceeds 64 MiB, or once it
  dies (its Go program exits or its wasm traps), after its last in-flight
  caller finishes. Previously every transform call initialized and stopped
  its own Go/wasm instance. `stop()` cancels the scheduler; memory is
  reclaimed by GC, not by stop. Parallel browser module requests exhausted
  the facet's memory and served error-overlay modules instead of Card and
  SystemStats, producing "does not provide an export named default". A
  throwaway preview now mounts the seeded React app: the failing crawl and
  browser probe peaked at 228 MiB; their fixed sessions peaked at 93 and
  97 MiB. The kept instance holds at 36 MiB over the seeded app and 400 more
  components, and 44 MiB after four 80–350 KiB TypeScript modules. A local
  V8 replay of Pi 0.87.1's 273-module launch made 23 slices (19 esbuild
  starts), retaining up to 153 MiB of uncollected wasm memories; kept, the
  instance plateaued at 52 MiB. A single 858 KiB module takes a fresh one to
  92 MiB. Instances are collectable, not a permanent leak. esbuild's adapter
  keeps every call's result or error reachable while its instance lives, so a
  kept instance hands out copies and fresh errors and empties what it keeps:
  120 transforms of a 190 KiB module left 19.2 of their 23.1 MiB of output
  on V8's heap before, and none after; 120 that failed on it left their 22.3
  MiB of input (through each error's stack), and now none. A transform whose
  instance died is answered as
  transient, so its launch fails as unavailable instead of caching a
  diagnostic shim of sound source. Builds and CLI calls keep their separate
  instances.

- esbuild facets are handed the host Worker's compiled esbuild module
  instead of 12 MiB of wasm bytes. The host already bundles
  `esbuild-wasm/esbuild.wasm` and workerd compiles it at startup. Worker
  Loader shares a compiled `WebAssembly.Module` member with the dynamic
  worker (workerd `worker-loader.c++`, `extractWasmModuleContent`).
  - The staged `/_assets/esbuild-0.24.2.wasm` and its fetch, digest check,
    and per-facet compile are gone, along with the `/api/_test/cache/wasm/*`
    endpoints that benchmarked that fetch.
  - The session's esbuild pool no longer retains the bytes. It no longer
    holds 11,907,565 bytes of resident supervisor allocation credit for its
    whole life. That resident lane was the credit pool's only use, so it is
    removed.
  - Measured locally on workerd 1.20260926.1 with esbuild's wasm: loading a
    dynamic worker and serving its first fetch took 14 ms when handed the
    Module and 64–75 ms when handed the bytes. On two Previews, a fresh
    session's first `esbuild` run took a median of 1,133 ms (n=12) against
    1,382 ms (n=8) for the build before the change.
  - `@nimbus-sh/fabric` adds `describeHostWasm` (`host-wasm.js`). A host
    records a module's id and wire size there. `IsolatePool` keys warm
    slots by that id and refuses an undescribed Module.
    `assertModuleMapWithinCodeLimit` counts the size, since a Module's
    bytes still count toward the 64 MiB dynamic-worker code limit.
  - The `worker-bundle-size` probe now checks the platform's limits as
    documented, not the 7 MB index.js budget: `Total Upload` ≤ 64 MiB
    uncompressed, and startup under 1 s as profiled by
    `wrangler check startup`. Measured: 18.42 MiB, 192.6 ms active CPU on
    local workerd.
  - The other fixed wasm stays staged and is handed over as bytes: sql.js,
    OpenTUI, yoga and tree-sitter (core, bash, powershell), 3.79 MB in all.
    esbuild's handoff was free because the host already bundled it. With
    these six bundled into the probe Worker, measured:
    - idle workerd RSS locally +8.1 and +9.2 MB (two runs), in an isolate
      every request and session shares, while most sessions never load them;
    - startup +~8 ms (`wrangler check startup`, three runs each);
    - Total Upload 18.4 → 22.0 MiB.
  - `_throwaway-target.mjs up` logs the Preview deployment's
    `startup_time_ms`, the platform's own startup figure.

- Node children spawned with `stdio: 'inherit'` now relay stdout and stderr
  through the parent's output streams. Their public streams stay null, but
  child close waits for inherited output to drain, so it precedes the
  parent's close-handler writes and does not end the parent's descriptors.
  Inherited stdin uses the parent's input/terminal pump, preserves bytes
  and EOF, and detaches when the child exits. Managed dispatch publishes
  output as it arrives rather than buffering prompts until exit; active
  live-stdin consumers hold the child alive without blocking resident
  startup. Node eval, stdin and script children reuse the broker's reserved
  pid, so their supervisor writes go straight to the child's queues, never
  to the shell or an exit-only capture buffer. Previously inherited output
  had no read loop at all; create-next-app hid npm's actual install output.

- SQLite filesystem calls through a process view reuse one checked inode
  traversal instead of re-walking every prefix, then walking again for the
  operation and revision. The namespace is consulted before each operation;
  links, mounts and beneath-root paths retain the component walk. A bounded
  last-resolution proof is invalidated by inode-table changes, mutations and
  confinement changes, and can share the checked parent among adjacent
  entries. Git's 400-file status/add/commit benchmark is back within the
  baseline's variation (50 alternating samples per revision in one process);
  permission changes and mount overlays still take effect immediately.

- `npm install` run by a node process (`create-next-app`, or any
  `child_process.spawn('npm', ...)`) installs again. Its resolver's last
  layer ran in-DO and its install batch followed at once, sized to the
  Durable Object's Dynamic Worker headroom; the platform still counted the
  resolver's workers for a moment after their calls returned and refused
  the batch ("Dynamic worker concurrency limit exceeded"), so
  create-next-app aborted with "npm install has failed". A pooled call the
  platform refuses to start now waits and is sent again, as the platform
  asks (up to 15 s), and the platform's limit message is recognised, so a
  hit that outlasts the wait names the workers that were in flight.

- `npm install` links every command of a project with more than about 120
  of them. The installer wrote all of `node_modules/.bin` in one W7 stream,
  which owns at most 128 paths, so the install failed at link-bins with
  "w7-frame: batch exceeds 128 owned paths"; a bin manifest past one chunk
  (a few hundred commands) failed with "expected 2 chunks, got 1". The shims
  now go in waves, and each file in chunks.

- A bash fork costs a fraction of what it did. Every fork instantiated
  bash anew, grew the child's memory to the parent's (about 17 MB, mostly
  the asyncify arena) and copied all of it, so a command-substitution loop
  of 500 iterations ran the facet out of CPU time ("dispatch failed: Worker
  exceeded CPU time limit") and `tests/unit/bash-pipes-jspi.mjs`' 2000-fork
  pipeline ran local workerd out of 4 GB. A fork now takes the instance of a
  process that exited normally when one is idle (up to four are kept per
  session), and copies only what the child can read: the memory below and
  above the arena, the unwind it resumes from, and each live setjmp capture
  up to its high-water mark (about 1 MB). A 300-iteration loop instantiates
  bash 4 times instead of 301; the 2000-fork pipeline peaks at 1.4 GB. On a
  deployed Worker, `echo "$(printf ...)"` in a loop went from 140-175 ms a
  fork (500 iterations exceeded the CPU limit) to 2000 iterations in 1.8 s.

- A process's filesystem call on a SQLite path costs less: a stat five
  components deep through the process bridge (`bind(...)`, `ProcessView`)
  went from 23.5 to 11 µs. The bridge's walk looks each component up once
  (the engine's credentialed view gains `kind(path)`, what `exists`,
  `isFile`, `isDirectory` and `isSymlink` each looked up separately), the
  namespace answers `composes` without normalizing a path whose first
  component no mount shares, and `normalizeVfsPath` returns a key already in
  canonical form as it is. The tools that now read a project through the
  caller's view (git, npm, vite build) gain the same.

- Native HTTP client I/O now remains live until the request's response body
  completes, errors or is cancelled, rather than ending at response headers.
  Referenced `listen(0)` allocations also keep the process alive until binding
  finishes. Closing a pending allocation emits `close`, permits immediate
  relisten, and retires late replies without disturbing the new listener.
  Import rewriting uses Acorn's full lexical/grammar context in one pass:
  regexp text after `await`, template text and comments are never rewritten
  as imports. Sloppy CommonJS, methods and ASI retain their native grammar.
  The Bun HTTP test adapter no longer charges its internal TCP connection
  sweep as a guest timer: refinement boots no longer wait out the one-second
  startup budget. Application option getters and listening callbacks remain
  guest-accounted; only the native connection-sweep listener uses host timers.
  Real workerd retains its native scheduling unchanged.

- Node HTTP guests now use workerd's native `node:http` server and
  `cloudflare:node.handleAsNodeRequest` instead of Nimbus's synthetic
  IncomingMessage/ServerResponse/Server classes. Native HTTP/HTTPS clients
  also replace the throwing HTTP client and the buffered HTTPS mini-client.
  Nimbus still owns port registration, VFS admission, requests parked before
  a listener attaches, and the response-header deadline. `listen(0)` reserves
  a distinct port through the session supervisor rather than independently
  choosing 49152 in every guest; ref/unref affects the process live-handle
  count without removing its route. Opencode's `node:http` map bridge is
  removed: its ESM imports share the patched native Server prototype. This
  does not add WebSocket upgrade support to workerd's HTTP dispatcher.

- Large Node CLI cells find dynamic imports and import.meta with
  es-module-lexer's CSP build, without a whole-cell AST or a runtime wasm
  compile. It is vendored as a factory, so the scratch buffer a large cell
  grows (8 MiB for pi's 3.8M-character chunk) is dropped after that cell.
  Acorn reads only spans: a call's arguments, the braces around an
  `import(...)` whose `{` opens the next line, directives, and escaped
  names. A cell the lexer can misread (a `/` in code whose regex reading
  could hide import syntax, an HTML-like comment in code, `new import(`, a
  lexer error) goes to Acorn's streaming parser. Over 636 real files and
  pi's 274 launch requests, both modes (1,820 rewrites), the output is
  byte-identical to the previous parser's and no cell needed the parser:
  1.2 s against 6.9 s. Of 137 grammar edge cases, 136 match and
  `o?.return / import()` now matches Node. The 3.8 MiB Pi 0.99.1 cell takes
  118–195 ms warm in a local V8 replay. The release candidate
  repeatedly killed that rewrite-only cell at the facet CPU limit; the same
  Pi version rendered its TUI on 957a56a6. Transform slices retain their
  256 KiB / 32-file bounds. If a resident launch fails before its guest exists,
  its already-returned pid now exits with the cause rather than remaining
  "running" behind an empty terminal. This exposed the actual cause of the
  intermittent pi TUI timeout: an esbuild-facet CPU-limit failure during
  module-map construction, not a stuck stdin or TUI renderer.

- The deploy-isolation preflight now audits Worker Previews
  (`wrangler preview`, https://developers.cloudflare.com/workers/previews/).
  Every `previews` block is its own deploy target in
  `bun scripts/deploy-isolation.mjs` and `tests/unit/deploy-isolation.mjs`.
  A Preview gets automatic isolation only for its Durable Objects, so the
  check refuses a block that shares D1/R2/KV ids with production or with its
  parent Worker (except the shared-by-design caches). It also refuses a
  service, Workflow or DO `script_name` binding that reaches the parent's or
  a production Worker's deployment, and a Preview of the production Worker
  itself. It warns about any Worker binding the Preview does not redeclare.
  `apps/probe/wrangler.jsonc` carries a `previews` block that passes the
  check.

- Throwaway probe targets, local and CI's, are Worker Previews of
  `nimbus-probe-previews`, a parent Worker with no production deployment.
  They are no longer separate `nimbus-tw-*` Workers.
  - `_throwaway-target.mjs up --name x` creates or updates Preview `tw-x` at
    `tw-x-nimbus-probe-previews.<subdomain>.workers.dev`.
  - Each Preview has its own Durable Object namespace and storage. Measured:
    a file written in a session on one Preview is absent under the same
    session id on another, and present again on the first.
  - `JWT_SECRET` is uploaded with every deployment (`--secrets-file`), and
    the dashboard's Previews Base configuration is ignored.
  - A deploy counts as landed only when the Preview's latest deployment id is
    the one reported and differs from the one before.
  - `down` runs `wrangler preview delete` and confirms through the API. The
    Preview's storage goes with it: a terminal no longer opens. Its
    hostname kept answering from the edge for over two minutes afterwards.
  - `list` shows every Preview under the parent, marking the ones no local
    checkout holds.
  - The parent is created with Preview URLs on.
  - Staging stays two Workers: Cron Triggers and routes target production
    only.

- A rebuild stages a new opencode artifact only from the directory named by
  `NIMBUS_OPENCODE_DIST`, and a named directory that does not exist is an
  error. Before, the stager fell back to `/tmp/opencode-research/dist-nimbus`,
  so a leftover build on the host silently replaced the committed opencode
  assets during `dist-integrity`. Without the variable, the committed assets
  are re-derived as before.

- The Cloudflare toolchain is current: wrangler 4.98.0 → 4.143.0, which
  pins workerd 1.20260603.1 → 1.20260926.1 and miniflare 4.20260603.0 →
  5.20260926.0-alpha, and `@cloudflare/workers-types` 4.20260605.1 →
  5.20260928.1. `nimbus init` (and `create-nimbus-app`) emits the same ranges.
- The compatibility date moves from 2026-04-01 to 2026-09-26, the newest
  that workerd accepts: `CF_COMPAT_DATE` (every Worker Loader guest), the
  hosted demo (all three tiers), the probe target, the library-host fixture,
  `nimbus init`, the `@nimbus-sh/config` default, and the default for a
  sandboxed project's `wrangler dev` without a date. `nodejs_compat` is on by
  date from 2026-08-04, so the Worker configs no longer list it.
  `@nimbus-sh/config` still lists it for an earlier `compatibilityDate`.
  These flags become the default on the way: `web_socket_auto_reply_to_close`
  (a received Close is answered and `readyState` is CLOSED in the close
  event; Nimbus only compares against OPEN),
  `enhanced_error_serialization` (below),
  `diagnostics_channel_has_subscribers_getter` and
  `throw_on_not_implemented_tls_options` (Node conformance for programs:
  `hasSubscribers` becomes a getter; `tls.connect` with `checkServerIdentity`
  throws `ERR_OPTION_NOT_IMPLEMENTED` instead of ignoring it),
  `nodejs_compat` and `nodejs_compat_v2` (already listed), and
  `spec_compliant_dispatch_exceptions` (listener exceptions are reported and
  the dispatch continues). The Python Workers and Workflows flags
  (`enable_python_external_sdk`, `python_process_pth_files`,
  `python_workers_314`, `workflows_preserve_non_retryable_error_message`,
  `workflows_enable_fast_engine_creation`) change nothing here.
- A filesystem error's `code` now reaches a process as the error's own
  property. workerd's `enhanced_error_serialization` carries it across RPC
  when both isolates have it. The process's side no longer parses the code
  out of the message: `restoreCode` in `vfs-supervisor.ts` and the prefix
  fallback in the node shims are gone. `fsReadBatch` answers a failed entry
  with the error itself instead of a `{ code, message }` copy. Filesystem
  errors that carried the code only in their message (the VFS's integrity
  and batch-validation errors, EBUSY on destroy, the facet-ownership EPERM,
  the hosted session's EPERM) now set `code` too. **Embedders must** run
  their Worker with `enhanced_error_serialization`: add it to
  `compatibility_flags`, which keeps every other behavior of an older
  compatibility date, or set `compatibility_date` to 2026-04-21 or later.
  Without it `composeFabric` throws, naming both fixes, rather than every
  process seeing EIO where the filesystem said ENOENT. It throws where the
  embedder composes: a library host that composes through
  `NimbusWorkspace.create({ fabric })` gets the error from its first
  `NimbusWorkspace.create` (measured: HTTP 500 with that message), and a
  Worker on `@nimbus-sh/worker`'s entry, which composes at module scope,
  fails at startup (measured under `wrangler dev`). Verified on local
  workerd: a host at 2025-12-01 with
  only the flag added starts, and its processes get
  ENOENT/ENOTDIR/ENOTEMPTY. `@nimbus-sh/config` lists the flag for a
  `compatibilityDate` before 2026-04-21, as it lists `nodejs_compat` before
  2026-08-04.

- A destroyed session no longer keeps a live alarm when an alarm handler was
  running at the time of the destroy. The alarm dispatcher wrote its reasons
  map back and re-armed `setAlarm` after destroy's `deleteAll` and
  `deleteAlarm`. A schedule queued behind it did the same. `Timers.reset()`
  in `@nimbus-sh/fabric/timers` now voids every schedule and dispatch
  already requested, and destroy calls it in the same turn as the wipe.

- Workers traces are on for every deployment: every invocation on dev,
  staging, `apps/probe` and throwaways, 1 in 100 on production
  (`observability.traces`). A supervisor call the platform drops is now
  classified by its spans. SupervisorRPC's `nimbus.supervisor.deliver`,
  `.read` and `.append` spans name the process, writer, operation or read
  id, the attempts, the hedges and the attempt that answered, with an
  exception for each lost attempt coded by its failure class. Under a
  delivery or a read, the session's `nimbus.session.deliver` and `.read`
  spans record what each arriving attempt met: `nimbus.receipt` (`applied`,
  `replayed`, `awaited`) or `nimbus.read.joined`, and the refusal (ESTALE,
  EIO) as an exception. Spans are best-effort. On a runtime from before the
  2026-09-25 span methods they record attributes only. A span method that
  throws is ignored, so no span call can change or stall a call's answer.
  `idempotent()` in `@nimbus-sh/fabric/do-calls` takes a `span` recorder and
  reports `do_call.outcome` as the new `DoCallOutcome`.
  `SupervisorDeliveries.deliver` and `joinRead` in
  `@nimbus-sh/core/workspace/supervisor-delivery` now return
  `{ receipt, answer }` and `{ joined, answer }` instead of the bare
  answer. `@nimbus-sh/platform/tracing` carries the Workers span API to core
  and fabric, which cannot import `cloudflare:workers`; `@nimbus-sh/worker`
  hands it over at module scope (`adoptTracing`). AGENTS.md now points
  reset diagnosis at Workers Logs, traces and the GraphQL memory
  percentiles instead of `wrangler tail`.

- Hosted node's synchronous `fs` and `require` see a mounted filesystem
  again, an asynchronous one (no `sync` face: a Drive, a container, a
  device) included. 0.13 listed a process's namespace from SQLite alone, so
  `readFileSync`, `existsSync`, `statSync`, `readdirSync`, `writeFileSync`
  and `require` of a path on `ws.filesystem.vfs.mount(...)` answered ENOENT
  or "Cannot find module" while `fs.promises` read it. With a mount an
  embedder made in view, a process's listing and ACQUIRE (`bind(...).list`
  and `.acquire`, the supervisor's `fsList` and `fsAcquire`) now come from
  the namespace's feed (`CompositeVFS.feed`): SQLite's names and changes,
  less what a mount covers (a write SQLite takes under a mount point is not
  reported), the directories the namespace makes, and each mount's names
  where the process's launch names them — its working directory, program
  directory and arguments, the literal paths its code names, and the files
  its module map was read from — walked through the mount as the process's
  credential (`CompositeFeed.walk`, a readdir per directory). A named
  directory is listed whole, breadth first, up to `MOUNT_LIST_NAME_LIMIT`
  (8192) names per launch, with every directory from the mount point down to
  it; a mount the launch does not name, or one under a directory the process
  cannot search, is not walked. A change of the mount table is a poison at
  the process's next barrier, which relists. A namespace that is SQLite alone
  lists and acquires exactly as before, synchronously. With a mount, the
  page's byte bound measures each SQLite name once, when SQLite lists it,
  and then only the path the process sees (a 40,429-name listing
  stringifies 18.1M characters instead of 32.5M). A synchronous call on
  a mounted path the launch did not list (or past the bound) answers EAGAIN,
  "<mount> is an asynchronous mount; this caller cannot wait for it", naming
  the `fs.promises` form that reads it; `require` of one reports the same,
  and `existsSync` is false. A missing name in a directory the launch listed
  is ENOENT. The listing marks such a directory with `VfsListEntry.unlisted`
  (its mount point). Contents follow the existing data plan and store
  budget. A synchronous write reaches the mount through the process's
  write-back, once. A kept resident store never vouches for a mounted file's
  bytes (a mount keeps no revision on the session's clock), so a relaunch
  reads what the mount holds. `NimbusFilesystemAuthority.nameLaunch` is how
  a launch names those paths. `CompositeFeed.list` orders by code point, as
  SQLite does, and a directory it makes above a mount point carries the stat
  `stat` gives it. The one-shot runners' `vfsWrites` result field and the
  manager's fallback that wrote it into SQLite are gone: a runner without a
  supervisor never started user code, so the field was always empty.

- npm installs and other fan-outs run on the session's own Worker Loader
  isolates up to Cloudflare's documented limit: 10 distinct Dynamic Workers
  with in-flight requests per Durable Object, where repeated requests to one
  worker count once (2026-08-28). A batch now runs in-DO when it fits the
  session's remaining headroom, and only a wider one shards to sibling
  Durable Objects; before, anything of 5 or more tasks sharded. Every npm
  install (at most 8 shards), and resolve layers of up to 10 packages, no
  longer start sibling objects on an idle session. Measured on a
  throwaway: 9 packages installed in 2.4-5.5 s in-DO against 7.2-7.3 s on
  siblings; the fetch+write phase of 98 packages took 2.4-3.2 s against
  5.8-11.2 s, and of 850 packages a median of 115 s (n=44) against 113 s
  (n=12). The headroom is live: resident processes count for as long as
  they run, and esbuild facet calls, git
  network ops, one-shot programs and other fan-outs while they are in
  flight. A sibling runs its shard as wide as its own headroom allows,
  instead of 4. The install log names the route taken
  (`Dispatching N packages across S shards (in-do, dynamic-worker headroom
  H, …)`), and each resolver layer's profile entry ends in its route.
  `@nimbus-sh/fabric`: `IN_DO_THRESHOLD` is removed; `DO_DYNAMIC_WORKER_LIMIT`,
  `dynamicWorkerHeadroom(ctx)` and `claimDynamicWorkers(ctx, n)` are new;
  `beginLoaderFetch(ctx, workerKey)` takes the worker's key;
  `recordLoaderId` is removed, and `loaderLedgerStats` reports
  `{ limit, inFlightWorkers, claimed, headroom, peak }`. `Fanout` takes an
  `onRoute` callback. `IsolatePool`'s default concurrency is 1 (was 4).
  The `/api/_test/fanout/topology` diag reports `dynamicWorkerHeadroom`
  instead of `inDoThreshold`.

- An npm install no longer hangs until its 10-minute deadline when one of
  its write waves goes unanswered. The platform sometimes dropped a
  shard's `writeBatchStream` call without an error, and the call never
  settled. The session then had no stream, credit or transaction for it.
  On a throwaway this hit 6 of 47 in-DO installs of 850 packages (none of
  12 on siblings). A wave unanswered for 60 s is now re-sent,
  like the dropped-connection and shed waves already are; its writes are
  keyed by path and identical, so a late answer changes nothing.

- The tools read and write the paths they are given through the namespace
  as the calling principal, so they work on an asynchronous mount (one with
  no `sync` face, such as an embedder's drive or container) as they do in the
  SQLite home. Before, each reached the SQLite engine or a synchronous face.
  Each tool now reads and writes through the caller's view of the namespace,
  which routes a SQLite path to the engine; only the engine's bulk paths
  (npm's batched writes and bin stream, pre-bundling, git's network writes,
  the dev servers) address the engine, at the path with every link resolved
  (`engineKey`), so a mount's link into SQLite reaches the project it names.
  - A script run by its path (`/m/s.sh`, `./s.sh`) runs. The PATH resolver
    inspected it through the synchronous face, and the mount's EAGAIN ended
    the whole command line. A mount that fails now fails only that command
    (exit 126), and a name looked up from a cwd inside one is not found
    (exit 127) rather than ending the line.
  - `git` works a repository on a mount, as the command's credential.
    `git init` tried to create the mount point in the SQLite root and got
    EACCES. git runs in the directory with its links resolved, as getcwd()
    gives it. `clone`, `fetch`, `pull` and `push` write through the engine's
    batches and refuse a mounted repository by name. `runGitCommand` reads
    `ctx.vfs`.
  - `npm install` and `npm ci` read the project's package.json and lock as
    the invoking user, not the kernel. A mounted project's packages are
    extracted into a staging directory in /tmp, then each is copied beside
    its place in node_modules and renamed there (on a mount with no rename,
    written in place with package.json last), so a package is there whole or
    not at all; one that cannot be put there is reported failed and the next
    install puts it there. The next install also sweeps what an interrupted
    one left in /tmp or in node_modules. `npm run`, `ls`, `init`,
    `uninstall` and `npm-fast` read and write package.json through the
    command's view. A project's own `node_modules/.bin` programs run bare,
    from a script and through `npx`, looked up in the project as the running
    command (`npx` went on to install them into its cache).
  - `vite build` reads the project, and esbuild every module, through the
    command's view, and writes dist/ back there (`EsbuildService.build`
    takes a per-build `fs`). `vite`, `vite preview` and `wrangler dev` serve
    only projects on SQLite, judged by the root they serve, and say so for a
    mounted one.
  - `bun run` finds the package.json script and the file on a mount.
  - A command run through `child_process` gets its process's view as
    `ctx.vfs`, and `sh <script>` from `child_process` reads the script
    through it.

- Tools that wrote part of a user's project as root now act as the user,
  and hand what earlier releases wrote as root to the project's owner before
  replacing it: vite build's `dist/`, the `package.json` that `npm init` and
  npm-fast wrote, and pre-bundling's `node_modules/.nimbus-synthetic`. Only
  those paths, and only what the owner could already read and replace; a
  root-only file, or a link, in their place fails the tool. `npm install
  <pkg>` and `npm uninstall` fail, and say why, when they cannot record the
  change in package.json; they exited 0 without recording it.

- Code a node process produces while it runs compiles in the next launch of
  the same command instead of never. A Worker compiles only from the module
  map it was launched with, and a Worker Loader map cannot grow after load
  (a dynamic worker has no module fallback), so this launch still refuses it —
  now with `EvalError` code `ERR_NIMBUS_CODE_NEXT_LAUNCH` — but the run's
  report (the one-shot envelope, the resident exit report) carries the text,
  the supervisor keeps it by SHA-256 in the session's Durable Object storage
  (at most 1024 pieces and 8 MiB, each charged its text plus a fixed
  overhead, least recently recorded out; a relaunch after the isolate was
  evicted or hibernated still gets it), and the next launch carries it as
  `gen/<key>.js` modules compiled on first use. It is reached without any
  opt-in: at request time the `AsyncFunction` and generator constructors
  (each kind's `prototype.constructor`, as a module runner reaches them),
  `vm.compileFunction`, `Module.prototype._compile` and a
  `require`/`import()` of a file the map lacks all go to it. The plain
  `Function` constructor stays native: code probes it once and keeps the
  answer (TypeBox's `CanEvaluate` in pi), and a staged probe would vouch for
  texts that are not staged. A constructor's arguments build the function
  the constructor would (same source text, body on line 3, global scope),
  and arguments it would refuse throw its SyntaxError and never run. A file
  is keyed by its text, directory and extension, not its name, so a fresh
  file name each run
  (Vite's `.vite-temp/*.timestamp-*.mjs`) converges. Text that changes on
  every run — a module runner's transform of an edited file — needs one
  relaunch per change.

- A node process compiles a module the first time it requires it, not at
  startup. Each code file of the launch's closure, and its entry, is now a
  `{ cjs }` module of the facet's map (`vfs/<path>`, `entry/<path>`, each
  character URL parsing would drop, trim or rewrite percent-encoded, so every
  path is its own module) that the guest's module registry
  (`new_module_registry`) compiles on first require; the shims' `require`
  still resolves the path and calls the module's Node wrapper with its own
  `require`, `module` and `exports`. A CommonJS file runs as Node's wrapper
  runs it; an ES module lowered to CommonJS runs in a block inside the
  wrapper, so its own top-level `const require`/`const __dirname` shadow the
  parameters. The facet no longer compiles the whole closure with
  `new Function` at module evaluation, and a module's stack frames name its
  module and line (`file:///bundle/vfs/home/user/app/a.js:2:7`; a column on
  the first line is offset by the wrapper) instead of `eval at
  __mkCompiledFn`. A SyntaxError carries no location of its own: the entry's
  stack leads with its file, as Node's does, and a required module's message
  names it. A code file is carried once: the process's store takes the
  file's content from the module's own text, read back through the bundle
  filesystem, so the map holds no second copy. A TypeScript source stays the
  file a program reads and its emit is the module. A resident launch ships
  the modules as one content-addressed image (`vfsCommonJsPacks`, decoded by
  `residentLoaderConfig`). Removed: the startup pre-compile loop
  (`BUNDLE_PRECOMPILE_LOOP`, `__compiledModules`, `__compileFailures`), the
  NUL-keyed compiled cells (`compiledCellKey`, `compiledCellPath`), the
  request-time `new Function` fallback and `@nimbus-sh/core/_shared/compiled-fn`.
  ESM is still lowered to CommonJS and resolution is still Nimbus's own: the
  registry resolves specifiers as URLs only, keeps every module under
  `file:///bundle/`, and takes no named exports for a `{ cjs }` module.
  `generateEntrypointCode` takes the entry's filename as a sixth argument.

- The Worker Loader guests Nimbus generates — the opencode facets, the
  esbuild transform facet, the git network facet, the hosted fetch proxy and
  every `IsolatePool` isolate (pre-bundle, npm resolve, child-process spawn)
  — run with `new_module_registry`, from one list, `GUEST_COMPAT_FLAGS` in
  `@nimbus-sh/core/constants`. Under it `require("process")` resolves to the
  global process, so a one-shot opencode run no longer carries a
  `node:process` bridge module, and only the attached TUI carries a
  `node:console` one. The resident modes keep their `node:process` bridge: it
  is how their bundle's `import "node:process"` reaches the shim process.
  Map entries named `node:<x>` still shadow the builtin under the new
  registry, so the `node:fs`, `node:http`, `node:os` and `node:sqlite`
  bridges are unchanged. `opencodeBuiltinBridgeModules` now takes the run
  mode instead of an attached-TTY boolean. The staged opencode 1.16.2 build
  no longer defines `import.meta.url` as `"file:///opencode/opencode-bundle.js"`:
  its modules read their real URL (`file:///bundle/<module>`), so its
  `createRequire(import.meta.url)` calls construct without a rewrite.

## 2026-09-28 (second release)

Published as core 0.13.1.

- A directory or file moved into a shared directory is shared at once in the
  running engine. The move wrote the shared mode, group and default ACL to
  the database, but the in-memory entry kept the pre-move values. Other
  members got EACCES on the moved entries until the next boot.

- `mkdir -p` of a symlink to a directory succeeds through `ws.fs`, the shell
  and a process's bridge, as coreutils and Node do. The bridge checked the
  link's own entry and answered EEXIST. A plain `mkdir` of the link, and
  `mkdir -p` of a link to a file or of a dangling link, still fail.

## 2026-09-28

Published as core 0.13.0, worker 0.11.0, fabric 0.8.0, platform 0.6.0,
sdk 0.9.0, config 0.2.2, and cli, loom, react and create-nimbus-app 0.2.0.

- A process's filesystem read that the session has not answered after 5 s
  is sent again on a fresh stub, and the first success is used. Under
  concurrent sessions some reads left SupervisorRPC and never reached the
  session; the program waiting on them hung. The first attempt is left
  running, and a late answer is disposed. Every attempt of a read carries one
  read id (the envelope's `readId`). The session joins a repeat that arrives
  while that read is still being served, for the same live process, so a
  read queued behind the read budget is read once. A host that predates the
  field serves each attempt. Repeats count against the existing three
  attempts. The callee's own error (ENOENT, EACCES) ends the call at once;
  a dropped or overloaded attempt ends it only when no attempt is left in
  flight. `idempotent()` in `@nimbus-sh/fabric/do-calls`
  takes the new `hedgeAfterMs` policy field; `onRetry` now fires when a retry
  starts, reports the failed attempt's own number, and a throw from it fails
  the call instead of leaving it pending. Mutations are not hedged.

- The metadata the node shims learn for each path they refetch now travels
  in the read batch. `fsReadBatch` takes an lstat request (`{ path, lstat:
  true }`) and answers it as the `lstat` op does. Before, each learn was its
  own `lstat` call, and a resumption refetches every path the program wrote:
  after 1,600 `writeFileSync` calls one facet sent 1,599 `lstat` calls at
  once. With concurrent sessions some of them stayed pending for more than
  30 s and never reached the session, and the program never exited. The same
  refetch now takes 50 round trips: 25 read batches and 25 lstat batches.
- A batch of concurrent ranged reads that filled up (1,024 paths or 4 MiB
  requested) is sent once. Before, it was sent when it filled and again by
  the microtask that opened it, so every entry was read twice: 1,536 of the
  3,135 reads that refetch sent were duplicates. Batches that carry only
  lstat requests no longer count toward the exec-diag `fsRpcReads` counter.

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
  end it. A successful kill prints nothing, as in bash. The resident exits
  with the signal's status (TERM 143, INT 130, HUP 129, KILL 137) and its
  exit record names the signal, instead of 137 for every signal.

- `mkdir -p /abs/path` works again for a non-root user under bash and for any
  process `mkdir` of `/`: creating `/` answers EEXIST, as mkdir(2) does, instead
  of EACCES from the root-directory write check. BusyBox's `mkdir -p` creates
  every prefix starting at `/`, so every absolute `mkdir -p` by a user failed
  with "can't create directory '/': Permission denied".

- In the workspace shell, `cat /dev/zero > file` (or into the terminal or
  /dev/null) fails at once with the device's "produces bytes without end"
  error again, instead of writing zeros until the session's storage is full.
  `cat` streams an endless device only into a pipe, whose reader ends it;
  `head -c N` and `head -n N` still read a slice of one. Commands that need
  the whole input (`wc`, `sort`, `tail`, `head -c -N`, checksums) get the same
  error for an endless device operand.

- A resident Node process now holds, from launch, a file its code reads with
  `readFileSync` or a read-only `openSync` (no flags, `'r'` or `'rs'`) by a
  statically known path, whatever the file's size, following any symlinks on
  that path to the file they lead to. The data plan used to drop every static reference of 256 KiB or more,
  so the first synchronous read of such a file raised EAGAIN. Its bytes are
  counted in the storage the launch asks the session ledger to admit. Large
  files the code only stats, joins or reads asynchronously are still left out. A path the code
  builds as `'/' + <unknown>` no longer stages every small file in the
  filesystem. A hole with a known prefix or suffix stages matching names in
  its directory, and the direct files of a matching directory (one level); a bare hole under a named directory stages that
  directory's files, minus dependency, VCS and cache directories.

- `vite` reads a `vite.config.ts` without esbuild when esbuild's transform
  cannot change what the config reader sees: the source parses as
  JavaScript using only syntax esbuild passes through unchanged (no
  operators, computed keys or template substitutions, so no generic call and
  nothing esbuild constant-folds), and every import binding is used and not
  shadowed (TypeScript drops an unused import). A fresh session's `vite` no
  longer waits about a second on the esbuild facet's start before serving
  the preview; other configs still go through esbuild. Transforms, builds
  and `esbuild` commands share one esbuild facet stub, dropped when a call on
  it throws, and a failed esbuild initialization inside the facet is retried
  instead of kept. (This replaces a background pre-warm of the facet at the
  first prompt, which slowed the session's first command.)

- The Worker bundle is back under its 7 MiB size gate (`-e production`
  dry run: 7,704,433 to 7,289,911 bytes). The git network facet's copy of
  the git module is now a staged asset
  (`public/_assets/runtime/git-<hash>.js`), fetched and sha-256 verified
  like the node-compat sources, instead of a second inlined copy of
  `vendor/git.generated.mjs`; `GIT_BUNDLE_CODE` is replaced by
  `GIT_BUNDLE_ENTRY`/`_BUILD_ID`/`_SHA256`. The facet manager no longer
  pulls the resident store's source text into the Worker by importing two
  constants from it; they now live in `vfs/facet-resident-limits.ts`.

- A process's filesystem mutations are re-sent when the platform drops the
  call to the session ("Network connection lost.", `retryable`), and apply
  once. Previously the program saw EIO (pip install failing with errno 29 on
  a wheel member; a FileHandle write loop failing partway). A session now
  names its instance in every SUPERVISOR binding it mints (`hostIncarnation`).
  SupervisorRPC sends a mutation on such a binding under the new
  `deliverOnce` op with one delivery id on every attempt, and the instance
  applies an id once, keeping its answer in memory: a repeat of a mutation
  that ran gets the same answer, or the same failure, and never overwrites a
  later write by another process. Another instance of the session refuses
  the repeat with ESTALE, and a host that predates the op refuses it as
  unserved; neither is retried or applied. Nothing is written to storage.
  Covered: writeFile, writeRange, truncate, mkdir, rmdir, unlink, rename,
  symlink, metadata changes, descriptor open/write/close/seek/dup, remove,
  copy and writeBatch. Appends are re-sent under their existing ledger
  identity, and descriptor stat and directory reads are re-sent like other
  reads. Only failures the platform marks retryable are repeated: three
  attempts, with the existing backoff, none started more than 5 s after the
  first. Overloaded and other failures surface unchanged, and so does the
  last drop when attempts run out. Answers are kept 15 to 30 s; after that,
  or once their process exits, the delivery id is kept as a 53-bit hash for
  10 to 20 minutes (at most 2 × 65,536 of them, about 5 MiB), and a repeat
  that arrives that late gets EIO, outcome unknown, and is not applied.
  Only bindings that act as a real process and route to the session itself
  name the instance, so pid-0 pools keep their warm isolates across
  restarts. Bindings minted by hosts that do not open a delivery store send
  each mutation once, as before. `fsWriteRange` is now served by the shared
  supervisor-op handler instead of `_rpcFsWriteRange`; it takes the same
  byte shapes and answers EINVAL for anything else, where the routed op
  wrote nothing and reported success. `writeBatchStream`, position-relative
  `fsRead` and non-filesystem calls are still sent once.

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

### SDK and hosted runtime

- A hosted runtime serves the SDK's session surface. `runtime.session({ shellId, cred })`
  returns an `RpcTarget` with every method a `NimbusSession` answers,
  streaming exec included, and `Nimbus.fromSession(() => session)` drives a
  sandbox over it, from the embedder's isolate or another one. A scope
  confines two things: the named shell its commands run in and the identity
  every command and file operation acts as (the session user when it names
  none, for every verb, `files.delete` included). A command that names
  another shell or no shell, and any call that names another identity, is
  refused with `EPERM`; a scope without a `shellId` runs no command at all,
  so it can never reach the embedder's workspace shell, but its file calls
  work. A scoped session cannot `destroy` the workspace (`EPERM`). It does
  not confine processes, ports, logs or applications: those verbs are
  workspace-wide, as they are to the shell's own `ps`, `kill`, `logs` and
  `nimbus expose`/`app`.
- `sandbox(id, { shellId })` runs every command in that named shell unless
  the call names another.

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
