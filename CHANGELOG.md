# Changelog

All notable Nimbus releases are summarized here. Package-level versions are
published independently in the `@nimbus-sh` npm scope.

## Unreleased

- Fixed (CI): a probe task armada starts again after losing its container
  is graded. Its token, minted when the job was submitted, could expire
  before the second attempt's limit, so that attempt refused to run and the
  task went ungraded (train 1021a's paired perf, twice: the first attempt's
  container was lost after 17 minutes). `remote-probes` now runs such a
  task once more, in a job of its own with fresh credentials, for the
  suite, a regrade and a paired confirmation alike, so no token lives past
  one task's limit. The wait a task may take before its first attempt is
  the sum of its measured parts (35 s to create the job, up to 331 s to
  prepare an environment, up to 61 s for a vessel), 428 s rather than a
  fixed 15 minutes, so each token lives about 37 minutes instead of 45.
  Each task's verdict now says when it started, and each run says how long
  its tasks waited, which measures the part not yet measured: many vessels
  waiting at once for fleet capacity.
## 2026-10-21: platform 0.15.0, core 0.26.0, fabric 0.21.0, worker 0.24.0, sdk 0.20.0, react 0.4.2, cli 0.2.11, loom 0.3.4, create-nimbus-app 0.2.7 (config 0.3.2 and the runtimes unchanged)

- Security: every session trusts the TLS roots this deployment serves, at `/proc/nimbus/ca-certificates.crt` (read-only, generated from the build as the rest of /proc is), and CPython's and Ruby's OpenSSL read them through `SSL_CERT_FILE` unless a program names its own. The bundle is Mozilla's roots as of 2026-10-20 (curl.se's extract, pinned by sha256), which no longer trusts emSign ECC Root CA - G3 and so nothing on a path to the eMudhra intermediates whose keys were found compromised that day. Before, CPython verified against a copy staged with its runtime (Mozilla's roots of 2026-07-16), which accepted certificates those intermediates issued for any name, and a session kept its copy until it reinstalled the runtime. Updating the roots is now `bun scripts/update-ca-certificates.mjs <date> <sha256>` and a deploy.
- Fixed: listing a session's processes (`listProcesses`,
  `GET /api/processes`) waits until each dev server its previous
  incarnation ran has its process again. Before, a listing right after a
  restart could come before the restore, so a host could not tell "none
  coming" from "not yet": Kinu failed a job whose server Nimbus then started
  again, and the job's second start found its port taken. The listing waits
  for the processes, not for their commands, so a command that never ends,
  or one that lists what runs itself, does not hold it. A restored server's
  ports and apps are listed as it starts, as at any start. Stopping a
  restored process before its command has run ends the restore of it for
  good. A listed process now also says which process it restarts
  (`restartedFrom`), as `/api/processes` did.
- Fixed: a WebAssembly program's or a worker's filesystem calls that cross to the session keep their options. Before, the hop dropped them, so:
  - a write that makes its parent directories failed with ENOENT in a new directory;
  - a write ignored the program's own umask;
  - a write or read stating the revision it is of could overwrite or return a newer file instead of failing ESTALE;
  - a read bounded to so many bytes read the whole file;
  - a listing returned what it was asked to leave out.
