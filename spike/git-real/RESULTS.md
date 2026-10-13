# Real git on WASI — spike results (2026-10-05)

git 2.53.0 built unmodified for wasm32-wasi with wasi-sdk 27 (`build-git.sh`):
config.mak (NO_PTHREADS, NO_MMAP, NO_CURL, …), 7 overlay headers, ~150 lines of
compat stubs (process creation answers ENOSYS). 4,198,054 bytes, 1,544,980
gzip; imports are wasi_snapshot_preview1 only (34). V8 compile: 4–8 ms lazy,
23 ms eager Liftoff, 462 ms TurboFan-only; instantiate ≤1 ms.

## Fidelity

Byte-identical output to host git 2.53.0 (sha1 of stdout) on express:
`log -p -20`, `log --stat --format=fuller -20`, `blame lib/application.js`,
`show HEAD~3`, `diff HEAD~30 HEAD`, `log --graph --oneline -200`,
`shortlog -sn`. `index-pack` of the Linux depth-1 pack writes an .idx
identical to host git's. A repo, index and commit written by cf-git read
clean (status, log, show; host `git fsck` clean).

Ran without a process: status (porcelain v2), diff (--staged, A..B, A B --
path), log (-p, --stat, --graph, -S, -L, --follow, --format), show, blame,
shortlog, describe, grep, switch, checkout (branch and paths), restore,
reset (--hard, paths), branch (-m, -vv), commit (-m, -a, --amend), tag -a,
rebase (non-interactive; -i with sequence.editor=:), cherry-pick, revert,
notes, reflog, clean, config (--global, --list), format-patch, count-objects,
worktree list.

Needs a child process (fails at ENOSYS): stash (update-index), merge with a
real merge (runs `stash create`), am (mailsplit), add -p (diff-files),
worktree add (reset), bisect (checkout), submodule, gc (pack-refs), fsck
(refs verify), range-diff (log), pull/fetch/push/clone (transport,
index-pack), commit/merge/tag without -m and rebase -i editing (editor),
hooks, pager, auto-maintenance after commit.

## Host measurements (Node 22 / V8 via node:wasi; cf-git via node:fs)

Tuned config: core.packedGitWindowSize=1m, packedGitLimit=16m,
deltaBaseCacheLimit=8m, untrackedCache=true, checkStat=minimal. Memory is
the guest's linear memory (peak).

| repo / op | git.wasm | fs calls | cf-git |
|---|---|---|---|
| vscode depth 1 (19,977 files), status | 58 ms, 16.4 MiB | 29,741 | 1,210 ms, 300 MiB heap |
| vscode depth 1, diff (5 files edited) | 57 ms, 24.9 MiB | 25,671 | – |
| vscode depth 1, add -A / commit | 138 / 70 ms, 24 MiB | 71,683 / 25,588 | – |
| vscode depth 1, show --stat / blame | 19 / 27 ms | 649 / 523 | – |
| Linux depth 1 (96,053 files), status | 154 ms, 35 MiB | 109,885 | 9,849 ms, 1,230 MiB heap |
| Linux, status without untrackedCache | 460 ms, 33.6 MiB | 235,044 | – |
| Linux, diff / commit | 126 / 222 ms, 35–39 MiB | ~102,000 | – |
| Linux, first status after another engine wrote the index (rehash) | 4.4 s, 59.5 MiB | 627,683 | – |
| Linux, index-pack 296 MB pack | 14.8 s wall, 12.3 s CPU, 60.9 MiB (host native `--threads=1`: 14.0 s) | 100,768 | – |
| vscode 166,965 commits (2.18M objects), log -p -100 / blame / log --graph -2000 | 0.9 / 2.4 / 1.7 s; 102 / 116 / 228 MiB | 19,246 / 2,607 / 2,789 | status 908 s, 296 MiB; log -100 3.1 s, 379 MiB |

With NO_MMAP every .idx is read whole: the deepened vscode's 60 MB .idx +
8.6 MB .rev set a ~70 MiB floor; depth-1 clones have a 0.7–2.8 MB .idx.

## Live (throwaway tw-git-real, main + work/git-depth)

- A WASI guest's filesystem call costs 7.9–12.7 ms (python3 os.stat ×2000:
  12,681 µs; lstat of a missing path 12,347 µs; ×200 in a second session:
  9,630 and 7,890 µs). listdir 133 ms. A node facet's async stat: 6,922 and
  7,146 µs; its sync stat (resident namespace): below the clock's resolution.
- Today's cf-git on vscode: clone 136.8 s (20,006 files); the first
  `git status` reset the session (WebSocket 1006 after 40 s). GraphQL for that
  object: 63.1 / 65.9 MiB during the clone, then 190.1 MiB and
  fatalInternalErrors 1 in the minute of the status.
- express (214 files): cf-git status 1.0 s first, 50 ms after.
