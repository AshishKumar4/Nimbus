# Git 2.53.0 WASI source-patch audit

There are three source patches before and after this audit. They are not a
second Git implementation: upstream Git still owns every command and object
format. The mmap patch has shrunk from a packfile-owned paging implementation
to accessors over Git's own `NO_MMAP` hooks; the process implementation now
lives once in `wasm/nimbus-libc/nimbus-proc.c`, outside Git's sources. The
no-fork and direct-helper switches no longer use a Nimbus-specific macro.

All three apply to the pinned upstream tarball in `build-git.sh`. Git proper
contains no Nimbus imports or process-fabric dependencies. Build options are
opt-in; ordinary native builds keep their existing mmap and fork backends.

## 0001-pack-index-paged.patch — NO_MMAP_PAGED

Reason: an emulated contiguous mapping reads an entire pack index into WASM
linear memory. A deep history's 60 MiB index, plus reverse index, pack windows
and delta bases, leaves too little of a facet's 128 MiB. WASM has neither
virtual-memory mappings nor page-fault handlers, so libc `mmap` cannot lazily
fill bytes that Git dereferences directly. Configuration alone cannot make
those dereferences go through a read operation.

The paging implementation is the included build overlay `git-mmap-paged.c`.
Git's `compat/mmap.c` owns its open/close hooks, under the `NO_MMAP_PAGED`
Makefile option alongside `NO_MMAP`. A mapping keeps a 4 KiB header and its
descriptor; one 64-page, 64 KiB/page LRU serves every mapping. `git_munmap`
closes the owned descriptor and forgets its pages. Ordinary `git_mmap` is
unchanged. A caller that genuinely needs the whole index materializes it
through `git_mmap_whole`, rather than reading a header as though it were a
full mapping.

The remaining call-site edits are unavoidable: pack-index lookups ask for a
range and the few full-index walkers ask for the full mapping. `packed_git`
has no paging state, cache or extra descriptor fields. Replacing raw pointer
arithmetic with these accessors is the smallest correct interface change;
moving that last part into libc would require a VM facility WASM does not
have.

Upstream path: propose explicit-range, read-only mappings in `compat/mmap.c`
and `compat/posix.h`, gated by `NO_MMAP_PAGED`, and the pack-index accessors.
The overlay could become `compat/mmap-paged.c`; the implementation is not
Nimbus-specific. Default builds remain contiguous. Tests cover native mmap
differentials, page crossings, eviction, short mappings, descriptor ownership
and bounds, plus Git's v1/v2 indexes compared with host Git 2.53.

## 0002-spawn-through-the-host.patch — NO_FORK

Reason: Git 2.53's POSIX `start_command` explicitly calls `fork`, prepares the
child's descriptors/environment and then execs. It has no `posix_spawn`
backend to select in config. A libc `posix_spawn` implementation cannot
replace a call Git never makes; a fake `fork` cannot clone a WASM instance's
memory, stack and supervisor capabilities. Enabling `GIT_WINDOWS_NATIVE`
would also select unrelated Windows pathname/filesystem behavior.

The patch adds a generic `NO_FORK` Makefile option and `git_spawnvpe` backend
declaration, then selects the existing no-fork descriptor setup in
`start_command`. Only the backend call is new. The forced-included build
overlay maps it to `nimbus_spawnvpe` in the shared libc shim, which owns NUL
encoding, environment deltas, cwd, pipe/dup/wait/kill and start errors. None
of that implementation remains in Git's source or Git-specific C shim.

The existing Nimbus import encodes the executable as `argv[0]`, so this
backend is deliberately not advertised as a complete POSIX `posix_spawnp`
ABI. Git passes the same name as `file` and `argv[0]`. A future standard
spawn ABI can replace this libc adapter without changing `start_command`.

Upstream path: generic no-fork spawning in `run-command.c`, with the backend
contract in `compat/posix.h` and `NO_FORK` in Makefile. Native POSIX targets
could implement it with `posix_spawnp` and file actions; WASI uses its host.
The source selection cannot move into libc because Git itself chooses the
fork backend. Existing WASI child/process tests and Git's child-hook probes
hold environment, descriptors, errors, output and wait semantics to account.

## 0003-remote-helper-started-directly.patch — REMOTE_HELPER_DIRECT

Reason: stock Git starts `git remote-http`, which starts `git-remote-http`.
That second child must inherit the first child's live fd 0 channel, including
queued bytes, later writes and EOF. The current WASI adapter forwards a
guest-created pipe but ends stdin when spawning with its own fd 0. The
interim patch starts the helper directly, avoiding that unsupported second
stdin handoff; it does not implement transport inside Git.

No shell special case or Git-specific spawn rewrite is appropriate. The
generic fix belongs in the shared process input channel and WASI adapter.
RealFlea has accepted inherited-fd-0 ownership/pumping as part of that work.
Once it lands and the stock two-child helper passes differential fetch,
pull and push probes, delete this patch and its build flag together.

Upstream path: none intended; this is temporary, explicitly gated by
`REMOTE_HELPER_DIRECT` in the build overlay. Git's transport stays stock
after the shared input channel can express its existing process semantics.

## Runtime contracts

Git's first build names `GIT_RUNNER`; CPython's new extension build is
`cpython/3.13.14-1` and names `CPYTHON_RUNNER` (`cpython-runner@2`). Both
build verifiers read the single `WASI_RUNTIME_IMPORT_MODULES` constant from
core's committed dist. No catalog or npm publication is part of this audit.

Clang's compiler, linker and sysroot have not been rebuilt and get no new
runner key or catalog/npm version. Its output's executable bit is a host
fix, not a new import. A libc/sysroot extension for clang-built programs is
deferred until a program needs it.