- Added: `tsc` works in a session with nothing installed. When no `node_modules/.bin` from the working directory up has a `tsc`, `tsc` and `tsrs` run tsrs, the Rust port of the TypeScript compiler built to WebAssembly: `@tsrs/wasm` 0.18.0-ts7.1.0-dev.20260929, which ports TypeScript 7.1.0-dev.20260929. It is experimental upstream (its diagnostics can come in a different order from tsc's). Nimbus serves it from its own assets, pinned by version and sha256, so the first `tsc` installs nothing. It type-checks and emits as tsc does, `--build` and incremental `.tsbuildinfo` included, with tsc's exit statuses (2 for type errors; 5 for a run that crashed, as on a stack overflow). It reads the project through the process's own copy of the filesystem, as every WASI program does, and runs on the session's warm workers. A project's own `typescript` still runs as installed. A `typescript` 7 project, whose compiler is a native binary that cannot run here, runs tsrs in its place, and a line says which compiler ran. `npx tsc` runs tsrs too; before, it installed npm's deprecated `tsc` package. `tsc --watch` exits 1: the wasm build has no watch mode, so install `typescript` in the project for it.
- Changed: a session keeps as many idle warm workers per interpreter or tool (`python3`, `ruby`, `clang`, `wasm-ld`, `git`) as its runs of that tool had in flight at once, up to the platform's ten Dynamic Workers in flight per Durable Object. Before, it kept at most two, so a third concurrent `clang` or `python3` run loaded its image again every time.
- Fixed: `git status` holds what its comparisons need of the worktree, not the worktree. Its one ordered scan of the tree is merged with the index as it goes, in the order both share, so only the directories it is in are held; its memory grows with the index alone. Before, status kept the whole scan (every entry's path, stat and listing row): about 0.6 KiB a file, 23 MiB more from 2,000 to 40,000 files, about 30 MiB on next.js's 34,000. Status also takes about a tenth less CPU on next.js's shape.
- Changed: `SupervisorRPC` no longer links the npm engine. Every isolate
  of a Worker evaluates, as it starts, every module its exported classes
  link. `SupervisorRPC` linked the npm cache client, and through it core's
  npm command, the `_shared/npm-*` tables and semver, though only its npm
  cache calls use them; they now load at the first such call. Bundled on
  its own, its static closure went from 133 modules (841 KiB) to 111
  (621 KiB). The session's RPC module no longer links the opencode artifact
  staging either: it validates a stage with a schema of its own
  (`facets/opencode-stage-spec.ts`). A Worker that also exports
  `NimbusSession` still links both through the session itself.
- Changed (CI): the paired `ruby-gem-require` perf probe grades the
  session's own time for each Ruby call, the least of 7 calls a round,
  instead of the time its client saw for one. Measured in an A/A of one
  commit, the client's time carried each Preview's placement (about
  +200 ms on some Previews), which made identical code read as 34% slower,
  and a call took over 1.5 times its round's least in 55–62% of calls. The
  probe now says what its grading was shown to find: a +60% slowdown, in 8
  of 8 replays and 3 of 4 live checks. A green says nothing about less.
- Added: a session's terminals by name. A browser terminal at `/ws?terminal=<name>` (a hosted runtime: `attachTerminal(ws, { terminal })`, `terminalFrame` and `terminalClose` likewise) is a shell of its own over the same workspace: its cwd, variables and history persist as a named shell's do and outlive restarts, its screen is stored and replayed per name, and one socket holds a name at a time (names never conflict with each other or with the session's own terminal, which is unchanged). `listTerminals()` names each with its cwd, whether it is live or attached, and the line it runs; `closeTerminal(name)` hangs up everything started from it and forgets its screen, state and history (SDK: `sandbox.terminals.list()` / `.close(name)`). Names are 1 to 64 of `A-Z a-z 0-9 . _ -`; there is no count of them: a live terminal measured 0.10 to 0.30 MiB of heap idle and 0.10 to 0.20 MiB more busy, and a saved one holds only its capped screen and a 0.8 KiB row. A process now has a controlling terminal, inherited from its parent; REPLs (python, ruby, interactive bash) bind to the terminal they were started from.
- Fixed: a reattached terminal shows the screen it left and adds nothing to it. The shell paints a prompt on reattach only when its line editor is not the last thing on the screen (a background job wrote after the prompt), and then once, on a line of its own, with the line being typed. A hosted runtime's resumed and reset notices are written above the prompt, which is painted again below them. Before, every reattach to an idle hosted terminal printed another prompt, into the screen and the stored scrollback, after a line being typed too.
- Fixed (CI): a throwaway Preview whose upload the API does not serve, as
  long as the upload itself took, is uploaded once more, with a warning,
  instead of failing the run. Measured on 20 uploads, the API served each
  273–1488 ms after `wrangler preview` exited, and the misses seen never
  landed later, so past the upload's own time another upload lands sooner
  than waiting. A Preview the run created keeps its signing secret through
  a miss whose upload wrangler reported, so a later `up` of the name
  redeploys it instead of refusing it for want of a secret (it had needed a
  manual `down`). `up` now refuses when the API errs on whether the Preview
  stands or on its latest deployment; it read the error as absence, which
  let it mint a new secret over a Preview that had one. On an account with
  no parent Worker yet, `up` makes the parent before it asks whether the
  Preview stands; it failed there, reading the Worker's absence as an error.
  `down` no longer waits up to 60 s for a deleted Preview's hostname to stop
  answering: the API's answer proves the deletion, and `list` says whether
  the hostname still serves it.
- Fixed (security): a process's environment is no longer stored where
  another process can read it. Before, a Node server's environment was
  written into its generated module, and a Python or Ruby server's into its
  durable image, under `/.nimbus`, which every account on the box can read.
  Now the environment goes to the process in memory when it starts. When a
  process is started again (after a reset, an on-failure restart, a durable
  app's relaunch on its port, or a dev server's restore), Nimbus asks the
  host for its environment through the new `resolveProcessEnv` option. The
  session keeps each such process's environment in a row of its own object,
  outside the filesystem. An embedder of `HostedRuntime` composes
  `resolveProcessEnv`; without it, such a restart fails and says why. A
  durable `spawnWorker` that passes an `env` now needs a
  `resolveWorkerLaunch` hook. The first start after the upgrade removes the
  copies earlier releases wrote in its records and durable images. It does
  not remove the generated program images earlier releases left in
  `/.nimbus/facet-images` and below `/var/lib/nimbus`, which still hold
  those processes' environments: that directory belongs to the embedder,
  which keeps its own images there. The session says how many it found, and
  `GET /api/_diag/session` lists them (`legacyGeneratedImages`). The hosted
  runtime owns its sessions' `/.nimbus/facet-images` whole, so it removes
  them there. Copies already taken in a snapshot, an export or a clone are
  not removed either. Remove `/var/lib/nimbus` with `sudo rm -r` once no
  durable worker boots from there. A Python or Ruby server whose image an
  earlier release wrote, under an embedder that composes
  `resolveProcessEnv`, is not restarted, and the session says so: start it
  again. `/api/_diag/session` lists the shell's variable names, not their
  values. Not fixed yet: a resident process's generated program image still
  holds the files its process read at start, and every account can read the
  image. A secret in such a file, such as an inline `VAR=secret` saved in
  `~/.bash_history`, stays readable by other accounts until the image
  store's privacy fix ships. Pass secrets through the launch environment
  instead.
- Fixed: the shell's commands walk their file operands as POSIX does. A `..` applies after the name before it is looked up, through a symbolic link to where it points, and a missing or non-directory name before it is ENOENT or ENOTDIR; a trailing slash asks for a directory (`cat f/` is "Not a directory"), and on a name being removed or renamed it names the entry itself, never a link's target (`rm -r link/` empties the target and refuses the link, `rmdir link/` says the link was not followed, as GNU's do). Before, `cat missing/../f` and `cat f/` read `f`, and `cat link/../x` read the `x` beside the link. Messages still name the operand as typed; `cp`'s into-itself check compares where the names lead; `mktemp` prints the name it made; logical `cd` refuses `missing/..` and keeps `PWD` logical; `mkdir -p` makes the names a following `..` leaves; `rm -r` refuses another name for `/`.

## 2026-10-20 (patch): worker 0.23.1 (every other package unchanged from the 2026-10-20 release)

- Fixed: `git status` holds what its comparisons need of the worktree, not the worktree. Its one ordered scan of the tree is merged with the index as it goes, in the order both share, so only the directories it is in are held; its memory grows with the index alone. Before, status kept the whole scan (every entry's path, stat and listing row): about 0.6 KiB a file, 23 MiB more from 2,000 to 40,000 files, about 30 MiB on next.js's 34,000. Status also takes about a tenth less CPU on next.js's shape.

## 2026-10-20: platform 0.14.0, core 0.25.0, fabric 0.20.0, worker 0.23.0, sdk 0.19.0, react 0.4.1, cli 0.2.10, loom 0.3.3, create-nimbus-app 0.2.6 (config 0.3.2 and the runtimes unchanged)

- Fixed: Nimbus no longer deletes an embedder's images in
  `/.nimbus/facet-images`. The store that holds a resident process's
  generated modules removed every file there that no running process booted
  from, an embedder's own images included (a durable worker's runner and its
  text modules, named by `facetImagePath`). After a reset, the first launch
  could remove a durable app's text module, and the app's next restart then
  failed with ENOENT. The store now writes to its own directory,
  `/.nimbus/process-images`, and removes files only there. Images an earlier
  release wrote to `/.nimbus/facet-images` stay where they are.
- Fixed: the shell's commands walk their file operands as POSIX does. A `..` applies after the name before it is looked up, through a symbolic link to where it points, and a missing or non-directory name before it is ENOENT or ENOTDIR; a trailing slash asks for a directory (`cat f/` is "Not a directory"), and on a name being removed or renamed it names the entry itself, never a link's target (`rm -r link/` empties the target and refuses the link, `rmdir link/` says the link was not followed, as GNU's do). Before, `cat missing/../f` and `cat f/` read `f`, and `cat link/../x` read the `x` beside the link. Messages still name the operand as typed; `cp`'s into-itself check compares where the names lead; `mktemp` prints the name it made; logical `cd` refuses `missing/..` and keeps `PWD` logical; `mkdir -p` makes the names a following `..` leaves; `rm -r` refuses another name for `/`.
- Fixed: a nested shell stops with its caller. `bash -c`, `sh -c` and `bash script` pass their command's signal to the shell that runs the program, and a hosted workspace's child shell stops on either that signal or its own. Before, an aborted or timed-out `bash -c 'while :; do :; done'` was reported stopped while its loop ran on, burning the session's CPU.
- Fixed: a Node program that renamed a file over another (`fs.promises.rename` or `fs.renameSync`, the atomic-save pattern) and then read the destination with `fs.readFileSync` could get the replaced file's bytes, while `fs.statSync` already described the renamed one. The replaced file's bytes now go with the rename, as an unlink's do. 
- Added: `NimbusWorkspaceOptions.mayChangeIdentity(from, to, command)`, the host's word on every identity change. It is asked before any process is made under a credential other than its parent's (`sudo`, `su`, any command's `runAs`, a spawn with a parent and a `cred`), in the one place a process is made; refused, the spawn fails with `EPERM: operation not permitted, uid 1000 may not become uid 0 (whoami)` and no process starts. A process the host starts with no parent is not asked. Absent, every change is allowed, as before. Before, `sudo` and `su` gave any process any uid with nothing asked.
- Fixed: a Node program that renamed, deleted or made a file and then listed its directory with `fs.promises.readdir`, `fs.readdir` or `fs.opendir` could be shown the directory without that change while it was still on its way to the session. These listings now wait for what the program did before them, as `readdirSync` already shows it.
- Fixed: in the shell, a `[[ ]]` operand that follows an alias ending in a blank is checked for an alias, the regex after `=~` included, as bash does. An operator in `[[ ]]` whose operand never comes (`[[ -n ]]`, `[[ x == ]]`) is a syntax error, as in bash. Before, `[[ -n ]]` was true.
- Fixed: the shell's redirections and `exec` share one descriptor table, as in bash. A redirection on a function call, a `{ }`, `while`, `if` or subshell, or `eval`'s or `.`'s text now applies over what `exec` set and is undone afterwards, including an `exec` made inside it. A pipeline element writes to its pipe, and `$(…)` captures its output, even after `exec >file`. Before, `exec`'s descriptors overrode every enclosing redirection: `exec >log; cmd | grep x` sent `cmd`'s output straight to `log`, bypassing the pipe, and `exec 2>log; f 2>other` wrote `f`'s errors to `log`.
- Fixed: the shell's arithmetic reads and assigns array elements, as bash does: `$((a[1] + a[-1]))`, `((a[i]++))` and `let 'a[0] = 3'`, in `[[ -eq ]]` and `for ((…))` too. `a` alone is its first element, and an element of a scalar turns the scalar into an array. A subscript of `@`, `*` or one before the first element is warned of as a bad array subscript, and the command goes on. Arithmetic refuses to assign a readonly name: `((…))` and `let` fail, and `$((…))` discards the line. `${t[-1]}` of a scalar is a bad subscript too. `$((…))` expands its text before evaluating it, as in double quotes, so `$(( ${#a[@]} - 1 ))` counts the array. An operand that is not one, or text left over after the expression, is a syntax error. Before, `a[1]` was read as `a`, arithmetic wrote readonly names, `$(( ${#a[@]} - 1 ))` gave 0, and leftover text was ignored.
- Changed: `git status` reads its worktree in one ordered scan of the
  session's filesystem instead of a listing per directory and an lstat per
  file. On next.js (34,302 files), measured on throwaway Previews, the
  session's CPU per `git status` went from 3.8–4.2 s to 1.0–1.6 s, and from
  7.4 s to 2.5 s (medians) on a slower placement; the wall time from
  4.7–5.5 s to 1.5–1.9 s. `list` itself judges each directory once, from
  its own row, so every walk of it is cheaper.
- Fixed: the shell's `export` and `readonly` are declaration builtins, as in bash: `readonly r=(1 2)` and `export e=([1]=x)` make arrays. A `name=value` argument to them, and to `declare`, `typeset` and `local`, expands as an assignment's value, without word splitting or pathname expansion, so `export x=$y` keeps `y`'s spaces. `readonly -p` prints declarations that bash reads back. Before, `readonly r=(1 2)` made the string `(1 2)`, `declare x=$y` split `y`, and `readonly -p` printed `readonly name=value`.
- Fixed: a Node program could read a file it had deleted with
  `fs.readFileSync` after the session restarted, while `fs.statSync` said
  it was not there: bytes the program's store still held under the name
  were served though the name was gone. `readFileSync` now answers as
  `statSync` does.
- Fixed (security): a command's environment in the shell holds only exported variables, as in bash. Before, every variable the shell held, exported or not, reached every command and program it ran, so `token=…` set without `export` was visible to `env`, `node` and any child shell. Prefix assignments (`x=1 cmd`) still reach their command, and `PWD` and `OLDPWD` are exported from the start, as bash exports them. A call's own `env` (`exec(…, { env })`) is exported for that call. `command -v` and `type` search the shell's own `PATH` even when it is unexported. A hosted terminal now saves its variables' export marks and arrays with their values. A terminal saved before this change restores with all its variables exported, as they all reached its programs then. A workspace call's shell (`exec`, a named shell's first call, a child shell) now starts from the workspace shell's exported variables, not every variable it holds. Shell parameters kept among the variables (`#`, `@`, positional digits, `$`) are never exported.
- Changed (core, public API): a named shell (`exec` with `shellId`, `withNamedShell`) now keeps its variables' attributes and arrays between calls: export marks, readonly, declared-without-value, and indexed arrays. Before, every variable came back exported, and arrays, readonly and declared names were lost. `ShellState` (`shellState(id)`, `parseShellState`) gains an optional `vars` with `exported`, `readonly` and `declared` name lists and `arrays` of `[index, value]` pairs. A state in which every variable is an exported scalar is saved and read without `vars`, so its JSON and any digest over it are unchanged. Once a call leaves an unexported variable, an array, or a readonly or declared name, the state has `vars` and its digest changes. `$` and `PIPESTATUS` belong to the call and are not saved. Rows from before `vars` read as before; the `vfs_shells.vars` column is added once. A call's own `env` and `cwd` now override a variable's whole binding, an array's too, and give it back afterwards.
- Fixed: the shell's `cd` sets `PWD` and `OLDPWD` the way an assignment does: an array's first element, and a readonly one keeps its value. In that case `cd` reports `PWD: readonly variable` (or `OLDPWD`) and returns 1, though the directory still changes, as in bash.
- Added: the shell runs `((expression))`, `let` and `for ((init; test; step))` as bash does. `((…))` returns 0 when the value is not 0. `let`'s status comes from its last argument. The C-style `for` takes a `do … done` or `{ … }` body, and `continue` runs the step. Shell arithmetic gains the comma operator, compound assignments (`+=` through `|=`), and working `++x` and `--x`, and a division by 0 is reported as bash reports it. A backquoted substitution inside `${…}` operands, subscripts and arithmetic now runs. Before, `((…))` ran its contents as commands, `let` was not found, `for ((` was a syntax error, `++x` gave x, and a division by 0 gave 0.
- Fixed: in the shell, a `#` inside a word is part of the word, as in bash. Only a `#` where a word begins starts a comment. `z=2#11; echo after` now assigns `2#11` and prints `after`, and `echo a#b` prints `a#b`. The check for whether an interactive line continues reads comments the same way. Before, a `#` anywhere ended the word and silently dropped the rest of the line.
- Fixed: the shell's arithmetic reads integer constants as bash does: `010` is octal (8), `0x1f` is hexadecimal (31), and `base#digits` takes any base from 2 to 64. A variable's value is read as an expression, so `x=0x10; echo $((x))` gives 16. `[[ a -eq b ]]` reads its operands as arithmetic, while `test` keeps decimal integers. A digit past its base, a base out of range, or a value that refers to itself is reported with bash's message, and the rest of the line is discarded. Before, every constant was decimal: `$((0x1f))` gave 0 and `$((010))` gave 10.
- Fixed: a WASI program (python, ruby, clang, bash) could lose a write,
  with `EIO` at its close or fsync, or with no error at all for a call
  that does not wait, when another process changed a file while the
  program was reading a directory: the session refused the write while it
  took back the program's read lease, and the program gave the write up
  instead of sending it again once the lease was back.
- Fixed: the shell's array literals take `[subscript]=value` elements, as bash does. `a=([0]=one [5]=z)` sets elements 0 and 5, a following word goes on after the last subscript, and `[i]+=v` appends to element i. The same holds in `declare -a`, `typeset -a` and `local -a`. A negative subscript counts back from the last element, and one before the first, an empty one, or `@` or `*` is reported and skipped. `declare -p`'s output for a sparse array now reads back as the same array. `a+=(…)` goes on after the last element that holds a value, and `a[i]=v` refuses an index before the first with `bad array subscript`. `${a[-1]}` counts back from the last element that holds a value, as writes do. A command made only of assignments that fails, through a readonly name or a bad subscript, discards the rest of its line as bash does: the next line runs with `$?` 1, including in a script (before, a script ended), and a subshell ends with 1. Under `set -e`, such an error ends the shell once it is reported, keeping what the array literal assigned before it, and a failed assignment ends an `sh` script. Before, `[i]=v` was stored as literal text at the next index.
- Added: `/api/_diag/session`'s launch record names the session's thread
  stalls (`stalls`): while work is in flight on its thread (a facet call, a
  one-shot's run, a git operation, a build or
  transform facet's call, a `wrangler dev` request, a supervisor call, or a
  terminal input's command),
  the session watches how late its own 50 ms ticks run, and records each
  wait of 250 ms or more with the work in flight across it. The facets a
  session loads share its thread, and a long slice of theirs ages the
  session's queue until the platform refuses requests ("Durable Object is
  overloaded. Requests queued for too long."). A probe that fails prints
  the record. heap-correctness/diag-reports-stream-retention reads the
  retained-write high-water mark once after its install instead of polling
  under load with no pause, and install-parallel-memory-bounded samples one
  read at a time and backs off after a 503, instead of adding to the queue
  that refused them.
- Fixed (CI): a probe's reset attribution reads a session's whole record.
  A telemetry query that comes back full (2000 events) is read again as the
  two halves of its span, until each comes back short. Before, the first
  2000 were all it read, and a reset logged past them read as "no reset or
  overload error logged". A record still reads as incomplete when one
  millisecond alone fills a query, or after 64 queries.
- Fixed: the shell's `node` refuses a hard link (`fs.link`, `fs.linkSync`, `fs.promises.link`) with `ENOSYS`, as the hosted `node` does: the filesystem has no hard links. Before, `linkSync` did nothing and returned, so the new name was never there. `truncate` and `ftruncate` (now also in callback form) check the length as Node does: a length that is not a number is `ERR_INVALID_ARG_TYPE`, and one that is not a safe integer is `ERR_OUT_OF_RANGE`.
- Fixed: a Node program could be told a file, directory or link it had
  just renamed was not there (`fs.statSync` ENOENT, and renaming it again
  refused) when input arrived while the rename was still on its way to the
  session: the program's own record of the rename read the old name, which
  the input's catch-up had already moved. The renamed entry is now found
  wherever the catch-up put it, also when the program renamed it again, or
  renamed its directory, before the first rename was answered.
- Fixed: a WASI program (python, ruby, clang, bash) listing a directory
  while another process changed it could be shown a listing the directory
  never had: a directory moved away listed as empty, or a renamed file
  missing from the directory it was renamed within. A listing is now of the
  directory as it stood at one moment, or the session is asked instead; a
  file or a missing name is no longer listed as an empty directory.
- Changed: a `python3` one-shot (`-c`, a script, `-m`) and a `clang` or
  `wasm-ld` run go to one of their session's warm workers, which keep the
  compiled interpreter or tool, instead of loading it into a new worker
  every time. Each process instantiates a fresh one there, so it finds
  nothing an earlier process left. A worker is used again only after a
  process that ended clean, was not killed, and never reached the network
  (a socket); a session keeps at most two idle per interpreter or tool.
  Measured on two Previews deployed side by side, 8 runs each (medians):
  `python3 -c pass` 513 ms against 1256, `python3 -c 'import json, re'` 819
  against 1828, `clang -c` 340 against 1929, and `clang` compile and link
  570 against 2825.
- Fixed: the shell's `node` makes symbolic links in the session's filesystem (`fs.symlink`, in its sync, callback and promise forms). `readlink` answers the link's text; it is `EINVAL` for a file that is no link and `ENOENT` for nothing. Before, `symlink` did nothing and `readlink` returned the path it was given. `readlink` answers in the encoding asked, and a lookup that fails on the way to a link (`ENOTDIR`, `ELOOP`) is `readlink`'s error. A path given to `fs` may be a `Buffer` or a `file:` URL, whose path is decoded (`%20` is a space); another scheme is `ERR_INVALID_URL_SCHEME`. A callback that is not a function is refused before anything is done.
- Fixed: the shell's `node` `fs.truncate` extends a file with zero bytes as well as cutting it, clamps a negative length to 0, and reports `open`'s errors, as Node does. It now also has a callback form, and takes a descriptor; `fs.promises.truncate` takes a path only, as Node's does. Before, a longer length left the file unchanged, and a negative one cut from the end.
- Changed: a `ruby` one-shot (`ruby -e`, `gem --version`, `bundle --version`
  and the like) runs on one of its session's warm Ruby workers, which keep
  ruby+stdlib.wasm compiled, instead of loading it into a new worker every
  time. Each process boots a VM of its own there, so it finds nothing an
  earlier process left. A worker is used again only after a process that
  ended clean and never reached JavaScript (`require "js"`); a session keeps
  at most two idle. On paired Previews a `ruby -e` launch took 0.38× the
  time (medians 471–493 ms against 1000–1731 ms) and a gem require 0.32×.
- CI: a paired CPU bench's arms each run their side's whole tree, every
  module resolved inside it, and a bench fails if an arm resolves one outside.
  Before, only a hand-kept list of modules was the baseline's, and the rest
  were the head's for both arms.
- Fixed: a WASI program (python, ruby, clang, bash) could see a file
  another process had deleted. A lookup or listing it asked before the
  delete, answered after it, put the name back. A name under a directory
  another process replaced was also still served. Now a lookup or listing
  that a later change overtook adds nothing, and a replaced directory's
  names are looked up again.
- Changed (Kinu ask 58): a mount that resolves its own paths
  (`MountOptions.resolvesPaths`) is handed the rest of a path as written,
  with its `.`, `..`, empty components and trailing slash, for its backend
  to walk as a kernel does. `/m/missing/../f` is now ENOENT, `/m/f/` is
  ENOTDIR, and `/m/link/../f` reaches the file beside where the link leads.
  The namespace keeps the names it owns: the mount point, a nested mount
  point or a directory above one met on the way, and a `..` past the mount's
  root. This applies to every operation, on both faces, and to a process's
  walks. `route().path`, a pin's and a held file's name, and realpath are
  that spelling when it has a `..`. Before, the namespace collapsed the path
  lexically first, so the backend read `/f` for each of those.
- Fixed: a WASI program (python, ruby, clang, bash) could see a stale name
  after another process changed it. A lookup or listing asked before the
  change and answered after it could put back a deleted file, keep the old
  file where another process renamed a new one onto the name, or hide a
  name another process added. A name under a directory another process
  replaced, renamed, or gave a new mode or owner was also still served.
  Now a lookup or listing that a later change overtook adds nothing, and
  that directory's names are looked up again.
- Fixed: a Node program's `fs.statfs` reports the storage limit a session
  enforces (10,000,000,000 bytes, `DO_STORAGE_LIMIT_BYTES`) as its capacity.
  Before, it reported 10 GiB, 737,418,240 bytes more than a session can
  store. `VFS_CAPACITY` is now that limit.
- Added: before each armada run, the CI client says how much the account's
  container registry holds, what has changed since the last run and who
  holds the most, and warns when the total grew 10 GB or more since the
  last run. The registry holds every armada environment snapshot and every
  container image, and the account's storage is limited.
- Added: `declare -p` (and `typeset -p`, `local -p`) prints each named
  variable as bash does, as a declaration it reads back: `declare -- x="1"`,
  `declare -a a=([0]="a" [5]="z")`, `declare -rx w="5"`, a control
  character as `$'…'`; an unset name is `declare: NAME: not found`, status 1.
  `export` marks a name exported (`export -n` unmarks it, `export -p` lists
  them), as `declare -x` does, and `unset` drops the mark. Before, `declare
  -p` was an invalid option.
- Changed (release): npm packages are published by a GitHub Actions workflow
  through npm trusted publishing (OIDC), and no npm token exists. Once
  production is green, `scripts/ci/promote.mjs` pushes the tag
  `npm/<sha12>`. The workflow packs that commit with every publish gate
  (`scripts/ci/publish-pack.mjs`) and publishes each version npm lacks, the
  runtimes first (`scripts/ci/npm-publish.mjs`). It replaces the armada pack
  (`remote-publish.mjs`) and the web-login script (`publish-web.sh`).
  `release.mjs staging` runs the same pack on CI and refuses a release npm
  would refuse. Each runtime package is built, packed and published with the
  release that needs it. clang's upstream is pinned to a commit, and its files
  and Ruby's tarball to their sha256. A tag `npm-dry-run/<sha12>` runs the
  pack and `npm publish --dry-run` on GitHub's runner.
  `bun scripts/npm-trust.mjs` links the packages to the workflow, once.
- Changed (core): the resident filesystem decides what a caller that
  cannot wait changes outside a subtree the process holds (its
  `synchronous` view). Such a change is answered at once, logged through
  the process's one client, and seen by the process until the view has
  the session's version of it. A descriptor names an inode, as on Linux.
  This is the engine Node's `fs` moves onto next, and that move deletes
  the shim's own. Each file the holder decides costs more CPU: on
  holder-ops-cpu against main, writing 1,000 files is 25% slower, a tar
  extract 5% and a checkout 8%. Clone, warm install, cold start, first
  paint, module load and gem require take the same wall time (paired
  against main, no detectable change).
- Changed (core): an operation a process decides by name without waiting
  carries the file it was decided on (W7 `expect`): the file's number,
  none, or the open that made it. The session refuses it before any
  effect where the name leads elsewhere by then (a peer replaced it, or a
  link there leads to another file): ENOENT where a file was expected,
  EEXIST where none was, EXDEV on a mount. The refusal is reported as any
  refusal of a decision is. Before, the operation acted on whatever the
  name led to, and an open's answer that named another file was merged
  into it.
- Fixed: `utimes`/`futimes` with `'now'` (or an omitted time) by a file's
  owner now succeeds when the owner lacks write permission, as
  utimensat(2) allows. Before, it was refused `EACCES`.
- Fixed: a Node program that replaced `Array.prototype.push`, the array
  iterator, `String.prototype.split` or `replace`, `RegExp.prototype.exec` or
  `Set.prototype.has` can still import a module the launch did not hold, and
  an error's stack still formats. import()'s fetch of the file, the resident
  store it lands in, a missed module's read and the stack formatter now call
  only what the launch captured before the program ran, as Node's loader does.
  Before, the import failed with ERR_NIMBUS_PREFETCH_UNREADABLE or "not in this
  launch's module map".
- Added: `/api/_diag/session` reports the session's last facet calls under
  `launch.facetCalls`: each call's facet, whether its worker was built for
  it (cold) or kept warm, and how long its code took to load and the call
  took.
- Fixed: a syntax error in `eval`'s text, or in a file `.` runs, is that
  command's status 2, said on its stderr, and the rest of the line runs, as in
  bash: `eval 'if' 2>/dev/null || echo recovered` prints `recovered`. Lines
  of the text before the error have run. In an `sh` script (bash's POSIX mode,
  also `--posix` and `set -o posix`), a syntax error before the text ran a
  command ends the script, as a special builtin's own failure does. Before,
  it ended the whole line, and `2>/dev/null` did not hide its message.
- Fixed: a `bash` script goes on after a special builtin's own failure
  (`. ./missing`, `eval -x`), as bash does outside POSIX mode; an `sh`
  script still ends there. Before, every script ended.
- Fixed: dragging a workspace divider could stop following the pointer at
  once when the preview's frame took focus as it loaded. The shell ended a
  drag whenever its window lost focus; it now ends one only when the
  pointer is no longer held by the divider.
- Fixed: when the file tree could not list the session's files, filtering
  it or opening a file (the editor's welcome page opens one) replaced the
  failure with "Empty", as if the session had no files. The failure now
  stays shown until the files are listed.
- Added: the shell's `[[ word =~ regex ]]`, as in bash 5.2. The regex is a
  POSIX extended regular expression as glibc compiles it. Its parentheses,
  and the blanks and `|` inside them, are its own; quoted characters match
  only themselves. A match is leftmost, then longest, and sets
  `BASH_REMATCH`. A regex glibc refuses gives status 2. Before, `=~` was
  "test: too many arguments".
- Fixed: the shell reads a script a line at a time and expands aliases as it
  reads, as bash does.
  - A line is read whole before any of it runs. A syntax error on a later
    line leaves the earlier lines run; one on the same line runs none of it.
  - An alias defined on a line is expanded from the next line on.
  - An alias's text is read in place of its word, before reserved words, so
    `alias begin='if true; then'` works, and a comment in it takes the rest
    of the line.
  - A function keeps the aliases it was defined with.
  - A here-document after `;` on its line is read.
  - A command followed by another without `;`, `&` or a newline is a syntax
    error, as `(echo a) (echo b)` and `x=1 (echo hi)` are in bash.
  Before, a whole script was parsed first, an alias was expanded when its
  command ran, and those two commands both ran.
- Fixed: Tailwind v4 generates the utilities its stylesheets' `@source`
  directives name outside the working tree. Tailwind's scanner reads those
  files synchronously, and they were not held for it, so their classes were
  silently missing. A process carrying the scanner now holds the files under
  each such source, found from the project's stylesheets (its own, those
  behind its links, and the sheets they `@import`), each brace alternative's
  directory taken whole, through links, with the project's exclusions
  (`node_modules`, VCS and cache directories). Their changes reach the
  dev server as the working tree's do, and a source on a mounted drive is
  listed for the process. At most 5,000 files of under 256 KiB each are
  held this way; past that, a launch says where it stopped, and the rest
  are learned from what the scanner misses.

## 2026-10-19 (patch): core 0.24.1, fabric 0.19.1 (every other package unchanged from the 2026-10-19 release)

- Fixed (data loss, since core 0.19): a recursive removal no longer enters a
  mount point. `CompositeVFS.removeRecursive`, and so the shell's `rm -r`, the
  SDK's `files.delete`, npm's and git's removals and a guest's `fs.rm`, keeps
  the mount point and everything under it, reports it EBUSY in the result's
  failures, and removes the rest, as GNU `rm --one-file-system` does. Before,
  `rm -r` of a directory holding a mount deleted what the mount held (Kinu
  ask 60: a connected machine's files).
- Added: `MountOptions.removalCrosses`. A mount that sets it is crossed by a
  recursive removal from above, as Linux's `rm -r` crosses one.
- Fixed: the shell's `rm -r /` is refused, as GNU's `--preserve-root` (the
  default; `--no-preserve-root` lifts it). `--one-file-system` is taken.
- Fixed: when the platform ended a session's activation and kept its
  facets, a durable application the next activation launched again (an
  embedder's `spawnWorker` with `durable`) could fail its first start
  with "resident process released": the earlier process's release ended
  the facet its successor had just started in. A release now ends,
  drains and deletes only a facet whose name is still its own. The bug
  needs an ended activation's code to keep running against the shared
  facets, which an embedder's harness can do and workerd's own abort does
  not.

## 2026-10-19: platform 0.13.0, core 0.24.0, fabric 0.19.0, worker 0.22.0, sdk 0.18.0, react 0.4.0, config 0.3.2, cli 0.2.9, loom 0.3.2, create-nimbus-app 0.2.5 (runtimes unchanged: runtime-bash 5.2.37-7, runtime-cpython 3.13.14-3, runtime-git 2.53.0-1)

- Fixed: the shell's patterns, trims, substitutions, `${#x}` and IFS count
  characters, as bash does in a UTF-8 locale, not UTF-16 units. `${x%?}` of
  😀 leaves nothing rather than half of it, `?` and `case 😀 in ?)` match it
  whole, `${#x}` is 1, and IFS=😀 joins and splits by 😀 without splitting
  😁. Before, these could leave a lone surrogate in a value.
- Fixed: a Vite dev server with Tailwind v4 could serve its first
  stylesheet without the classes the app's components use, about one
  start in three. Each time the dev server read a source file it had
  already been given, the copy was written again, and once its store was
  full the write was refused and the file dropped. Tailwind's scanner then
  skipped the file. A read of bytes the store already holds no longer
  rewrites them.
- Fixed: a text file of more than about 350,000 characters with an emoji or
  other character outside the Basic Multilingual Plane at a chunk boundary
  read back with two replacement characters in place of it, from a
  process's resident store.

- Fixed: the shell reads quoting as bash does wherever quoting decides what
  a word is.
  - A quoted reserved word is a command: `'if' true` runs a command named
    `if`, and `then 'fi'` does not close an `if`. An unquoted `then`, `fi`,
    `do`, `done`, `esac`, `}` or `]]` where a command begins is a syntax
    error.
  - A quoted `for` variable or function name is "not a valid identifier",
    and so is a function name with `$` in it or one that is all digits.
  - `'x=y'` and `x"="y` are commands, not assignments.
  - `x='(a b)'` and `declare x='(a b)'` assign a string; only a written
    `x=(a b)` makes an array.
  - An alias expands only on an unquoted command word, before anything else
    is expanded. Its arguments stay the words they were: `p 'a; echo b'`
    passes one argument, and a redirection after an alias applies.
  - A quoted `*`, `?`, `[`, `-` or `!` in a `case` pattern, on the right of
    `[[ == ]]`, or in `${v#…}`, `${v%…}`, `${v/…}` or `${v^…}` matches only
    itself. An unquoted `$p` there is a pattern.
  - An unquoted expansion's `*` globs (`v='*.txt'; echo $v`).
  - `${x:-'a b'}` is one word and is not globbed, and `"${x:-'a b'}"` keeps
    its single quotes, as in bash.
  - `${v/pat/rep}` and `${v//pat/rep}` replace the longest match (`${v/*/X}`
    is `X`).
  - A here-document inside `$(…)` may hold an unbalanced quote or `)`.
  Before, these read a word's text after its quotes were gone.
- Fixed: a bash step that failed inside its facet said only "facet returned
  an invalid payload"; it now says what the step failed with, as a python
  step already did. And a step or process whose request body reaches its
  facet unreadable now says that the body did not parse, and its length.
- Fixed: a launch whose program loads wasm or a native binding (rolldown's,
  in a remix dev server) no longer gathers its closure twice. Its build
  gave back the bytes its module map would need for them, then had to ask
  for them again, and when anything else was waiting it gathered the
  whole closure again. The build now keeps what its map will own.
- Fixed: a Vite preview could crash on its first load with a SyntaxError
  in a pre-bundled package (react-query, remark-parse, rehype-highlight,
  react-dom), about once in 35 cold loads. The dev server answered a
  module's first requests with clones of one response, and a clone's body
  reached the browser with a 16 KiB block out of order. Each request now
  gets a response of its own made from the module's text.
- Fixed: a launch could wait forever in "prepare" (a vite dev server sat 5
  minutes) after a session that shared its isolate was deleted while it
  waited for the isolate's transient budget. The budget had handed that
  session its share, which workerd never let it receive, so the share was
  held for good. A waiter now takes its share itself when its turn comes;
  a turn not taken within a second passes to the next waiter.
- Fixed: a dev server relaunched after a change could miss its start
  (remix's took 198 s against a 180 s bound). Its module map was dropped
  and made again three times, each time a file read of a running program
  waited for credit as the map was made, though a worker was free for the
  launch. A launch's map is now given up for running work only while the
  launch waits for a worker, and a pre-bundle's prepared files only while
  the pre-bundle waits. And a map that needs a little more than its
  closure was sized for takes the rest when it is free, instead of
  gathering its whole closure again.
- Fixed: a Vite preview could crash with "the package changed while its
  prebundle was being prepared" though nothing in the package changed.
  Every request for a barrel package (date-fns, say) wrote its synthetic
  entry file again, and a request still waiting saw that rewrite as a
  change. The entry is now named by its content and written once, so
  requests for the same imports share it and others never touch it.
- Fixed: a Vite preview could crash with "Nimbus's build facet was reset
  twice while pre-bundling …" when another session on the same isolate
  built something large. The sessions share the bundler, which is
  replaced once it grows past its mark, and every other session's waiting
  pre-bundles failed then and were tried once more. A pre-bundle that has
  not begun now begins on the new bundler.
- Fixed: a program that writes files before it listens as a server, as `react-router dev` (Vite) does from two tasks at once, is no longer ended when its run again writes them in another order. The run again starts from what the first run started from: every file and directory the first run made, changed or removed is put back first, and the run again's changes are its own. If another process changed one of those files meanwhile, or the run changed more than 4096, nothing is put back. The program is run again from its start instead, prints again what it printed, and says why in one line. A program that waited for a marker it wrote itself now serves on its run again instead of ending. Before, the run again had to make the same changes in the same order as the first run, so these programs were ended with "it changed the filesystem otherwise than the run before it".
- Fixed: a process that ends now says why on its stderr. A run again that stops after it has booted (it did not retrace its run, say) ends with status 1 and its reason. Before, its facet was released while the session showed it running, with no exit and no output. A process whose host the platform reset says so too.
- Fixed: shell function nesting is bounded. A call past the bound is refused with `f: maximum function nesting level exceeded (N)`, and the rest of its line is discarded, as bash 5.2 does with FUNCNEST set. The shell goes on with the next line, its own or a sourced file's, with `$?` 1; a subshell, command substitution, pipeline element or background job ends with 1; a trap's action ends. The bound is FUNCNEST when it is a number above 0, otherwise 1000, and never more than 1000. Before, a function that called itself ran until the session's heap was gone (bash with no FUNCNEST segfaults).
- Fixed: in the shell, an `exit` in the EXIT trap's action is the shell's status, as in bash: `trap 'exit 5' EXIT; exit 1` ends with 5. So is an end by `set -e` there. A bare `exit` there ends with the status the shell was ending with. Before, the action's `exit` ended only the action, and the status was always the one before the trap.
- Changed: a paired CPU bench names the engine it is graded on (`engine`, `node` for the guest's code, which workerd runs on V8) and the engines its bench runs on. `--engine bun|node` runs it on another of those, as context: the receipt names the engine, and only a run on the graded engine is graded. An engine its bench cannot run on is refused before anything is sent to armada.
- Changed: a paired perf probe red on one set of Previews is run again on a fresh set of four, and is red only when it is red on both. Each candidate Preview is graded against the mean of the two baseline Previews: against each one alone, a real +46% cold start was found on only half the sets. A paired CPU bench's slower kind is measured again on a second set of runs, and is slower only when both find it slower: 95% per kind finds about one slower kind in two runs of a dozen that are not.
- Fixed: a program's launch could wait minutes (a `vite build` sat 5
  minutes before it ran) while a dependency pre-bundle in another session
  of the same isolate waited for a compiler. The pre-bundle reserved 28 MiB
  of the isolate's transient budget before it read anything and kept it
  while it waited. It now reserves what its files take, once a compiler is
  ready for them, and gives it back as the compiler takes them.
- Changed: a launch that waits 10 seconds at one stage logs who holds the
  isolate's transient budget and who waits for it, and so does the
  session's launch diagnosis. Dev servers' launches log it too.
- Added: the shell's `eval`. It runs its arguments, joined by spaces, in the current shell, as bash does: assignments, `cd`, functions and aliases persist; `return`, `break` and `exit` act in the calling shell; the status is the last command's, 0 for nothing. A leading `--` ends its options and any other option is refused with status 2. In a script, a failing status from the text is recoverable (`eval false || echo recovered`), and so is a sourced file's: `. ./f.sh` whose last command failed no longer ends the script. Before, `eval` was "command not found".
- Changed: the paired perf probes measure the candidate on two Previews
  beside the baseline's two, and grade it slower only when each of its
  Previews is slower than the mean of the baseline's two. One Preview can run
  slower than another of the same code for a whole run (ruby launch had
  one of three 300-500 ms behind in 9 of 14 runs), and with one candidate
  Preview that read as a regression whenever it was the candidate's.
- Fixed: a hosted node program that replaces a built-in its module resolution calls (`String.prototype.startsWith`, `Array.prototype.push`, `JSON.parse`, `Map.prototype.get`, `%GeneratorPrototype%.next` and the like) still resolves `import`, `import()`, `import.meta.resolve`, `require.resolve` and `require` specifiers, and gets Node's errors for them, as Node's loader does on its primordials. A package.json's fields are its own: an `Object.prototype.main` or `.exports` a program adds no longer changes how a package resolves. A URL's members are read as Node reads them, so a replaced `URL.prototype.pathname` breaks resolution as it breaks Node's. Loading itself is the remaining work (design-guest-loader-primordials, heads 3 and 4).
- Fixed: in the shell, a command word read from an alias's own text is not expanded as that alias again, as in bash. `alias ls='ls -l'`, `alias q=q`, two aliases that name each other, and an alias whose text runs its own name in a list, group, subshell or a function it defines now run that name as a command. A command substitution or a function defined elsewhere still expands it, as bash does. Before, an alias that named itself expanded without end until the session ran out of memory.
- Changed: a probe run's baseline checkouts and the releases it uploads to its throwaways live in one directory beside the checkout that runs it, and go when the run ends. A run that was killed left them behind (each baseline checkout about 1 GB, and 600 releases had piled up); the next run now deletes them, and nothing of a run still going.
- Fixed: a program that writes files before it listens, as Vite's config
  load does, serves. When its listen makes it a server, Nimbus runs it again
  and checks that run against the first. That check failed for two reasons.
  A `mkdir -p` of a directory the first run had made made nothing, so the
  check saw one change fewer. Nimbus's own clock reads (the resident's boot,
  its startup and event-loop deadlines, a stat's fallback times) took
  readings meant for the program, so its `Date.now()` named a file
  otherwise. Now the found directory counts as made again, and Nimbus reads
  the clock itself. `react-router dev` gets past its relaunch.
- Fixed: Tailwind CSS v4 works again. Its scanner, `@tailwindcss/oxide`
  4.3.3, runs from Nimbus's staged threadless build, so `@tailwindcss/vite`,
  `@tailwindcss/postcss` and `@tailwindcss/cli` install and serve. A Vite
  dev server's stylesheet carries the utilities the project's files use,
  including files edited or added while it runs, and `vite build` writes
  them too. Before, the install noted that oxide had no Workers-compatible
  build, and Tailwind v4 could not load.
- Fixed: a hosted `node -e`, `node -p` or stdin program with a `return` at its top level fails as Node's does, with V8's `SyntaxError: Illegal return statement` under the `return`, plus amaro's message where Node adds one. Before, `node -e 'return 1'` ran and exited 0, and `-p` showed the error at generated code.
- Fixed: a hosted typeless ES module entry whose graph does not compile as a module shows only its SyntaxError, as Node does. Before, the MODULE_TYPELESS_PACKAGE_JSON warning came first, a warning Node's failure cuts off.
- Fixed: hosted `node -e`, `node -p` and a program read from stdin take TypeScript as Node 22 does, with type stripping on by default. Code that does not compile as JavaScript is stripped and run (as an ES module when its stripped syntax is one). Code that is neither JavaScript nor TypeScript fails with V8's error, adding amaro's message as Node does. `--input-type=commonjs-typescript` and `module-typescript` strip first. An unknown `--input-type` is refused with exit 9. An `import` or `export` nested in a block is module syntax to detection, as it is to Node, and a module's nested `import` is placed where V8 places it.
- Fixed: a hosted `require()` of a CommonJS module that does not compile throws a new SyntaxError each time, as Node, which compiles the module again, does: before, every require after the first rethrew the first error, the same object with its stack as first formatted (a stack formatter installed since never saw it).
- Fixed: a hosted CommonJS program whose SyntaxError is at the end of its source (an unclosed call, block, bracket, template or comment) is reported as Node reports it, by `node` and `node -c` alike: its line, its arrow (an argument list's last token, or nothing underlined at the end), and `Unexpected end of input` where Node says so. Before, the report showed the module wrapper's closing `}; });` a line past the source, and could say `Unexpected token '}'`.
- Fixed: `node -c` (`--check`) in a hosted session checks a CommonJS
  program's syntax and does not run it, as Node does: a script, stdin, or a
  TypeScript file's own text. It exits 0, or prints Node's SyntaxError and
  exits 1. Before, it ran the program. An ES module entry cannot be compiled
  here without running it, so `-c` of one exits 9 with "-c cannot check an
  ES module entry in Nimbus without running it". `-c` with `-e` or `-p`
  is Node's refusal (exit 9).
- Fixed: `node --experimental-default-type` in a hosted session exits 9 as
  unsupported, as the portable node does. Before, it was ignored: `-e`
  code under `=module` ran as CommonJS. A value other than `module` or
  `commonjs` is Node's own refusal.
- Fixed: a workspace resize handle could stop following the pointer
  mid-drag when the page lost the pointer's capture. The drag now follows
  the pointer until it is released, and a release the page cannot hear
  (over the preview's frame, or outside the window) ends it at the next
  move or when the window loses focus.
- Fixed: `WeightedCreditPool.acquire` (and the supervisor allocation
  budget over it) refuses a request whose signal is already aborted, with
  an AbortError and no credit taken, whatever its size. Before, a request
  at or below `smallRequestBytes` was granted from free shared capacity
  before its signal was looked at.
- Fixed: `fs.copy(src, dst, { preserve: true })` (and `copyFile` with `preserve`) sets what `cp -p` sets, by every path a copy takes, as far as the destination's filesystem supports each. A single file copied on SQLite keeps the source's mode (no umask), its times, and its owner when root copies, onto a new name and onto a file there; before, `preserve` was dropped and the copy had the time of the copy and the mode less the umask. A copy between backends (a mounted filesystem's, recursive or not) sets each entry's owner (root), mode and times once its content is in, a directory's after its entries, and fills a read-only directory; before, it set no time, left a SQLite destination's umask, and could not write into a read-only directory it had made. A link's own metadata is not set, and nothing is set through it. With `keepMode` too, `preserve`'s mode wins. A resident process's preserving copy is the session's, as is one through the supervisor's call, which dropped `preserve`.
- Changed: a program whose launch waits 10 seconds at one stage (its
  preparation, its admission for a worker, or its load) logs one line to
  Workers Logs: `[facet-manager] launch stalled:` with its pid, command,
  stage, the wait, and the state of the worker ledger, the launch pacer
  and the isolate's transient budget. A command that hangs before it runs
  leaves this as its evidence. The line is logged once per launch.
- Fixed: when sessions compete for an isolate's transient budget, a
  program's launch no longer reads past the share it holds while it
  stages its files. A read that would take it over is refused before it
  happens, and the launch asks for the whole budget once, as it already
  did when its files outgrew its share.
- Fixed: when the workspace's connection to its session drops and comes
  back, a file listing or a file read that was waiting for its answer is
  sent again and completes. The file tree showed "fs-list failed:
  Session connection closed" until it was refreshed by hand. A save that
  was waiting still fails, since it may have been written.
- Changed (config): `NIMBUS_REQUIRED_ALIASES`, and so the alias map
  `buildNimbusWranglerConfig` writes, is `{ diff: 'diff' }`. The other 11
  entries (clean-git-ref, is-git-ref-name-valid, crc-32, sha.js, pako,
  pify, diff3, ignore, readable-stream, simple-get, minimisted) were for
  Git's dependencies, which are bundled into its vendor module, so they
  are no longer needed. `extraAliases` still merges over the map. A
  hand-written config may drop those entries.
- Changed (worker): `@nimbus-sh/worker` no longer declares
  `@renovatebot/pep440` or `pip-requirements-js`. `@nimbus-sh/core`,
  which is the one that imports them, still does.
- Fixed (computesdk-nimbus): `nimbus({ timeout })` is now the default
  timeout of every command, as documented; a `runCommand` without its own
  `timeout` used to run with no deadline. `getInfo` reports that timeout,
  or 0 when none is configured, in place of a fixed 300000.
- Fixed: with two versions of a gem installed, `require` now picks the
  version host Ruby does. A bare `require "a"` loads the highest version.
  A gem whose dependency requires `a < 2` gets a 1.x. Requiring both
  where they conflict raises `Gem::ConflictError`. Before, the older
  version could be loaded, and conflicts loaded anyway. Only gems whose
  version RubyGems must choose are activated: two versions installed, or
  a dependency, at any depth, that has two. Every other require loads from
  the load path as before, at no added cost. A gem's executable runs the
  version RubyGems activates, as host Ruby's binstub does, including the
  wrappers an earlier Nimbus wrote into a persisted home.

## 2026-10-17: platform 0.12.0, core 0.23.0, fabric 0.18.0, worker 0.21.0, sdk 0.17.0, cli 0.2.8, loom 0.3.1, react 0.3.3, create-nimbus-app 0.2.4, runtime-bash 5.2.37-7, runtime-cpython 3.13.14-3, runtime-git 2.53.0-1 (config 0.3.1 unchanged)

The 2026-10-14 and 2026-10-15 versions reached production but were never published to npm; these carry their changes too. The runtimes need core 0.23.0: it is the first core that registers bash-runner@6, cpython-runner@3 and git-runner@2.

- Fixed: a WASI process that makes a directory and then a file in it,
  as `pip install` does for each package, no longer fails ENOENT about
  once in a hundred runs. That happened when the process's hold on the
  subtree was renewed or given back while the new file's name was being
  looked up: the lookup carried on over a listing from before the
  directory reached the session. Each step of a lookup now catches up
  with the session first when the process has sent it anything.
- Fixed: a process that wrote a file through a descriptor in a subtree it
  held itself (a WASI process's delegation) could lose those bytes when
  the file stayed open more than 100 ms after the write. The held write
  was stored later as if another process had made it, the store refused
  it, and the close failed with EBADF. It is now stored as the writer's.
  A close whose held writes the store refuses now reports that refusal,
  for example ENOSPC, and names the file, instead of EBADF.
- Fixed: a running program no longer stalls waiting on launches that are not
  running. A Durable Object runs at most ten Dynamic Workers. When every one
  ran a program whose next write needed supervisor credit, and parked
  launches or loads waiting for a worker held that credit, neither side could
  go on. Credit is now taken before a worker, never while holding one, and a
  running program's writes and session calls come first. When only parked
  launches' module maps, or credit a load took and has not used, stand in
  the way, that credit is reclaimed: the launch prepares again at its turn,
  and the load takes its credit once it has a worker. A load refused its
  credit fails at once with EAGAIN.
- Fixed: launch-credit contention no longer changes which learned reads or
  lazy imports are staged. A tight first try now retries with full credit
  instead of trimming the program's snapshot.
- Fixed: a command waiting for its session's busy workers no longer stalls
  commands in other sessions sharing its isolate. One-shot commands prepare
  their module maps before waiting and keep only their retained share of the
  isolate budget; new builds use the remaining room within a checked bound.
  Running programs can reclaim parked maps for their writes and reads; the
  waiting commands prepare their maps again before taking a worker.
- Changed: a process that can be stopped and replayed records its input
  and output replies at almost no CPU cost. Each reply was hashed byte by
  byte and the hash kept, though nothing read it: about 0.9 ms of CPU for
  each 64 KiB of piped input. The replay keeps only their count, which is
  all its limit needs.
- Fixed: Bun's file-URL helpers preserve spaces, `#`, `%` and other escaped
  filename characters, and resolve relative paths from the process's current
  directory, including after `process.chdir`, as its `node:url` helpers do.
- Fixed: bash and its commands receive a broken-pipe write error when
  `trap '' PIPE` ignores SIGPIPE, including commands that inherit it across
  exec. Before, a write after the pipe's reader closed killed the writer
  with SIGPIPE even when the signal was ignored.
- Fixed: a running process now notices an embedder filesystem mounted after
  its first filesystem listing. Before, a process that started with SQLite
  alone could keep a staged namespace that omitted the new mount.
- Fixed: dragging the handle between the editor and the preview keeps the
  handle under the pointer. It fell behind by a fifth of the drag, and a
  fast drag to the right could end on the preview's frame and stop short.
  The workspace's resize handles now keep the pointer while they are held.
- Fixed: a write batch keeps the writes it committed before a refused
  operation (an unlink answering ENOENT, say), including writes through an
  open file another process has unlinked. Before, retrying those writes
  after the refusal could fail with EIO and lose them, along with
  everything else the batch committed before the refusal. Writes through
  an open description the session kept across a restart are kept too
  (they were refused EBADF), and a shared directory stays shared after a
  refused rename of it.
- Added (platform): `@nimbus-sh/platform/hex.js`, `bytesToHex(bytes)`
  (unseparated lowercase hex, through the runtime's native
  `Uint8Array.prototype.toHex` where it has one) and `HEX_BYTE` (each byte
  value's two digits). Nimbus's content keys, digests, git object ids and
  tokens spell through it; the strings are unchanged.
- Fixed: two mounts made through different views of one namespace (the
  root and a principal's `as` view, say) are two devices. Before, each view
  numbered its mounts' `st_dev` from the same start, so files on the two
  could share a (dev, ino), and a move of one over the other was refused
  as "the same file".
- Fixed: a snapshot view (`SqliteVFS.at(name)`) reads as the live tree
  does. Its `readdir` of a link to a directory lists that directory (it
  listed nothing), its `list` pages are bounded by their encoded bytes (a
  page could exceed the RPC frame), and once the snapshot is dropped its
  `acquire`, `invalidatedSince`, `revision` and `storageKey` throw ESTALE,
  as its other calls do (they answered as if it were still pinned).
- Fixed: `ProcessFiles.killProcess(pid)` closes the last description of
  each file the killed process held open, as a process's exit does on
  Linux, so an unlinked file it held is collected once no one else holds
  it. Before, only a mount's files were closed, and an unlinked file's
  content stayed pinned for the session's life.
- Added (platform): `compareUtf8(a, b)` in `@nimbus-sh/platform/utf8.js`,
  the order of two strings by their UTF-8 bytes (code point order) without
  encoding them. A string with a lone surrogate, which UTF-8 cannot write,
  orders by its WTF-8 bytes, so the order is total and a directory's
  entries sort together after it. The engine's keyset cursors, a mounted
  namespace's listings and git's index order through it. Before, the three
  disagreed about lone surrogates, and the engine took two different ones
  as the same name.
- Fixed: `SqliteVFS.restore` and `dropSnapshot` (and their async forms)
  write in transactions the storage envelope admits. Before, one page of
  200 paths was one transaction of up to 600 rows (restore) or 401 (drop),
  past the 256 a transaction may hold.
- Fixed: a resident process fills a file it listed from a synchronously mounted backend (`/mnt/data`, an SDK embedder's mount). Before, the read named the engine's epoch, which a mounted path never matches, and was refused (ESTALE). A read of a mounted file now names the file as its listing's stat did (`RuntimeReadOptions.expectedFile`: device, inode, size, mtime, ctime) and is refused only if it is no longer that file. A mounted read that names the engine's epoch is refused by the asynchronous path too, as by the synchronous one. A filled mounted file is still undated in the store: it vouches for nothing on a relaunch.
- Fixed: a hosted ES module that statically imports a file the program writes after it starts (a module staged with the launch, its import of `./generated.mjs` written at runtime) finds the file when it is imported, as Node does. Before, the import failed with "Cannot find module", because the file was missing when the launch began. One still missing fails with Node's `ERR_MODULE_NOT_FOUND`, and, as in Node, so do later imports of the modules that failed to link, even once the file is written; a `require()` tries again. A query's or a fragment's import of such a file (`./generated.json?x`) loads as the file's format.
- Changed: the hosted node's `node:path` posix half is now Node v22.22.3's own `lib/path.js`, ported onto built-ins the launch captures before any program code runs. A program that replaces `String.prototype.charCodeAt`, `slice` and the like gets from `path` what Node's `path` gives, where workerd's `path` used to fail. Its key order, function names and argument errors are Node's, including `path.join` failing, as Node's does, when `Array.prototype.push` is replaced. `win32` and `matchesGlob` remain the platform's.
- Changed (docs): the docs' sandbox terminal keeps the session it booted
  per attach endpoint, so two endpoints on one origin no longer share it. A
  browser that cached a session the old way keeps it: the first visit moves
  it to the new key and removes the old ones.
- Fixed (shell): when the Explorer's first listing fails (a lost connection,
  a refused listing), selecting the Editor again lists the files. Before,
  the tree counted itself loaded and kept the error until Refresh. A
  folder's icon now opens and closes with the folder; it kept the state the
  folder had when first shown. A Markdown preview renders once per open and
  reload, not twice.
- Breaking (react): `useNimbusSession` no longer takes `tenant` or `sub`.
  The hook never read them; identity belongs to the token.
  `<NimbusTerminal />` keeps both props, to show on its iframe. Drop them
  from a hook call.
- Fixed (react): the headless `useNimbusSession` guide (README and the
  hook's own example) works as written. It mounts the iframe at once and
  shows its loading state over it until the shell reports ready. Before,
  it waited for ready before mounting the iframe, and only that iframe
  could report ready, so it showed "Loading…" forever.
- Fixed (agent chat): a running tool's timer counts from when the tool
  started. Before, a chat opened while a tool ran showed it starting from
  zero, and a tool whose start was unknown showed a timer it could not
  know.
- Fixed (shell): the built-in shell reads `$'...'` (ANSI-C quoting) as bash
  does. `echo $'\303\251'` prints "é", `$'\cA'` is the control character,
  `$'\u00e9'` a character, `$'it\'s'` keeps its apostrophe, and a NUL ends
  the quoted part. Nothing inside expands, and inside double quotes it stays
  literal. Before, the `$` stayed and the body was read as a plain
  single-quoted string, so `\'` ended it early. A `"` inside a substitution
  nested in double quotes within `$(...)` no longer ends the outer
  substitution.
- Fixed (shell): in the built-in shell, an octal or hex escape in `printf`
  (its format and `%b`) and `echo -e` writes one byte, as bash does.
  `printf '\303\251'` writes "é" and `printf '\377'` writes the byte 0xff.
  Before, each escape became a character written as UTF-8, so
  `printf '\357\273\277'` gave six bytes instead of a byte order mark.
  `printf %c` writes its argument's first byte.
- Fixed: one session's compiles no longer reset the other sessions that
  share its isolate. The platform runs several sessions in one isolate
  with one memory limit, and resets all of them when it is crossed. Each
  `clang` compile read its 31 MiB compiler into that isolate, copied it,
  and held it through the link, so three compiles at once, in one session
  or across co-tenants, reset every session there. A runtime's wasm image
  (clang, wasm-ld, CPython, Ruby, bash, git, a `wasm-runner` program) is
  now read by path when its facet loads, without a copy, and each load is
  admitted on the isolate's transient budget: loads that would overlap
  take turns, and one larger than the budget runs alone. Staged opencode
  decodes its chunk pack one chunk at a time and assembles under the same
  admission. A load not admitted within 60 s fails with EAGAIN, naming
  what it waited for.
- Changed (core): `FacetSpec.wasmModules` and a call's `wasmModules` take
  `FacetImage`s instead of ArrayBuffers. Open one with
  `ProcessView.image(path)` or `hostImage(authority, cred, path)`. An
  image is named by the store's content key for its bytes
  (`RuntimeFsBridge.contentKey`), which equal bytes share in every
  session, and nothing is hashed to name it. The host reads the image
  when it builds the facet, and refuses it (ESTALE) unless the file still
  holds those bytes, checked in the read's own turn. An image on a mount,
  which keeps no content keys, is refused (ENOTSUP).
  `ws.fs.readArrayBufferUncached` is removed; `readFileUncached` returns
  the read's own bytes without copying them.
- Added: `/api/_diag/memory` names the isolate the session runs in
  (`isolate.id`). Sessions that report one id share its memory limit.
- Fixed: `NIMBUS_DEBUG` means the same in a hosted runtime as in a session.
  A hosted runtime accepted only `'1'`, while its facet manager also took
  `'true'`, so `'true'` turned on the manager's traces but left the
  runtime's debug exit notices off. `'1'` and `'true'` now enable both;
  any other value disables both.
- Fixed: a Node program that hands `new WebAssembly.Module`,
  `WebAssembly.compile` or `WebAssembly.instantiate` a DataView or any
  typed array over a staged image's bytes, shared memory included, gets
  the staged module, as it already did for a Uint8Array or an ArrayBuffer.
  Before, those views were refused as bytes the launch did not carry. A
  view that spans other bytes is still another image, and a detached one
  is refused by the real compile.
- Changed (core, worker): the validated record types are derived from
  their schemas, under the names they had: `ManifestFile`,
  `ManifestEntrypoint`, `RuntimeArtifactMetadata`,
  `RuntimePythonExtensionModuleMetadata`,
  `RuntimePythonPackageArtifactMetadata` and `RuntimeManifest` (core
  `runtime/runtime-manifest.js`); `CatalogVersionEntry`,
  `CatalogRuntimeEntry` and `RuntimeCatalog` (worker `./runtime/catalog`);
  and `NimbusAgentOAuthCookie` (worker `./oauth`). They are type aliases
  now, not interfaces, so declaration merging no longer extends them. A
  `RuntimeManifest`'s `runtime_artifacts` elements are typed as parsed:
  they keep unknown keys (`[key: string]: unknown`), so a value typed by an
  interface of your own no longer assigns to them. Each was checked both
  ways against the interface it replaces, and that was the only
  difference. `envString` (an env var, trimmed, or `''`) moves to core's
  OAuth module and `@nimbus-sh/sdk/oauth`.
- Fixed: output that begins with U+FEFF (the UTF-8 BOM) keeps it, as a
  Linux terminal receives every byte a program writes. This covers a
  program's output in the terminal, process logs and `exec` results, a
  program's stdin read as text (`process.stdin.setEncoding`, `readline`),
  `curl`'s body, and the text-only output of `cut`, `find` and git. `grep`
  matches a line's bytes, BOM included, as GNU grep does. Before, each
  decoded with a TextDecoder that drops a leading BOM, per process or per
  chunk; `setEncoding` and `readline` also split a character whose bytes
  arrived in two chunks.
- Fixed: `child_process.spawn(' node')` (a command with spaces or a BOM
  around its name) finds no program (ENOENT), as in Node. Before, the name
  was trimmed and `node` ran.
- Breaking (worker): `vendor/git.generated.mjs` no longer exports
  `gitHttp`, cf-git's own HTTP client (isomorphic-git/http/web), nor
  declares it (`vendor/git-http.generated.d.ts` is gone). Nimbus's git
  speaks smart HTTP through its own clients (`git/pack/upload-pack.ts`,
  `receive-pack.ts`), and nothing used it. The vendor module was never a
  package export.
- Changed: the built-in `git push` over HTTP speaks receive-pack through
  Nimbus's own client (`git/pack/receive-pack.ts`), the one `git fetch`,
  `git clone` and the git remote helpers already use. It streams its pack
  as git does past `http.postBuffer`; before, cf-git collected the whole
  request and sent it with a Content-Length. Push no longer reads the
  isomorphic-git-only `http.corsProxy` setting, which fetch already
  ignored and git never had.
- Fixed: a name that begins with U+FEFF (the UTF-8 BOM, bytes EF BB BF)
  keeps it, as git, tar and Linux keep it. This covers file and directory
  names in git's index, trees and checkouts, symlink targets, ZIP member
  names, paths in the wasm bash and its programs, and the text `$( )`
  captures. Before, each was decoded with a TextDecoder that drops a
  leading BOM: a clone of a repository with a directory named by a BOM alone
  failed with "invalid path", a file `\uFEFFf` was created as `f`, and
  `readlink` lost the BOM from its link's target. A `.git/commondir` loses
  only its line's end, as git reads it.
- Fixed: a hosted ES module, staged or interpreted, can statically import
  a `data:` module (`import x from 'data:text/javascript,…'`). Its imported
  names are checked before any module body runs. It runs once, in a cycle
  or after it throws, and its `export *` conflicts are left out of its
  namespace, as in Node. Before, a staged entry or package with such an
  import failed to link, and an interpreted one refused it.
- Fixed: a hosted program's ES modules that the interpreter evaluates
  (files written after launch, `?query` and `#fragment` instances, `data:`
  modules, staged modules it takes over) are linked and evaluated as
  ECMA-262 specifies (`runtime/esm-graph.js`). A static import of a module
  with top-level await now waits for it, as in Node; before, the importer
  ran first. In a cycle, modules run in Node's order, whatever their kind;
  before, the order depended on which module of the cycle was interpreted
  or staged.
- Fixed: a hosted `data:` JavaScript module is always an ES module, as its
  MIME type says: strict, with `this` undefined at its top level. Before,
  one without `import` or `export` ran as sloppy CommonJS.
- Fixed: a hosted ES module may export its own `__esModule`. Before, a
  module the program wrote with `export const __esModule = false` threw a
  TypeError, and namespaces left the name out. Now the name is in its
  namespace, as in Node.
- Fixed: a hosted typeless `.js` file the program writes, whose top level
  redeclares a CommonJS wrapper name (`const require = 1`), is an ES
  module, as Node detects it. Before, it ran as sloppy CommonJS. An
  explicitly CommonJS file that does this is now the SyntaxError V8 gives.
- Fixed: a hosted module under a directory whose name has `#`, `?`, `%` or
  another character a file URL escapes imports beside itself, and its
  `import.meta.url` escapes the name as Node's `pathToFileURL` does. Before,
  `a#b/main.cjs` imported from the directory above it.
- Fixed: `npm run`, `npm test` and `npm start` run a script as npm does.
  The words after the script name (after `--`) are passed to it, each
  quoted for the shell. `pre<script>` runs before the script and
  `post<script>` after it, unless `--ignore-scripts` is given. The first
  script that fails stops the rest. A script runs with npm's lifecycle
  environment (`npm_lifecycle_event`, `npm_lifecycle_script`,
  `npm_package_name`, `npm_package_version`, `npm_package_json`), and
  `node_modules/.bin` of the project and each directory above it come
  first on its `PATH`. Before, `npm run x -- a b` dropped `a b`, and pre
  and post scripts did not run. Without a host shell, core npm split a
  simple script on spaces, so `mkdir "a b"` made `"a` and `b"`.
- Fixed: a project's bins are commands of its own scripts only. Before,
  core npm's `npm run` registered every bin in the project's node_modules
  as a command of the whole workspace, so a script in another project ran
  the first project's tool. Core npm's local install now links bins into
  `node_modules/.bin`, as npm does. Every bin shim names its target as a
  JSON string, so a path with a quote in it still works.
- Fixed: `lifo install`, `lifo remove` and `lifo list` find lifo packages
  where npm installs them globally: `<prefix>/lib/node_modules`, with the
  prefix from npm's configuration (`--prefix`, `npm_config_prefix`, an
  `.npmrc`, else `PREFIX` or `/usr/local`). Before, lifo read
  `/usr/lib/node_modules`, where npm installs nothing. `npm install -g`
  takes its prefix from the same configuration, `PREFIX` included. A
  workspace's default environment no longer sets `npm_config_prefix`, so a
  `prefix` in `~/.npmrc` takes effect. Without one, the prefix is still
  `/usr/local`, npm's default.
- Breaking (core): a workspace no longer restores global packages as
  commands when it boots. `npm install -g` links a package's bins into
  `<prefix>/bin`, which is on the default `PATH`, and the shell finds them
  there, as it does with npm. A prefix set in `.npmrc` behaves as with npm:
  its `bin` must be on `PATH`. `rehydrateGlobalPackages` is replaced by
  `rehydrateLifoPackages(view, registry, { cwd, env })`. It restores only
  lifo commands, under npm's configured prefix, and only a host that
  registers `createLifoPkgCommand` needs to call it at boot. No Nimbus host
  or app registers lifo, and Kinu does not. `registerBinCommand` is gone:
  global bins are no longer registered as commands.
- Breaking (core): `createNpmCommand` runs every script through the host's
  `ShellExecuteFn`. Before, `createNpmCommand(registry, undefined, kernel)`
  ran a script with no shell operator by calling its first word from the
  registry. Now `npm run` without a shell executor fails for every script
  with "shell integration unavailable". A host that registers npm without
  one should pass its shell, for example
  `(command, ctx) => workspace.exec(command, { cwd: ctx.cwd, env: ctx.env })`,
  writing the result's output to `ctx.stdout` and `ctx.stderr` and
  answering its exit code. `ShellExecuteFn` takes an optional third
  argument, the script being run (`NpmScript`). It may answer `'resident'`
  for a script the host keeps running after the call returns, such as a
  dev server: npm run then stops, and says that the script's `post` script
  did not run. The new `NpmCommandDeps.beforeRun` hook receives every
  script npm run will run (pre, own and post) and can stop the run. The
  hosted terminal's `node_modules` check and Next.js refusal use it, so
  they also check pre and post scripts. `npmInstallGlobal` no longer takes
  a command registry, and `createNpmCommand` no longer reads its own.
- Changed: the perf probe `perf-regression/clone-fast` is graded like
  `cold-start`: against the baseline measured in the same run, one clone on
  each of the three throwaways per round, 40 rounds. Its fixed 5600 ms
  bound failed 5 of 591 full runs of unchanged main code, and passed a
  clone 600 ms slower than main's.
- Changed: the perf probes `perf-regression/cold-start`, `first-paint` and
  `install-warm` grade the candidate against a baseline measured in the
  same run, not against a fixed bound. `remote-probes` stands up three
  fresh throwaways for them: two of the baseline (`--baseline`, by default
  the commit's merge-base with origin/main; the release matrix uses the
  commit production serves) and one of the candidate. Each round measures
  all three at once. A probe is red when the candidate's median paired
  log-ratio is above 0 with 95% confidence and above the two baseline
  arms' own spread. The fixed bounds failed 25, 4 and 21 of about 560 full
  runs of unchanged main code, and passed a 1.5x slower cold start when its
  one sample landed under 800 ms.
- Changed: `remote-probes` attributes every red row whose session socket
  closed 1006 (the run's session ledger records each such close) or that
  shows `E_NIMBUS_DO_OVERLOADED`, from the platform's own record (Workers
  Logs and trace exceptions, read on the workstation), by the exact error on
  each session's object. A row is rerun once, and the rerun grades it, only
  when the probe reached its summary, every check it failed is the driver's
  1006 close error naming a session whose socket dropped, each such session
  shows "Internal error in Durable Object storage caused object to be
  reset", and every session's record, read whole, shows no other class. The
  verdict keeps both rows. Isolate memory resets, overloads and the rest
  stay red, with their attribution printed. A target or paired throwaway
  redeployed during a job makes the run not graded, and the release matrix
  counts a probe that exits 2 as not graded, as `remote-probes` does.
- Fixed: `pip install` decides which dependencies apply by the markers of
  the CPython it installs for: CPython 3.13.14 on `wasm32-wasi`, as the
  interpreter itself answers them (`sys_platform` is `"wasi"`). Before, pip
  used a table left from the Pyodide runtime, CPython 3.13.2 on
  Emscripten: a dependency guarded by `python_full_version >= "3.13.3"` was
  dropped, and one guarded by `sys_platform == "emscripten"` installed.
  `python --version`, `pip --version` and the Python prompt's banner read
  the version from the installed runtime too.
- Fixed: `pip install` installs an extra's dependencies when the extra is
  asked for after its package was resolved without it. Before, `b`
  requiring `a[x]` after `a` was resolved left out what `a[x]` adds.
- Breaking (core): `@nimbus-sh/core/runtime/python-pip.js`'s
  `PythonPipRuntimeContext` takes `markers`, the interpreter's PEP 508
  environment (`cpythonMarkers(manifest)` from
  `@nimbus-sh/core/runtime/cpython-runner.js` for the installed CPython),
  and no longer takes `pyodideLockfileText` or `runtimeArtifacts`.
  `PipInvocation.pyodidePackages` is gone, with pip's Pyodide installer,
  which no runtime reached since the CPython runtime replaced Pyodide.
  Runtime manifests keep their Python package metadata.
- Fixed: `gem install` and `bundle install` hold an exact version
  requirement to the request's other requirements and to the pure-Ruby
  platform, as they hold any other. `gem "p", "= 1.0.0", "< 1.0.0"` now
  fails with "no ruby platform version of p satisfies = 1.0.0, < 1.0.0",
  and an exact version built only for another platform is refused. Before,
  the first `=` requirement installed that version whatever else the
  request said.
- Breaking (core): `scanCjsExports` (`runtime/cjs-export-names.js`) is the
  Vite dev server's CommonJS interop scan alone, and takes no policy:
  `scanCjsExports(source)`. The `'node'` policy, a second hand-written
  grammar of what Node detects, is gone, and so is `CjsExportPolicy`. Node's
  own detection is the vendored cjs-module-lexer (`runtime/cjs-module-lexer.js`
  `createCjsLexer`), which both module loaders already use. The Vite scan's
  results are unchanged: identical for all 10,084 CommonJS files of the
  repository's dependencies.
- Added (core): `bindRuntimeCommands` and `runtimeSummary`
  (`runtime/installed-runtimes.js`), the one way an installed runtime's
  commands are registered and summarized. Install, rehydration,
  `RuntimeManager.list` and `listInstalledRuntimes` now all use them, and
  their results are unchanged.
- Fixed: a very long line at the hosted Python prompt (`python3`) reaches
  the interpreter. Before, a line of more than about 125,000 bytes of
  UTF-8 failed with "[python-repl] dispatch failed: Maximum call stack size
  exceeded" before Python saw it. The prompt, TypeScript source maps, the esbuild-compatible
  build's base64 and data-URL loaders, CSS data URLs, and stop/replay tapes
  now share one base64 codec (`_shared/crypto.js`).
- Fixed: a hosted or portable `node` program's package resolution errors
  are Node's own errors, from `require()` and `import()` alike:
  `ERR_PACKAGE_PATH_NOT_EXPORTED`, `ERR_PACKAGE_IMPORT_NOT_DEFINED`,
  `ERR_INVALID_PACKAGE_TARGET`, `ERR_INVALID_PACKAGE_CONFIG` and
  `ERR_INVALID_MODULE_SPECIFIER`. `String(error)` and its stack read
  `Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: …`; before, they read `Error: …`,
  with the code only on `error.code`. The two Node 22 throws from C++ (a
  package.json that is not JSON, `ERR_INVALID_PACKAGE_CONFIG`, and a
  package main that names no file, `ERR_MODULE_NOT_FOUND`) are plain
  `Error`s with their code, as in Node; `import()` used to give them the
  `[CODE]` head. A module `require()` does not find is still a plain
  `Error` with `code` `MODULE_NOT_FOUND`, as in Node.
- Breaking (fabric, worker, sdk): the legacy inner Durable Object transport
  is gone. `NimbusDOStub` is no longer exported from
  `@nimbus-sh/fabric/bindings.js`, `@nimbus-sh/worker` or
  `@nimbus-sh/sdk/entrypoints`, and `InnerDoFetchAnswer` from
  `@nimbus-sh/fabric/bindings.js`. `NimbusDurableObjectNamespace` keeps
  `callOn` and `getOn` and loses `get`, `idFromName`, `newUniqueId` and
  `idFromString`. The supervisor op `innerDoFetch` and
  `NimbusSession._rpcInnerDoFetch` are gone. A `wrangler dev` Worker's
  Durable Objects are unchanged: they already went through `callOn` and
  `getOn`, fetch included. An embedder whose Worker entry re-exports with
  `export * from '@nimbus-sh/sdk/entrypoints'` needs no change; one that
  names `NimbusDOStub` in its imports or exports must drop the name.
- Fixed: `/api/_diag/memory`'s `heap.breakdown.preBundleSliceBytes` is
  what the pre-bundles running now hold, and the "supervisor heap" an
  install's pre-bundle phase prints counts it. Before, it was inferred
  from lifetime totals: a running pre-bundle's slice showed as
  unattributed, and one whose package was reinstalled while it built left
  28 MiB in the estimate until the session restarted.
- Fixed (fabric): an `IsolatePool` wasm module whose name holds a quote or
  a backslash, such as `it's.wasm`, loads. Before, the pool's generated
  worker imported it from an unescaped string, and the dispatch failed to
  parse. Two module names that make the same identifier are still
  refused; the refusal now names both.
- Fixed: a session's destroy (`DELETE /s/<id>/`, `box.destroy()`) is
  repeated once on a fresh connection when the platform fails it with a
  reset of the session's storage ("Internal error in Durable Object
  storage caused object to be reset") or its undescribed "internal error".
  Before, either answered the destroy with a 500 and left the session in
  place. The destroy is idempotent, so the repeat answers with its result;
  any other failure is answered as before.
- Fixed: a portable workspace's `node` reads its command line as the
  hosted `node` does (Node's own parser, NODE_OPTIONS first), and finds its
  script the same way. `node .` runs the package's `main`, and `node start`
  finds `start.js`. Options before the script, such as `--trace-warnings`,
  are options. `--conditions`, `-C` and `NODE_OPTIONS='--conditions=…'`
  apply to both `require` and `import`. Before, only a first-position `-v`,
  `--help` or `-e` was read, `node .` read the directory, and conditions
  were ignored. What it does not run (`--require`, `--import`, `--print`,
  `--check`, `--input-type`, `--experimental-default-type`, a program from
  stdin) is refused with exit 9 before anything runs. A script it cannot
  find is "node: cannot find module '<script>'", as on the hosted `node`.
- Fixed: a hosted launch's dependency walk and ES module staging decide
  what is a Node builtin the way Node's `module.isBuiltin` does
  (`runtime/node-builtins.js` `isNodeBuiltin`). The process's `require`
  shares its scheme-only names and serves the builtins it implements. A
  `node_modules/constants` shadow is no longer walked: `require('constants')`
  is the builtin, as in Node. Before, a large shadow could fail the launch over a file Node never
  reads. An npm package named `sqlite`, required bare, is now shipped with
  the launch, since bare `sqlite` is no builtin.
- Fixed: a portable `node` program's `import()` refuses a second argument
  that is not an object (`1`, `null`), or a `with` that is not an object,
  with V8's TypeError before anything resolves. Before, these counted as no
  options, and the module loaded and ran. An attribute value that is not a
  string is now V8's TypeError, read after every other value, instead of
  `ERR_INVALID_ARG_TYPE`. A hosted program's `import()` of a Symbol is now
  refused as Node refuses it; before, it looked for a package named
  `Symbol(s)`.
- Fixed: a portable `node` program reads a `data:` URL module as Node 22
  does. Base64 JSON and JavaScript are read as UTF-8, so `"✓"` arrives
  intact instead of as `"â\u009c\u0093"`. `application/javascript` is a
  module. An unknown type such as `text/javascriptx` fails with
  `ERR_UNKNOWN_MODULE_FORMAT` instead of loading. A hosted program's
  unknown type is now Node's RangeError, "Unknown module format: <type>
  for URL <url>", where it was a TypeError.
- Fixed: a portable `node` program's `node:module` is Node's `Module`
  class. `new Module(id)` works, `Module.Module === Module`, and the
  default import is the same class. Before, it was a plain object and
  `new Module()` threw.
- Fixed: a portable `node` program can `import { version, transform } from
  'esbuild'` with the names `require('esbuild')` has. Before, it failed to
  link. `node:esbuild` and `node:rimraf` are not modules, as in Node.
- Added: `npm install` and `npm ci` read packuments in npm's cache modes.
  `--prefer-online` checks a cached packument with the registry however
  fresh it is (a `304` keeps it). `--prefer-offline` uses any cached copy,
  however old, and fetches only what is not cached. `--offline` uses any
  cached copy and fails a package with none with npm's `ENOTCACHED` error,
  without the network. Each is read from the command line, `npm_config_*`
  or an `.npmrc`, as npm reads it, along with the deprecated
  `--cache-max=0` and `--cache-min=9999`. Tarballs are read in the same
  mode: `--prefer-online` downloads each, `--prefer-offline` takes the
  cache's copy and downloads only one it lacks, and `--offline` downloads
  none, failing one the cache lacks with `ENOTCACHED`.
  Otherwise a cached packument is reused for 60 minutes, as before, and
  one past that is checked against the shared cache's copy before the
  registry.
- Fixed: a session's own server sends its reason phrase as Node's server
  does. That is the phrase Node's `http.STATUS_CODES` gives the status
  ("unknown" for a status it does not name), or the phrase the handler set
  with `writeHead(status, reason)` or `res.statusMessage`. `curl -I` prints
  it, `fetch` gets it as `statusText`, and `http.get` from another program
  gets it as `statusMessage`. Before, the shell knew 18 phrases and ignored
  the handler's, so `curl -I` printed `HTTP/1.1 205` and `HTTP/1.1 200 OK`
  for a 200 "Fine By Me". Another program's `http.get` got no phrase at all.
- Fixed: `server.listen(port, callback)` in a portable `node` program
  calls `callback` with the server as `this`, as Node does. Before, `this`
  was undefined, so `this.address()` threw.
- Fixed: a session's own server can answer 205 (Reset Content). `curl`
  gets it, and so does `http.get` from another portable `node` program.
  Before, the response was rebuilt with the empty body its server ended,
  which a Response refuses for 205: `curl` reported "Failed to connect"
  and `http.get` failed with `ECONNREFUSED`. 204 and 304 were already
  right.
- Changed: `curl -L` and `wget` walk redirects with the same code as a
  portable `node` program's `fetch` under an egress
  (`runtime/http-redirect-policy.js` `followRedirects`). Each keeps its own
  policy: which statuses it follows, and what a Location it cannot use
  means. Two edge cases change:
  - A Location is checked before the 20-redirect cap, as Node's fetch
    checks it. A `fetch` whose 21st response redirects to a URL that is not
    HTTP(S) fails "URL scheme must be a HTTP(S) scheme", as in Node, rather
    than "redirect count exceeded". With `curl -L` or `wget`, a 21st
    redirect whose Location does not parse is the answer rather than "too
    many redirects".
  - The body of a redirect that is followed, or that redirect mode
    `'error'` refuses, is cancelled without waiting for the cancel, as
    undici does. A cancel that fails no longer fails the `fetch`.
- Breaking (core): `MAX_REDIRECTS` moved from
  `substrate/lifo/commands/net/kernel-fetch.js` to
  `runtime/http-redirect-policy.js`. `HopRequest` is gone; use
  `RedirectHop<string>`. A walk's `response` result now also says whether
  it was `redirected`.
- Fixed (SDK): `box.ports.ensureDurableApp({ owner, name })` through
  `Nimbus.connect` now passes the app's `name` to the session, as
  `Nimbus.fromEnv` always has. Before, the remote API rebuilt the request
  without it, so a durable app reserved remotely had no name. The input
  type is now the session protocol's `SessionDurableAppOptions`, exported as
  `NimbusDurableAppOptions`, and it includes `name`. Every input that
  compiled before still compiles. Remotely, a `name` that is not a string is
  refused (`E_ARG_SHAPE`), as `exposeApp`'s is.
- Added (core): `runtime/remote-http-contract.js`, with
  `DEFAULT_REMOTE_BASE_PATH` and `normalizeRemoteBasePath`. These are the
  remote API's base path and how a configured one is read. The SDK's
  `Nimbus.connect` and the worker's remote API both use them now, in place
  of a copy each. Base paths behave as before.
- Fixed (git): `git tag -l <pattern>` matches as git does, with the same
  wildmatch git uses for refs. A negated class (`rel-[!x]`), a POSIX class
  (`[[:digit:]]`) and an escape (`\x`) now work. Before, a regular
  expression stood in, and it read `rel-[!x]` as "rel-! or rel-x".
- Fixed (git): `git clone --depth` and `git fetch --depth` read their
  value as git does, into an int. `0`, a negative number, `abc` or
  `2147483648` fails with "fatal: depth <n> is not a positive number".
  `2junk` or `08` fails with "fatal: transport: invalid depth option
  '<n>'". Each failure exits 128. `010` is octal, so depth 8. Before, a
  clone took `0` and `abc` as depth 1 and `2junk` as depth 2, and cloned
  anyway. A clone with no `--depth` is still depth 1.
- Fixed (git, mounted clone): when a file, an unlink or the index lock
  fails, git's error gives strerror's words for every code the session's
  filesystem answers. `Invalid argument`, `Directory not empty`, `Bad file
  descriptor` and `Stale file handle` were missing, and those failures
  printed the raw error, such as `EINVAL: …`.
- Fixed (shell): when a here-document's command fails, the interactive
  shell reports it the way the shell and runtimes report any caught value
  (`_shared/error-text.js`). A thrown object's `message` is shown, and an
  `Error` with no message is shown by its name. Before, these read
  `heredoc error: [object Object]` and an empty `heredoc error: `.
- Changed: a process's filesystem client counts the bytes of a wave's paths,
  and a symlink's target, with `@nimbus-sh/platform/utf8.js`, as W7 does.
  It used to build a text encoder for every path of every wave. A resident's
  derived owner now comes from `sha256Hex`, with the same bytes as before.
- Fixed (shell): `tar -x` and `tar -t` on an archive that ends inside a
  file, its data or its padding, fail as GNU tar does: "tar: Unexpected EOF
  in archive", exit 2. Before, they exited 0 and left that file out, so a
  cut download looked whole. `tar -x` still writes what came before it, and
  that file's whole 512-byte blocks, as GNU tar does. An archive that ends
  between files, even partway through a header, is still whole.
- Fixed: `gem install` refuses a gem whose `data.tar.gz` is corrupt (a gzip
  CRC failure) or ends inside a file, as RubyGems does, and installs nothing
  of it. Before, the files that came before the damage were installed under
  the gem's specification, so it looked installed. An npm package whose
  tarball ends inside a file, though its integrity matches, now fails its
  install (the shell's `npm` and the install facet both), and its
  `package.json` is never written; before, it was installed without the
  rest.
- Breaking (core): `parseTar` (`substrate/lifo/utils/archive.js`) resolves
  `{ entries, truncated }` instead of the entries. `streamTarRecords`, and so
  `streamTarEntries` and `streamPackageEntries`
  (`_shared/tarball-stream.js`), throw the new `TarTruncatedError` after the
  entries before a member the stream ends inside; `extractTarball`
  (`_shared/tarball.js`) rejects with it, or with the gzip failure, rather
  than resolving the files before it.
- Fixed (`nimbus wrangler dev`, nested Nimbus): a Worker loaded through a
  `worker_loaders` binding no longer grows the host Worker's isolate without
  bound. The Worker Loader shim used to keep every loaded Worker's whole
  code in memory, up to 32 Workers whatever their size; seven 20 MiB Workers
  held 140 MiB in a 128 MiB isolate. What the shim holds is now bounded by
  bytes, 52 MiB in all: 4 MiB of loaded Workers' env and metadata, an 8 MiB
  cache of their modules, 32 MiB of credit for code being admitted or
  re-created, and 8 MiB for `LOADER.get` keys in flight. Each Worker's code
  is written to the session's store before its handle is returned, under
  `/.nimbus/loader-code`, owned by the store's own uid and out of the session
  user's reach. When workerd evicts a Worker, it is re-created from the store
  even after the shim's cache has let its modules go. A Worker whose build
  was replaced or stopped is not re-created; that call fails, naming the
  retired binding. A rebuild sends only its changed modules: unchanged ones
  are adopted from the previous build. Limits, each refused by name:
  - A Worker loaded through the shim may hold at most 32 MiB live, its
    working space included (native workerd allows 64 MiB).
  - Its env and metadata may take at most 4 MiB.
  - A `LOADER.get` id may be at most 262,144 characters.
  - A `load` that arrives while the shim is busy is refused ("retry")
    rather than queued.
  - The store holds at most 16,384 files and 256 MiB per binding of a
    build, and 1 GiB per session incarnation. Each binding's files count as
    its own, so a copy shared with another binding counts again.
  - A compiled `WebAssembly.Module`, a symbol, an accessor, a `toJSON` in a
    `{json}` module, or an instance of a program's own class is refused:
    the shim cannot account for what it holds.
- Breaking (fabric): `getLoadedCodesStats` is gone from
  `@nimbus-sh/fabric/bindings.js`. The session diagnostics' `loadedCodes` now
  reports each of the shim's buckets with its bound (`loaderHeapStats`,
  `@nimbus-sh/fabric/loader-heap.js`). `NimbusLoaderRPC.load` answers a
  promise, settled once the code is admitted. New supervisor op
  `loaderCodeStore`, which is the host's alone: any process's envelope is
  refused.
- Fixed: `fchmod`, `fchown` and `futimes` on a WASI program's file
  descriptor change the file it opened. Before, they changed whatever file
  had the name by then: after an unlink and a new file at that name, they
  changed the new one.
- Fixed: `futimes` with explicit times needs the owner, as `utimes` does.
  Before, any process that opened the file to write could set them.
- Fixed: setting a file's times to now (`touch`, or `UTIME_NOW` from a WASI
  program) needs only write permission, by name or by descriptor, on a
  mount as on the session's files. Before, a process that could write a
  file but did not own it was refused (`EPERM`). A time left as it is
  (`UTIME_OMIT`) is the one the file has when the change lands; before, a
  change to it made in between could be undone.
- Fixed: a napi binding's WASI opens (rolldown, the Astro compiler,
  satteri) no longer follow a final symlink when the binding asks not to.
  Such an open is refused with `ELOOP`, or `ENOTDIR` for a directory, as
  `open(2)` with `O_NOFOLLOW` refuses it. Before, the loader dropped the
  flag and opened the link's target. `fd_fdstat_set_flags` that changes
  `APPEND` is now refused with `ENOTSUP`, because the host's descriptor
  cannot change it. Before, it answered success and the descriptor kept its
  old mode.

- Fixed: in Node programs, `fs.open` honours `O_NOFOLLOW`: a final symbolic
  link is `ELOOP`, or `ENOTDIR` with `O_DIRECTORY`, as on Linux, and
  `EEXIST` under `O_CREAT|O_EXCL`. An open that creates or truncates is one
  call the session judges with its flags and the access it asks, so a file
  a peer replaces with a link after the program looked is refused, not
  followed and emptied, and `O_RDONLY|O_CREAT` opens a file its owner may
  only read. `O_CREAT|O_DIRECTORY` is `EINVAL`. `O_SYNC` follows each write
  with an fsync. `FileHandle.write` reads its arguments
  as `fs.write` does: `handle.write('ff', 0, 'hex')` writes the byte `ff`
  (it wrote `66 66`), and `handle.write(buffer, { offset, length,
  position })` writes that part there.
- Fixed: a name below a regular file is `Not a directory` (ENOTDIR), as on
  Linux, to `lstat`, `unlink` and `rmdir`, and to a mounted file system's
  `stat` and `open`. It was `No such file or directory`. `rm`, `mkdir -p`,
  `cp`, `mv`, Node's `lstatSync` and git now see the right error, and
  `existsSync` stays false. `ls` exits 2 for an operand it cannot reach, as
  GNU's does. `rename` from, or into, a name below a regular file is
  ENOTDIR too. `mv f/x a d` with `f` a file reports `cannot stat 'f/x'` and
  still moves `a`, as GNU's does; it ended the whole command.
- Fixed: `Bun.file` and `Bun.write` in `bun` answer as Bun's do. `text`,
  `json`, `arrayBuffer`, `bytes` and `stream` read through the session, so
  a file the process does not hold reads its bytes; before, `text()` and
  `arrayBuffer()` answered empty. A missing file rejects with `ENOENT`,
  `text()` drops a byte order mark, a directory does not `exists()`, and
  `name` is the path as given. `Bun.write` writes the bytes of a `Blob`,
  `Response`, `BunFile` or view, encodes a string as UTF-8 and anything
  else as its string, and answers the byte count. Before, a `Blob` was
  written as text (0xff became U+FFFD) and a string's count was its UTF-16
  length. opencode's `Bun` uses the same `file` and gains `write`.
- Fixed: a barrel package's synthetic entry reads the barrel with the
  JavaScript parser. A re-export in a comment or a string no longer wins
  over the real one, every name of `export const a = 1, b = 2` and of a
  destructuring export counts, and `export * as ns` is one name. A barrel
  that does not parse is refused rather than read in part. The barrel and
  each module it re-exports with `export *` are read one statement at a
  time, so no module's whole syntax tree is held in memory.

- Fixed (CLI): `nimbus runtime sync` with no runtime named, and so `nimbus
  setup cloudflare`, now publishes `cpython@3.13.14-3` as the bucket's Python.
  It used to publish `python@0.29.4`, Pyodide, whose `python-runner` no host
  registers anymore, so a fresh bucket's `python` could not be installed.
  The published CLI can publish the runtimes Nimbus builds itself (cpython,
  bash, git), although the published `@nimbus-sh/worker` has no wasm build
  tree. Each is staged from its npm runtime package at the version the
  release names. The tarball must match the registry's sha512 integrity, and
  it is read in memory, never unpacked: an entry that is a link or a device
  is refused, so nothing outside the package is ever read, and so is a
  package of more than 4,096 entries or 1 GiB of tar. Each file must
  match the package manifest's sha256, and the manifest the publisher
  composes must be the package's, byte for byte, or nothing is published.
  Before, the publisher stopped at the missing build tree. Publishing
  `@nimbus-sh/worker` or `@nimbus-sh/cli` now requires each of those runtime
  packages to be on npm at its spec's version, as publishing core already
  did (`check-runtime-packages.mjs`, run by `dist-integrity.mjs --publish`).

- Fixed (build): the dist fixpoint's input fingerprint covers what the
  packages' builds run and import outside their own trees. That is the
  shared body compiler (`scripts/compile-facet-bodies.mjs`,
  `scripts/lib/compiled-bodies.mjs`), the orchestrator's helpers,
  `rebuild-opencode`'s output patcher, and the bash input check. Before, a
  change to one of them was accepted by the warm path unbuilt: moving
  compiled-bodies' target from esnext to es2018 left the record verified.
  `tests/unit/dist-integrity.mjs` [27] walks the build's imports and refuses
  any file outside the inputs. It parses each script with TypeScript, so a
  comment, a template literal or a `new URL(…, import.meta.url)` read cannot
  hide a file (`scripts/lib/build-reads.mjs`).

- Fixed: the shell's `node` emits `beforeExit`, as Node does. It fires
  with `process.exitCode` each time the loop runs empty, and again only
  when a listener scheduled a timer or an immediate. A write or a microtask
  in a listener does not run the loop again, and `process.exit()` and a
  fatal error skip it.
- Fixed: the shell's `node` changes owners. `chown`, `lchown` and `fchown`
  (sync, callback, promise and `FileHandle` forms) were no-ops or missing.
  `-1` keeps that side, another's owner is `EPERM`, and a bad id is
  `ERR_OUT_OF_RANGE` or `ERR_INVALID_ARG_TYPE`, thrown at once as in Node.
  The hosted runtime's `chown` now reads ids the same way; it gave `EINVAL`.
- Fixed: `fchown` on an open file was refused to everyone but root. The
  owner may now change its group, as on Linux.
- Fixed: `stat` reports each operand it cannot stat with its own error,
  such as `Permission denied` or `Too many levels of symbolic links`, then
  goes on to the rest and exits 1, as GNU's does. It used to stop at the
  first one and call every failure `No such file or directory`. `%n` and
  the `File` line name the operand as given. A link is reported as itself,
  and what it points to only with `-L`.
- Fixed: `grep --exclude-from=FILE` excludes the globs listed in FILE. It
  was refused as an invalid option.
- Fixed: the `ruby` prompt runs as the caller, as `ruby -e` does, so its
  file calls use the resident filesystem instead of a supervisor round trip
  each. A file one line opens stays open on the next, as in irb.
- Fixed (lifo `node`, X-9): `vm` is Node's. Contexts, scripts,
  `compileFunction`, `runInThisContext` and `runInNewContext` work in an
  inline `node` program and a lifo command alike; before, the module was
  refused. `importModuleDynamically:
  vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER` is refused
  (`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`) at each compile and context that
  names it, because the engine's own loader would import the host's files
  at the program's paths. A program's options reach the engine as they are,
  and a program's own callback is its own. `vm.SourceTextModule`
  and `vm.SyntheticModule` are absent, as in Node without
  `--experimental-vm-modules`. `domain` stays refused.

- Fixed: `bash` and its BusyBox commands read accounts from `/etc/passwd`
  and `/etc/group` at each lookup. `~user` is the user's home and `~root`
  root's, a name no account has stays as written, `ls -l` and `stat` name
  each file's real owner and group, and an account added while bash runs is
  found. bash 5.2.37-6 answered every name with one fixed account, and
  its BusyBox named every owner `user`, root's files in `/usr/bin` and
  `/etc` too. A command that names owners now makes one lookup per name.
- Fixed: a piped stdin is a FIFO to bash's `test -p` (on `/dev/stdin` and
  `/dev/fd/0`) and to BusyBox's `stat`, as on Linux.
- Fixed: `python -c` flushes its `sys.stdout` once as it ends, as `python3
  -c` does; the host flushed it a second time.
- Changed: bash 5.2.37-7 (runner contract `bash-runner@6`) and CPython
  3.13.14-3. BusyBox is now built by the same reproducible recipe as bash.
  The catalog keeps 5.2.37-6 and 3.13.14-2 as its defaults until the next
  release publishes the new builds.
- Fixed: a WASI program (git, Python, clang, Ruby) that was killed, or that
  exited, before the session had answered its last file changes no longer
  loses the files it made in a directory it held. The session landed the
  rest of what the program had logged but refused those files.
- Fixed (real git, `NIMBUS_GIT_WASI=1`): Ctrl-C reaches `git` while it
  waits on a credential helper, an editor, a pipe or a child, as on Linux:
  `git credential fill` and `git commit` waiting on its editor end with
  status 130 and the prompt comes back, where before git and its helper
  ran on and the terminal hung. The terminal's key goes to the command's
  whole process group; a program whose image takes its own signals (git's,
  runner key `git-runner@2`) is sent the signal rather than killed, its
  host ends the wait the signal came in (`NIMBUS_ESIGNAL` + the signal's
  number), and its libc raises it before the call returns `EINTR`
  (`wasm/nimbus-libc/nimbus-signal.c`), so git's handlers run and an
  unhandled signal exits 128 + its number. SIGKILL still ends it. A child
  process that a signal ended from outside its parent (its process group's,
  `kill <pid>`) is reported to the parent as killed by that signal, as on
  Linux (a Node parent's `'exit'` has code `null` and the signal), not with
  whatever its program returned as it was stopped.
- Breaking (core): `GIT_RUNNER_CONTRACTS` values are `GitRunnerContract`
  (`{ restartsWaits, takesSignals }`), and `makeGitRunnerFactory` and
  `GitFacetArgs` take `takesSignals`. `SessionProcessSupervisor` gains
  `takeSignals`, `nextSignal` and `signalGroup`; a process that took its
  signals is sent a caught signal by `kill`/`signal` instead of ending.
  New supervisor op `cpNextSignal`.

- Fixed (lifo `node` and lifo CommonJS commands, X-1/X-2): a program's
  `process.stdin` is a Readable over fd 0, as Node's: `'data'` as each piece
  arrives rather than once stdin ends, `for await`, `pipe`, `setEncoding`, and
  readline over it (the engine's own readline now; lifo's copy, which split a
  line arriving in two pieces into two lines, is gone). A program that never
  reads stdin, pauses it or destroys it, no longer waits for it to end, and
  a read it left pending takes nothing typed after it ends. A program's
  process (a lifo CommonJS command's too) now hears `'exit'` as it ends (by
  itself, by `process.exit()`, or of an error nothing caught), and its
  listeners decide its status through `process.exitCode`, as in Node; no
  listener ever heard it before. A program that ends in raw mode leaves the
  terminal in the mode it found it. And in the shell, what is typed while a
  command runs and before it reads is edited into a line, as a tty's line
  discipline holds it: a reader gets the whole line, not its first key. In a terminal,
  `process.stdin`, `process.stdout` and `process.stderr` are the tty module's
  streams, as in Node: `isTTY` is true, `columns` and `rows` are the window's
  (`COLUMNS` x `LINES`), a typed line is read as it is typed, and
  `setRawMode` hands the program each key. `tty.isatty(fd)` answers for each
  descriptor (it was always false), and `tty.WriteStream(fd)` writes to that
  descriptor in order with `process.stdout` (its writes went nowhere) and
  hears its own writes' failures, as Node's: one that fails after `end()`
  is its `'error'`, not its finish, and none is heard once it is destroyed;
  a descriptor that is not 0, 1 or 2 is refused as Node refuses it.
  Breaking: `createProcess` (`substrate/lifo/node-compat/process.js`) takes
  `stdio` (`{ stdout, stderr, env, input?, terminal? }`) in place of `stdout`
  and `stderr`; `substrate/lifo/node-compat/readline.js` is removed; and a
  `tty.WriteStream` needs its descriptor, as Node's does.
- Fixed (real git, `NIMBUS_GIT_WASI=1`): a push, fetch or credential lookup whose helper took more than 8 s to answer was taken for a helper that quit: `git push` reported "failed to push some refs" (though the remote had taken the push, leaving the remote-tracking ref stale), and `git credential fill` asked its own prompt. A wait on a pipe gives up at 8 s (a suspended wasm stack outliving its bound never resumes), and git's stdio took the give-up for the end of its helper's output. Git's image now asks such a read or write again (`wasm/nimbus-libc/nimbus-restart.c`, linked over `read`, `readv`, `write`, `writev`); its host answers the give-up `NIMBUS_ERESTART` (512) to an image that declares it, and a signal still interrupts with `EINTR`. The runtime is `git/2.53.0-1` and names `git-runner@2`; an installed `git/2.53.0` keeps `git-runner` and its old answer. Breaking (core): `GIT_RUNNER` is `'git-runner@2'`; `GIT_RUNNER_CONTRACTS` lists both keys, and `makeGitRunnerFactory` takes `restartsWaits`.
- Fixed: `gem install` and `bundle install` finish a gem whose install was
  interrupted, instead of treating it as installed once its `lib`
  directory existed. A gem is installed once its specification is written,
  as RubyGems decides, and that is now written last; Ruby's load path lists
  only installed gems. `Gemfile.lock` lists the bundle's own gems and their
  dependencies, at the versions it resolved, instead of every gem the
  session ever installed. Gems installed by an earlier Nimbus are installed
  again once.

- Fixed: `npx` keeps each request's install apart, as npm does: in its own
  directory under `/tmp/.npx-cache`, named as npm names it, written only
  if its install succeeds. A request for a package that does not exist no
  longer breaks every later `npx`. What earlier sessions installed in the
  shared `/tmp/.npx-cache` is installed again once, where it is asked for.
- Fixed: `npx <pkg>@<version>` runs that version. A project's
  `node_modules`, or what an earlier `npx` installed, answers only a
  version or range it satisfies; before, whatever version was there ran.
  One known difference from npm: `npx <pkg>` by name alone, with that
  package already in its npx directory, runs what is there, where npm
  asks the registry first for a newer version.
- Removed: core's `createNpxCommand` (`@nimbus-sh/core/substrate/lifo`),
  a second npx no Nimbus shell registered. The session's `npx` is the one.
- Fixed: `pip install` sees a release published since an earlier install.
  The session kept PyPI's answers forever, so a later install could not
  see a new release, and each process's own network left its answers
  behind. They are now kept as pip's HTTP cache keeps them: for the
  response's `max-age` (15 minutes for PyPI).
- Fixed: the shell's built-in `node` hears of a write its output refused,
  as Node does: piped to a reader that closed (`node … | head -1`) or
  redirected to a full device, `process.stdout` emits the EPIPE or ENOSPC
  error; unhandled, the program ends with its stack and status 1, and a
  program that handles it goes on. A write that fails after the program's
  code ran reaches any listener the program added before it ended.
  `console.log`'s failures are heard only by an `'error'` listener on its
  stream, as in Node. One known difference: Node's `console.log` in a loop
  into a closed pipe can end the program with an unhandled EPIPE (status 1);
  here it is ignored. A status set in `process.exitCode` after the main
  script ran is now the program's, and `process.exit(n)` no longer prints a
  `[process.exit]` line.
- Fixed: text the shell captures (exec's stdout and stderr, `$( )`) decodes
  a multibyte character that a command's writes split, instead of two
  stray bytes. A streamed exec's result, `bun run`, `npm run`, shell
  scripts and the WASI runtimes now write the character their output's last
  bytes left unfinished; it was lost. Captured text keeps a byte that is not
  UTF-8 the same way for every command: a `node` program's now reads as a
  coreutil's always did (one character a byte), not as U+FFFD.
- Fixed: `cat`, `tee`, `head`, `cut`, `cksum`, `md5sum` and the other
  `*sum` tools, `sum` and `grep` read their options as GNU's getopt_long
  does. A long option may be any unambiguous prefix of its name
  (`cat --numb`, `head --lin=1`); an ambiguous one lists its possibilities;
  a missing or unwanted argument gets getopt's message. `grep -A` and `-B`
  now win over `-C` and `-NUM` whichever comes first, as in GNU grep.
- Fixed: when `python`, `bash` or `clang` cannot start, the reason reads as
  every other command's does: a thrown object's message instead of
  `[object Object]`, and `Error` instead of nothing for an error without a
  message.
- Fixed: WASI programs and bash see their files and clocks as on Linux. A
  small file's offset stays where a seek past its end put it after a read
  there, and a negative `pread` offset is `EINVAL`. Each open of a `/proc`
  file reads it anew, so two `read </proc/uptime` in one bash differ. A
  piped stdin is no longer a character device (`[ -c /dev/stdin ]`), while
  a terminal's still is. A `poll_oneoff` clock subscription on an unknown
  clock gets `EINVAL` in every WASI program, as it already did in bash.
- Changed: `clang` reads each toolchain image only when its phase runs.
  `clang -c`, and a compile that fails, no longer read or hold the 18.5 MiB
  linker; a link of objects alone no longer reads the 31 MiB compiler.
- Fixed: `ruby -r NAME` requires NAME as written, as Ruby does: `#{...}` in
  it is no longer interpolated. A Ruby script (which keeps running as its
  own process) now runs with the caller's credential, as `ruby -e` does, so
  its file calls use the resident filesystem instead of a supervisor round
  trip each.

## 2026-10-15: platform 0.11.0, core 0.22.0, fabric 0.17.0, worker 0.20.0, sdk 0.16.0, loom 0.3.1, react 0.3.3, cli 0.2.7, create-nimbus-app 0.2.4, runtime-cpython 3.13.14-2 (config 0.3.1 unchanged)

The 2026-10-14 versions reached production but were never published to npm; these carry their changes too.

- Changed: in a directory tree a node process holds (one it writes often
  enough to take), `fs.promises.stat` and `fs.promises.lstat` answer from
  the process's own view, without a round trip to the session, once that
  view is known to be the session's for everything the answer depends on.
  Everywhere else, and for anything the process changed and the session
  has not answered yet, they ask the session as before. A mount or unmount
  overlapping a held tree now gives that tree back first.
- Fixed (local workerd: `wrangler dev`, the unit suite): a session could
  stop answering for good, its thread at 100% CPU, after a real-git run on a
  busy machine. workerd 1.20260926.1 left cppgc sweeping incremental (V8
  overwrote the atomic sweeping workerd asked for), and its message-loop pump
  ran the incremental sweep task, which re-posted itself, forever. wrangler
  4.143.0 → 4.145.0, which pins workerd 1.20260930.2 and miniflare
  5.20260930.0-alpha: workerd's e5803288a sweeps atomically, so no sweep task
  is ever posted. Deployed Workers are unaffected: the edge runs Cloudflare's
  own build.
- Fixed: the shell's `node` matches Node in more of its module surface. A
  CommonJS file runs with `this` as its `module.exports`;
  `require('fs').promises` is `require('fs/promises')`, and likewise for
  `dns`; `module.isBuiltin` and `module.builtinModules` agree with
  `Module`'s own and no longer count `rimraf` and `esbuild` as core; and
  `fs.rm` and the new `fs.rmSync` remove a dangling link, never what a link
  names, and refuse a directory without `recursive` (`ERR_FS_EISDIR`).
- Fixed: `stat -c` prints a file's real inode, link count and device for
  `%i`, `%h`, `%d` and `%D`; `%i` used to be a hash of the path as typed.
- Fixed: the interactive shell collects a here-document with an empty
  delimiter (`cat <<''`, ended by an empty line) instead of running the
  command before its body.
- Fixed: both `node`s check a mode, a mask and open flags as Node does,
  with Node's errors. In a hosted program, `process.umask('022garbage')` and
  `fs.chmodSync(f, '7a5')` took the digits they began with, and
  `umask('40000000000')` set 0; `fs.openSync(f, 'xw')` opened for reading
  and failed on a new file, and any other string opened for reading. The
  shell's `node` now honours `fs.mkdirSync`'s mode and takes an octal string
  for `chmod` and `mkdir`.
- Changed: in a directory tree a node process writes often enough to hold,
  the changes it has already answered (its sync calls, and the async ones
  decided there) are sent with the next change it awaits, when it flushes,
  prints or otherwise acts outside, or 10 ms later. Sent one by one, each
  made the program's next read and next awaited change wait out the
  session's durable commit, about 40 ms deployed. The session's file tree
  and other processes' watchers see such a change up to 10 ms later than
  before. In such a tree, `fs.promises.chmod`, `utimes` and `chown` (and
  their callback and `FileHandle` forms) now resolve once the change is
  logged, as `mkdir`, `unlink` and a file's `rename` already did. So does
  `fs.promises.copyFile` when both names are in held trees and the source
  is a file the program just wrote, or one the copy reads once into the
  program's view. `fs.promises.cp` of 200 small files takes about 3 s,
  where it took 13 s, and 8 s before it was Node's own. An async `chown` now
  refuses `EPERM` itself, as `chownSync` does.
- Fixed: a file `fs.promises.copyFile` or `fs.promises.cp` made in a
  directory the program had just made was missing to `existsSync`,
  `statSync` and `readdirSync` until later, although it could be read.
  It is now there as soon as the copy resolves.
- Fixed: `chmod`, `chown` and `utimes` in node (sync, callback, promise and
  descriptor forms) judge as the session does, by the same rules: `utimes`
  of another user's file is `EPERM`, a directory on the path the caller may
  not search is `EACCES`, `lchown` and `lutimes` judge the link itself (a
  link to another's file, or to nothing, is the caller's to change), and a
  `chown` by anyone but root clears the setuid and setgid bits in what
  `statSync` reports. Each was accepted, or refused, where the session
  answered otherwise. While the process's view of the filesystem is being
  rebuilt, their async forms ask the session instead of refusing `EAGAIN`.
- Fixed (npm): an install of many packages dropped one about one time in
  ten, its reason "Response closed due to connection limit" (pi's official
  installer, 118 packages). The install facet held registry answers open and
  unread (a hedged download while the cache was still answering, and a body
  read only as fast as its files were written), and the runtime closes the
  least recently used idle connection when six are open and another waits.
  Every registry answer the installer fetches (tarballs and packuments) is
  now settled as it arrives: a 2xx body is read ahead of its reader (up to
  4 MiB, which most tarballs fit), any other answer's body is cancelled and
  only its status kept, so a 503 is retried without waiting on its body; and
  a package's download is ended however the package ends.
- Added: `npm install` and `npm ci` check engines as npm does: the
  project's (unless it declares `devEngines`) and every required package's
  `engines`, a lock's packages included, against this runtime's Node and
  npm, with npm's `npm warn EBADENGINE` warning for each mismatch, in npm's
  order. Under `--engine-strict`, or an `.npmrc`'s `engine-strict=true` (as
  `sv create` writes), the first mismatch fails the install with npm's
  error, and nothing changes. An optional package whose engines exclude
  this runtime is left out, as npm leaves it out. Before, no engine was
  checked, and `--engine-strict` was refused.
- Added: every `npm` command but a global one checks the project's
  `devEngines` first, as npm does: npm's `EBADDEVENGINES` error ends it
  (`onFail: "error"`, the default), npm's warning lets it run
  (`onFail: "warn"`, or any under `--force`). `--force` now says npm's
  "Recommended protections disabled" for every command, not only
  `npm init`.
- Fixed: `npm install --no-production` (and `--include=dev`, `--dev`,
  `--also=dev`) installs devDependencies where `NODE_ENV=production` would
  omit them, and `--optional=true` keeps optional dependencies
  `--omit=optional` would leave out, as npm reads them.
- Fixed: npm's defaults that npm takes from its own environment (`omit` from
  `NODE_ENV`, `editor`, `shell`, `unicode`, `color`) come from the session's
  environment, not the Worker's. The Worker's production build made
  `npm ls`, `npm uninstall` and `npm init` read `omit=dev` as the default.
- Fixed: a session's npm installs no longer take one registry's package for
  another's. The session kept what a registry said of `name@version` (its
  tarball, integrity and dependencies) under the name and version alone, so
  an install against another registry (`--registry`, an `.npmrc`,
  `NPM_REGISTRY`, or a process's own network) could install the first
  registry's tarball. Each registry's answers, read through each network,
  are now kept apart. What the session kept before is dropped once.
- Fixed: a version range (`^2`) is resolved from the registry's versions, as
  npm resolves it, never from the few versions a session happened to have
  kept: a fresh `^2` came back 2.0.0 when 2.0.0 had been installed before,
  with 2.1.0 published. An exact version (as a lockfile names) is still
  answered from what the session kept.
- Fixed: `npm install` and `npm ci` read their options as npm does, from
  the command line, `npm_config_*` and the `.npmrc` files (project, user,
  global), like `npm init`, `npm ls` and `npm uninstall` already did.
  `--registry` (or an `.npmrc`'s `registry=`) was parsed and dropped: an
  install went to the session's registry (`NPM_REGISTRY`, else
  registry.npmjs.org) whatever was asked. Now npm's setting wins, and the
  session's applies where npm names none. Options npm spells its own way
  are read as npm reads them: `--global=false`, abbreviations, and `-p`,
  which is `--parseable` to npm (it was taken as `--production`; use
  `--omit=dev`). `bun install|add -p` still means production, and bun's
  `-d`/`--dev` now save a dev dependency as bun does.
- Fixed (lifo commands): a command's `process.exit(n)` writes nothing, as
  Node's does; it wrote `[process.exit] code=n` on the command's stderr for a
  non-zero `n`. lifo's `http` gives Readables, as Node's: a server's request
  and a client's response push their body as a Buffer and end, so `pipe`,
  `for await`, `setEncoding` and `'data'` work as in Node, and `'end'` comes
  only once the body is read.
- Fixed: `tee`, `dd` and the commands that read a file operand (`cat`, `wc`,
  `grep` and the rest) open each file once, as their GNU tools do. If
  another command moved the file aside and a new file took its name while
  they ran, the rest of the input went to, or came from, the new file.
  They read a file to its end even where a mount answers a read with less
  than it asked, and `dd` truncates the file it opened. `tee` now reports a
  file it cannot write once, and writes it no more; `tee` and `dd` close
  every file they open, also when a write, a sync or their own error
  report fails.
- Fixed: a lifo ES module command sends only its real bare imports to the
  CDN. A string or a comment that read like an import was rewritten too,
  so `ctx.stdout.write("from 'foo'")` printed a CDN URL, and `node:`
  builtins and URL imports were sent to the CDN. A computed `import()` of
  a bare name now goes to the CDN as well.
- Fixed: `cp -p` and `cp -a` keep each entry's owner on every path, as
  GNU cp does: a single file, an overwritten one and a copy into an
  existing directory used to be owned by whoever ran cp. A symbolic link
  keeps its own owner and modification time. A user who may not give a
  copy another's owner keeps their own, silently; root is told when it
  cannot (status 1). A symbolic link named on the command line is now
  followed, as GNU cp follows it, unless `-r`, `-a`, `-P` or `-d` copies
  the link itself.
- Fixed: the shell's built-in `node` is the process the shell started.
  `node --version`, `process.version` and `process.versions` now name one
  release, core's (they disagreed: v20.0.0 and v22.14.0), and
  `process.versions` no longer has a `lifo` key. `process.pid` is its pid
  in the session, `getuid`, `getgid` and `getgroups` are its credential
  (root under `sudo`), and `process.umask()` reads and sets the program's
  own mask, which its files are made with; the shell's mask stays.
  `global` is the realm's `globalThis` in every module, as in Node.
- Fixed: opencode's TUI gets answers from its syntax-highlight parser. The
  parser runs as a Worker that the opencode facet hosts on its own thread,
  where workerd's `worker_threads` reports the main thread, and the parser
  installs its message handler only off the main thread: it never answered
  anything the TUI sent it. Its build now gives it a `worker_threads` of its
  own that says it is a worker. Its file reads and writes (`fs/promises`) are
  the session's filesystem, as checked in a real facet.
- Fixed: a long-running `node` process holds from its start the file a
  package specifier its code resolves names as Node resolves it. A
  `createRequire(...).resolve('pkg/data')` of a package whose `exports`
  lists `require` and `import` targets read the `require` one, as Node's
  require does, but the process held the `import` one, so the synchronous
  read failed. Its program's `--conditions` count too.
- Fixed: `node` stages what its code reads by a path it spells out even
  after a URL string on the same line. `node -e 'const u =
  "http://example.com"; fs.readFileSync("/home/user/data/x.txt")'` raised
  EAGAIN for a file outside the working directory. A read through a name
  given a path function (`const resolve = require('path').resolve`) is
  found as one too.
- Fixed: `node`'s `fs.readFileSync` returns a file that opens with a UTF-8
  byte order mark with the mark, as Node does, wherever the launch staged
  it from: a working-tree file, a required module or JSON file, an
  installed package's `package.json`. The staged copy used to drop it, so
  `EF BB BF 68 69` read back as two bytes synchronously and five from
  `fs.promises.readFile`. `require()` of a JSON file and a package's
  resolution through its `package.json` still skip the mark, as Node's do.
- Fixed: Python's `os.umask` governs the files it creates, `os.open` makes a
  file with the mode asked for (under the umask, as Linux does), and
  `os.getuid()`/`os.getgid()` are the session user's, not 0. Before, the
  umask was the interpreter's own variable, which nothing read, and every
  file was made 0644. This needs the CPython runtime 3.13.14-2 and core
  0.21.0 or later; 3.13.14-2 names a runner of its own, so a deployment
  whose core predates it keeps 3.13.14-1. This core runs both builds: it
  installs 3.13.14-2 when the catalog's default names it or when it is
  asked for (`nimbus install cpython@3.13.14-2`), and a session that
  installed 3.13.14-1 keeps it.
- Fixed: a Python program that resolves more than 64 distinct hostnames gets
  `socket.gaierror` (EAI_MEMORY) for the 65th, instead of an address that
  stood for another name, which a connect would have dialed.
- Fixed: a running `wrangler dev` stopped serving when its session's object
  was re-created (an idle session's is, within minutes; so is one after an
  instance reset): its Worker URL answered "no dev server running" until it
  was started again. It is now a process of its own from before its first
  build (`ps` lists it, `kill` ends it, and `startProcess('wrangler dev')`
  keeps serving after the call returns), and while it runs, its spawn is
  recorded: the command line, its argv, directory, credential and exec id,
  and the environment the command was given (a launch's `$PORT` and
  `$NIMBUS_APP` are not part of it). The next incarnation of the session
  runs the command again, once, with exactly that environment, as the same
  process restarted (`restartedFrom` cause `session-restart`); a `vite`,
  `wrangler dev` or stop the user runs meanwhile waits for it, so it is not
  undone. `wrangler stop`, `vite stop` or a kill ends the record with the
  process, so a stopped server stays stopped; a destroy ends the restore.
  `vite`, `vite preview` and real Vite come back the same way, through the
  `vite` command run again: it reads its `vite.config` afresh rather than
  the options it had when the session stopped. A server started by
  `/api/start-vite` comes back as `vite --port <n> --no-install-check` in its
  root, with its project's `vite.config` and not the aliases or define the
  request gave. A command that fails to start again is not retried: a
  request for its server, through its preview, its port or a link handed
  out for that port, answers 503 with the command, why it failed and which
  process's log holds its output. An in-session Vite server now also stops
  when its process ends however it ends, and starting one ends a running
  real Vite. A `vite` server the session was running when it was upgraded
  to this release is not restored once; run `vite` again.
- Fixed: a session's `npm uninstall` and `npm ls` do what npm 10 does.
  `npm uninstall -g p` removes the global p and its commands, for good (no
  later global install links them again); it removed the project's p and
  its declaration instead. Both read their options as npm reads them
  (`--global=false` is the project, `--location=global` the global
  prefix, and `.npmrc` counts). `npm uninstall p` removes p's
  bins with it, and every declaration of p, installed or not (each
  dependency field and `bundleDependencies`); package.json keeps its own
  indent, its dependency fields sorted and empty ones dropped, and
  `--no-save` leaves it as it is. It reports `removed N packages` or `up to
  date`. `npm ls` lists what the project declares as npm does: one that is
  not installed is an `UNMET DEPENDENCY` (not its range, as though it
  were), one its range does not take is `invalid`, and a package nothing
  depends on is `extraneous`; a missing or invalid one fails the command
  (`ELSPROBLEMS`). `npm ls -g` lists the global prefix, not the project.
  An install and an uninstall into one tree at once run one after the
  other. For embedders: `createNpmCommand` takes `beforeWrite`, called
  before the command replaces the project's package.json, and an
  `NpmInstallPort` may have `unlinkBins`, called with the packages an
  uninstall removed, and `hold`, the hold its installs take on a tree.
- Fixed: two npm installs at once in a session no longer remove each
  other's staged packages. Each install built its own installer, so one
  starting could sweep the staging directory of another installing into a
  mounted project, which then reported packages installed that it never
  put there. The session has one installer; each install's progress and
  npm log are still its own.
- Fixed: a Worker whose `wrangler.jsonc` declares `kv_namespaces`,
  `d1_databases` or `r2_buckets` starts under `wrangler dev`, and
  `env.KV`, `env.DB` and `env.BUCKET` answer as the local bindings real
  `wrangler dev` gives a Worker do: KV get (each type, and bulk), put,
  delete, list and getWithMetadata; D1 prepare, bind, first, all, run, raw,
  batch, exec and withSession, with D1's errors and meta fields; R2 head,
  get (ranges, conditions), put (metadata, checksums, conditions), delete,
  list and each body method. The build failed with "Could not serialize
  object of type "D1Emulator"" (or "KvEmulator"): a Worker Loader env
  carries no class instance. Each binding reaches only the store it is
  declared for, in its own project: a KV namespace's or R2 bucket's files
  under the project's `.nimbus`, as the user who started the server, and a
  D1 binding's own database. A KV or R2 body is streamed to its file as
  it arrives, never held whole, and one past the platform's limit (25 MiB
  for a KV value, 5 GiB less 5 MiB for an R2 upload) is refused with the
  platform's error as it passes it, its stream cancelled, leaving the value
  it would have replaced. An R2 object's etag is now its body's MD5, as on
  Cloudflare, a key ending `.meta` is its own object, and KV and R2
  listings page with Cloudflare's cursor. Unlike workerd, an R2 put of a
  stream whose length is not known is accepted.
  Embedders re-export the new `NimbusKVNamespace`, `NimbusD1Binding` and
  `NimbusR2Bucket` classes from their Worker's main module, as they do the
  other Nimbus classes (`export * from '@nimbus-sh/sdk/entrypoints'`
  does); without one, its kind of binding is not made, with a warning.
- Fixed: two Durable Objects of a `wrangler dev` Worker could run as one
  (one instance, one storage): an object's facet was named by its binding
  and its id joined with `-`, so binding `A-B`'s object `c` and binding
  `A`'s object `B-c` were the same. Each pair now names its own facet, of
  a bounded length (a long object id named one over workerd's limit). An
  object's local storage under `wrangler dev` starts empty once, under its
  new name; so does a D1 database's, whose facet name is bounded the same
  way (a long project path named one over the limit).
- Fixed: the agent's "Send again", after a message whose answer never came
  back, stored the message a second time when the first had reached the
  session. A message is now sent under an id the browser chooses (`id`, a
  UUID, in the `POST /api/agent/messages` body), and the session takes
  each id once: it keeps the ids of its last 512 sends, past the 80
  messages it stores, until the conversation is cleared. Sent again, the
  message is answered again only if it is the conversation's last and has
  no complete answer; otherwise the reply is the conversation as it is. A
  repeat while its answer is still being written is refused (409
  `E_AGENT_TURN_RUNNING`), as is an id another message or an answer holds
  (409 `E_AGENT_MESSAGE_ID_TAKEN`). A message whose text is not
  well-formed (a lone UTF-16 surrogate) is refused (400
  `E_AGENT_BAD_MESSAGE_TEXT`). An answer now names the message it answers
  (`replyTo`), so with two turns answering at once, a retry or a message
  sent again finds its own answer, and replaces only that one.
- Fixed (security): a public application URL is forwarded only to the
  session its capability belongs to. Put under another session's id of the
  same tenant, the capability was forwarded to that session, which woke
  (or, for an id no session had, was created) only to refuse it; now the
  router answers 404 and names no session.
- Breaking (embedders): `createNimbusHandler`'s hooks no longer declare
  `onSessionEnd`. It was reserved and never called: a function passed as
  it never ran. TypeScript now refuses it in a `hooks` literal; at run time
  nothing changes. Remove it from the hooks you pass. The next
  `@nimbus-sh/worker` publish is a minor version, and so is
  `@nimbus-sh/sdk`'s, whose `@nimbus-sh/sdk/worker` entry re-exports
  `NimbusHooks`.
- Breaking (embedders): `isValidAppName` and `APP_NAME_RE` are removed from
  `@nimbus-sh/worker/port-capability`. An application name has one rule,
  `isPreviewHostName` from `@nimbus-sh/worker/preview-host`, which checks
  what `isValidAppName` checked; no re-export remains. The public
  directory's `bind` checks a name by the same rule. The next
  `@nimbus-sh/worker` publish is a minor version.
- Fixed (Node `fs`): `fs.cpSync`, `fs.promises.cp` and `fs.cp` are Node's
  own `cp`, run over Nimbus's `fs`, so they answer as Node 22 does. The async
  forms took a file the program had not read for a directory (EISDIR), and
  ignored `filter`, `force: false`, `errorOnExist`, `dereference`,
  `verbatimSymlinks`, `preserveTimestamps` and `mode`. They also copied a
  link as the file it names. `cpSync` refused `errorOnExist` even under the
  default `force: true`, where Node overwrites. Directory modes and errors
  (`ERR_FS_CP_*`) differed from Node's, and copying a directory into itself
  never ended.
- Changed (Node `fs`): `fs.cpSync` is faster than before, and
  `fs.promises.cp` and `fs.cp` are slower, about 1.6 ms per file in a warm
  isolate (a 200-file tree: +315 ms warm, +247 ms cold). Node's `cp` stats
  each source entry twice and each copied file's destination once, every
  stat a call to the session, and each file's copy waits for the session.
- Changed (Node `fs`): `fs.cp` and `fs.cpSync` create directories as Node
  does: 0777 less the umask, with the mode set only where Node sets it.
  `fs.cpSync` leaves each directory it makes that way, and `fs.promises.cp`
  and `fs.cp` give each one the source's mode once its entries are in. Each
  file is still given the source's mode. A copied directory used to take the
  source's mode, and while it was being filled only its owner could open it.
- Added (Node `fs`): `fs.symlinkSync` and `fs.readlinkSync`.
- Changed (Node `fs`): `fs.promises.copyFile` and `fs.copyFile` are now a
  single copy the session makes, in program order. The program neither
  reads the file nor sends it back, and within one filesystem the copy
  shares the source's stored content. The copy still has the source's mode
  exactly, and the program can read it at once if it held the source's
  bytes.
- Fixed: a process's recursive copy beneath a WASI preopen on a mount that
  answers asynchronously followed a link named as the source even when the
  copy did not ask to follow it.
- Fixed: an `opencode` launch that fails while it is prepared (a working
  tree whose snapshot serializes past the RPC payload ceiling, say) ends
  the process it started, exit 1, with the reason in its exit. It was left
  running in the process table, for a program that never started.
- Fixed: in a core workspace, a process that ends after the exec that
  started it (a background job) leaves the process table a minute after it
  ended, at the next exec, as in a hosted session. It stayed, with its
  logs, until the workspace closed.
- Fixed: a Node program's `child_process` handle stays its own, and its
  ancestors', while the child's output and exit are still to be read,
  though the process table forgot the rows of the ended child and of the
  processes between. A parent that paused for a minute between reads got
  ESRCH and lost the rest of the child's output and its exit status. A
  `kill()` of such a child returns false, as in Node.
- Changed: `kill -STOP` (and `-TSTP`, `-TTIN`, `-TTOU`) of a shell job is
  refused with "Operation not supported" and status 1, as it is for a
  hosted resident: nothing can pause a job's work. It used to answer 0 and
  list the job as Stopped while the job ran on. `kill -CONT` of a job
  succeeds and does nothing, `jobs -s` lists nothing, and `bg` of a job
  says "bg: job N already in background", as bash does of a running one.
- Fixed: two sessions served by one isolate decode their background
  processes' terminal output each on its own. Their processes are numbered
  alike, and one isolate-wide decoder per process number let a character
  one session's process split across two writes take in the other's text
  (a replacement character on its terminal); one session's process ending
  dropped the other's pending bytes. A process that is killed leaves no
  decoder behind.
- Fixed: the agent's conversation is one record that turns change, not a
  copy each turn writes back whole. A second message sent while a turn was
  still answering was overwritten by that turn's next save, and clearing
  the conversation during a turn was undone by it.
- Breaking: `/usr` is laid out as on Linux. `/usr`, `/usr/bin`, `/usr/lib`
  and `/usr/share`, and the global module folders `/usr/lib/node_modules`
  and `/usr/share/pkg/node_modules`, are root's 0755, so writing into them
  needs `sudo`; `/usr/local` stays the session user's, and `npm i -g`
  installs there without it. `/etc/profile`, `/etc/hostname` and
  `/etc/os-release` are root's 0644; put your own settings in
  `~/.profile`. A session an earlier release made is moved over once, as
  it opens: those directories become root's, without what was put in
  them, and files keep what they hold.
- Breaking: `nimbus install` puts a runtime where apt would: its tree in
  `/usr/lib/nimbus/<name>/<version>`, owned by root, and a launcher in
  `/usr/bin` (a link into the tree) for each command the tree has a
  `bin/` entry for (`python3`, `ruby`, `clang`, …), so `/usr/bin/python3`
  and `#!/usr/bin/python3` run it as `python3` does in Nimbus's shell.
  Front-ends with no entry of their own (`pip`, `gem`, `bundle`) run by
  name only, and a launcher is not a program GNU Bash (`bash -c`) can run.
  A runtime's name and version must each be one path name, and a
  configured `env.HOME` may not be inside `/usr/lib/nimbus` or `/.nimbus`,
  the system's own stores, nor be made through a link (a home already
  there is left as it is). A
  configured `env.HOME` no longer chooses where runtimes go. The `root` a
  runtime list or install reports, and the paths `nimbus install` prints,
  are the new ones. Runtimes an earlier release installed below
  `~/.nimbus/runtimes` are moved into place once, and a link is left
  there. For embedders: `seedRuntimePackage`, `installRoot`,
  `listInstalledManifests(View)`, `listInstalledRuntimes` and
  `rehydrateInstalledRuntimesView` no longer take a home, and
  `RuntimeManager` no longer takes `getHome`. `which clang` (and `cc`,
  `clang++`, `wasm-ld`, `lld`) says `/usr/bin`, where its launcher is.
- Fixed (security): the kernel kept the images resident processes boot
  from, its copies of inline wasm and of staged native bindings below
  `/var/lib/nimbus`, and `/var` is the session user's. A user who moved
  `/var/lib` aside and put a link where a store was had the kernel write
  those files into any directory, and the image sweep remove, as root,
  every file there it did not recognise. The stores are now below
  `/.nimbus`, in root's `/`, where no user can make, move or remove a
  name; the kernel checks that `/.nimbus` is its own directory, which no
  one else may write, before each use. `/var` is now the user's alone: a
  process may hold a delegation of it. The old stores are left below
  `/var/lib/nimbus`, since a durable worker an earlier release made may
  still boot from them; once none does, `sudo rm -r /var/lib/nimbus`
  frees their space.
- Fixed (security): `writeProtectedRootFile` followed links the session's
  user had made. A link at the file's name had the kernel overwrite the
  file it led to and make it root's, read-only; a link at the declared
  root or above it had the kernel make the directory it led to sticky and
  world-writable. A link at the file's name is now replaced by the file,
  and a root reached through a link is refused.
- Fixed: `npm install` cleared what an earlier install cut short left in
  `/tmp` as root, whatever was inside: a directory the session's user
  moved to a staging name had root's files in it removed too. Each
  staging directory is now cleared as the user who owns it, so another
  user's stale one still goes, and what that user could not remove stays.

- Fixed: a Ruby program and a threaded WASI program end as other WASI
  programs do: what they wrote is in the workspace before their result
  returns, and a run whose session restarted under it, or whose writes the
  session refused, fails and says why. Before, such a run could report
  success, and a file it wrote could be missing when the command returned.
- Fixed: a Node process holds only the output it has not delivered yet. A
  server that logged with no HTTP traffic, or a long one-shot run, kept a
  record of every write it made until its next request or its end.
- Fixed: a durable `spawnWorker` launch with an inline wasm module
  (`modules: { 'x.wasm': { wasm } }`) boots again after the session
  restarts. Its stored image wrote the module's bytes as `{}`, so the
  restarted program could not compile it. An image stored before this fix
  has lost those bytes: unless the launch's `vfsWasmModules` or
  `vfsTextModules` supplies the same module, its restart fails, naming the
  image, and the application has to be spawned again.
- Fixed: `opencode` reads the files of its working tree and installed
  packages as they are. Its snapshot was prepared as a Node program's
  module map: an installed module came back as Nimbus's rendering of it,
  and every module and TypeScript file went through the compiler for code
  opencode never runs.
- Fixed: a terminal that reconnects is shown its session's history without
  storing it again. Each reconnect wrote the replayed history back into the
  scrollback, so the next reconnect showed it twice, then four times, until
  the size cap evicted real history to keep the copies.
- Fixed: a session has one build. An SDK call, a shell connection and the
  frame of a socket that woke a hibernated session, arriving while the
  session was being built, each started a build of their own, replacing the
  first's terminal, workspace and shell process under it; and an SDK call
  could proceed before the session's own commands were registered. They
  now wait for the one build, and a socket among them is attached to it.
- Fixed: a Node program whose only remaining work was a `zlib` or `crypto`
  call with a callback (`zlib.deflate`, `crypto.pbkdf2`, `scrypt`,
  `randomBytes`, ...) could end with exit 0 and none of the output its
  callback writes: the runtime counted fetches, timers and its own calls as
  live work, not the engine's. Such a call is live until its callback, as
  Node's active requests keep its event loop. Small calls finished in time
  unless the machine was busy.
- Security: a D1 binding under `wrangler dev` is a database of its own (a
  Durable Object facet of the session, its own SQLite), as on Cloudflare.
  It ran its statements in the session's own database, and a table name it
  had not created passed through unchanged, so a migration in the project's
  `migrations_dir` could read or change the session's internal tables (its
  filesystem, its storage ledger, its scrollback). A statement naming one
  now finds no such table. Embedders re-export the new `NimbusD1Database`
  class from their Worker's main module, as they do the other Nimbus
  classes (`export * from '@nimbus-sh/sdk/entrypoints'` does); without it a
  D1 binding is not made. A project's local D1 data starts empty in the new
  database: its migrations apply again on the next `wrangler dev`.
- Fixed: a D1 migration under `wrangler dev` applies whole or not at all,
  as `wrangler d1 migrations apply` does. A failing statement left the rest
  of its migration applied and the migration recorded as applied; now it is
  rolled back, not recorded, logged, and ends the run, and the next
  `wrangler dev` tries it again. The ledger is wrangler's `d1_migrations`.
## 2026-10-14: platform 0.10.0, core 0.21.0, fabric 0.16.0, worker 0.19.0, sdk 0.15.0, loom 0.3.1, react 0.3.3, cli 0.2.7, create-nimbus-app 0.2.4 (config 0.3.1 unchanged)
The 2026-10-13 versions, and core 0.20.0, fabric 0.15.0 and worker 0.18.0 of this date, reached production but were never published to npm; these carry their changes too.
- Fixed: a Node program's `http.get` or `http.request` to a server of the
  same program waits for the server's `res.end()`, as Node does. It
  answered at once, so a handler that ended from a timer or after an
  `await` sent the client a 200 with an empty body. The client now also
  sees the status's reason (`Not Found`, not always `OK`), and the server
  sees the request's header names lower-cased. Such a request is served as
  `curl`'s is, and `req.abort()` ends its wait.
- Fixed: the library's built-in `node` gives a program the engine's own
  `assert` (and `assert/strict`), `querystring`, `timers` (and
  `timers/promises`), `perf_hooks` and `v8`, and the context-free builtins
  it did not have: `async_hooks`, `diagnostics_channel`, `punycode`, `sys`,
  `util/types`, `path/posix` and `path/win32`. `require('console')` is the
  program's console, and `module.Module`'s builtin list is the module's. lifo's `assert` compared
  values as JSON (two different Maps were equal) and threw plain Errors;
  its `querystring` kept one of repeated keys and stringified arrays with
  commas; its `v8.serialize` returned no bytes. `v8`'s functions that would
  reach the host's files or the engine's flags (`writeHeapSnapshot`,
  `setFlagsFromString`, coverage) refuse as unavailable, as do `vm`,
  `domain`, `trace_events` and `wasi` whole: they would import past the
  program's modules, set the engine's own process, or reach the host's files.
- Fixed: `env` runs its command, as GNU env does. `env NODE_ENV=production
  node build.js` printed the environment and ran nothing. It reads its
  options as GNU's getopt does (`-i`, `-u NAME`, `-0`, clusters such as
  `-iu NAME`, and the first operand ends them), then `NAME=VALUE`
  assignments, and ends with the command's status, 127 for a command it
  cannot find, 126 for one it may not run, or 125 for a bad option or a
  name `-u` cannot unset. Any operand with an `=` is an assignment, and any
  name a name (`__proto__` too).
- Fixed: `xargs` takes each of GNU's spellings of its replace string:
  `-I{}` joined, `-i[R]` and `--replace[=R]`, which ran a command named
  after the option. With one, each input line is an item, its leading
  white space dropped, so `printf 'a b\n' | xargs -I{} echo [{}]` prints
  `[a b]`. A replace string and `-n` exclude each other as in GNU, the
  later one winning with GNU's warning.
- Changed: `xargs` reads its input as GNU xargs does, in every mode but
  `-0`: quotes and backslashes are decoded (`"a b"` is one item, `a\ b`
  too), and a quote left open ends xargs with status 1 and GNU's "unmatched
  quote" message, after the items read before it have run. Before, quotes
  and backslashes reached the command as they were.
- Fixed: a shell blocked in `wait` (or `fg`) on a background job counts as
  waiting on that job, so the Dynamic Worker ledger can refuse a launch in a
  family stuck behind it instead of hanging. While the shell has another
  job running that could free it (a job that kills the awaited one), the
  ledger refuses nothing.
- Fixed: Astro projects run again. `@astrojs/compiler-binding` 0.5.2,
  published 2026-10-14, is what `npm create astro` now installs, and Nimbus
  had a build only of 0.5.1, so `astro dev` and `astro build` failed with
  "Cannot find native binding". Nimbus now stages a build of 0.5.2 as well
  as 0.5.1.
- Fixed: the library's built-in `node` gives a program the engine's own
  `path` and `url`, against the program's working directory: `path.resolve`
  and `path.relative` start from it, as does `url.pathToFileURL` of a
  relative path. lifo's `path` resolved from `/`, dropped a trailing
  separator (`path.normalize('/a/b/')`), and had no `toNamespacedPath` or
  `matchesGlob`; its `url` had no `domainToASCII` or `urlToHttpOptions`, and
  `url.parse` lost an explicit port.
- Fixed: the library's built-in `node` gives a program the engine's own
  `stream` (with `stream/promises`, `stream/consumers` and `stream/web`),
  and `fs.createReadStream` and `fs.createWriteStream` are the engine's
  `ReadStream` and `WriteStream` over the program's files. lifo's streams
  pushed a whole file as one string (no Buffers, no `start`/`end` ranges in
  pieces, no `setEncoding`), had no `pipeline`, `Readable.from`,
  `Transform` or async iteration, and ended the program's stdout on a pipe
  into it. `process.stdout` and `process.stderr` are Writables, and `fs.read`
  and the new `fs.write` call back with what Node's do.
- Fixed: the library's built-in `node` gives a program the engine's own
  `events`, and every emitter it hands one (a stream, a watcher, a request,
  a readline interface, `process` itself) is the engine's `EventEmitter`.
  lifo's had no `once()`, `on()`, `errorMonitor`, `captureRejections`,
  `rawListeners` or `prependOnceListener`, silently dropped an `'error'`
  nothing listened for (Node throws it), and `process` was no emitter.
  `require('stream')` is an emitter class of its own rather than
  `EventEmitter` itself with streams attached to it.
- Fixed: the library's built-in `node` gives a program the engine's own
  `crypto`, `util`, `string_decoder` and `buffer`, and its console formats
  with the engine's `util`, so a program writes what `node` writes. Its
  handwritten modules refused every hash but sha1 and sha256 (md5, sha512,
  HMAC, pbkdf2), printed a Map or Set as `{}` and a class instance without
  its name, decoded a hex or base64 `StringDecoder` as UTF-8, and encoded
  `Buffer.from(s, 'latin1')` as UTF-8. Its `fs.watch` refuses an encoding
  Node does not know when called, and keeps a copy of its options, as
  Node's does. A warning, the program's own `process.emitWarning` or a
  builtin's (`util.deprecate`), reaches the program's `'warning'` listeners
  and is written on its stderr as Node writes it; it was written as
  `Warning: <message>` and told no listener. A program has one `process`,
  as in Node: each of its modules had one of its own, none of them
  `globalThis.process` or `require('process')`.
- Fixed: in the installed GNU bash, an ERR or RETURN trap no longer breaks
  what the shell parses after it. After the first such trap ran, every later
  `eval`, command substitution and trap failed with "conditional binary
  operator expected": `trap ':' ERR; false; eval 'echo x'` printed nothing,
  an ERR trap ran only the first time a command failed, and under `set -E`
  it ran in the function but not again at its caller. The bash module's
  signal sets were one byte wide, and adding SIGCHLD to one wrote past it
  on the stack. This needs the bash runtime 5.2.37-6.
- Fixed: `test` and `[` run as programs (`xargs test`, `find -exec test`)
  evaluate as the shell's builtin does. `test 1 -eq 2` run so returned 0,
  and `[ 1 -eq 1` ran without its closing `]`.
- Fixed: `xargs` runs each command as a child process with stdin from
  `/dev/null`, as GNU xargs does. `printf x | xargs -I {} cat /dev/zero |
  head -c1` failed, and one command's `umask` reached the next. It ends
  with GNU's statuses: 127 for a command that cannot be found, 126 for a
  file it may not execute, 125 at once for one a signal ends (a `kill` of
  it from another shell included), 124 at once for one that exits 255, and
  123 when any other command fails. It returned the last failing status.
  `sudo` of a file it may not execute answers "command not found", as
  sudo does.
- Fixed: `command NAME` runs a builtin as bash does, skipping only
  functions and aliases (a function named `command` is still that
  function). `command kill %1` answered "no such job", and `command cd`,
  `command wait` and the like ran no builtin.
- Changed: a background job is a process of the session's process table, a
  child of the shell that started it, as a fork makes one. `$!`, `jobs -l`
  and `jobs -p` give that pid, the session's `ps` lists it, and a session's
  destroy stops it. Its commands run as that process, so a `umask` in the
  job stays the job's, as in bash.
- Changed: `$$` in the session's terminal shell and in a script's shell
  (`sh x.sh`) is that shell's pid in the session's table, as in bash; it
  was 1. `kill` of the terminal shell's pid answers "Operation not
  permitted".
- Changed: `kill` run as a program (`xargs kill`, `sudo kill`) has no jobs,
  as procps kill has none: `%2` answers "no such job". The shell's own
  `kill %2` still ends job 2, and `kill PID` from any shell ends a job by
  its pid. A signal to a process of another uid answers "Operation not
  permitted" unless the caller is root, as kill(2) does (`kill -0` too), and a
  default-ignored signal (`WINCH`, `CHLD`, `URG`) to a job leaves it
  running and succeeds.
- Changed: `wait PID` for a process that is no job of this shell answers
  "pid PID is not a child of this shell" with status 127, as bash does. It
  waited for another shell's job.
- Breaking (embedders): the lifo `ProcessRegistry` and
  `Kernel.processRegistry` are gone. A `Shell` takes the session's process
  table (`SessionProcessSupervisor`), `ShellCommandIdentity` drops
  `accountWork` and `holdWork` (the shell counts and holds its work in that
  table), and `createKillCommand(host)`, `createPsCommand(processes)` and
  `createTopCommand(processes)` read it.
- Fixed (Node `fs`): a write keeps the bytes it was given. `writeFileSync`,
  `appendFileSync`, `fs.promises.writeFile` and a descriptor's `write` used
  the program's own buffer as the file's bytes, so changing or reusing the
  buffer afterwards changed what `readFileSync` read and what the session
  stored, and growing such a file through a descriptor could write past the
  end of the buffer it came from, into memory the program used for other
  data. Each write now takes a copy, as Node does.
- Fixed: in an isolate that runs several Node programs one after another
  (a warm facet's one-shots and children), each program's setup wrapped
  `Buffer`, `crypto`, `zlib`, `events` and `URL` again around the last
  program's wrappers. Every call into them grew one layer deeper per
  program run, `new URL()` accepted a string that is not a URL, and a
  program that replaced `zlib.crc32` broke the file writes of the programs
  after it. Each builtin is now wrapped once, around the platform's own,
  and the runtime's checksums use the platform's builtins.
- Changed: a Node program's file writes cost less CPU in a warm isolate:
  about 6 ms less for a run that writes one file, and about 0.1 ms less for
  each further file.
- Fixed: a copy makes its files as any creation there makes them. A
  program's `copyFile` (or the editor's and SDK's copy) between a mount and
  the session's own files keeps the source's mode less the umask, as `cp`
  does; it wrote 0644 for a 0755 script or a 0600 key. Off a mount that
  answers asynchronously, `copyFile` of a symlink copies the file it names
  rather than the link, and a tree copied off one answers how many entries
  it made (it answered 0). `cp -r` and a recursive copy into a setgid
  directory take its group, and their directories are setgid; under a
  directory with a default ACL the ACL replaces the umask and each new
  directory inherits it, as `mkdir` and `writeFile` there do (the copy took
  the copier's group, the umask, and the source's default ACL).
- Fixed (security): guests could call methods of the platform's RPC classes
  that were meant only for the platform's own use. Workers RPC exposes every
  string-named method of a WorkerEntrypoint, RpcTarget or Durable Object to
  whoever holds its stub, whatever TypeScript's `private` says.
  - The real-Vite resident's `CIRRUS_HMR` binding answered the session's
    Durable Object stub and its raw dispatch. Through that dispatch, the
    project's Vite config or plugins could act as any process, or as the
    kernel.
  - Every process's `SUPERVISOR` answered its generic dispatch helpers.
    These sent any operation the session serves, past the methods that stamp
    their arguments: a process could spawn a child as another process's,
    inheriting that process's stdin. They also answered the process's network
    without the recording that replay depends on.
  - The Worker Loader shim's entrypoint answered the props it was minted with
    (its egress among them) and the raw loaded entrypoint.
  - A scoped `HostedSession` answered the unscoped runtime it serves.
  These helpers are no longer on any class's RPC surface, and the KV, R2
  and D1 emulators that wrangler dev hands its Worker keep theirs out of
  reach too. The session also takes a spawned child's parent from the pid
  its binding stamped, never from the request.
- Fixed (security): a process could act on another process through the
  child_process operations, which acted on whatever pid they were given. It
  could read another process's stdin, write to it or end it, read or close
  its output, wait on it, or kill it. Each operation is now refused unless
  the process owns the target:
  - a child's handle belongs to its parent or an ancestor; any other
    process gets ESRCH;
  - a process reads only its own stdin, whatever channel it names: the
    stdin it inherited as fd 0 when it did, never another process's;
  - a signal follows Linux's rule for kill(2): only root, or a process of
    the target's uid, may send it; any other process gets EPERM.
- Fixed: `nimbus wrangler dev`'s assets binding read a project's assets as
  the session's user. It now reads them as the process that started the
  server, as it reads the project's config, bundle and stores.
- Fixed: in the installed GNU bash, an `exit` or `return` inside `eval`, a
  sourced file, a function or an EXIT trap now ends with the status bash
  chose. Before, a jump through one of bash's saved copies of its jump
  buffers could land in another capture: `eval 'exit 7'` exited 0, an EXIT
  trap's exit was lost, and code after a `return` ran. This needs the bash
  runtime 5.2.37-5 (runner `bash-runner@5`); a session with 5.2.37-3 is told
  to install it. The bash module is now built by a reproducible recipe
  (`scripts/ci/remote-bash-build.mjs`) and carries its provenance.
- Fixed (Node `fs`): `fs.promises.realpath` and callback `fs.realpath`
  resolve symlinks and refuse a missing path with `ENOENT`, giving
  `realpathSync`'s answer; they returned the path as written. A link the
  program makes is seen at once by both, and by `stat`, `lstat`, `readdir`
  and writes through it, as are its rename and removal; before, the sync
  calls saw it only after the session reported it. A link another program
  makes is seen, as other changes it makes are, once the session reports it
  to this one. `readdirSync` of a directory the program made lists a file it
  wrote there from then on; after an `await` it could omit it until the
  session reported the file.
  `fs.promises.watch` yields a file's changes, not one every 500 ms for a
  large unchanged file, and ends when its `signal` aborts (an `AbortError`)
  or the loop stops. It starts watching on its first `next()`, so one that is
  never read keeps nothing running, and once ended it yields nothing more.
  A program's own `chmod` and `utimes` no longer outlive
  the file: `stat` shows another user's later change, and a file removed and
  made again has a new file's mode and times. `stat` answers the file's real
  device and link count (`dev`, `nlink`) instead of one made-up device.
- Fixed: in a WASI program (an uploaded program, CPython), a filesystem call
  the session took more than 10 s to answer failed with EAGAIN, which no
  filesystem call returns on Linux: `os.makedirs` raised `BlockingIOError`
  when the process's first change waited on the session. It now waits for
  the answer. Only a socket's or a poll's wait still ends with EAGAIN at the
  10 s park deadline.
- Fixed: in a WASI program (bash and its commands, CPython, any compiled
  program), `/dev/fd/N`, `/proc/self/fd/N`, `/dev/stdin`, `/dev/stdout` and
  `/dev/stderr` now name the process's own descriptor, as on Linux. A pipe or
  a stream is shared. A file is opened again with the new open's flags, so it
  gets its own offset, and `>/dev/stdout` truncates a file that stdout writes
  to. It is the file itself, even one renamed or unlinked since, never
  whatever file now has its old name, opened as it is now: its current
  content, under its current permissions. A small file opened read-only
  that another program (not the shell, or not the uploaded program itself)
  renamed or removed since cannot be opened again this way yet (ENOENT).
  `stat` of the path is that descriptor's stat. Process substitution works:
  `source <(...)`, `done < <(...)`, `diff <(...) <(...)`. Before, `/dev/fd/N`
  was not found, `/dev/stdin` read as empty, and writes to `/dev/stdout` and
  `/dev/stderr` were silently discarded.
- A WASI program's open of a file makes one round trip to the session, not
  two: the open answers the file's stat.
- Fixed: in the wasm bash, `exec 3<file; read a <&3; read b <&3` read the
  first line twice for a small file, and a subshell's read did not move its
  parent's offset. A duplicate (`<&3`, `dup2`) and a child now share their
  descriptor's offset, as on Linux.
- Fixed: a bash run whose non-local jump lost its target (an `exit` or
  `return` inside `eval`, a sourced file, or an EXIT trap) now fails with
  "bash-runner: pid N returned from _start mid-rewind, its longjmp or resume
  target lost". It used to report exit status 0. The jump itself is fixed
  with the next bash runtime build (bash-runner@5).
- Fixed: on Cloudflare, piping into the installed GNU bash (`printf x | bash
  -c 'read -r y'`) failed with "The RPC receiver does not implement the
  method "call"". bash now reads its piped stdin.
- Fixed: CPython, Ruby and clang read their piped stdin (`printf x | python3
  -c 'import sys; print(sys.stdin.read())'`). The WASI layer now reads every
  runtime's fd 0 from its process's input channel; before, only the generic
  wasm runner wired it, and the others read an empty stdin.
- Fixed: a Node program's launch holds its share of the session's memory
  budget while it packs the files it staged, and until its module map is
  made, not only while it gathers them, so several launches at once queue
  instead of building side by side past the budget. Launches of the same
  program at once build it once. A launch killed, or whose session is
  destroyed, while it waits for room is never admitted. A launch takes its
  memory, or waits for another launch's build of its program, before it
  takes a Dynamic Worker, never after, so launches waiting on each other
  across the two can no longer hang (the order is in the runtime spec's
  Facet Resource Contract).
- Added: real git 2.53, built for WASI, in the default runtime catalog.
  `git` runs it for every command, option or repository format the
  built-in git does not fully implement (for example `log --graph`,
  `commit` with paths, `branch -d`'s merged check, `push -u`, `rebase`,
  `stash`, a SHA-256 repository); `status`, `add`, `diff`, a plain `commit`
  and `checkout` stay on the built-in git. A command whose hooks the
  repository makes executable, or whose message comes from an editor, runs
  on real git, since the built-in runs neither; `status` and `diff` stay
  built-in and do not write back their index refresh where a
  `post-index-change` hook is executable. Remote helpers (`git-remote-http`
  and `git-remote-https`), hooks and aliases work through the session's one
  child-process broker. On a host whose engine cannot suspend WebAssembly
  (Node 22), a git child process is refused by name instead.
- Fixed: a program's end no longer waits on the session to answer the
  release of its read lease and of the subtrees it held; only its last
  writes are waited for.
- Fixed: a `node:sqlite` database keeps what a connection wrote when it is
  closed. A connection opened after another's `close()` in the same run sees
  it (it read the run's starting copy), a write made through `all()` or
  `get()`, such as `INSERT ... RETURNING`, or one SQLite does not count, such
  as `ANALYZE`'s statistics, is kept (only `run()` and `exec()` were), and a
  relative name is the file it named when the connection opened. The model
  is the whole database image: close writes the connection's image back to
  its file, through the program's `fs`, unless it is the image that was read,
  so a database only read is not written; a program killed before `close()`
  loses that connection's changes, and two connections or processes writing
  one file each write their own image, the last close winning. A write the
  program may not make fails `close()` as `fs.writeFileSync` would; one the
  session refuses later is reported as any refused write is. node:sqlite is
  powered by `fs`, so a close that writes costs what writing that file
  through `fs` costs: about 0.85 ms CPU per database a close writes, and a
  SQLite-only program's first write in a fresh isolate about 6 ms more, the
  fs write path's one-time compile. Writes are no longer lost. A Node `fs`
  write over an existing file no longer reads the file it replaces (about
  0.4 ms less per MiB).
- Fixed (security): helpers a command starts acted as the kernel, not as
  the command's process. `nimbus wrangler dev` read its config and D1
  migrations, kept its KV and R2 stores, and bundled its Worker as
  `CRED_KERNEL`, so a project symlink made it read a file its user could
  not; a resident process's boot read the `.wasm` files it named as the
  kernel; `npm install -g` wrote its bin shims as the kernel; and global
  npm and gem commands, and a command lookup with no caller, were
  discovered by reading as the kernel. Each now acts as the process that
  ran it (the session's user for discovery), and is refused what that
  process is refused. Shims and stores an earlier release left as root are
  handed to the owner of the directory holding them, the first time they
  are written. The shared build service's default view is the session's
  user's.
- Changed: `npm install -g` makes a missing prefix (`<prefix>/lib`,
  `<prefix>/bin`) as the process that runs it, where it always used the
  session's user: `sudo npm install -g --prefix <new dir>` now makes it
  root's, as on Linux.
- Fixed: `nimbus wrangler dev` could serve an old build after a rebuild
  or a restart. A rebuild still bundling when `wrangler dev` was run again
  (or when a later rebuild overtook it) went on: it printed "Worker built"
  while the new server was still building, so opening the Worker then
  showed the waiting page, and it ended the new server's Durable Objects
  and put its own old classes in their place. A superseded build now says
  and changes nothing, "Worker built" is printed once the build serves,
  and `wrangler dev` stops the server before it even while that one is
  still starting.
- Fixed (security): the session's owner surfaces acted as the kernel. The
  browser editor's saves, reads and listings, the agent's `read_file`,
  `write_file` and `list_files`, and `POST /api/write-file` and
  `/api/mkdir` read and wrote as `CRED_KERNEL`. So they could replace a
  kernel-owned file the session's user cannot change, such as one an
  embedder provisioned in a sticky directory, and read another user's
  private files. They now act as the session's user, and are refused what
  that user's own shell is refused. These rules, like protected files,
  guard against accidents and against the session's own tools: the
  session's user has passwordless root through `sudo`, so they do not stand
  against a program in the session that uses it (documented in the SDK
  guide, "Users and Permissions").
- Breaking: `files.delete` with no credential now acts as the session's
  user, like every other file method, instead of the kernel. An embedder
  that deletes past the user's permissions asks for it by name:
  `sandbox.files.as(CRED_KERNEL).delete(path)`. `CRED_KERNEL`,
  `CRED_SESSION_USER` and the `VfsCred` type are exported from
  `@nimbus-sh/sdk`. Over the remote endpoint a deletion already acted as
  the session's user.
- Security: a sticky directory (mode 1777, such as `/tmp`) protects its
  entries from every removal. Removing an ancestor (`rm -r`,
  `fs.rmSync(..., { recursive: true })`) or deleting through a batch could
  remove another user's file in a sticky directory below it; only the top
  operand was checked. Changed: `rm -r` of a tree in the session's own store
  now does what it does on a mounted directory and on Linux: an entry it may
  not remove stays, with the directories holding it, and everything else
  goes; it refused the whole tree before removing anything.
- Fixed: `nimbus wrangler dev`'s Worker Loader binding (`worker_loaders`)
  cached a Worker loaded with `LOADER.get(id, …)` under its id alone, for
  the whole isolate: two Workers in co-located sessions that used the same
  id shared one, and the second ran the first's code. A keyed Worker is now
  its loader's own: each build's binding has its own, so a rebuild loads
  its keyed Workers afresh.
- Fixed: a module a Node program writes and then imports links as Node's
  does before any of its graph runs. An import of a name its module does
  not export is Node's SyntaxError, with no module body run first; before,
  a sibling's body ran, or the name was just undefined.
- Fixed: such a module imports a CommonJS module as Node does: `default` is
  `module.exports` even when it sets `__esModule`, its other names are the
  ones Node's lexer finds, and their values are taken once the module has
  run. `export *` of two different bindings of one name exports neither,
  and importing that name is Node's SyntaxError.
- Fixed: import attributes are checked as Node checks them on every
  import: JSON needs `with { type: 'json' }`, JavaScript and builtins refuse
  it, and an unknown type is refused. A static import's unknown attribute
  key is ignored, as Node ignores it; it was refused.

## 2026-10-13: platform 0.9.0, core 0.19.0, fabric 0.14.0, worker 0.17.0, config 0.3.1, loom 0.3.0, sdk 0.14.0, react 0.3.2, cli 0.2.6, create-nimbus-app 0.2.3

- Fixed: in a WASI program (an uploaded program, CPython), a socket read that
  followed a poll which gave up on the socket could lose a chunk that arrived
  just before the socket closed. A read or an accept that the 10 s park
  deadline answered with EAGAIN wrote into the guest's buffer, or adopted a
  connection, when its input arrived later; the input now waits for the next
  call. A threaded program reading a pipe its other thread writes no longer
  waits 8 s for EINTR. An open after `fd_renumber` or `dup2` no longer
  replaces the descriptor moved there.
- Fixed: walked recursive removal attempts unreadable entries, continues past
  failures, and reports each entry that remains. The shell reports vanished
  children unless `rm -f` was requested.
- Changed: `rm -r` enters mounted subtrees and removes their writable contents,
  as Linux does. It keeps busy mount points and their ancestors.
- Fixed: credentialed SQLite paths follow links before `..`, matching the
  namespace while keeping plain lookups on their indexed fast path.
- Changed: real Vite (`NIMBUS_REAL_VITE=1 vite`) runs as one of the session's
  resident processes, with the lifecycle every resident has. `vite` returns
  once Vite listens, and a Vite that fails to boot fails the command instead
  of its first page. Time moves with it: `vite` takes about 0.4 s longer,
  the first page about 1 s less (start to first page about 0.4 s less), and
  the page's first modules about 70-80 ms more each, the entry's transform no
  longer hidden behind the boot's wait. Fixed: a server whose isolate the platform resets ends
  with 137 and frees its port; before, its pid stayed running. A second
  `vite` ends the server it replaces; before, that pid stayed running. A
  server that ended (`kill`, `vite stop`, a lost isolate) stays ended;
  before, the next request to the preview or its port started it again. A
  session that sleeps and wakes still restores the server it was running. `spawnWorker` takes
  `identity` (the argv, credential and exec id of a process no invoker
  names) and `bindings` (beside the process's own SUPERVISOR). Removed: the
  stateless fallback for hosts without Durable Object facets, where no
  resident process can run, and `/api/_diag/cirrus`.
- Fixed (security): JS git refuses a tree entry whose path native git
  refuses: a `.git` component in any case, `.` or `..`, and the names
  NTFS (and, with `core.protectHFS`, HFS+) read as `.git`. `checkout` and
  `reset --hard` write nothing and say git's `invalid path` error, `reset`
  leaves the index, and a clone keeps its repository with nothing checked
  out. A clone honours `core.protectHFS` and `core.protectNTFS` from `-c`
  and the user's `~/.gitconfig`, as git's does. Before, a fetched commit
  could write `.git/config` or a file above the worktree.
- Fixed (security): a malformed tree object is git's error
  (`too-short tree object`, `malformed mode in tree entry`, `empty
  filename in tree entry`). One reader looped forever on such a tree,
  growing until the session ran out of memory.
- Fixed (security): when a git server refuses the request for a pack after
  answering its discovery, clone, fetch, pull, push and a partial clone's
  lazy fetch say `RPC failed` as git does, and never print the server's
  answer. Before, they printed it whole, credentials it echoed included.
- Changed: `npm install`'s background warming of browser bundles and the
  Vite dev server's `/@modules/` bundles are one path. Install now warms a
  package subpath the dev server can resolve (a directory with its own
  `package.json`), skips a package whose entry is a native or WebAssembly
  payload with the same reason the dev server gives, and holds only the
  memory a slice needs while it builds.
- Fixed: a peer-hosted resident whose boot reads stdin (a synchronous read of
  fd 0) was replayed against reads it never made: the hosting peer's own
  reads of the process's boot images counted as the process's, and its
  second boot stopped with `reached fd 0 before the recorded answer to stat
  was delivered`. The peer reads the images through a binding no run acts
  through, under the process's pid; the session serves such a read apart
  from the run's own receipts.
- Fixed: Node programs report Node's navigator identity and ICU locale, so
  packages such as pg choose their Node transport. Worker identity and
  hardware concurrency stay unchanged.
- Added: `NimbusWorkspace.shellState(name)` reads the named shell's saved cwd
  and exact environment, without its call pid. Reads share the shell's queue
  and distinguish lone UTF-16 surrogates and variables named `__proto__`,
  `constructor` or `toString`. Listings and UTF-8 pipes are unchanged.
- Fixed: fabric connections preserve the host's socket type in lookups and
  listings, so callers can use methods such as `send` without type assertions.
- Fixed: Cloudflare account lookup validates only the successful account
  result and reports malformed responses with their HTTP status and cause.
  Account names are trimmed; blank names use the account id.
- Fixed (security): `undici.request()` no longer forwards explicit Authorization,
  Cookie or Proxy-Authorization headers across an origin-changing redirect.
  Redirects now match Node 22's bundled undici: Host is regenerated on every
  hop, 303 drops the body and content headers (keeping HEAD), 301/302 and
  307/308 retain the method and body, and redirect limits honor
  `throwOnMaxRedirect`. Along a redirect, a Node stream body stops at the
  first redirect; an async or sync iterable, an array or a Web ReadableStream
  is iterated again for the next hop that keeps the body, so a spent one fails
  its Content-Length (`UND_ERR_REQ_CONTENT_LENGTH_MISMATCH`), and no redirect
  after that hop is followed until a 303 drops the body. A string, bytes, a
  Blob, FormData and URLSearchParams are the same on every hop (for FormData
  and URLSearchParams, undici's own handler differs). A Web ReadableStream is
  streamed on the first request, as before. Sync iterables and arrays are now
  accepted as request bodies.
- Fixed: peer placement put a process in the isolate another process of the
  same coordinator already ran in, and two processes placed at once in the
  same one: the isolates in use were checked but never recorded. Each
  placement now reserves its isolate when it accepts it, and frees it when
  the process is released, fails to open, or its host closes.

- Breaking: a Worker that composes the fabric needs the `enable_request_signal`
  compatibility flag, which no compatibility date enables. Add
  `"enable_request_signal"` to `compatibility_flags` in your wrangler config;
  `buildNimbusWranglerConfig` lists it. Without it `composeFabric` refuses the
  Worker at startup, naming the flag. A client that leaves a response a
  process is serving is seen only through that flag.
- Breaking: `RouteableFacetTarget.handleHttpRequest(request, scope)` and
  `HostedProcess.handleHttpRequest(request, scope)` take a `ResponseScope`
  (`signal`, `settled`): the process owns work for the response until the
  caller is done with its body or its client leaves. `relayRpcBody` and
  `responseScope` (`@nimbus-sh/core/runtime/port-registry.js`) relay a body
  with that scope.
- Fixed: a client that leaves a response a resident Node server is still
  writing reaches that server as it does in Node: the response closes
  unfinished and later writes are refused, on facet and peer hosts alike. The
  process's work, and the session, are no longer held until it writes again.
- Changed: a resident process's HTTP requests reach it through its fetch
  entrypoint, as its WebSocket upgrades already did, instead of an RPC call;
  routed requests cost less than before. Its request signal is that call's
  own: the process is loaded with `enable_request_signal` and
  `request_signal_passthrough`, unless its program turned either off, so a
  request it forwards is cancelled when its client leaves.
- Fixed: a resident's request is admitted by the instance its host opened,
  checked in the request itself; one the platform put in its place refuses it
  before any guest code runs, and the process reports its host lost once. A
  request no longer waits for a separate host validation first.
- Fixed: a quiet client WebSocket routed through a port remains resident
  interest until it closes; unrelated embedder sockets and idle terminals keep
  their bounded traffic rule. Closing a preview begins that bounded idle grace.
- Changed: peer residents retain a passive native coordinator-lifetime socket;
  idle traffic on the hosting peer no longer ends a process while its coordinator
  is alive. Releasing or losing the coordinator ends residency without polling.
- Changed: durable application spawns require facet hosting and fail before
  announcing a pid under peer mode; retained SQLite is not silently relocated.
- Fixed: a resident's host loss is reported on that process and cannot refuse
  unrelated commands or healthy siblings. Resident preparation and streamed
  HTTP responses retain their work ownership through startup or body completion.
- Breaking: the retired peer control operations `awaitHostedOpen` and `hostLost`
  are removed. Staged boot assemblers return the shared `WorkerCode` contract.
- Fixed: peer process hosts use activity-owned, abortable loss observation and
  validate incarnation on use; idle peers no longer hold a permanent hosting
  RPC or fire a five-second hosting-watch alarm. Cold cleanup drops legacy
  throwaway-only hosting records without a physical facet name, logs that the
  peer facet could not be named, and never guesses which facet to delete.
- Fixed (security): the remote sandbox API deleted files as the kernel. A
  `sandbox:use` token's `deleteFile` reached the session without a
  credential, and an absent credential acts as `CRED_KERNEL`, so a remote
  caller could delete files the session's user cannot, such as host-governed
  files in sticky directories. A remote deletion now acts as the session's
  user, as its writes already did; a colocated embedder calling the session
  binding directly keeps the kernel default.
- Added: `createNimbusHandler` names the Worker version that answered on the
  replies a deploy's readiness reads (`POST /new`, the terminal WebSocket
  upgrade, `DELETE /s/<id>/` and the remote API), as `x-nimbus-version`, when
  the Worker binds `version_metadata` as `CF_VERSION_METADATA`. The hosted
  demo binds it on every tier. Staging and production promotion now grade a
  hosted-demo upload only after the edge answered as that version alone; one
  old-version reply during the deploy overlap had made a promotion's `/try`
  check report the session gone.

## 2026-10-12: platform 0.8.2, core 0.18.0, fabric 0.13.0, worker 0.16.0, loom 0.2.5, sdk 0.13.1, react 0.3.1, cli 0.2.5, create-nimbus-app 0.2.2

- Fixed (security): the shell's Ctrl+P palette put file names into the page as
  HTML. A file named like `<img src=x onerror=...>`, for example from a cloned
  repository, ran script in the shell page when the palette opened. Palette
  entries are now plain text, and its error line is escaped.
- Fixed: `utimesSync`, `lutimesSync` and `futimesSync` in a Node program reach
  the session; they changed only what the program itself saw.
- Fixed: a file JS git checks out, and a loose object it writes, is made with
  its final mode (0644 or 0755, 0444); it was made 0666 less the umask and
  changed after, so under a permissive umask others could write it meanwhile.
- Fixed: an npm install no longer fails for up to an hour after a dependency
  publishes a new version. The shared packument cache served any unexpired
  entry as the whole truth, so a range only the new version satisfies failed
  with "no published version satisfies". When a cached packument cannot
  answer a request (a range, an exact version, an alias, a staged binding or
  a swap target), the resolver now asks once more past the cache, then picks
  again; if that read fails, the cached answer stands as before. Fresh reads
  are unchanged. The cache keeps the registry's ETag, so an expired entry
  revalidates with a bodyless 304 instead of a full download. Entries cached
  before this release refetch once when they expire.
- Fixed: a file or directory a Node program creates has the mode it asked
  for, as Node's does. `writeFile` and `appendFile` (sync, callback and
  promise forms), `open` and write streams honour `mode`, less the umask, and
  a file already there keeps its own. `mkdir` shows its `mode` to the
  program's own `stat`. `mkdtemp` makes 0700. `copyFile` and `cp` leave the
  source's mode. Before, such files were made 0666 less the umask, so
  `writeFileSync(p, secret, { mode: 0o600 })` made a file others could read.
  `chmodSync` and `fchmodSync` reach the session when nothing touches the
  path after them; before, such a change was kept only in the process.
  A directory `cp` makes is its owner's alone until it is filled, and a file
  copied over another is closed to others before the bytes go in, so no one
  reads a private copy while it is made or after it fails partway.
- Fixed: `VFS.copy` of a file to a new name (the shell's `cp`) makes it with
  the source's permission bits less the umask, as cp(1) does; it was made
  0666 less the umask, so a copy of a private file was readable by others.
- Added: an egress per process (Kinu ask 45). `NimbusWorkspaceOptions.egressFor`
  and `NimbusSession.egressFor` take `{ pid, execId }` and return the egress
  for that process, or undefined to keep the workspace's. Nimbus asks once
  per process while it lives (`WorkspaceNetwork.forProcess`), and everything
  the process does goes through that one egress: its fetch, sockets and TLS,
  its Dynamic Worker's outbound, a peer hosting it, and the commands it runs
  (curl, wget, dig, ping, npm, pip, gem, lifo, git, wrangler dev and the
  Workers it loads, opencode, the inline node). An embedder that mints it
  with the exec in its props can tell which exec made each request. Each
  workspace selects for its own processes, so two workspaces over one egress
  object never share a selection, and a session destroyed and made again
  selects for its new processes. Without `egressFor`, nothing changes.
- Fixed: under an egress, three kinds of traffic went around it: a one-shot
  opencode run (`opencode run`, `opencode models`), a Worker that a
  `wrangler dev` Worker loads through `worker_loaders`, and `lifo search`.
  Each now goes through the egress of the process that makes it.
- Added: under an egress, a program's `tls.connect({ servername })` with a
  name other than the host reaches the egress as `connectTls`'s optional
  `servername`, which the egress presents and checks the server by, as Node
  does. It used to fail with `ERR_OPTION_NOT_IMPLEMENTED`. A servername that
  is not a string throws `ERR_INVALID_ARG_TYPE`, as in Node. An egress that
  ignores the field connects as before (Kinu ask 44).
- Changed: under an egress, `tls.connect({ socket })` (STARTTLS) fails with
  `ERR_NIMBUS_EGRESS_STARTTLS`: "Nimbus: TLS over a socket the program
  opened (tls.connect({ socket }), as STARTTLS does) is not available when
  the workspace's network goes through an egress: the egress carries that
  connection, and workerd starts no TLS on a connection through a service
  binding". It used to close the program's socket and make TLS on a new
  connection to the same host, which a STARTTLS server answers as plaintext.
  A new connection is not the same connection (Kinu ask 46).
- Breaking: node runs ES modules natively. A program's ES modules (`.mjs`,
  `type: module`, a typeless `.js` with module syntax, `-e`/stdin under
  `--input-type=module`) are staged as the Worker's own modules and
  evaluated by its module registry, no longer lowered to CommonJS. They link
  and evaluate in Node's order, with live bindings and one namespace per
  module, and top-level await suspends only its own graph. A `require()` of
  an ES module returns Node's require(esm) result. It is refused with
  `ERR_REQUIRE_ASYNC_MODULE` before any of the graph runs if the graph
  awaits at its top level, even after an `import()` evaluated it. A module
  that threw throws the same error again on every later `require()` or
  `import()`, without evaluating twice. `import()` and `require()` of a JSON
  file share one object. A query or fragment URL (`./m.mjs?x`) is its own
  instance. An ES import of a CommonJS module that is still executing fails
  with `ERR_REQUIRE_CYCLE_MODULE`. `import()` in code that `Function`,
  `AsyncFunction` or `eval` built resolves against the module that called
  it. A missing export or a module that does not compile is reported with
  Node's message and its arrow at the source position. A module graph
  written while the program runs (late) is resolved and parsed whole before
  any of its bodies runs. A missing file, a syntax error (a top-level
  `return` in a module included), or TypeScript/JSX that cannot be compiled
  until the next launch (`ERR_NIMBUS_CODE_NEXT_LAUNCH`) rejects its
  `import()` with no body run, staged modules' bodies included, as in Node.
  `node app.jsx` and `bun app.jsx` compile JSX entries and modules. Measured
  against the previous main, paired: `pi --help` is 9.8 s faster (about 13.7
  s against 23.9 s); a fresh 120-module ES graph launches 323 ms faster, and
  80 ms faster when warm; the launch's WebAssembly-image scan is 40 ms
  against 89 ms. Small `node -e` launches are unchanged.
- Breaking for embedders (native ES modules):
  `@nimbus-sh/core/runtime/async-module-lowering.js` is removed, and with it
  `lowerEsModule`. New core modules: `runtime/native-esm.js`
  (`readEsModule`), `runtime/cjs-module-exports.js` (Node's CommonJS
  named-export discovery; an unresolvable re-export adds no names),
  `runtime/cjs-module-lexer.js` (cjs-module-lexer 2.2.0, Node 22.22.3's,
  vendored; core and worker now pin `cjs-module-lexer` 2.2.0), and
  `runtime/esm-require-hoist.js`. New worker module: `facets/esm-stage.js`
  (`stageEsModules`). `bundleTypescriptLoader` is renamed
  `bundleCompiledLoader` and also answers `jsx`. fabric's
  `encodeCommonJsPack` is replaced by `encodeCodePack(codeModules,
  esModules)`, whose packs also carry ES modules. The interpreter's
  `moduleRequests` returns `{ requests, unread }` instead of an array
  (`unread`: `'syntax'` or `'unparsed'`), with optional `javaScript` and
  parse-goal arguments. The transform store's key schema moves to
  `nimbus-transform/5`, so earlier records miss once.
- Known gaps in native ES modules: a typeless ES module written at runtime
  and imported under two static query variants shares one instance; a module
  that rebinds its `createRequire` alias with `var` before a top-level
  `require()` can have that require hoisted; in the lifo (Bun) runtime, a
  namespace without a default export gets `__esModule`, and a free
  `require`/`__filename` in an ES module reads `undefined` instead of
  throwing.
- Auth: each session route owns its attach cookie, `__Host-nimbus_token-<sid>`,
  selected by the parsed route on HTTP and WebSocket (host previews included).
  Two iframes on one page no longer overwrite each other's credential. The
  pre-change `__Host-nimbus_token` cookie still authenticates its own pinned
  session and migrates to the route-owned name on next use. Header and query
  credentials are never stored as cookies, and issuance capacity is refused
  before a single-use bootstrap is spent. Re-attaching a held session replaces
  its cookie without growing the jar; destroying a session through its public
  DELETE expires exactly its cookie.
- Breaking: VFS-2b uses one change notification for the namespace:
  `CompositeVFS.watchChanges(path, listener)` tells every change a view may
  see at a path or under it, on any mount, as batches of `VfsEvent`s (paths
  in the namespace), by one rule for
  every watch (`projectChange` in `vfs/events.js`): each end of a change told
  where the view shows that file and may search every directory above it; a
  rename seen at one end only is that end's `add` or `unlink`; the watched
  path renamed away, or a directory above it, is its `unlink`, and a watch
  that follows its target (`watchChanges`' and `RuntimeFsBridge.subscribe`'s
  new `follow` option, which Node's `fs.watch` uses) is told that move, a
  `rename`, and moves with it. It is told to the watches registered when it
  landed, at every mount of the store it landed in (the new optional
  `VFS.fileStore`); a recursive copy or removal tells each entry as it lands;
  `mkdir -p` on a mount that resolves its own paths tells the directories its
  backend says it made (`VFS.mkdir` may now answer them; `MemoryVFS`'s does).
  Whether a directory renamed above a watched path took it along is judged
  by a look when the watch began and the changes told since; a backend that
  holds changes back answers that look as they were told, storing and
  recalling nothing (the new optional `VFS.landedAt`, which `SqliteFiles`
  implements).
  A backend may tell its own (the new optional `VFS.watchChanges`, which
  `SqliteFiles` implements, without storing any held write); any other
  mount's changes are told as they land through the namespace, typed by the
  operation (whether a whole-file or range write made its file is not looked
  up: those are `change`). SQLite now tells every entry a copy made, as it
  tells every entry a removal removed. Nothing reads the engine's bus besides:
  the file tree's `fs-watch`, the in-supervisor Vite dev server, wrangler
  dev, the real Vite facet's chokidar (`ViteDevServer`, `NimbusWrangler` and
  `CirrusReal` take the session's `namespace` where they took `vfs.events` or
  `vfsEvents`) and a process's `RuntimeFsBridge.subscribe` hear the
  namespace, so they see changes on mounts too, and not a write SQLite takes
  under a mount point; a rename's `oldPath` reaches chokidar absolute. The
  shell's built-in `node` has a working `fs.watch` (`NodeFilesystem.watch`
  replaces `onChange`): Node's `rename`/`change` events and filename
  encodings, the watched target resolved through links and followed across
  renames, `ENOENT` for a missing one, `close` (one `close` event) and
  `ref`/`unref` as Node's, a referenced watch keeping the program; it watched
  the root, which never fired. `VfsEventEmitter.on` hears only what is
  published after it registers, listeners let go during a delivery are not
  told, a path listener hears either end of a rename and a rename of a
  directory above it, and a path listener on the root (`''`) hears every path.
- Changed: `npm install` has one engine (WASI-2). The Worker's installer and the
  shell's own npm (a library workspace with no installer of its own) plan
  every install with core `_shared/npm-arborist/`, npm 10's arborist
  build: a conflict goes to the highest ancestor it fits, a package's peers
  are placed with it, an optional peer only constrains, and what a package
  bundles is its own. A package named on the command line is resolved even
  where an installed copy meets it (`pkg@latest`, an alias retargeted).
  Installs are checked against npm 10.9.8 itself, on both hosts. A cycle of
  incompatible ranges, which npm breaks with a link, fails past 16 levels.
- Breaking: options npm has that change the tree, and that are not
  implemented here, are refused with `npm ERR!` instead of ignored:
  `--install-strategy` other than hoisted (and `--global-style`,
  `--legacy-bundling`), workspaces, `--dry-run`, `--package-lock-only`,
  `--no-bin-links`, `--before`, `--cpu`/`--os`/`--libc` and
  `--engine-strict`. So are git, file, directory and URL specs, which no
  host installs. New: `--omit=optional`, `--omit=peer`, `--include`,
  `--strict-peer-deps`, `--prefer-dedupe`, `--no-save`, `--save-exact` and
  `--save-prefix`, as npm reads them.
- Breaking: `npm ci` builds npm's ideal tree over the lock and fails, before
  it removes anything, where that tree is not the lock's: a package the lock
  lacks, or holds at another version. A lock whose root declares other
  dependencies than package.json is no longer refused for that alone; its
  flags are found again and what nothing reaches is left out, as npm does.
  `npm ci` keeps the lock's dev, optional and peer flags, honours `--omit`,
  `--force`, `--legacy-peer-deps` and `--strict-peer-deps`.
- Breaking: a required failure changes nothing, as in npm. An install with
  a required dependency that cannot be resolved, or that is refused for its
  platform (EBADPLATFORM), now installs nothing and exits 1; before, it
  installed everything else. When a required tarball fails partway through
  a Worker install, the install exits 1 and names what it published and
  what failed. It removes nothing, leaves package.json unchanged, and
  records in the lockfile only what is on disk.
- Breaking: a peer dependency that conflicts with one of the project's own
  dependencies is npm's ERESOLVE, and the install fails. `--force` lets it
  through with a warning; `--legacy-peer-deps` installs no peers at all.
- Changed: `npm install <pkg>` plans with the project's whole tree, and
  prunes what the tree no longer needs. It saves where npm saves: `-D`,
  `-O`, otherwise where the project already declares the package. A bare
  name keeps its declared range. The saved range is `^version` unless the
  range given is narrower.
- Changed: an optional dependency that fails, whether at resolution, by a
  platform refusal or at download, is left out with every package only it
  needed. The decision is made per placement, over the whole graph. A
  dependency that is in both `dependencies` and `devDependencies` takes its
  `devDependencies` range. The project's own `peerDependencies` install.
  `--omit=dev` plans the whole tree and leaves out what only
  devDependencies reach, as npm does.
- Changed: `npm install -g` uses npm's global layout, where each package's
  dependencies, and its peers, sit beneath it. It builds what it names
  afresh and changes nothing else in the prefix; `<prefix>/lib/package.json`
  is neither read nor written.
- Changed: the shell's own npm publishes under a journal in `node_modules`.
  If an install is interrupted, the next one undoes it before planning.
  Ctrl-C before publication changes nothing. Installs into one tree, in
  either host, run one at a time. A stopped install that is waiting for the
  tree never starts.
- Changed: registry cache records belong to the registry package, and are
  kept only under its name; an alias's lockfile entry names the package it
  installed. A record cached before this release does not say which package
  it is, so it is not used: the first install after upgrading resolves its
  tree from the registry once.
- Breaking: VFS-3 and VFS-9 A open a file on a mount by one rule, and its open
  description is one implementation (`vfs/mounted-description.js`), for a
  process's synchronous face, its asynchronous one, and a wave's `open`;
  one descriptor numbering per process (`runtime/descriptors.js`). Visible
  changes, Linux's answers:
  an open asking no access reads; `O_NOFOLLOW` of a mounted link is `ELOOP`
  (the synchronous face followed it); `O_CREAT|O_EXCL` of a link, even
  dangling, is `EEXIST` before `ELOOP`; `O_CREAT|O_DIRECTORY` of an absent name
  is `EINVAL` and makes nothing (one face made a file and failed, the other
  opened it); a directory opened with write rights opens (the asynchronous face
  refused it); `O_TRUNC` is the mount's truncate; an `O_APPEND` descriptor
  starts at offset 0, on SQLite too, and each append leaves it at the end;
  a mounted `fstat` carries the mount's revision, not the SQLite clock; an
  explicit negative offset of a read or write, and a seek to no integer, is
  `EINVAL` (a negative offset read from 0); `O_CREAT|O_DIRECTORY` is `EINVAL`
  before any lookup, `O_CREAT` of a directory `EISDIR` (`O_EXCL`: `EEXIST`),
  `O_DIRECTORY|O_NOFOLLOW` of a link `ENOTDIR`, and `O_TRUNC` asks write
  access whatever access the descriptor has, on SQLite and on a mount alike;
  `ftruncate` of a descriptor not open for writing is `EINVAL` (it was `EBADF`
  on SQLite, and truncated on a synchronous mount); a mount whose `writeRange`
  refuses with `ENOTSUP` holds the writes until fsync or close, as one without
  `writeRange` does, and a descriptor that awaits writes them as it makes them.
  Who may open a mounted file for what is the mount's own policy, as for every
  other operation on it, asked before the open changes anything (the new
  optional `VFS.access`, which `SqliteFiles` and `/proc` implement): the
  synchronous face no longer refuses an open with `EACCES` by the mode a
  backend of one identity reports, and both faces now refuse what a
  credentialed backend's modes deny. A description holds the file its open
  found (`CompositeVFS.pin`, a `PinnedName` and its `hold`, a `HeldFile`): an
  unmount, a mount or a link changed at its name later moves neither its I/O
  nor its held writes, and a write through it is reported to `observeWrites`
  only while the namespace shows that file at that name. A backend may keep
  open files (the new optional `VFS.openFile` and `VfsOpenFile`, which
  `SqliteFiles` implements; the unused `VFS.open`, `VfsHandle` and
  `VfsOpenFlags` are removed): a description of one is that file across a
  rename or an unlink, guarded by leases and observed at the name it has now;
  one of a backend that keeps none is held by its name, and refuses with
  `ESTALE` once the name holds another file or none. An open holds the file
  it decided on: one put at its name meanwhile is `ESTALE`.
  `MemoryVFS` numbers its files (`ino`). Held writes are keyed by the file
  (its number in its backend's store, the new optional `VFS.fileStore`, the
  same through any view or wrapper of it), not its mount and path, apply in their
  descriptions' open order, and a process's held writes on a file are
  written before that process cuts it (a truncate, an `O_TRUNC` open, a
  whole-file write), so nothing brings back what it cut; a flush the process
  did not ask for that fails is reported by that descriptor's next `fsync` or
  `close`. A close answers what the backend's close failed with, and
  `releaseProcess` what every close of its descriptors did, as a wave's
  `close` of a mounted description does; a description whose flush fails
  still closes its file, and a killed process's close theirs, writing
  nothing. A positional write through an
  `O_APPEND` descriptor lands at the end and leaves the offset where it was.
  `SqliteVFS.openDescription` asks only search: the open that asks decided
  the access (a creat(2) of a mode without write writes what it made). `EFBIG`
  is a VFS error code. Not atomic on a mount that awaits: an `O_APPEND` write
  (the end is read, then written at) and `O_CREAT|O_EXCL` (a stat, then a
  create).
  A wave's `open` of a file on a mount keeps it as the process's description
  (`WaveDescriptions.describe`, `WaveRouter.open`): that description's
  writes, appends and truncates act on that file, not on whatever its name
  leads to later, are refused (`EBADF`) once it is closed rather than made by
  its name, and stop with its process; the open's receipt carries its
  descriptor, and a re-sent open answers it again. `WaveScope.isDescribed` is
  removed. `O_CREAT|O_EXCL` of a name that is a link, followed or not,
  is `EEXIST` on SQLite too (it created the link's target, or answered
  `ELOOP` first). Held writes are read back by every read of their file, by
  path or descriptor, awaited ones included. The synchronous face refuses a
  descriptor on an asynchronous mount with that mount's `EAGAIN`, not
  `EBADF`. `CompositeVFS.writesInPlace` is removed.
- The shell's built-in `node` keeps no descriptor table of its own: an `fs`
  descriptor is the process's (`NodeFilesystem.open`, `read`, `write`,
  `fstat`, `ftruncate`, `fsync`, `close`), shared with `fs/promises`, with
  its file, offset, rights and `O_APPEND`; Node's flag strings and `O_EXCL`,
  `O_DIRECTORY`, `O_NOFOLLOW`, `O_SYNC` are honored, and an unknown flag
  string is `ERR_INVALID_ARG_VALUE`.
- `CompositeVFS.route` and `mutationRoute` take `{ report: true }`: the answer
  then carries the links the lookup traversed, in order, and a lookup that
  refuses (`ENOENT`, `ENOTDIR`, `ELOOP`, `ENXIO`, `EACCES`) answers its refusal
  `{ code, at }` instead of throwing, for a caller that invalidates on what a
  name depended on. Without it both answer and refuse as before.

- Breaking: `@nimbus-sh/fabric` removes `IsolateMapOptions.onError`.
  `IsolatePool.map` returns values or rejects after all dispatched calls
  settle; use `mapSettled` for each outcome. `mapSource` now requires
  `stopOnFailure` and returns outcomes. `Fanout.submitMany` also waits for
  dispatched tasks to settle; `submitManySettled` returns every outcome.
- Fixed: npm placements sharing a tarball fetch each verify their own
  integrity. Each required digest is computed once per shared fetch.
- Fixed: Worker npm read-back uses a per-batch receipt when replacing the
  same name@version after a shard's reply is lost. A previous copy cannot
  prove this batch landed; receipts are removed after read-back.
- Changed: generated napi-wasm, OpenCode, Oxc and CPython artifacts carry
  source digests. The artifact-provenance gate refuses stale inputs before
  restaging; remote rebuilds return artifacts through one checked write-back
  path.
- Fixed: the regenerated napi-wasm loader includes the current WASI
  filesystem's Nimbus extensions, shared dirent helpers and `EFBIG` mapping.
- Added: `scripts/ci/remote-python-build.mjs` builds CPython wasm reproducibly
  on armada and returns the artifacts through the shared write-back path.
- Changed: Lean formal models prove that draining a pipe releases a held exit
  status without waiting for a background job. Async hydration completes by
  fetched chunk identity, preserving queued chunks across reprioritization
  and failures; pipe refinement fixtures cover drain settlement.
- Changed: the release matrix excludes `remix-real` and `vinext-real` under
  the recorded user approvals. The measured per-bundle engine split is not
  shipped.

## 2026-10-11: platform 0.8.1, config 0.3.0, core 0.17.0, fabric 0.12.0, worker 0.15.0, loom 0.2.4, sdk 0.13.0, react 0.3.0, cli 0.2.4

- Breaking: W7 wave ingestion lives above the SQLite engine, in the
  namespace's `WaveIngest` (`@nimbus-sh/core/runtime/wave-ingest.js`,
  `ProcessFiles.waves`). `CredentialedVfs.writeStream` and `writeBatchPlaced`
  and `SqliteVFS.setWaveRouter` and `placesHere` are removed: stream a wave with
  `waves.writeStream(view, stream, options)`, place a batch with
  `waves.writeBatch(view, payload)`, ask `waves.placesHere(view, names)`. A
  view opens a wave's storage with `wave(options, work)`. The wave contracts
  (`WriteStreamOptions`, `WriteBatchStreamResult`, `WaveRouter`, `WaveSequence`,
  `ROUTED_FILE_MAX`, `linkedSignal`, …) move from `vfs/sqlite-vfs.js` to
  `runtime/wave-contracts.js`. `seedProject` and `shouldSeedProject` take the
  filesystem authority (`{ engine, waves }`) instead of the engine.
- Breaking: the legacy symlink registry is gone. `@nimbus-sh/core/vfs/symlink-registry.js`
  (`SymlinkRegistry`, `getSymlinkRegistry`, `LEGACY_SYMLINK_REGISTRY_PATH`) and the
  supervisor's `hasLegacySymlinkUnder` call are removed. No Nimbus since the core
  package wrote that registry, and schema v2 and v3 stores never carried one over,
  so a root `/.nimbus-symlinks.json` is now an ordinary file: it no longer defines
  symlinks, and an exclusive mutation elsewhere no longer holds it busy.
- Breaking: low-level `Facet.submit`, `IsolatePool` and `Fanout` calls now
  accept `FacetTaskSource` values, not functions or closures. Compile the
  task and its dependencies at build time, then pass its expression to
  `facetTaskSource` from `@nimbus-sh/core/runtime/facet-task.js`. The old
  `FacetFn`, `FacetTaskFn` and `serializeFunction` exports are removed.
  Nimbus's tasks and embedded helpers use one build-time compiler and survive
  host identifier minification; no runtime function-source serialization remains.
  Guest entry helpers now live in core `runtime/facet-tasks.js` and worker
  `runtime/repl-facet-tasks.js`; the former runner/REPL exports are not re-exported.
  `runtimeModuleScope` moves from `_shared/commonjs-cell.js` to
  `_shared/runtime-code-identity.js`, where the host/guest identity helpers are compiled together.
  The obsolete `_shared/esbuild-facet-shim.js` and its `ESBUILD_NAME_*_SHIM`
  exports are removed; compiled bodies carry their own lexical bindings.
- Fixed: published core bundles npm's CommonJS dependencies with explicit ESM
  builtin imports, so a neutral ESM bundle can start under workerd without
  eager dynamic `require` failures.
- Added: SDK `files.readlink`, plus optional `ino` and `revision` on `stat`
  and `lstat`, through the shared session contract on every transport.
- Added: `exec`/`execStream` accept a local `detach` signal. Detaching releases
  a named shell to its next call without killing the current command or
  saving its later cwd/environment. Its output remains readable and its exit
  still reports actual completion. The wire `detachId` identifies an invocation
  independently of its inherited `execId` attribution tag.

- Changed: the programmatic session wire contract and result schemas now live
  in `@nimbus-sh/core/runtime/session-protocol.js`, shared by SDK, HTTP, hosted
  sessions and Durable Objects. Existing SDK option/result type names remain
  available as shared or derived aliases rather than augmentable interfaces. Runtime-install
  replies now validate their declared spec, exit code, stdout and stderr fields.
- Breaking: `NimbusSessionSurface._rpcWriteFile` and the hosted session's raw
  method now return the committed revision (`Promise<number>`), matching the
  Durable Object wire result. Public `files.write` consistently returns void
  on every transport, as declared; it no longer leaks the revision on colocated
  calls. Producer-only `Programmatic*`, serialized process/port and app result
  types move from the worker implementation module to the core contract.
- Breaking: `RuntimeInstallSummary` is removed from
  `@nimbus-sh/worker/runtime/package-manager`. Use `SessionRuntimeInstallResult`
  from `@nimbus-sh/core/runtime/session-protocol.js`; no deprecated re-export
  remains.

- Changed: the shared base64url decoder requires canonical unpadded encodings,
  rejecting nonzero unused padding bits. JWT, signed OAuth state and sealed
  JSON verification therefore reject alternate strings for the same bytes;
  generated canonical tokens and cookies are unchanged.

- Changed: colocated SDK `runCode` enforces the sandbox profile's `node`
  and `shell` allow rules for JavaScript, TypeScript and shell code, as the
  remote API already did. Sandbox profiles and runtime-policy decisions now
  come from `@nimbus-sh/config/sandbox`.
- Breaking: execution `NimbusConfig` no longer accepts the unused
  `runtimeCache` field. Configure runtime bucket bindings through
  `BuildWranglerOptions.runtimeCache` instead.
- Breaking: OAuth, cookie and crypto helper exports have moved out of
  `@nimbus-sh/sdk/worker` and the `@nimbus-sh/worker` root. Import them from
  the workerd-independent `@nimbus-sh/sdk/oauth` entrypoint. This includes
  the Cloudflare provider functions/constants, PKCE/sealing/base64 helpers,
  agent OAuth cookie helpers and their types; no compatibility re-exports
  remain. The next affected-package publish requires a minor version bump.

- Changed: a program that listens serves, however it was started.
  - `node app.js`, an npm bin or a `child_process` child whose server Nimbus could not see in its code used to run as a one-shot. Its port answered 501, or 502 once it was gone.
  - Now its first `listen()` stops it, and Nimbus runs it on as a server (the same pid), replaying it up to that listen. What it printed before is shown once.
  - Files it changed before it listened are checked against the first run, one by one, as the replay makes them again.
  - A program that appended to a file, started a child, opened a connection or made a request before it listened cannot be run again. Its `listen()` throws an error naming what it did.
- Changed: a bin that served once in a workspace starts as a server directly next time.
  - Learned by its package's name and version, the bin, and its first argument.
  - The known server CLIs (vite, next, astro, and the others) still start that way from their first launch.
- Changed: an npm bin runs as `node <its file>` does: one process, shown under the bin's command line, whose start, output and exit are reported once. A bin no longer has a process entry and a `[bin started]` line of its own.
- Fixed: a `kill` sent while a process's earlier end was still waiting for its writes to drain was acknowledged but did nothing; the process kept running until the drain finished. The kill now takes effect at once, and its status is the one recorded.
- Fixed: `opencode` run once (`opencode --version`, `opencode run …`) could reset the session; repeated runs reset it within a few dozen. Killing such a run now also ends the program, which used to run on after the session had let it go.
- Fixed: a resident process whose filesystem could not be listed at boot reported a stale cause ("a change reported without the stat every name needs"). It now names the listing's own failure.

- Breaking: `@nimbus-sh/react` takes `@nimbus-sh/sdk` `^0.13.0` as its peer.
  `NimbusTerminal` builds its attach URL with the SDK's `sessionAttachUrl`, at
  the endpoint's origin root rather than under the endpoint's own path, and
  drives the frame through the headless `useNimbusSession`.
- Breaking: `@nimbus-sh/fabric`'s peer-hosting receiver moves from
  `process-host.js` to `peer-host.js` (`isolateToken`, `HostProcessOpts`,
  `HostedHttpRequest`, `HostedHttpResponse`, `headerPairs` and the
  `HOSTED_WEBSOCKET_*` headers); `workerd-facet-host.js` no longer exports
  `NimbusCtxExports`, `createLoadedWorkerEntrypoint` or `getNimbusCtxExports`.
- Added: a program under an egress makes its TLS sockets through the egress,
  `node:net` sockets go out through it, and a WebSocket a program opens is
  relayed inline (Kinu ask 37).
- Added: `CompositeVFS.route` and `mutationRoute` take `creating`, the lookup
  `writeFile({ parents })` makes; a namespace write reports each side's
  observation; `writeFileIfRevision` expecting revision 0 creates only where
  no file is (Kinu asks 32, 34, 36).
- Changed: one namespace walk answers a lookup on the SQLite root, and a miss
  is an answer rather than an error (Kinu ask 28).
- Changed: a resident's keep-alive follows client traffic rather than any
  attached socket, an aborted call settles, and verified npm tarballs stay in
  a local tier (Kinu asks 30, 26).
- Changed: a node program's writes made while a relay call is out go in one
  call (Kinu ask 39). A process end ends its read lease, an ended program takes
  no resumption barrier, and node's formatting closure loads first, the rest
  of Node's library on first use (Kinu ask 40).
- Changed: `node:http`'s client runs over the native transport; `node:stream`
  is the one stream implementation.
- Fixed: a shed writer-epoch open is opened again, not cached as a failure.
- Fixed: a destroy stops session work, a running clone included, before it
  returns the session's leases; Git's network failures exit as Git's do,
  honour `-c` overrides, and redact credentials in what they print.

## 2026-10-10: platform 0.8.0, config 0.2.4, core 0.16.0, fabric 0.11.0, worker 0.14.0, loom 0.2.3, sdk 0.12.0, react 0.2.3, cli 0.2.3, create-nimbus-app 0.2.1, runtime-cpython 3.13.14-1

- Fixed: process stdin is one bounded byte channel for Node, WASI and registry
  children. Inherited fd 0 keeps queued bytes, future writes and EOF; full
  pipes hold their writers until a reader makes room. Registry and shebang
  children stream byte-exact stdout/stderr, and foreground output no longer
  passes through a decoded log or binary placeholder. Logs persist bytes and
  derive their text view on read. Missing/nonexecutable children fail spawn
  with ENOENT/EACCES, and a vanished reader releases a blocked writer. npm-bin
  entrypoints retain their broker-owned pid/fd0 and forward logged bytes
  without feeding the same foreground subscriber back into itself. A child's
  parent-side stdin is destroyed on exit, so a delayed end cannot write to
  a removed reader and abort its parent's asynchronous work. A source read
  failure preserves queued input and then reports EIO instead of clean EOF.
  Broker-owned WASI runs reuse the same process and stream their bytes rather
  than returning a rendered, truncated process-log tail.
- Fixed: echo, progress, replay wakeups and impossible-child refusals use a
  timer-independent continuation fence, so incoming filesystem RPC traffic
  cannot withhold their bookkeeping. Fresh CPU turns still use the session's
  alarm-backed paced-work scheduler. Complete-file stdin reads use bounded
  1 MiB windows rather than one RPC per small stream chunk.
- Fixed: CPython, Ruby, bash and the clang toolchain use the shared live WASI
  byte relay instead of returning collected output at exit. Redirected files
  receive flushed output during the run, binary pipes preserve their bytes,
  and REPL/server control frames are bounded metadata rather than stored text.
- Fixed: Node byte-mode readable streams expose Buffer chunks at their public
  edge, preserving Buffer methods and encoding-aware toString calls.
- Fixed: live Node console output no longer retains a second whole-output
  string. Opencode's explicit one-shot text-result capture is bounded to
  1 MiB per stream; an oversized result fails with EFBIG and a nonzero exit
  instead of silently truncating it or exhausting the facet's memory.
- Changed: `zlib`, `buffer` and `crypto` in node programs check their
  arguments as Node does and throw Node's errors (`ERR_INVALID_ARG_TYPE`,
  `ERR_MISSING_ARGS`, `ERR_OUT_OF_RANGE` and the rest, in Node's words).
  They used to throw workerd's uncoded `Failed to execute …` errors, which a
  program's `e.code` checks missed.
  - `btoa` now refuses characters past U+00FF, as Node's does.
  - `atob` reports Node's two errors.
  - `crypto.createECDH` and `getDiffieHellman` name an unknown curve or
    group as Node does.
  - `crypto.setEngine` reports that no engine is found.
- Fixed: `crypto.randomBytes`, `randomFillSync` and `randomFill` in node
  programs threw `QuotaExceededError` past 65536 bytes. They fill up to
  2^31-1 bytes, as Node's do. `crypto.getRandomValues` keeps the Web
  Crypto quota, as in Node.
- Fixed: `fs.stat(path, options, callback)` treated the options object as
  the callback. `{ bigint: true }` was ignored by every stat call; it now
  returns `BigIntStats` in nanoseconds.
- Changed: `process` and `fs` in node programs are closer to Node's.
  - `process` is an `EventEmitter` (`process instanceof EventEmitter`).
  - `process.hrtime`, `cpuUsage`, `threadCpuUsage`, `resourceUsage`,
    `memoryUsage`, `kill`, `_rawDebug`, `loadEnvFile`, `assert`, `ref`,
    `unref` and `allowedNodeEnvironmentFlags` are Node's own code
    (`lib/internal/process/per_thread.js`), with Node's argument checks.
    `process.hrtime` now has sub-millisecond resolution and a correct
    difference.
  - `setUncaughtExceptionCaptureCallback` is present, along with `argv0`,
    `release`, `debugPort`, `availableMemory` and `constrainedMemory`.
    `process.argv[0]` is `process.execPath`, and `uptime()` counts up.
  - Every `fs` stat result is an `fs.Stats` with Node's fields (`dev`,
    `nlink`, `blksize`, `blocks` and the rest).
  - `fs.F_OK`, `R_OK`, `W_OK`, `X_OK` and `fs._toUnixTimestamp` are present.
  - `fs.lchmod` is undefined, as on Linux.
  - `dns` has Node's constants.
  - Known limits: `cpuUsage`, `resourceUsage` and `memoryUsage` read 0. A
    Worker has no CPU or memory readings.
- Fixed: a second `astro dev` in the same session reset the session (the
  dev server never answered, 502). The launch carries what the first one
  learned, and its larger code pack outgrew the session's memory twice:
  writing it encoded the whole pack beside the module text it came from,
  and booting it read the pack's bytes beside the process's wasm images and
  decoded them into one string, two bytes a character throughout if any
  module held a non-Latin-1 one. A code pack is now written a module at a
  time, and read first at boot and decoded a module at a time. Past those,
  its module map, 68.5 MB with what the first run learned beside 39.4 MB of
  wasm, was over the platform's 64 MiB ceiling on a dynamic Worker's map:
  it was refused at start, and the session reset holding it. A launch's map
  now carries what earlier runs learned only as far as that ceiling allows,
  what they needed first kept first; what does not fit runs as it did in
  the run that learned it.
- Fixed: an unreferenced timer, interval or immediate (`.unref()`) kept a
  node program running until it fired, and an unreferenced interval kept it
  running forever. They now let the program exit, as in Node.
- Changed: `timers`, `timers/promises`, `os`, `perf_hooks` and `stream/web`
  in node programs are Node's.
  - `require('timers').setTimeout` is the global `setTimeout`.
  - `timers/promises` validates its arguments, rejects with `AbortError` when
    its signal aborts, and has `scheduler`.
  - The deprecated `timers.enroll`, `unenroll`, `active` and `_unrefActive`
    are present.
  - `os` adds `machine()`, `version()`, `devNull`, `getPriority()` and
    `setPriority()`. `os.release()` and `uname -r` now report the same
    release, `6.0.0-nimbus`; `uname -r` used to print `1.0.0`.
  - `perf_hooks` adds Node's classes and `constants`.
  - `stream/web` exports every Node class.
  - Known limits: `perf_hooks.createHistogram` and `monitorEventLoopDelay`
    throw `ERR_METHOD_NOT_IMPLEMENTED`. `os.getPriority` and `setPriority`
    on another process throw ENOSYS.
- Fixed: a module the launch staged because earlier runs executed it, or as
  a guess at a package's main, came without what its require wrapper loads.
  nuxt's `nuxt dev` failed "Failed to resolve vue/compiler-sfc" when
  `@vitejs/plugin-vue` was staged that way. Such a module now brings its
  static imports and its wrappers' loads together, or is left to load late.

- Changed: `util`, `assert`, `querystring` and `punycode` in node programs
  are Node 22.22.3's own library code, loaded on first use. Modules are
  Node's `Module` objects (`require.cache` is `Module._cache`), and a
  missing module throws `MODULE_NOT_FOUND` with its `requireStack`, so the
  try/catch pattern for optional dependencies works. Known limit:
  `util.getCallSites` returns `[]` when a program has made both
  `Error.stackTraceLimit` and `Error.prepareStackTrace` non-writable and
  non-configurable.
- Fixed: the first `vite` or `vite build` of a create-vite Vue project
  failed. `@vitejs/plugin-vue` loads `vue/compiler-sfc` through a function
  that wraps `createRequire`, and the first run staged no module reached
  that way. The first run now stages modules a `createRequire` wrapper
  loads.
- Fixed: a resident process whose launch was over 2 MB and that was reset
  during its restart backoff never came back. The cold-start alarm
  re-drove its launch, but the launch's next timer was armed into a
  dispatch that had already finished, so nothing ran it.
- Fixed: `fs.promises.cp` of a single file the process held copied the held
  bytes without checking the read: a file the process had made write-only
  was copied, and a file the session had refused it was "copied" from the
  refusal. It now copies a file as `fs.promises.copyFile` does, through the
  read, and fails with EACCES where that read does.
- Fixed: a node process could go on reading, synchronously, a file whose read
  a chmod or a chown had revoked. The bytes it already held were kept under
  the new revision because their content was unchanged (the same held for a
  store kept from an earlier launch, and for a one-shot's package.json
  copies), and readFileSync checked only the directories above the file.
  A file is now kept or copied only while its mode and owner let the
  process read it, and readFileSync and a read open judge the file's own
  mode, as the session does: EACCES.
- Fixed: a one-shot node process can read every installed package's
  package.json synchronously on its first run, as a resident process can.
  Package resolution reads manifests for names no closure walk sees: vite's
  config load reads one for every import of the config to decide whether to
  externalize it, and on a fresh create-react-router project every read
  failed, so it bundled @react-router/dev, @tailwindcss/vite and babel into
  the config and ran out of memory. The session reads the manifests once per
  install and hands each launch the copies; a launch holds a copy only while
  the file still has its content, and reads any other manifest itself.
- Fixed: a one-shot node process reports the files it was refused, and the
  code it produced, as they happen, as a resident process does, not only in
  its exit report. A run the platform killed reported nothing, so its next
  launch missed the same files and died the same way: a fresh
  create-react-router project's config load was killed by memory ("Worker
  exceeded memory limit") on every run. A killed run's failure now names the
  reads it was refused, beside the platform's error, and its next launch
  stages them.
- Fixed: a node run that was refused a synchronous read of a file it had not
  been staged (EAGAIN) fails at exit, naming the file, even when the program
  swallowed the error and a later call on the same path succeeded. vite's
  resolver swallows the EAGAIN of a package.json, bundles the package it took
  to be missing, and later stats and reads the same path successfully; that
  later answer cleared the miss, so the run reported success built on the
  wrong answer. Only the remedy the error names, an asynchronous read of the
  path, answers it now.
- Fixed: a WebAssembly program whose memory grew past 128 MiB could no longer
  read or write at the top of it: rolldown pre-bundling React with
  lucide-react (152 MiB) failed "Bad address (os error 21)" writing its
  pre-bundles, and "Invalid array buffer length" returning strings. In a
  Worker, `subarray` refuses a begin past the 128 MiB an ArrayBuffer may
  have; the WASI hosts and the napi-wasm loader (its emnapi included) now view
  guest memory by offset instead.
- The probe driver pings its terminal and process-log WebSockets every 30 s.
  A socket that carried nothing either way for about 270 s was dropped on the
  way to the session (close 1006, no close frame; the session was not reset),
  so a probe waiting on a command that printed nothing for that long failed
  as if its session had reset.
- Breaking for Cloudflare embedders: the hosting Worker must explicitly set
  `"limits": { "cpu_ms": 300000, "subrequests": 10000000 }` in its Wrangler
  configuration. A facet's limits only lower its parent's, and under the
  plan's 10,000 subrequests a dev server's filesystem calls ran out within
  minutes ("Too many subrequests by single Worker invocation"). Omitting
  either or configuring less is refused by deployment validation.
  `@nimbus-sh/config` emits the required block automatically.

- Added explicit, evidence-based per-kind facet CPU and subrequest limits,
  replacing the implicit 30-second Loader CPU default. Resident filesystem
  transport retains its invocation budget across incoming HTTP requests, so
  processes receive a deliberately generous finite lifetime ceiling. This
  resource policy is separate from batched filesystem write delivery.
- Fixed: a process no longer has a wall-time deadline. A wasm program, WASI
  included, was killed at 30 s ("Task exceeded 30000ms deadline"), which
  ended clang over 10,000 files under load at 9,199. CPython was killed at
  120 s, clang, Ruby and bash steps at 300 s, and a Python or Ruby REPL
  evaluation at 60 s. A process now runs until it exits or is killed (kill,
  Ctrl-C), and on Cloudflare the CPU limit ends a runaway one. Only a direct
  compute call (a build, a transform, a git network step, a fan-out task)
  still has a deadline.
- Breaking for embedders running `@nimbus-sh/core` off Cloudflare:
  `localFacetHost` no longer takes `defaultTimeoutMs`, and a facet call
  given no `timeoutMs` has no deadline. Off Cloudflare there is no CPU
  limit, so a program that never ends runs until it is killed, as it would
  under Node. Pass `timeoutMs` to bound a call of your own.
- Fixed: a command's second run could fail before it started, where its
  first had got further: what the first run executed and the launch lacked
  is learned and rooted in the next launch's required closure, and on `nuxt
  dev` that took the closure past the snapshot bound ("require closure for
  …/@nuxt/cli/bin/nuxi.mjs exceeds the 18874368-byte snapshot bound"). Learned
  modules that do not fit are now staged as optional, as far as the bound
  allows.
- Fixed: a module a launch's map had no room for (the bound evicts the
  largest guesses first) that the program then loaded through an `import()`
  could not read what it reads synchronously, nor compile its WebAssembly:
  `nuxt dev` evicted rollup, and Nitro's load of it failed reading
  `bindings_wasm_bg.wasm`. An evicted module's wasm images are now carried,
  and the `import()` that reaches it fetches its synchronous reads.
- Fixed: a launch that loads rolldown, satteri or the Astro compiler by a
  name its code computes (`nuxt dev`: nuxi loads the project's nuxt, which
  loads vite and rolldown) carried none of their staged bindings, and failed
  with "Cannot find module '../rolldown-binding.linux-x64-gnu.node'". It now
  fails by name: which binding, the version Nimbus stages, and that the next
  launch of the command carries it.
- Fixed: `nuxt dev` failed its first run with "Cannot find native binding":
  Nuxt reaches Vite, and Vite rolldown, through an `import()` whose specifier
  is a variable, so the launch never carried rolldown's staged wasm binding,
  and a binding cannot be added after launch. A launched bin now also carries
  the staged bindings its own declared dependencies install (resolved as Node
  resolves them, at the binding's exact version). A carried binding is
  registered, never instantiated, until a program requires it.
- Fixed: a program that compiled a WebAssembly module from bytes built in
  memory, rather than read from a file, was refused, and a caller that caught
  the refusal carried on without it, silently, on every launch (one of 286
  bytes during `nuxt dev`'s startup). The refusal is now named on stderr, once
  per module, and a module that validates (up to 1 MiB) is staged: the next
  launch of the command carries it. And `WebAssembly.instantiate(bytes)` that
  fails after its compile (a link failure, a trap) keeps its own error, where
  it was reported as a refused compile and lost its class.
- Changed: a process compiles a wasm image its launch carries when the
  program first compiles it, not when the process starts. A Vite 8 or Astro
  dev server no longer compiles lightningcss's 15.8 MB image on every launch,
  only when it transforms CSS with lightningcss.
- Changed: a long-running launch no longer stages, at boot, what modules it
  reaches only through an `import()` read synchronously; that `import()`
  fetches them before the module evaluates. A Vite 8 dev server's boot drops
  the 15.8 MB `lightningcss_node.wasm` it reads only when it transforms CSS
  with lightningcss.
- Fixed: a process whose file store was at its storage budget could be
  refused files it read many at once, though the session granted all the room
  they asked for: each grant served one fill of the batch, and a fill gave up
  after eight. Waiting fills now get room in the order they asked, and one ask
  covers them all (`astro dev`: "import() prefetch: could not fetch
  …/zod/v4/locales/…; its fetches did not land").
- Added: a git repository on a mounted filesystem. `git clone` onto a mount
  (before: "writes a repository only on the workspace filesystem"), and
  `git fetch`, `pull` and `push` in a repository there. A file over a wave's
  4 MiB mount limit is written through the session's file API (open, write,
  close), the index through `index.lock`. A failed or interrupted clone
  there is cleaned up as on the session's own filesystem. A mount backend
  without `rename`, `writeRange` or `truncate` fails the clone with the
  namespace's refusal naming the call (EXDEV for a rename, ENOTSUP for the
  others), and the destination is removed.
- Fixed: a write wave routed onto a mount, and a lease holder's `mkdir`,
  `open` for writing, `unlink` and `rmdir`, did not present the caller's
  exclusive-mutation lease: under its own lease a holder was refused EBUSY
  there. A file opened under a lease now writes and truncates under it.
- Changed: what a process's writes survive. A resident (node, python,
  ruby or opencode in a SQLite-backed facet) logs every change in its own
  store before the program is told it succeeded. When the process is
  killed or runs out of memory, the session drains that log, and only then
  reports its exit status: 5,000 of 5,000 files after an OOM or a `kill -9`.
  One limit remains: a resident that dies of CPU or memory partway through
  one unbroken synchronous stretch loses what that stretch logged (958 of
  5,000 in a live CPU-death run). No output ever gets ahead of it.
  A one-shot (node, python, ruby or a WASI program run once) releases no
  output, exit status or outbound message until every change it made
  before it is in the session. A one-shot that ends abnormally (out of
  memory or CPU, or killed) can lose an unknown number of the changes it
  made since it last produced output or flushed. It always exits non-zero
  and says so in its output, naming any subtree it held. No count is
  promised: the session never saw the changes the process acknowledged and
  never sent.
- Fixed: a WASI program run with `./prog.wasm`, and ruby, ran without its
  credential, so every file call was a round trip to the session. A C
  program writing 10,000 files now takes 14.7 s, where before it stopped at
  the 30 s limit with about 3,000 written.
- Fixed: a resident that died on its own after it started (out of memory
  or CPU) stayed listed as running, and its writes were never recovered.

- Fixed: a write wave ignored mounts. A W7 wave (`writeBatchStream`, which
  `git clone`, `git checkout` and `npm install` use) wrote every record to
  the session's SQLite store, even under a mount. A file under a mount
  point was written to SQLite, where the mount hid it, or failed with
  ENOENT when its directory existed only on the mount. Now each record
  goes where the namespace places it, as the matching single call would:
  a file is one `writeFile`, a directory one `mkdir`, a removal one
  `rm -r`, and a link one `symlink`. Removing a directory above a mount
  point fails with EBUSY, and a file there with EISDIR, before anything is
  written. If the namespace changes under a wave (a link repointed, a
  mount made), the wave fails with ESTALE instead of writing where the
  name no longer leads. Records that stay in SQLite cost what they did
  before routing.
  Limits:
  - A wave writes a file to a mount in one call, up to 4 MiB
    (`ROUTED_FILE_MAX`). A larger file fails with ENOTSUP before anything
    is written. Write it to the mount directly.
  - A link's target on a mount is at most 4,096 bytes
    (`ROUTED_LINK_TARGET_MAX`); a longer one fails with ENAMETOOLONG.
  - A mounted record cannot be applied twice. If a resent wave reaches a
    mounted record that an earlier attempt may already have applied, the
    wave stops there with EIO ("outcome unknown"). Check that path on the
    mount before you write it again.
  - A link on a mount is made under a temporary name first, then renamed
    over its name. The temporary name is `.<name>.nimbus-wave-<wave>-<record>`,
    in the link's directory. If the session crashes between the two steps,
    that temporary link stays, at most one per link being written. Nimbus
    does not remove it; delete it by that pattern.

- Fixed: `npx create-react-router` stopped while copying its template with
  "TypeError: dest.write is not a function". `stream.pipeline` turned every
  stream without a `pipe` of its own into a Readable, its destination
  included (tar-fs 3's extract), so the gunzip stream piped into a stream it
  cannot write. It now adapts only the source, as Node's does.
- `node` reads its command line as Node does: `--conditions`/`-C` (on the
  command line or in `NODE_OPTIONS`) choose a program's `#imports` and its
  packages' `exports`, for `import` and `require` alike; `process.execArgv`
  holds node's options and `process.argv` the program's own; an option Node
  refuses is refused with Node's message and exit code 9.
- `node -p` prints the code's value when the process exits, as Node does,
  and `echo code | node -p` too; it was refused. `-r`/`--require` and
  `--import` load their modules before the program (`node -r dotenv/config
  app.js`); they were ignored. In `-e` and `-p` code, `crypto` is
  node:crypto, as in Node.
- Fixed: `react-router dev` (React Router 8.4) exited at once with "Oops, Node
  v22.19.0 detected": processes now report Node v22.22.3, the release the
  tests use as Node's reference, which meets its `>=22.22.0` engines floor.
- Fixed: a file a process faulted in could stay unreadable for good when its
  fetch completed without its bytes landing (a barrier spoiled the fill, or
  the store refused it): the path counted as asked. It is now asked for again
  by the next read that misses it, and an `import()`'s prefetch takes another
  round for it (`astro dev`, now and then: "Cannot load module
  '…/zod/v4/classic/index.js'").
- Fixed: a process whose file store was at its storage budget could never
  read a file it had not staged: the fetch a refused read starts was declined
  for want of room, room was asked for only afterwards, and the fetch was not
  tried again (`nuxt dev` stuck at "Starting Nuxt..."). The fetch now asks for
  the room first, and concurrent asks each get theirs.
- Fixed: `astro dev` logged an unhandled "EAGAIN … aria-query/lib/index.js":
  Vite's dependency optimizer reads, synchronously, the entries of what a
  framework includes for itself (Astro's dev toolbar includes `astro >
  aria-query`, `astro > axobject-query` and `astro > html-escaper`), and a
  launch planned only the entries of the project's own dependencies. It now
  also plans the entries of those dependencies' dependencies.
- Fixed: `vinext dev` answered every App Router page 404, because `fs.glob`
  matched no braces: `fs.glob`, `fs.globSync` and `fs.promises.glob` are now
  Node's own, its Glob over the minimatch it vendors, with every option
  (`cwd`, `exclude`, `withFileTypes`). `fs.glob` and `fs.globSync` were missing.
- Fixed: `nuxt dev` died at start with "BroadcastChannel is not a constructor":
  `node:worker_threads` and the global now provide `BroadcastChannel`, which
  delivers to the process's other open channels of the same name as Node does
  and keeps the process alive until it is closed or unref'd.
- Fixed: an `import()` that reaches installed files a launch did not stage
  loads them on the first run. A launch's store holds its static closure and
  its data plan; any other file on disk was known by name but not held, and the
  synchronous load an `import()` ends in failed with "Cannot load module '…':
  it was not in this launch's module map; the next launch of the same command
  stages it" (or "Cannot find module", when it was a `package.json` that
  resolution needed). That never helped a file named afresh on each run.
  `astro dev` failed its first request this way, on `zod/v4` imported by its
  server code, and so did Vite's own config loading on react-router's
  template: the config Vite bundles to `node_modules/.vite-temp` imports
  `@react-router/dev`. Before loading, `import()` now fetches through the
  store's own fill: exactly the files Node's resolvers read for it (a bare
  name's `package.json`, a file URL's package scope, through links), then
  every module the target requests, as the runtime-code interpreter's parser
  reads requests and each resolved as the loader will evaluate it (a static
  import under `require`'s conditions, `import()` under `import`'s), outside
  the launch's map, breadth first. The bound, 4096 files and 64 MiB of raw
  bytes, is charged as each fetch is issued and as each range of it is
  read, manifests included; past it nothing more is fetched and the `import()`
  fails with `ERR_NIMBUS_PREFETCH_BOUND` rather than load on part of its
  closure. A file whose fetches never land fails it with
  `ERR_NIMBUS_PREFETCH_UNREADABLE`, naming the file, rather than resolve past
  it. Its reads are its own: a file the program itself failed to
  read stays in the program's exit report. A floating `import(...).then(...)`
  keeps the process while it fetches, and an `import()` of a module already
  loaded fetches nothing.
- A full clone (`git clone --no-shallow`) leaves a commit-graph with
  changed-path filters, as `git commit-graph write --reachable
  --changed-paths` writes it (generation data v2, filters version 2), byte
  for byte. It is written after the clone answers, so the clone takes no
  longer: on vscode (167,136 commits) the clone's finish took 1.1 s as
  before, and the graph was complete about five minutes later. It is one
  layer of a commit-graph chain, so the layers a later `git fetch` writes
  stack on it as git's do. A history that does not parse as git parses it
  gets no graph rather than a failed clone.
- Reading objects from a repository with many packs (a full clone has
  scores) searches the pack the last object came from first, as git does.
- Fixed: `node` and `bun` with no script opened a REPL that evaluated
  nothing ("workerd CSP: cannot evaluate JS at request time"). The REPL is
  now a program the runtime runs, as Node's is, and each line compiles
  through the same runtime-code path as a program's `eval`: top-level
  `let`/`const`/`class`/`function` persist across lines, top-level `await`
  works, `_` and `_error` hold the last value and error, `import()`
  resolves from the working directory, and an unhandled rejection or
  timer error is printed without ending the session. Ctrl-C cancels a
  pending block. `.editor`, `.load`, `.save`, completion and history are
  not supported. `echo code | node` runs its input as a program, as Node
  does.
- A job started with `&` gets `/dev/null` as its default standard input
  and does not own the terminal's modes, as in a shell without job
  control; it can still open `/dev/tty` explicitly.
- `git add -A` writes its objects in batches through the workspace's
  write waves: at 96,000 files it took 18 s instead of 53 s, or 23 s
  instead of 80 s with every file changed. A symlinked `.git/objects` is
  written through, never replaced. `git init -b` refuses a name git
  refuses, and short options can be grouped (`-qb main`).
- A write wave never turns an existing symlink into a directory; a wave
  that would is refused whole with ENOTDIR.
- Faster installs and clones: a write wave whose files are all in memory is
  encoded once and sent to the session in 1 MiB pieces, instead of being
  pulled a few kilobytes at a time. Markflow's `npm install` went from about
  65 s to 41-47 s (writes from about 1,000 to 1,600 files/s), and a vscode
  clone from about 40 s to 28-30 s, with the session's memory unchanged. A
  file larger than one wave still streams. Stall detection counts the bytes
  a reader drains, so a slow reader is not taken for a lost call.
- The VFS can read a chunk stored deflated. Nothing writes one yet; a later
  release compacts cold chunks in the background. Shipping the reader first
  means rolling back one release never meets data that release can't read.
  An inflated chunk must match its SHA-256 before it is returned or cached,
  or the read fails with EIO. `storeStats()` now reports the database size
  through the same `databaseSize` the storage ledger charges.
- Fixed: the Vite dev server's scan of the project for the names it imports
  from a barrel package (one of over 1500 files) is bounded. It ran on every
  request for a barrel and read every source file whole. It now reads at most
  2048 files, none over 1 MiB, and 16 MiB in all, checking each file's size
  before reading it. A scan that left files unread may miss a name one of them
  imports, so the server says what it left unread and bundles that barrel
  whole, as it bundles any package, rather than from an entry synthesized from
  the names it found. A bundle synthesized earlier from other names is never
  served in its place: a cached bundle synthesized from some names answers
  only a barrel request for exactly those names. The installer scans the
  project within the same budget and by the same rule, so for an unchanged
  project both reach one decision and share one bundle row; before, an
  over-budget project had the install write a synthesized row and the preview
  a whole one, each rebuilding the barrel every time (install, serve, install,
  serve: four bundles, now one).
- Fixed: an install's background pre-bundle stops when its session is
  destroyed. A client that destroys the session while pre-bundles are still
  queued deletes the storage under them. Each remaining pre-bundle then walked
  a store with no tables: its walk skipped every file it could not read, so it
  either threw "no such table: vfs_inodes" or sent the bundler an empty slice,
  which rolldown reported as 'Entry module "…" cannot be external'. On
  2026-10-06 that was 470 logged failures (clsx, tailwind-merge, hono/* and
  others), every one after its session had closed. The phase now stops, with
  one line saying how many were not pre-bundled, once node_modules is
  confirmed gone: not there (ENOENT) or its filesystem's store deleted
  (SqliteVFS.storeDeleted). Any other failure to list it (a node_modules its
  principal may search but not list) stops nothing. The slice walk passes over
  only a file removed under it (ENOENT); any other read failure fails that
  pre-bundle with its error. A slice without its entry fails, naming the
  entry, before the bundler runs.
- axios works in a node child, with its http adapter (its Node default)
  and its fetch adapter: the child's `process` is tagged as Node's
  (`[object process]`, the same `Symbol.toStringTag` descriptor), which is
  how axios picks its Node path; `fetch`/`Request` drop the cache modes
  Node accepts and workerd refuses (`default`, `reload`, `force-cache`);
  the child's stream classes are callable as Node's are
  (`Writable.call(this)`, as follow-redirects inherits); and
  `stream.pipeline` takes an array of streams, as axios passes a
  compressed response and its decompressor.
- The `ws` package works in a node child, for ws:// and wss://, through the
  workspace's egress when it has one: an `http(s).request` with
  `Upgrade: websocket` is answered over the supervisor's relayed socket
  (the one the global WebSocket uses), which now sends the request's own
  headers (Authorization, Origin, Cookie; never the handshake's or
  hop-by-hop ones) and answers a refused upgrade with its status, headers
  and up to 64 KiB of its body. The global WebSocket takes Node's
  `{ protocols, headers }` init. A WebSocket server inside the session is
  not available (docs/sandbox-sdk.md).
- A binary WebSocket frame reached a node child empty: the supervisor's
  relayed socket read workerd's default Blob as bytes. It reads
  ArrayBuffers now.
- Fixed: a build facet no longer fills with the builds it has run until its
  isolate is reset. rolldown (1.2.11 and 1.2.12, native and wasm alike) never
  frees a build whose plugin has an output hook or `buildStart`: for those
  hooks it caches the build's normalized options, a wrapper of a native
  object, on the build's plugin context data, and something the native object
  holds strongly reaches that data back, a cycle through the binding that no
  collector frees. Nimbus's build plugin had one (`generateBundle`, for each
  module's import order), so every pre-bundle's slice and every build's module
  sources and plugin stayed in the facet's isolate. Measured on Markflow's
  install: the facet's V8 heap and external memory grew from 18 to 415 MiB
  over 136 pre-bundles, and on throwaways six concurrent Markflow sessions had
  1 to 7 facet resets per 12 ("Durable Object's isolate exceeded its memory
  limit and was reset"), each on a small pre-bundle after 20 to 40 others. The
  import order now comes from `moduleParsed`; the same pre-bundles hold 65 to
  76 MiB between calls, flat. Every facet ran in an isolate of its own, one
  Durable Object each, one call at a time; the builds of different sessions
  never met in one.
- The build facet asks to be retired once its binding passes 40 MiB, not
  64: a call peaks at the binding it starts on plus what it grows it by
  (up to 41 MiB, measured) plus its slice and the isolate's JavaScript.
- Fixed: a pre-bundle whose build facet is reset under it runs once more on
  a fresh facet (logged), as it is pure; a second reset fails it with
  `BuildFacetResetError`, naming the package and the reason.
- Fixed: a Vite dev server that cannot bundle a package for the preview
  serves a module that tells the page why. It served a stub whose only
  export was a throwing default, so an importer of a named export failed to
  link ("The requested module '.../@modules/tailwind-merge' does not
  provide an export named 'twMerge'", Markflow on staging) and the real
  cause never showed. The module served now declares every name the
  package's entry exports (following its `export *`, or CommonJS's) and the
  project imports from it, and throws the cause as it evaluates: a build
  facet reset twice, a bundle error, or a slice past its cap. The barrel
  paths that could not bundle serve the same form.

- A workspace's network can go through its host's egress
  (`NimbusWorkspaceOptions.egress`; for the session Durable Object a
  `NIMBUS_EGRESS` service binding, or `workspaceEgress()` overridden to mint
  one per session). Every request made for the workspace's commands and
  programs goes through it: git (every facet it loads), npm (the install
  facets here and in peers; the shared packument cache is bypassed), curl,
  wget, dig, ping, `npm view`/`search`, pip (metadata and downloads), gem,
  a program's fetch, `http`/`https` (node-fetch, undici) and WebSocket, the
  one-shot runtimes and REPLs, a plain TCP socket (the egress's
  `connect()`), and the workers and dev servers a command starts; an inline
  `node` program's fetch streams through it and follows redirects as Node
  does. A program's TLS socket (`tls.connect`) is refused by name under an
  egress (`ERR_NIMBUS_EGRESS_TLS`): a Fetcher's `connect()` carries plain
  TCP only (measured in workerd: `startTls()` on such a socket has no TLS
  starter); so is an inline `node` program's WebSocket. Nimbus's own
  traffic (R2, catalog, OAuth, AI, assets) is not routed. The egress is a
  `Pick<Fetcher, 'fetch' | 'connect'>`. Process bindings carry the egress
  (`supervisorBindingProps` now requires the workspace's network), and every
  facet host, pool and fanout takes the network its facets go out through:
  `loaderFacetHost(env, ctx, network)`, `localFacetHost(network)` (whose
  facets' fetch crosses to the host and out through the egress),
  `IsolatePoolOptions.network`, `FanoutOptions.network`; Nimbus's own work
  states `ISOLATE_NETWORK`, exported with `workspaceNetwork` from
  `@nimbus-sh/core`. See docs/sandbox-sdk.md.
- npm: a malformed integrity value for a known algorithm (`sha512-` with an
  empty, non-base64 or wrong-length digest) now refuses the tarball instead
  of skipping the check. A packument whose body breaks mid-read is retried
  with its fetch. `npx --package=p tool` runs only `tool`, and plain
  `npx <pkg>` picks its bin by npm 10's rule. The shell's fallback npm reads
  specs, picks versions and checks integrity as the worker's installer does,
  and saves `npm:` aliases as written. One retry policy now serves npm, the
  install facet and git's HTTP transport.
- Shell: `diff` is a port of GNU diffutils 3.12's search, in linear memory
  (two 10,000-line files no longer exhaust the session), with GNU's output
  and exit status 2 for unreadable operands. `dirname`, `basename`, `seq`,
  `printf %b`, `df -h`, `readlink` and `sort -R` match GNU; `grep` and `cut`
  stream character devices; `type` and `command -v` report only builtins
  that run. The simulated `ip`, `ifconfig`, `route` and `netstat`, which
  were never registered, are deleted. 16 duplicate coreutils, two shell
  histories and two job tables are merged into one each.
- Node: `import()` of a CommonJS module or built-in returns one namespace
  per module, with `default` and the named exports Node detects. The Vite
  dev server again exposes every key of a CommonJS `module.exports = {...}`
  literal as a named export (for example `color-name`'s `red`), checked
  against Vite 7.3.6.
- Removed the legacy synchronous filesystem methods on `NimbusSession`
  (`vfsReadFile`, `vfsReadFileString`, `vfsStat`, `vfsExists`, `vfsReaddir`,
  `vfsWriteFile`) and their functions in `@nimbus-sh/worker/session/rpc`.
  They always acted as the kernel, stripped leading slashes and turned every
  error into `null` or an empty answer; nothing in Nimbus called them. Use
  the session's files API (`files.read`, `files.write`, and the rest) or the
  credentialed `_rpc*` methods, which act as a process's credential and
  report errors. A breaking change to a published API: `@nimbus-sh/worker`
  moves to 0.14.0, and `@nimbus-sh/sdk` to its next minor, since its
  `@nimbus-sh/sdk/worker` entry re-exports `NimbusSession`.
- Fixed: `create-nimbus-app` wrote a `wrangler.jsonc` without
  `limits.cpu_ms`, so a scaffolded session ran under the 30 s default CPU
  limit. The scaffold now writes the config that `@nimbus-sh/config`
  builds, with `limits.cpu_ms` 300000.
- Fixed: `nimbus wrangler dev` and its unsupported-binding warning refused a
  `wrangler.jsonc` with a trailing comma, which wrangler accepts. Every
  reader of the file now parses it as wrangler does, and refuses a config
  that is not an object.
- Fixed: a warm Worker Loader slot could run a stale WebAssembly image. An
  image was identified by its name, its length and its first and last
  bytes, so two images that matched there shared a slot. An image is now
  identified by its SHA-256.
- Fixed: the named preview host of a session whose id holds `--`
  (`api--team--sandbox`) did not resolve, and a capability host accepted a
  zero-padded port (`03000`) that no Nimbus URL contains. One grammar now
  parses every preview host form, as the URL builders write it.
- Fixed: the dev server served every HTML page but the root `index.html`
  (a multi-page app's `/about/`) without the error overlay, the HMR client,
  the Tailwind bundle or the mount base on its paths. Every page now gets
  the root page's dev head; only the root page gets a `<base>`.
- Fixed: an SDK sandbox whose id holds capitals, `_` or `.` (for example
  `Build_7.a`) could not finish the Agent's Cloudflare login: its OAuth
  start and callback were refused with 400.

### Breaking changes for embedders

These need a minor version of fabric and of platform at the next publish.

- fabric: the facet-ID ledger is removed: `FACET_ID_LIFETIME_BUDGET`,
  `FACET_NAME_HIGH_WATER_KEY`, `recordFacetNameMinted`, `facetNameCount`,
  `facetNameCountDurable`, `facetIdBudget` and `withFacetBudgetNamed`.
  Cloudflare does not bound the facet names an object uses: one object
  created 70,000, deleting each after use, and none failed. It bounds
  facets kept: with none deleted, one object failed at 32,240
  (2026-10-07). `facetPool` no longer refuses a new name past 65,536, and
  a start failure is no longer called permanent for the object. A
  `FacetPoolContext`'s `storage` needs only `sql`. The session
  diagnostics no longer report `facet.idBudget`. The rows the ledger
  wrote stay in storage, unread.
- platform: `SQLITE_MAX_BOUND_PARAMETERS` is removed. It was a second name
  for the same measured bound as `SQL_MAX_BOUND_PARAMETERS`, which every
  caller uses. Use `SQL_MAX_BOUND_PARAMETERS`.

## 2026-10-06: platform 0.7.2, config 0.2.4, cli 0.2.3, core 0.15.1, fabric 0.10.1, worker 0.13.3, loom 0.2.3

core 0.15.1, fabric 0.10.1, worker 0.13.3 and loom 0.2.3 had not been
published; they ship with this release and carry the 2026-10-05 entries
too. platform, config and cli move because their sources changed since
their last published versions; core, fabric and worker require platform
^0.7.2, and cli config ^0.2.4.

- Fixed: `mkdir -p` through a directory that already exists no longer fails
  with EBUSY when a process holds a lease on part of the tree. Making a
  directory that is already there is not a mutation, so no lease refuses it.
- Fixed: a named, default or re-exported import of a module lowered to
  CommonJS is now a live binding, as in Node: `import { count }` sees a later
  `count++` in the exporting module. Writing to an imported binding throws a
  TypeError. In an import cycle, a hoisted `export function` is callable while
  the other module evaluates.
- The Markflow probes run in every release gate again; they had been skipped
  since 2026-08-04. The unit suite runs sharded on Cloudflare Containers
  (`bun scripts/ci-run.mjs <commit>`), and `bun run typecheck` also checks the
  repo's JavaScript scripts and test helpers.
- A pre-bundle's slice plugin resolves through the one bundler resolver the
  VFS plugin uses, awaiting each answer, again; the synchronous driver added
  as a workaround (`createSyncBundlerResolver`) is gone. Its stall (Markflow's
  background pre-bundles waiting past 120 s once the resolver awaited) was the
  lost pump wake-up fixed in the last release: a resolve hook that awaited
  settled after a JSPI pump turn's poll loop returned but before its result
  was handled, and the loader asked for no further turn while one was in
  flight. On throwaways with the awaited resolver, Markflow failed its
  navigation 2 of 2 times with the loader before that fix, and passed 3 of 3
  with it (the one line apart); on this tree, two Markflow sessions at once
  passed 6 of 6.
- Added `CompositeVFS.route(path, { follow })` (Kinu's ask 23). It answers
  `{ point, source, path, absentReason? }`: the mount an operation on that path
  lands on, the backend view that operation uses, and the path inside the
  mount. It is the same lookup every operation makes, root links and lexical
  `..` included. An absent mount answers `source: null` with its reason.
- Added `observeWrites(observer, { wants? })` on `CompositeVFS` and `SqliteVFS`
  (Kinu's ask 24). It reports each landed mutation once, as
  `{ type, path, oldPath?, before, after, principal }`, in commit order:
  writes, creates, deletes, renames (both paths), truncates, copies and
  attribute changes. `before` and `after` can be read until the observer's
  callback settles. A refused or rolled-back write reports nothing. Writes on
  backends that do not report their own take one turn per namespace while
  someone observes; unobserved writes cost the same as before.
- Fixed: the bundled React Fast Refresh plugin shipped react-refresh with
  `$$typeof` rewritten to `$typeof`, so a `memo` or `forwardRef` component
  lost its state on every edit. The plugin is now built from the lockfile's
  pinned inputs inside `bun run bundle`, and checked like every other asset.
- Fixed: `http://[::1]:<port>` from a node program now reaches the session's
  own server, as `localhost` does.
- Fixed: `os.constants` and `node:constants` now come from one errno, signal and
  priority table, so the two agree with each other and with Node.
- Fixed: ES module lowering treated a string export named `"*"` as the whole
  namespace, and a pre-bundle could miss an import that followed JSX or a TSX
  generic function type. Modules are now read by one JSX/TS-aware import lexer;
  a file it cannot decide is parsed in full.
- Fixed: two Durable Objects building at once could fail each other's builds
  with "Cannot perform I/O on behalf of a different Durable Object", or leave
  one waiting forever (Kinu's ask 22). Every object's build facet runs in one
  isolate on one rolldown binding, and the binding ran its work where it was
  last woken: its pump, started by one object's build, dispatched another
  object's plugin hooks in the first object's context. The binding still
  serves every object from one isolate (an isolate per object measured about
  46 MiB more per workspace that builds), but each facet call now runs in a
  lane of its own (napi-wasm-loader's `callLanes`): a threadsafe function
  calls JavaScript in the lane of the call that created it, its release and
  emnapi's other work (finalizers, a closing function's finalize) run in a
  call's lane, and the pump runs in the lanes of the calls in flight and where
  it last ran, so no hook runs in, or waits on, another object's context. A
  lane ends with its call. An async work completes in the lane of the call
  that created it and computes in whichever call gets to it first; works past
  emnapi's pool of four wait in the loader, since emnapi lets a queued work in
  from inside another work's step, where it then completed. The esbuild facet
  needed nothing: each call runs its own esbuild, whose timers and callbacks
  are that call's.
- Fixed: a build whose Durable Object is reset under it no longer stays on the
  shared binding for good. Workerd drops a reset object's continuations,
  `finally` included, so its call never settles; each such build kept its
  rolldown task, its share of the binding's memory and a call in the facet's
  in-flight set until the isolate went (fifty resets of one object in workerd:
  the binding grew from 6.3 to 34.3 MiB, with 50 calls in flight). The facet
  now runs its calls through an instance of its Durable Object
  (`callLanes().instance(id)`), of which there is one at a time, so the next
  instance's first call takes over the lanes the last one left: the binding
  refuses what it awaited there (the rejection handler it gave each promise's
  `then` or `catch`), the task ends and its memory is reused. Fifty resets now
  leave no lane or call behind, and the binding stays at 6.4 MiB. An object
  that never builds again keeps its lanes until the isolate goes, as before.
- Fixed: in workerd, emnapi stopped running finalizers once a garbage
  collection first reached one. Workerd runs FinalizationRegistry callbacks in
  its global scope, where setting a timer throws ("Disallowed operation called
  within global scope", logged once per run), and emnapi had marked its
  finalizer drain scheduled before the timer threw, so it scheduled none
  again. The drain now runs in a call's lane, or the next call's.
- Fixed a lost pump wake-up: a napi callback that woke a task while a JSPI
  pump turn's result was still queued asked for no further turn, so the task
  waited for some other event.
- The staged napi-wasm loader is rebuilt through its recipe: it carries the
  lanes, and the WASI filesystem codec as it stands in core now (the staged
  one predated core's later filesystem changes).

### Git at scale

- `git clone` no longer holds a pack in memory, and every clone checks
  out one way: prepare, batches, finish. A server without `filter` or wants
  by id sends one pack, as git would fetch it; it is stored and indexed as
  it arrives, its decoding continues from the stored bytes, and the
  checkout is planned from it and written by batches that read their blobs
  from it (cf-git's clone and its chunked checkout are gone). A server
  that offers
  `filter` and wants by object id (GitHub, GitLab) gets the fast path
  (`git/pack/`): prepare fetches the commit and its trees (`filter
  blob:none`), plans the checkout from them and writes the repository's
  metadata; batches of ~2,500-6,000 blobs, two at a time, are fetched by id
  and each blob is written at its paths as it resolves; finish writes the
  index (with git's TREE extension) from the stat the session reported for
  each file, so `git status` is clean without reading them. A clone follows
  tags as git's does (`include-tag`; the tags of what it fetched are
  written). Every pack is
  decoded as it arrives (native zlib, SHA-1 and CRC, a byte-bounded
  delta-base cache, evicted bases re-read by range), stored by ranged
  appends and indexed in the same pass; its `.idx` is byte-identical to
  `git index-pack`'s. A delta chain is applied one delta at a time. Packs
  are installed one way (`git/pack/install.ts`, git's order: idx under a
  temporary name, .promisor, pack, idx last); a resumed pack records its
  outcome before it is named, so a step run again after its answer was
  lost finishes the naming. A decoding pass stops at a work budget (a third of
  the facet's measured 30 s CPU limit) or 400 store reads and continues in
  another invocation from the stored pack. Live, depth 1 (before → after):
  express 4.4 → 3.1 s; vscode 88.6 → 60.9 s (one batch at a time);
  next.js 147 → 73.5 s;
  TypeScript failed (CPU limit in prepare; a reset in checkout) → 86-102 s,
  3 of 3; Linux failed ("exceeded memory limit" in prepare) → 224-251 s,
  99,648 files, 1.65 GB, session peak 80 MiB.
- `git clone --filter=blob:none | blob:limit=<n>[kmg] | tree:<depth>`: a
  partial clone, recorded as git records one (repositoryformatversion 1,
  `remote.origin.promisor`, `partialclonefilter`, a `.promisor` file beside
  every pack). Missing objects are fetched on demand from the promisor
  remote (`git/promisor.ts` `fetchMissingObjects`, one request, resolved
  once the pack and its idx are durable): `checkout`, `reset --hard` and
  `merge` prefetch the commits' trees and then blobs, `diff` its pairs'
  blobs, each in one request; any other read that misses fetches lazily.
  Other filters are refused by name, and so is `--filter` against a server
  that cannot serve it (no `filter`, or no wants by id), before anything is
  written. Staged and committed objects are local (loose): a prefetch never
  asks the promisor for them.
- `git clone --no-shallow` takes the fast path for its worktree and then
  fetches the history in self-contained pieces: every commit (`filter
  tree:0`), the trees of 5,000 commits at a time (`filter blob:none`), and
  the blobs met there, deduplicated and sorted by basename, 10,000 by id
  per request. Live: react in ~130 s (git clone: 17 s), ~137.8 MB (git's
  pack: 137.2 MB, +0.4%) in 22 requests (git: 3); vscode in 635 s
  (git: 169 s), 1.31 GB of history in 89 requests, session peak 82 MiB.
- `git fetch` and `git pull` store the pack as it arrives (cf-git's
  side-band demux now waits while 64 packets sit unread, and `_fetch` hands
  the stream to the filesystem's `packs.ingest`), complete a thin pack as
  `index-pack --fix-thin` does, and read packed objects by range. Refs and
  `.git/shallow` move only after the pack and its idx are durable; a fetch
  whose pack fails leaves no temporary file. `git
  fetch --depth <n> | --deepen <n> | --unshallow` deepen a shallow clone
  (one request, decoded in one invocation).
- Packed objects are read by range everywhere (`git/pack/store.ts`: an
  idx a 64 KiB page at a time, packs in 1 MiB pages, an object of any size
  included), in the session and in the facet, never a whole pack; the
  facet's reads skip the session's content cache.
- `status`, `diff`, `add`, `commit`, `ls-files`, `reset` and `checkout` read
  the index as its own bytes and walk the worktree a directory at a time
  (`git/worktree/`), at Linux's scale; see the runtime spec.
- The session ingests a clone's waves wider (up to 1,024 paths and 256 KiB
  of path bytes per W7 batch, a 64 KiB decoder read-ahead): one writer
  338 → ~780 files/s.
- Retries: one lost-transport policy (`git/pack/transport.ts`), three
  tries 1 s and 3 s apart (jittered), for an idempotent request to the git
  server (a connection failure, HTTP 502, 503, 504 or 522-525 before its
  body, no headers in 45 s; cf-git's fetch, pull and push included) and for
  a clone's batch or history piece (its request failed so, its write wave
  to the session lost its connection, "Network connection lost", or it ran
  past 150 s), each failure written to the terminal. A piece that hung
  loses its write authority first: the clone's lease passes to a new owner
  (`SqliteVFS.rotateExclusiveMutation`) and its late writes are refused;
  an abort does the same. Finish, budget overruns and other errors are not
  retried.
- A git command run in a repository whose clone is still running refuses
  (`fatal: '<dir>' is still being cloned`). A failed clone's abort deletes
  `.git` file by file (one recursive delete passed a write group's row
  limit).
- Every pack the git facet installs gets its reverse index (`.rev`), byte
  for byte what `git index-pack --rev-index` writes. A clone writes
  `packed-refs` as git clone does (the remote-tracking branch, or a cloned
  tag and its peeled id), and the local branch, `origin/HEAD` and followed
  tags loose: `tests/unit/git-clone-matches-git-workerd.mjs` compares HEAD,
  config, packed-refs, shallow, every ref and the index with git 2.53's
  depth-1 clone. A command's one-shot pack read caches only the bases its
  delta chain is built on, as git's delta_base_cache does.
- Live, on a throwaway (2026-10-06, release head): next.js depth 1 in
  32-50 s, 20 of 20 with no piece retried; TypeScript depth 1 in 37-62 s;
  Linux depth 1 in 170-191 s; react `--no-shallow` in 107-123 s; vscode
  `--no-shallow` in 548-587 s (the previous release candidate: 714 s and a
  hang). A clone piece may run 300 s before it is taken as hung.

### Session ingest and write waves

- One wave writer for every W7 producer (`@nimbus-sh/platform/wave-writer.js`:
  git, npm's install facet, the installer bins and the clang sysroot), with
  one lost-call policy (`lost-call.ts`): a wave nothing reads for 10 s, or
  unanswered 20 s after it ends, is sent again on a fresh call, up to six
  times with backoff. Each attempt carries a fence: the session admits a
  wave only under a writer epoch it issued and holds open
  (`openWaveWriter`), and refuses an attempt older than one it has seen, so
  a re-sent wave's late original never applies.
- Fixed: two concurrent write streams could wait forever on the 1 MiB
  small-request reserve, each holding its own group and file; a stream now
  gives back every lease it holds before it waits for credit.
- A write stream authorises a group of files at once, in the turn that
  commits them; W7 decode makes no encoder per record. A directory's mtime
  and ctime move when its entries change, and a stream's directory records
  commit in batches its plan can hold.

### Resident WASI filesystem

- A WASI guest whose engine can park answers from a resident store of its
  own, with one copy of a file's bytes; a change by path settles held
  writes first, a held file's pinned copy is one version's, and a CPython
  start that failed is ended and named before any port is advertised.

### Known: rollout right after a deploy

- A clone started within about a minute of a fresh deploy may meet
  Cloudflare's version rollout: seen once as a clone batch that hung until
  its 300 s timeout (retried behind its fence; the clone completed) and
  once as a session reset (WebSocket 1006). Neither recurred in 20 clones
  in steady state.

### Breaking changes for embedders

- `nimbus install` reads the runtime catalog by its SHA-256 and nothing
  else. The Worker that binds `NIMBUS_RUNTIME_CACHE` must carry the var
  `NIMBUS_RUNTIME_CATALOG_SHA256`, which `nimbus runtime sync` prints after
  filling the bucket (`buildNimbusWranglerConfig({ runtimeCatalogSha256 })`
  carries it). The catalog is read from `catalog/sha256/<digest>.json` and
  served only if its bytes hash to the var. A missing var, a missing object
  or other bytes fail the install with a message that names which. Before,
  every deployment read `catalog/v1.json`, so a publish for one deployment
  changed what all of them installed. `catalog/v1.json` is still written,
  for deployments built before this change. Re-run `nimbus runtime sync`
  once to write the catalog under its digest and get the value.

### Synchronous stdin, sockets and TLS

- Fixed: a child stopped at a synchronous stdin read releases its Dynamic
  Worker launch admission while it waits. A replay queues fairly to regain
  admission before preparation, so stopped children cannot prevent a
  sibling from running; killing a wait or a queued replay leaves no hold.
  Post-read supervisor calls and outbound requests wait for the replay
  boundary acknowledgement, so they cannot be mistaken for pre-read work.
  If the ledger refuses a replay, a child that already started reports the
  refusal on stderr and exits; only an initial admission can fail its spawn.
  Native sockets and TLS carriers also wait for the replay boundary; a
  refused notice destroys the socket with the original error before connecting.
  Immediate TLS writes and ends remain buffered until the carrier is adopted;
  destroying its returned socket cancels the pending carrier and registration.
  Repeated in-flight read attempts join before journaling, so a transport
  hedge cannot be mistaken for an extra pre-read observation.
  A journaled run also keeps bounded settled read replies until its writer
  ends: a lost response resent after settlement cannot consume a second
  observation. Exceeding the retention bound forbids a later replay by name.

- Fixed: synchronous-stdin replay is fail-closed at the session boundary.
  Every supervisor operation has an explicit observation, effect, or
  input/output-protocol classification; unknown operations forbid a later
  replay. Caller pids are stamped from their bindings, acquired filesystem
  bytes and namespace metadata are checked, and fd-0 preparation no longer
  exempts ordinary reads of the same file. Reaching fd 0 before a previously
  completed observation is delivered fails loudly without consuming new
  input. Recorded GETs deliver headers immediately and record their streamed
  bodies and errors; a still-unfinished body forbids a later replay.

- Fixed: a synchronous read of stdin waits for its input, as Node's does,
  and only a read that runs waits. `fs.readFileSync(0)` (and `/dev/stdin`)
  waits for the end of stdin and `fs.readSync(0, …)` for any of it, so a
  child can print READY and have its parent write only then, a parent can
  write in delayed pieces, and a readSync prompt answers each line as it
  comes. A Nimbus process cannot block, so the run stops at such a read
  (`ctx.abort`, which the program cannot catch), the session waits for the
  input, and the program runs again from its start with it: the second run
  replays what the first drew (its random numbers, clock readings, random
  bytes and stdin reads) and the output it already printed is checked and
  not shown twice. What the session told the first run is journaled there,
  out of the program's reach, and the second run must be told the same in
  the same order: a file that changed while the program waited ends the
  second run loudly instead of letting it go on with the new bytes, as
  does any other way the second run strays before the read. Such a
  program's network goes through the session too: a GET (`fetch`,
  `https.get`) is recorded with its status, headers and bytes, and the
  second run is handed the same response however it reads it; a request
  still on its way at the stop is answered only past the read; and
  `tls.connect`'s TLS session is made by the session, which sends the
  server name the program gives (workerd's own node:tls sends the host). A
  client certificate (`cert`, `key`, `pfx`) or a TLS session over a socket
  the program opened (a STARTTLS) fails by name; a CA the program names
  (`ca`) is not used, as workerd's own node:tls does not use it, and a
  session that fails says so. Once such a program has done something
  outside itself, nothing more it reads is recorded and its network goes
  straight out. Only Nimbus can stop a run this way: a program that forges
  a stop is not believed. A program that never makes such a read, or finds
  its input there when it does, runs once and is never held: the guess
  about which programs read stdin, made from their code before they ran,
  is gone, and with it the read ahead of their pipe. So `sleep 30 | node
  -e "function u(){fs.readFileSync(0)} console.log(1)"` prints at once,
  and a child whose code merely mentions such a read no longer waits for a
  stdin its parent leaves open. A program that changed something outside
  itself before the read (a file write that reached the session, a spawn,
  a request other than GET) cannot be run again, and the read fails with
  `ERR_NIMBUS_SYNC_STDIN` naming that change, as does one that read
  `process.stdin` as it arrived first; opening a connection counts as such
  a change, however it was opened (node:net, node:tls, or workerd's own
  socket class). What arrives on stdin while the program runs reaches a
  later synchronous read, its end too, so a program its parent finishes
  writing to before it reads never has to stop. Ctrl-C during the wait
  ends the program with 130; a pipe that passes 16 MiB without ending
  fails the read naming the bound, and output a piped program printed
  before such a failure is still handed on, as is what it printed before a
  second run that strays. A server the SDK starts with its stdin open
  waits for what its caller writes the same way; one started from the
  terminal answers such a read with `ERR_NIMBUS_SYNC_STDIN`, as nothing
  can write its stdin while the shell waits for its boot.
- Fixed: bytes a parent wrote to a child's stdin faster than the child
  read them were dropped past the child's 256 KiB queue, all of them when
  written before the child had started. A write waits for room now, as a
  full pipe holds its writer, and goes in pieces no larger than the queue,
  so one write larger than the queue gets through instead of never fitting.

## 2026-10-05: core 0.15.1, fabric 0.10.1, worker 0.13.3, loom 0.2.3

loom moves only its fabric range.

- A session the platform could not reach answers 503 with a named code, not an opaque 500. When Cloudflare reports a Durable Object overloaded, or reset because its code was updated, the router and the remote API answer 503 with `E_NIMBUS_DO_OVERLOADED` or `E_NIMBUS_DO_CODE_UPDATED` and `Retry-After: 5`. Nimbus does not retry these calls itself.
- Fixed: `git clone --no-shallow` made a depth-1 clone. The git facet replaced a missing depth with 1, so the flag never reached isomorphic-git. A clone without a depth now fetches the whole history.
- The Vite dev server's persistent caches answer only the request that
  made a row. A transformed module (user_module_transforms) is keyed on
  the whole request: the transform's options with vite.config's `define`,
  the router basename injected, and what the import rewrite reads (the
  aliases, the base, `package.json#imports`), beside the engines. Before,
  a row made under one `define` or `resolve.alias` was served after the
  config changed. A pre-bundle (pkg_esm_bundles) is keyed on its build
  options, externals and every manifest its build consulted (each
  package's package.json, the closest one to each file it bundled, a
  nested or workspace package's too): a dependency reinstalled at another
  version was served (and skipped by the installer) as its old bundle.
  What a row is keyed on is what it was made from, read once: a module's
  `#` imports resolve against the package.json read when its request was
  made, not one edited during its transform; a build's manifests are
  recorded as it reads its files, absences included (a nested
  package.json that is not there yet would be the closer scope), and a
  bundle whose manifests changed while it was built (a reinstall, a
  package.json that appeared or went), or that the build itself read as
  other than recorded, is served but not stored. The installer
  and the dev server pre-bundle with one define (core `PREBUNDLE_DEFINE`),
  so either's row is the other's; the installer's had none, and the dev
  server's carried vite.config's `define`, which a pre-bundle no longer
  takes, as Vite's dependency optimizer takes none of it. Its
  `process.env.NODE_ENV` ("development") is what Vite's optimizer defines;
  its `global` (globalThis) and `import.meta.env` values (DEV, PROD, MODE,
  SSR, BASE_URL "/") are Nimbus's own, kept from the dev server's
  pre-bundles (worker `npm/cache-keys.ts`). A `#` import whose target file
  is missing is now rewritten to its URL (a 404 in the browser), where the
  specifier was left as written.
- An edit of vite.config takes effect in the dev server `vite` started, as
  Vite restarts on one: the server reads the config again (its
  `resolve.alias`, `define` and `nimbusInjectBasename`), drops every module
  it made under the old one, reloads the browser, and keeps the new config
  for a restore after hibernation; a config that cannot be read leaves it
  on the one it has, and root, base, port and outDir still take a new
  `vite`. An edit of a tsconfig (`tsconfig*.json`, `jsconfig.json`) drops
  every transformed module and reloads, as Vite does. A module a request
  began making under the old config is not remembered. Before, the config
  was read once at `vite`, and a tsconfig edit reloaded the browser onto
  the same modules (worker `facets/vite-config-file.ts`). A server
  restored after hibernation sends its reloads to the session terminal, as
  the server `vite` started did; before, it sent them nowhere, and the
  browser never reloaded on an edit.
- The built-in Vite dev server compiles a module as Vite 7's esbuild plugin
  does. A .ts or .tsx module's tsconfig is found and read as tsconfck 3.1.6
  reads it for Vite 7 (the closest `tsconfig.json`; a solution's reference
  that includes the module; `extends` of a path, of `.` or `..` (the
  tsconfig.json there), of a package (its `exports` conditions matched in
  their order, as Node's require.resolve matches them) or of an array;
  `${configDir}`; comments and dangling commas), unless vite.config's
  `esbuild.tsconfigRaw` is a string (then none is read, as in Vite), and
  its eleven compiler options Vite reads reach the transform:
  `jsx`, `jsxFactory`, `jsxFragmentFactory`, `jsxImportSource`,
  `experimentalDecorators`, `useDefineForClassFields` (false where neither
  it nor `target` is set, as in Vite), `target`, `verbatimModuleSyntax`,
  `preserveValueImports`, `importsNotUsedAsValues`, `alwaysStrict`.
  vite.config's `esbuild` (read statically: a computed value is warned
  about once and left out) and what @vitejs/plugin-react and
  @preact/preset-vite set in it apply over the tsconfig's JSX settings, as
  in Vite, with `jsxDev` on: React and Preact modules import the dev JSX
  runtimes, as in Vite. `esbuild.define`, `supported`, `tsconfigRaw` and
  `jsxInject` are honoured (a `#` import a jsxInject names resolves in the
  module's package scope); options the server cannot (`target` other than
  esnext, `include`, `exclude`, and the rest) are warned about once. Before,
  every module compiled with the automatic React runtime (or h and Fragment
  for one importing preact) and no tsconfig. With no vite.config and no
  tsconfig JSX setting, the server keeps those defaults (Vite would compile
  React.createElement).
- A module's `import()` and `import.meta` are kept as written, as Vite
  keeps them. Before, the transform made `import()` a `require()`, which
  the browser has not (a lazy route failed), and emptied `import.meta`
  (`import.meta.url` and `import.meta.hot` were undefined). And the import
  rewrite of a dynamic `import("pkg")` replaced the whole call with the
  module's URL, unquoted; it now rewrites the specifier.

Checks: `vite-esbuild-differential` serves 47 modules of 30 projects
(create-vite's react-ts, preact-ts, vanilla-ts and lit-ts templates as
they are, and a project per setting) and compares each, run, with what
real Vite 7.3.6 (esbuild 0.28.2) made of it, and Vite 6.4.3 (esbuild
0.25.12) and 5.4.21 (esbuild 0.21.5) beside it, recorded by
`tests/reference/record-vite.mjs` (which installs the pinned Vite,
plugin-react, preset-vite and tsconfck outside the repository) in
`tests/fixtures/vite-esbuild-reference.json`, and each module's tsconfig
with what tsconfck 3.1.6 read. Vite 5 or 6 differs from Vite 7 in two
projects, each with its reason: Vite 5.4.21 bundles a tsconfck that
replaces `${configDir}` only in the config it finds, and Vite 5.4.21 and
6.4.3 bundle one that resolves an `extends` of `.` as a directory (the
module fails). On the server before this change 39 of the first 44
modules differ.
- `experimentalDecorators` and `useDefineForClassFields: false` (or a
  `target` below es2022 that implies it) are honoured in `transform()` and
  `build()`, as 0.14.0's esbuild honoured them (0.15.0 refused every
  `tsconfigRaw`). As in esbuild,
  they change TypeScript files only. Legacy decorators are applied in tsc's
  order (instance members, then static members, then the constructor's
  parameters and the class), where Oxc's transform applies them in source
  order; class fields are assigned (static ones after the class, a static
  block still between them), and one without an initializer goes. The
  helpers they call (TypeScript's `__decorate`, Babel's private-field
  helpers) a build bundles from rolldown's own copy of @oxc-project/runtime,
  and a transform carries inline, from @oxc-project/runtime 0.152.0 (MIT),
  as esbuild's output carried its own. A build transforms such a module
  itself (rolldown's transform options are its whole build's), moving the
  source map's lines with the decorator calls it moves (core's
  `runtime/rolldown-compat.ts`).
- A TypeScript class's parameter properties (`constructor(public q)`) no
  longer get a field declaration ahead of its other fields, so its objects'
  own keys are in esbuild's order (the fields', then the parameter
  properties'); Oxc declares one, as tsc does under useDefineForClassFields,
  since 0.15.0. A field the class writes of the same name stays where it is.
- A module binding named as a global the inlined helpers or the class-field
  lowering read (`const Object = 0` beside a decorated class, a namespace or
  enum of that name, a parameter or a pattern) is renamed (`Object2`, its
  export name kept), as esbuild renames it, rather than taking the helpers'
  `Object`. The transform renames it by its symbol before lowering anything,
  so what the lowering generates for it (a namespace's `Object || (Object =
  {})`, `export = Object`, a parameter property's assignment) follows it; an
  ambient declaration (`declare const WeakMap`) is the global and keeps its
  name. A build refuses, by name, a TypeScript module whose own `WeakMap` or
  `WeakSet` (a declaration, a pattern, a parameter, a catch clause, an
  import) is in scope where the lowering of a class's private members
  creates one (rolldown's transform output does not tell its references
  from the module's); a binding elsewhere (a function's parameter beside a
  top-level class, a block's, a class expression's own name) is left alone,
  and types and ambient declarations bind nothing. An import of an
  @oxc-project/runtime helper that the module writes itself stays an import;
  only the transformer's are inlined.
- A decorated class inside a decorator factory's callback keeps every
  class's decorators in tsc's order, and their source map, in a build.
- The worker's Oxc transform is rebuilt through its pinned recipe:
  2,430,868 bytes (0.15.0's was 2,333,997 before the JSX work). The
  worker's cache keys (below) change with it, so warm sessions transform
  and pre-bundle again.

Checks: `tsconfig-jsx-differential` gains decorated classes (every kind of
legacy decorator, what each is called with and returns, tsc's order alone),
parameter properties, and field initialisers (an inherited setter, private,
computed and static fields, a static block, `this` in an initializer) under
each setting, TypeScript and JavaScript, through transform (ESM, CommonJS)
and build (ESM, CommonJS), and the reviews' cases (helper imports, shadowed
globals in every binding position, in and apart from the lowered class's
scope, namespaces and enums, nested decorator runs, written fields): 929
cases, 829 compiling, running and recording the same as esbuild 0.24.2, 63
refused by name, 37 failing where it fails; 165 of them differ on main before this change.
`build-decorators-sourcemap` checks the moved calls, flat and nested, still
map to their decorators.

- Fixed: a warm session served transforms and pre-bundles an older engine
  made. The session's two persistent build caches, the Vite dev server's
  user_module_transforms and pkg_esm_bundles (the install's pre-bundles and
  the dev server's `/@modules/`), were keyed on core's BUNDLER_VERSION
  alone, a constant bumped by hand, and core 0.15.1 changed the dev
  server's transform output without a bump: a `.ts`/`.tsx` module with an
  unused `import React` (default or `* as`) under the automatic runtime
  kept it in 0.15.0 and drops it in 0.15.1, as esbuild does, and
  `import {} from "x"` is dropped. A session that had served a file before
  the deploy kept serving 0.15.0's output for it until the file changed. That
  output still ran (an extra import of react, a kept side-effect import).
  Each key is now BUNDLER_VERSION and a digest of the code that built the
  output (worker `npm/cache-keys.ts`): for a transform, core's transform
  pipeline (TRANSFORM_PIPELINE_ID) and the service's transform host (the
  transform facet's runtime and wasm, and the esbuild facet's); for a
  pre-bundle, the build facet (rolldown, its binding and loader, the facet
  runtime with core's adapter). A new build of any of them misses every row
  the old one wrote, with nothing bumped by hand; BUNDLER_VERSION is still
  bumped for what the supervisor does around an engine (the slice walk,
  import rewriting). Rows written by 0.13.2 and before miss once and are
  rebuilt. The session's other persistent compiled store, the launch's
  transform store, already keyed on the pipeline and the host; the R2 cache
  holds only tarballs (by integrity), packuments and read profiles.

Checks: `build-cache-keys` checks each key changes with each identity it
stands for, that those identities carry the engines' builds, and that the
dev server serves neither a transform nor a pre-bundle another engine made,
nor a row keyed on BUNDLER_VERSION alone, while it does serve its own from
the cache; red on 0.13.2's dev server.
- Fixed: a session's `child_process` children ran one at a time. Every
  spawn was relayed through a Worker Loader pool of one slot, and the
  relay's call stayed open for the child's whole life, so a child that does
  not exit (a dev server, a watcher, a language server) held back every
  later spawn. A parent that spawned A (`setTimeout(…, 15000)`) and then B
  (`console.log`) saw B at 15.9 s on a local workerd, where host node
  prints it at 37 ms. Killing A freed nothing: its program ran on to its
  own end, holding the slot and its Dynamic Worker. A child that spawned a
  grandchild and waited for it deadlocked. A child still running at 120 s
  was reported closed, status 1, with `spawn-pool: Task exceeded 120000ms
  deadline` on its stderr, while it ran on. Children now run beside each
  other, dispatched from the session itself: B prints at 1.2 s, about the
  time a child takes alone; a child spawned after a kill runs at once; a
  nested spawn finishes; a child runs as long as it runs. On a deployed
  Worker, B printed at 218 ms beside a live 20 s A (a child alone: 260 ms),
  where it had waited 20.5 s. A kill ends the work behind the child's pid
  (its run is aborted, its Dynamic Worker given back), and the process
  table records it `killed`. The relay's supervisor RPC,
  `cpDispatchInline`, is gone with it; it ran a command as whatever pid
  its caller named.
- A one-shot program (`node -e`, a `child_process` child, a shell job) is
  let in by the Dynamic Worker ledger. While the Durable Object has its 10
  Dynamic Workers in flight, the program waits for a release to make room,
  before its module map is assembled, where it used to start anyway and be
  refused by the platform. A burst of 14 children runs 10 wide and
  completes. Only a kill, Ctrl-C, or the ledger's refusal of a wait nothing
  can satisfy (below) ends the wait.
- A wait for a Dynamic Worker that no release can satisfy is refused rather
  than left to wait for good. Who waits on whom is the session's own
  account, never pids a guest names: a guest holding a worker waits on its
  running children in the process table; a shell line running in the
  session (`sh -c 'node x'`, an npm script under `npm run`, a command run
  as another user) waits on the programs it started, when awaiting them is
  all its commands are doing. Every command counts as work for the pid it
  runs as, whichever shell runs it, and an npm script runs on a shell of
  its own under its wrapper's pid, which its `npm run` awaits (before, nine
  `sh -c 'npm run build'` children, each awaiting a queued grandchild,
  hung with the limit full). Between two commands, a line is the shell's
  own work: each thread of a line (the line, an element of a pipeline, a
  background job) holds a unit whenever none of its commands runs, handed
  to the next command before it is let go, so the count never dips while a
  step is still to run, whichever turn it starts on (before, in
  `node x | (sleep 10; kill $(cat x.pid))` the line looked wait-only the
  instant `sleep` ended, and the ledger refused a grandchild the `kill`
  was about to make room for). A guest says when its only remaining
  work is waiting on its children (its event loop, top-level `await`
  included, has no timer, socket, server, stdin read or fetch of its own
  pending). The session numbers each piece of news of a guest's children as
  it is produced (a start, output, the end of a stream, an exit, a refused
  spawn); the reply that delivers it carries the number, and the guest
  acknowledges the contiguous run it has applied, whatever order the
  replies came in. Its report counts only while that run is everything
  issued, and a report older than the last taken is dropped. A process is
  stuck when it is in that state and each process it waits on is queued for
  a worker or stuck too; a builtin running (`sleep`) never is. When every
  worker in flight is held by a stuck process, the newest queued process a
  stuck one waits on is refused, never on the synchronous path of the
  change that showed it: the decision is taken on a later turn, on the
  ledger as it is then. That child's spawn fails as Node's does at
  a process limit: an 'error' event (`spawn node EAGAIN`, errno -11), no
  'spawn', no 'exit', no pid, and 'close' with -11. Its program never runs;
  whoever waits on it hears it and can go on. Nine children each doing
  nothing but wait on a grandchild (in a callback, a top-level `await`, or
  under `sh -c`) get one EAGAIN and eight runs; the same nine with a
  `process.exit(0)` scheduled keep waiting and complete; two `spawnSync`
  chains that fill the limit get one EAGAIN and both finish. A process that
  does not say (a resident, a non-Node runtime) is taken to end on its own.
  The protocol is checked over every interleaving of reports, news (sent and
  delivered out of order), exits, admissions and refusals for small
  families, wired to production: the real ledger, the session's process
  table and its work and await accounting, and the guest's news tracker
  from the very source the shims embed (`dynamic-worker-protocol-model*`);
  mutants of each are caught.
- A child's pid is published, and 'spawn' emitted, once the session has
  admitted it or its first output arrives, as Node publishes them only for
  a spawn that succeeded and always before the child's output; a refused
  child never has either, and has one 'error', whichever of the parent's
  waits hears of the refusal, or both (the exit-time drain gave it an
  'exit' with -11, and both hearing it gave two 'error's).
- Fixed: a `child_process` child ended by a signal reported the shell's
  status to its parent. 'exit' and 'close' gave (143, 'SIGTERM') for every
  signal but SIGKILL (137), SIGINT included, and `exitCode` was 143. They
  now give Node's (null, signal) for `kill()`, `kill('SIGKILL')`,
  `kill('SIGINT')` and any other terminating signal, by name or number;
  `exitCode` is null and `signalCode` names the signal. The process table
  keeps the status, 128+signo. `kill()` on a child that has exited returns
  false, as Node's does. spawn, spawnSync, exec and execFile take `timeout`
  and `killSignal`: spawnSync's result is then `status: null` with the
  signal and an ETIMEDOUT `error`. execFile's and exec's error carries
  `code: null`, `signal`, `killed` and `cmd`, with Node's message
  (`Command failed: <cmd>` and the child's stderr), and a spawn's own error
  reaches their callback. The parent's view is compared with host node's.
- Fixed: a child spawned right after its parent wrote a file could miss
  the write. A synchronous write is parked in the parent until a write-back
  carries it to the session; a child spawned at once could launch first and
  fail `cannot find module` on the script its parent had just written (the
  first of eight such children, every run). The parent's parked writes now
  reach the session before a child is launched, and before anything is
  written to a child's stdin, as they already did before a fetch or a
  socket frame.
- Fixed: a child whose output its parent never read exited but never
  closed: its unread stderr (an error message) held 'close' back for good,
  and a parent waiting for 'close' waited with it. Unread output is now
  drained after 'exit', as Node's `flushStdio` does, and 'close' follows; a
  stream a consumer reads in readable mode (an async iterator until it
  completes, a 'readable' listener while one is attached) is left to it,
  as Node leaves one; once the last 'readable' listener is removed, it is
  drained again. A failing child's
  exit no longer prints a dump of its output to the terminal either: its
  output and its end are its parent's to report.
- Fixed: `process.exit()` in a `child_process` child whose stdin was still
  open did not end it. The child had read its input and exited 0, but its
  run then waited for its stdin pump, which ends only when the parent ends
  the pipe: the child never closed, its Dynamic Worker stayed held, and
  nine such children with their parent wedged the session (every later
  launch waited for room). No input was lost: traced per child, the broker
  queued 3 bytes, the child took 3 and printed them. A program that calls
  `process.exit()` now ends at once, its stdin included. So does a parent
  that calls it while a child it listens to still runs; it used to wait
  for that child to close. Both are compared with host node.
- Fixed: after `npm install` in a session, every later `child_process`
  child hung, even `console.log('x')`, while terminal one-shots ran. A
  launch too large for one Durable Object turn (the installed tree made
  every launch in it one) is paced across turns, and the turn that granted
  its last chunk was held until the program ended: the session's launch
  alarm was held for the parent's whole run, and the child, whose launch
  needed a turn of its own, never got one. The turn is released once the
  program is loaded and entered, as a resident launch's is once it has
  booted. On a local workerd the child printed in 1.75 s after
  `npm install ioredis`, where it was still waiting at 90 s.
- Fixed: a `sh` child (`spawn('sh', ...)`, `exec`) ran on the session's own
  shell, which saved and restored its cwd and variables around the line.
  With children running at once, two of them read and restored each
  other's state (one's `$TAG` and `pwd` were the other's), and the eleventh
  at once was refused as recursion. Each now runs on a shell of its own
  (`NimbusWorkspace.shellFor`), from its own cwd and environment, whose
  descriptors close as it ends.
- A child's launch is admitted once on the Dynamic Worker ledger, before
  its preparation: its transform, its prebundle and its program are that
  one worker in turn, so its preparation never waits on room its own
  admission holds. The program claims the admission whatever pid its
  runtime runs it as (Bun's runner allocates its own; a Python, Ruby or
  wasm runtime dispatches to a pool), where a `bun -e` child taking the
  tenth worker waited for room its own admission held. A transform, build
  or esbuild call outside a launch waits its turn. Before, the transform
  facet of `node child.ts`, spawned with the limit full, was an eleventh
  worker the platform refused, and the child exited 1.
- Killing a child runs the session's own kill of its pid before the broker
  stamps the exit: its ports, RPC resources and relayed sockets are
  released, and its exit reported to its parent rather than the terminal.
  A child killed before its program started never starts it.


- Fixed: `build()` and `transform()` refused any `tsconfigRaw` (Kinu ask),
  and `build()` refused esbuild's own `jsx`, `jsxFactory`, `jsxFragment`,
  `jsxImportSource` and `jsxDev`, though both still declared them and
  0.14.0's esbuild honoured them; `transform()` dropped `jsxImportSource`
  and `jsxDev` without a word. Kinu's
  `build(['/a.tsx'], { tsconfigRaw: '{"compilerOptions":{"jsx":"react-jsx","jsxImportSource":"react"}}' })`
  was refused, where 0.14.0 bundled it to
  `import { jsx } from "react/jsx-runtime"`. Now both read JSX from both
  sources as esbuild 0.24.2 does (core `runtime/tsconfig-raw.ts`):
  `compilerOptions.jsx` `react`, `react-jsx` and `react-jsxdev` (in any
  case), `jsxFactory`, `jsxFragmentFactory` and `jsxImportSource`, applied
  over the options, as esbuild applies them, except that nothing undoes
  `jsx: 'preserve'`; `preserve`, `react-native` and unknown values are
  ignored, as esbuild ignores them; an import source and development only
  apply to the automatic runtime, a factory only to the classic one; the
  own `jsxFragment` may be a constant (`0`, `'"frag"'`, `null`) and the own
  factory may not be a keyword, as esbuild's validateJSXExpr reads them. The
  automatic runtime and preserved JSX no longer keep a TypeScript file's
  unused `import React`, as esbuild drops it; in development the automatic
  runtime's `createElement` fallback (a key after a spread) gets the props
  alone, without Oxc's `__self` and `__source`. A tsconfig's comments end
  where esbuild's do (a `//` comment at any line terminator; an unterminated
  `/*` is esbuild's error). Of the other fields esbuild reads:
  `preserveValueImports` (KeepValues) keeps unused value imports;
  `importsNotUsedAsValues` `preserve` and `error` (KeepStmt) keep an import
  statement as `import "x"` though nothing of it is used;
  `verbatimModuleSyntax` does both. Without KeepStmt, an import left with
  an empty clause (`import {} from "x"`, or every specifier a type) is
  dropped, also with no tsconfig, as esbuild drops it (Oxc and rolldown kept
  it). rolldown's one option is both flags at once; a build with either
  alone compiles its TypeScript modules keeping every import and makes each
  what esbuild keeps of it (see rolldown-compat.ts below).
  `alwaysStrict` (else `strict`) makes every file strict code: what only a
  sloppy script may contain (`with`, a legacy octal, `delete x`, ...) is an
  error in a transform, as in esbuild, and CommonJS and IIFE output begins
  with `"use strict"`. `target` decides `useDefineForClassFields`; `baseUrl`
  and `paths` are ignored, as esbuild ignored them here (the build's plugin
  resolves every import), and `extends` is ignored by a transform, and by a
  build when it names no file (`[]`, `null`). Refused by name, and only
  where esbuild's output would differ: `experimentalDecorators: true` for a
  TypeScript file with a decorator, `useDefineForClassFields: false` (or a
  `target` below es2022 that implies it) for a TypeScript class with a
  public or static field, each placed at that decorator or field; and
  `extends` naming a file in a build (esbuild failed reading it). esbuild's
  warnings about a tsconfig (a misplaced option, an invalid factory, an
  unknown target) are reported, without their place in it. Known gap: in a
  build under `alwaysStrict`, sloppy-only syntax in a CommonJS module is not
  a build error, as it was in esbuild: rolldown's parser reports none of
  those errors, so the bundle (strict, as esbuild's) fails when loaded. And
  under `preserveValueImports` or `verbatimModuleSyntax` (which keep unused
  names), a TypeScript import of a name its module exports only as a type,
  without `type`, is a build error ("is not exported"), where esbuild left
  it undefined; tsc rejects such an import under either setting.
- In a build, the development runtime's `jsxDEV` names each file by its
  absolute path (`fileName: "/home/user/app/src/App.tsx"`): rolldown gave it
  relative to its working directory (`home/user/…`), and 0.14.0's esbuild
  put its plugin namespace before it (`nimbus-vfs:/home/user/…`). The build
  facet transforms such a module itself with rolldown's own transform, given
  the absolute path; its source map is unchanged. A transform has no path,
  and names the file `<stdin>`, as esbuild did.
- What a build compiles itself so a module comes out as esbuild made it (the
  development runtime, a constant fragment, the unused-import flags, empty
  import clauses, the refusals) is core's
  `runtime/rolldown-compat.ts`. It reads modules with rolldown's own parser
  and compiles them with its own transform; it edits only that transform's
  output, at parsed nodes, keeping every position, so the transform's
  source map stays the map. No module's text is edited before rolldown
  reads it. Its imports are paired with the source's by the bindings they
  make, so an import the transform adds (the automatic runtime's, its
  `createElement` fallback's) is never taken for one of the module's; where
  a pairing is not known the build fails saying so, rather than compile
  the module otherwise. Under `jsx: 'preserve'` it compiles JSX to JSX. A
  constant fragment's placeholder is a name no identifier of the module
  has, however its source spells it (a binding written
  `\u005f_nimbusJsxFragment` no longer collides), in both engines; a
  string fragment's line and paragraph separators are written escaped, so
  no line of the output moves.
- The worker's Oxc transform (`scripts/oxc-wasm`) takes an import source,
  the development runtime, esbuild's KeepValues and KeepStmt, a constant
  fragment, `alwaysStrict` and the two refusals; rebuilt through its pinned
  recipe, 2,333,997 bytes (was 2,276,933). Its KeepStmt no longer takes an
  import the transform added (the JSX runtime's, which has no place in the
  source) for the module's first import, so it keeps that one too.

Checks: `tsconfig-jsx-differential` runs 629 cases against esbuild-wasm
0.24.2: every JSX mode and source and their precedence (tsx and jsx), each
other field on a source that shows it (each unused-import flag on imports of
every shape: unused values, inline types, empty clauses, a brace in a
comment, a name only a type, a type-only import of the module the JSX
runtime then imports from, preserved JSX), through transform (ESM, CommonJS)
and build (ESM, CommonJS, IIFE). 576 must compile, run and record the same imports
and calls as esbuild's output (two outputs that fail alike are no pass); 16
are refused by field name where esbuild's output runs; 37 must fail where
esbuild fails. `build-tsconfig-sourcemap` checks a build's map under each
unused-import flag, and after a fragment of a line separator, still maps
each token to its own column.
`facet-host-tsconfig-jsx` runs Kinu's repro through `supervisorEsbuildService`
from the `facet-host` entry with both facets as production loads them.

## 2026-10-04: platform 0.7.1, worker 0.13.1

- Fixed: worker 0.13.0 imports `recordSupervisorAnswer` from
  `@nimbus-sh/platform/diag-counters.js`, which platform 0.7.0 does not
  export: platform's source gained it after 0.7.0 was published, and its
  version was never bumped, so the release skipped it. Every module that
  loaded the worker failed with "Export named 'recordSupervisorAnswer' not
  found". Platform 0.7.1 exports it, and worker 0.13.1 requires
  `@nimbus-sh/platform` `^0.7.1`. Worker 0.13.0 is deprecated.

## 2026-10-04

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

- Fixed: every outbound WebSocket a process opened (`ws://` or `wss://`)
  failed with "Fetch API cannot load: wss://...": the session fetched the
  socket's own URL for the upgrade, and workerd's fetch takes http(s) only.
  The upgrade is now fetched from the same address over http: or https:.

- Fixed: a process whose release failed (a descriptor's buffered bytes lost
  to an abort) stopped the prune of a session's or workspace's ended
  processes: that pid and every one after it stayed bound to the
  filesystem, and an unrelated launch that pruned first failed with the
  other process's error. Every ended entry is now released and forgotten.
  A prune by age writes a failure to the failed process's own stderr log; a
  workspace exec reports its own tree's failures after all of it is gone.
- A file written a piece at a time through an open descriptor is stored a
  block at a time. `yes | head -c 48M > f` took 43 s on a local workerd:
  each 8 KiB write rewrote the file's growing last chunk (3.5 bytes stored
  per byte written) and paid its own commit; it takes 2 to 5 s on the same
  machine under load. SQLite's filesystem now holds a descriptor's appends,
  up to 1 MiB and 100 ms, and stores them then, at fsync and close (the
  shell fsyncs each command's redirections as it ends), and before anything
  else looks at the store: a read, stat, listing, revision, the change feed,
  a snapshot or another write sees them, in the order they were made, with
  the mtime of the write that made them (`node -e "write A; appendFileSync
  B; write C" >> log` is ABC). A held append the store refuses is the next
  write's, fsync's or close's error, of the descriptions that wrote it;
  refused as a command ends, it fails that command (status 1, its message on
  its stderr). A host whose isolate dies holding appends loses them, as a
  machine loses its page cache: fsync (on any descriptor of the file) and
  close are the durable boundary. A descriptor opened `sync` (O_SYNC; a
  facet process's, through the supervisor) holds none, on SQLite or on a
  mount that cannot write in place, so each of its writes is answered with
  what the store did. `yes` yields once per 512 KiB, not per 8 KiB, so a
  pipeline's turns are not each a commit.
- Fixed: a shell builtin whose write the store or a device refuses fails,
  with status 1 and its message on its own stderr. `echo x > /dev/full
  2>/dev/null; echo rc=$?` ended the script with status 2 and the message
  on the shell's stderr: the refused write was the shell's error.
- `/api/_diag/memory` reports `counters.supervisorAnsweredBytes`, the file
  contents and stdin the session has handed its processes (counted once,
  where a supervisor envelope's answer leaves the session), and
  `stdinReadAhead` (`heldBytes`, `peakBytes`, `capacityBytes`), the pipe
  read ahead launches hold for their synchronous reads of fd 0.
- Fixed: in the library host under Bun, a program's realm kept Bun's
  web-worker globals, which hosted Nimbus (workerd) does not have: `Worker`
  (a worker of the host engine's own), `prompt`, `alert` and `confirm`
  (they read the host process's stdin), `postMessage` and `onmessage` (the
  worker's channel to the host). They are gone before a program runs, in
  `node` and in the wasm runtimes' realms alike. `Bun` itself cannot be
  removed from any Bun realm (Bun 1.4 makes it and its members
  non-configurable, a ShadowRealm's included), so under Bun a program can
  still reach the host machine's files, processes and network through it.
  The library host is not a boundary against the host machine; under Node
  no such namespace exists.
- Fixed: the library host's `require` of a module it cannot find threw an
  Error without Node's `code: 'MODULE_NOT_FOUND'`; and its `util.format`
  (console.log) quoted string arguments (`console.log(true, 'x')` printed
  `'x'`) and lacked `%i`, `%f` and `%c`. Both now match Node.

- `@nimbus-sh/core`: each facet of `localFacetHost()` runs in a realm of its
  own, a worker thread under Node, as the inline `node`'s programs do, and a
  child process under Bun (Kinu ask 17, local-facet-host.ts:183). The facet's scope was built in the host's realm,
  so what a program reached of JavaScript was the embedder's: a Ruby
  program's `JS.eval("globalThis.Promise = null")` broke the host's shell
  ("null is not an object (evaluating 'Promise.allSettled')"), and
  `Array.isArray`, timers and `Object.prototype` were the host's to rebind.
  The other runtimes (bash, CPython, clang, `wasm-runner`) reach no
  JavaScript, but a guest of any of them that spun without a syscall held the
  host's only thread, so nothing could end it, and `timeoutMs` was ignored.
  Now a facet's globals are its own, its session capability crosses as calls
  (the supervisor's, answered by promise where the engine parks and at once
  where it cannot, and its synchronous view's), and a call's `timeoutMs` or
  new `signal` ends the facet. `python3`, `ruby` and `wasm-runner` pass the
  command's signal, so a kill or Ctrl-C answers 130, the host runs on, and
  nothing of the program is left: no thread, no process, no CPU within a
  second of the kill (measured from /proc). Bun 1.4 cannot terminate a worker
  running WebAssembly (`terminate()` never settles and the thread spins on, a
  core for good, on 1.4.0, 1.4.2 and the 2026-10-03 canary alike; one in
  JavaScript, or in WebAssembly that calls into JavaScript, it ends), so under
  Bun a facet is a child process of the same engine, ended by SIGKILL, over
  the same protocol framed on pipes. That process is a realm's own in full:
  it starts with none of the host's environment (a thread realm too) and,
  under Bun, no .env and no bunfig preload from where it runs; it is a
  process group of its own, so ending it ends every process it started that
  stayed in the group, and its end waits for none that left; it ends with
  its host, even when the host dies before it has started (it is told the
  host's pid, not left to read its parent once); a frame it announces over
  256 MiB ends it before a byte is kept, where 4 GiB was allocated as it
  came; a process that cannot be started ends its realm with the reason
  (ENOENT), where the call hung; and a call that waits for its answer and one
  that does not take theirs on separate channels, so a guest's second call
  no longer blocks on its first. An idle facet no longer keeps the process alive. The
  mechanism is the inline `node`'s, now shared (runtime/realm.ts,
  realm-guest.ts). It costs each wasm program run about 60 ms more to start
  under Bun and 40 ms under Node, and each filesystem syscall about 55 µs
  under Bun and 30 µs under Node. `bash` and `clang` pass the command's
  signal too, through one step controller for both facet transports, so a
  killed `bash -c "while :; do :; done"` answers 130 at once where it waited
  out its 300 s step deadline; a bash session's `interrupt` is now always
  there. An abort that comes while a facet starts or compiles its modules, or
  in the same turn as the call, ends the call (it hung); a call whose
  modules failed sends all of them again, where the ones compiled before the
  failure were dropped from the retry; and an answer that is a typed array or
  DataView on part of a buffer comes back as that type, where it became a
  Uint8Array. A spare realm started ahead was measured and not added: it
  saves at most 20 ms of python3's 165 ms under Bun, most of the rest being
  python.wasm's 11 MB sent to the child and compiled there. Under Bun a
  Ruby run's memory now goes with its process: eight runs leave the host at
  207 MB, where they left it at 6.9 GB.

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
- Fixed: a shell script that `child_process.spawn` starts (`spawn('./s.sh')`,
  by absolute path, by its name on PATH, or `spawn('sh', ['s.sh'])`) got
  no stdin. The broker ran it on an empty fixed stdin and never said its
  descriptors were pipes, so `sh` took its stdin for a terminal and handed
  its commands none, and a script of `cat` printed nothing. A child's stdin
  is now a pipe its command reads as the parent writes it, for every kind
  of child the broker runs: a registry command, a shell, or a program found
  by name or path. It used to be what had been written once the parent
  ended stdin or half a second had passed. So such a child answers each
  line before its parent ends, as under Node, and a child that reads its
  stdin waits for its parent to end it rather than giving up after half a
  second. `sh` hands its stdin on to its program's commands as a stream,
  where it read all of it first. A node run by a child's script reads the
  script's stdin, not the child's queue, whose pid it inherits in its
  environment. A runtime whose stdout is a pipe still hands its output
  back when it exits. A command that does not read its stdin no longer
  waits on it: the shell's builtins (`printf`, `true`, `echo`, `test` and
  others) used to read their stdin to its end before running, so `sleep 5 |
  true` took 5 seconds. `head -n 0` and `head -c 0` read nothing, as GNU
  head does, where they waited on their stdin.
- Fixed: bytes a parent wrote to a long-running child's stdin (a server it
  started with `child_process.spawn`) were decoded as UTF-8 on the way, so
  a byte that is not UTF-8 arrived as U+FFFD. They arrive as written.

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
