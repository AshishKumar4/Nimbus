# @nimbus-sh/core

> Part of [Nimbus](https://github.com/AshishKumar4/Nimbus), my hobby/research
> cloud OS. This README is edited and maintained with Claude (AI) and
> presented as-is.

The backend-agnostic half of Nimbus: a durable POSIX-like filesystem, a shell
with 60+ Unix commands, and the WASI runtime layer. It has no Cloudflare
dependency.

You hand it a SQLite and get back `.fs` and `.exec`. On Cloudflare that
SQLite is `ctx.storage.sql` inside your Durable Object; in bun or node it is
`bun:sqlite` or `node:sqlite`. The whole package rests on two narrow ports
(`SqlDatabase` and `SqlTransactions`), so the same code serves both hosts.

Use it when something you already run needs a real workspace. A Durable
Object that does something else and needs somewhere to work. A local script
that needs the filesystem semantics the hosted product has.

## Install

```bash
npm install @nimbus-sh/core
```

## Quick start

```ts
import { Database } from 'bun:sqlite';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { writeText } from '@nimbus-sh/core/vfs/vfs.js';

const db = new Database('workspace.sqlite');
const sql = {
  exec(q, ...p) {
    const st = db.query(q);
    if (st.columnNames.length === 0) { db.run(q, ...p); return []; }
    return st.all(...p);
  },
};
const transactions = { storage: { transactionSync: (cb) => db.transaction(cb)() } };

const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });

await writeText(ws.fs, '/home/user/hello.txt', 'hi\n');
const out = await ws.exec('cat /home/user/hello.txt | wc -c');   // { stdout: '3\n', exitCode: 0 }
```

Inside a Cloudflare Durable Object, complete:

```ts
import { DurableObject } from 'cloudflare:workers';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';

export class Workspace extends DurableObject {
  private ws?: Promise<NimbusWorkspace>;

  private workspace(): Promise<NimbusWorkspace> {
    this.ws ??= (async () => {
      // Bump a persisted counter once per instance. Never a constant and
      // never Date.now(): pids derive from the generation, so a repeated
      // one hands a dead process live write authority, and the platform
      // re-instantiates this class far more often than it looks like it
      // does (cold starts, hibernation wakes, resets). Use the bumped
      // value only after the put resolves.
      const generation = ((await this.ctx.storage.get<number>('generation')) ?? 0) + 1;
      await this.ctx.storage.put('generation', generation);
      return NimbusWorkspace.create({
        sql: this.ctx.storage.sql,
        transactions: this.ctx,
        generation,
      });
    })();
    return this.ws;
  }

  async exec(command: string) {
    return (await this.workspace()).exec(command);
  }
}
```

## Running commands

Each `ws.exec(command)` runs as a process of its own, in a shell of its own.
That shell starts from the cwd and environment of `ws.shell` (the shell a
terminal types into) with the call's `cwd` and `env` on top, and the process
has `ws.shell`'s credential and umask. It is not a login shell: the aliases
and functions `ws.start()` sources from `~/.nimbusrc` stay in `ws.shell`.
What the command changes ends with it: a `cd`, an `export`, a function, an
alias, a `set -o` option, a `umask`, an `exec` descriptor. The next call
does not see it, and neither does `ws.shell`. Calls made at once run at
once, each in its own state. The process leaves `ws.processes` when its
result is returned.

```ts
await Promise.all([ws.exec('cd /tmp && pwd'), ws.exec('pwd')]);   // '/tmp\n' and '/home/user\n'
```

To keep a working directory and environment between calls, name a shell.
Calls with one `shellId` run one at a time, in the order they were made, and
each starts where the last one left the shell. A new name starts in the
directory the workspace started in (`ws.fs.cwd`). A call's own `cwd` and
`env` hold for that call only. Only the cwd and environment persist:
functions, aliases, options, umask and descriptors belong to the call's
process. The state is a row of the workspace's `vfs_shells` table, so a name
survives reopening the workspace. A name is 1 to 160 characters from
`A-Z a-z 0-9 . _ : -`, starting with a letter or digit.

```ts
await ws.exec('cd app && export NODE_ENV=production', { shellId: 'agent-1' });
await ws.exec('pwd; echo $NODE_ENV', { shellId: 'agent-1' });   // '/home/user/app\nproduction\n'
```

A host that runs commands under processes of its own uses the two parts
`exec` is made of. `ws.shellFor(pid, { cwd, env })` builds the shell for one
process. `ws.withNamedShell(id, { start, persist }, body)` holds a named
shell for one call and saves it afterwards. A hosted runtime's
programmatic exec is built on them, so a `shellId` names the same shell
whether the command arrives through `@nimbus-sh/sdk` or through `ws.exec`.

### `node`

The workspace's `node` runs each program in a worker thread of its own, so
the program's globals and built-ins are its own: a program that rebinds
`Array`, installs fake timers or patches `Object.prototype` changes them
for itself, not for your process. ES modules are strict, as in Node. A
program ends when its event loop is empty: a timer it leaves still runs, and
a server it listens with keeps it until the server closes.
`readFileSync(0)` waits for stdin to end, as in Node, and an aborted call
(`signal`, a kill, Ctrl-C) terminates the program even in a loop that never
yields. It needs `node:worker_threads`, which Bun and Node have; each run
costs about 16 ms to start, and each synchronous filesystem call about
0.1 ms, against the host's. A hosted session runs its own `node`.

### What a program can reach

A `node` program and each wasm runtime (`python3`, `ruby`, `bash`, `clang`)
run in a realm of their own: a worker thread, or under Bun a child process
for the wasm runtimes. Their globals and built-ins are Nimbus's: `fs`,
`child_process` and `process` act on the workspace, and nothing a program
does to its globals reaches yours. Kill and abort end the realm.

A realm separates programs from your process, not from your machine. Under
Bun, every realm has Bun's `Bun` namespace, which Bun makes permanent, and
through it a program can reach your files, processes and network around the
workspace. Under Node there is no such namespace. To run code you do not
trust, run the host in an OS sandbox (a container or VM).

## Files

Files written through `.fs` are owned by the session user (uid 1000), not
root. The shell enforces the same permission model either way: a root-owned
`/etc/passwd` refuses a write from `.fs`, and `id` resolves names through
it.

`.fs` takes a relative path from a working directory of its own, as a
process does: the one the workspace starts in, which is `create`'s `cwd`,
else `HOME`. A `cd` typed into the shell moves the shell, not `.fs`.
`ws.fs.cwd` says where that is, and `ws.fs.resolve(path)` gives the
absolute path an operation on `path` uses: the cwd, then `path` as it is
spelled. `.` and `..` are left to the walk, which takes them after a link,
as the kernel does, so with a cwd that is a link to a directory, `.` is
the directory. An empty path names nothing (`ENOENT`), and removing or
renaming `.` or `..` is refused with Linux's code.

```ts
const ws = await NimbusWorkspace.create({ sql, transactions, cwd: '/home/user/app' });
await ws.fs.writeFile('notes.txt', 'hi\n');   // /home/user/app/notes.txt
ws.fs.resolve('src/main.ts');                 // '/home/user/app/src/main.ts'
```

The session shell's own view, `ws.shell.getVfs()`, is a `ProcessView`:
it takes every relative path from `/`, because Nimbus's own code hands it
keys such as `etc/passwd`. `.fs` is a `WorkspaceFs`. Neither type is
assignable to the other, so neither kind of path can reach the other view.

`ws.fs.rename` is rename(2): between two mounts it answers `EXDEV`.
`ws.fs.move` is mv's move, and the shell's `mv` runs the same code. Within
one filesystem it is one rename. Between two (and on a mounted backend
that cannot rename in place) it copies the file or tree to a staged name
beside the destination and confirms the copy, then removes the source,
then renames the copy over the destination, which keeps what it held
until that rename. A failure before that rename puts back what of the
source had gone and removes the staged copy, so the move leaves both
names as they were.

When the final rename fails, its own answer decides, never what the
names then hold. A refusal made before anything changed (EPERM, EACCES,
ENOSPC and the rest of `RENAME_REFUSALS` in `vfs/vfs-error.js`) puts the
source back and is the answer. A filesystem that says it renamed all of
it (`renameOutcome`; the SQLite filesystem says so from its own store)
has moved it, and the residue at the staged name goes. Anything else,
EIO or an error with no code, may have renamed it in whole or in part,
so nothing is undone or removed, and the answer is `EIO` naming the
staged name and the destination.

Each file and directory it makes is made private and given its own mode
and times once it is complete, as GNU cp makes a copy, so no one reads a
copy the source would not let them. Mode and times are carried best
effort, as GNU mv carries them. The same move works over any `VFS`,
mounted or not:

```ts
import { move } from '@nimbus-sh/core/vfs/move.js';

await ws.fs.move('dist', '/shared/dist');   // a tree onto another mount
await move(plane, '/a.txt', '/b.txt');      // a bare VFS, with or without rename
```

It is not atomic to a reader, and a crash can interrupt it: between the
source's removal and the final rename, what is moving is only at
`.nimbus-move-<id>` in the destination's directory. A backend that cannot
rename in place has its destination replaced where it is, after what it
held is read so it can be put back; a write another process makes to it
meanwhile can be lost, as on any filesystem written in place.

Appends through an open file (a redirection, a program writing its file
descriptor) are held by the SQLite filesystem and stored a block at a time:
once 1 MiB is held, after 100 ms, at fsync and close, and before anything
else looks at the store. A read, stat, listing, revision, the change feed,
a snapshot or another write sees them, in the order they were made, with
the mtime and ctime of the write that made them, so nothing can tell they
were held; the shell fsyncs each command's redirections as the command
ends. A held append the store refuses (the storage limit) is thrown by the
next write, fsync or close of each description that wrote it, never to a
reader.

The durable boundary is fsync, as on any filesystem with a page cache: a
returned fsync (on any descriptor of the file, a read-only one included)
or close means what was written is in the store. A descriptor opened
`sync` (O_SYNC) holds nothing: each write is in the store when it returns,
on SQLite and on a mount that cannot write in place. The supervisor opens
a facet process's descriptors that way, so each of its writes is answered
with what the store did. A host whose isolate dies while appends are held
loses them, as a machine loses what it had not synced.

## The user's home

`env.HOME` sets the session user's home directory, `/home/user` by default.
Everything Nimbus keeps per user follows it:

- the home directory itself, made for the user, with `~/.config` and `~/.nimbusrc`
- the user's entry in `/etc/passwd`
- `PATH` (`~/.local/bin`, `~/.gem/bin`), `XDG_CONFIG_HOME` and `XDG_DATA_HOME`
- installed runtimes (`~/.nimbus/runtimes`), gems (`~/.gem`) and pip packages
  (`~/.nimbus-python/site-packages`)

```ts
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1, env: { HOME: '/home/main' } });
```

HOME must be an absolute path. A workspace first seeded under another home
keeps its files there. Nimbus moves `/etc/passwd` and `/etc/profile` to the
new home only while they are still exactly what it seeded for `/home/user`.

## Real runtimes, off Cloudflare

The wasm runtimes are separate npm packages, so nobody downloads a Python
interpreter to get a filesystem. Install the ones you want and pass them in:

```bash
npm install @nimbus-sh/runtime-bash @nimbus-sh/runtime-cpython
```

```ts
import bash from '@nimbus-sh/runtime-bash';
import cpython from '@nimbus-sh/runtime-cpython';
import { localFacetHost } from '@nimbus-sh/core';

const ws = await NimbusWorkspace.create({
  sql, transactions, generation: 1,
  facets: localFacetHost(),
  runtimes: [bash, cpython],
});

await ws.exec('bash -c "echo $((6*7))"');       // 42 — GNU bash 5.2, real BusyBox children
await ws.exec(`python -c "import sqlite3; print('live')"`);  // CPython 3.13, real stdlib
```

`@nimbus-sh/runtime-ruby` (Ruby 3.3) and `@nimbus-sh/runtime-clang` (clang →
`wasm32-wasi`, compile and run C in the workspace) work the same way. Every
package carries the same manifest and the same sha256-verified blobs the
hosted product serves from R2.

A runtime package is `{ manifest, readBlob(file) }` (`RuntimePackage`).
`readBlob` returns the file's bytes or a `ReadableStream<Uint8Array>` of them.
Each blob is hashed as it is written, so a stream lets an install hold
512 KiB pieces instead of whole interpreters. A blob
whose digest does not match never reaches its install path.

Without `facets` and `runtimes` you still get the full shell and coreutils.
The wasm runtimes are a dependency you add.

`localFacetHost()` covers bun and node only. On workerd the CSP forbids
request-time `WebAssembly.instantiate`, so wasm has to ride the Worker Loader
module map. That machinery lives in `@nimbus-sh/worker` and
`@nimbus-sh/fabric`. The shell, coreutils, and filesystem need none of it.

Each facet `localFacetHost()` opens is a realm of its own: a worker thread
under Node, as each inline `node` run is, and a child process under Bun,
because Bun 1.4 cannot end a worker that is running WebAssembly. So nothing a
program reaches through it is your process's: Ruby's `js` bridge (`JS.eval`,
`JS.global`) sees the facet's globals, not yours, and none of your
environment variables. A kill, Ctrl-C or `signal` ends the program, answering
130, and its thread or process with it (under Bun, every process it started
that stayed in its process group too), so nothing keeps spinning. A facet's `timeoutMs` ends it too, and an idle facet
does not keep your process alive. Each wasm program run starts about 60 ms
later under Bun and 40 ms later under Node than it did in your own realm,
and each filesystem syscall costs about 55 µs more under Bun and 30 µs under
Node.

## Sharing a database with your own app

The workspace is a tenant in a database you own:

- It creates and touches only its own tables, all named `vfs_*`. A database
  still holding the pre-v2 filesystem (`inodes`, `file_chunks`,
  `content_lifecycle`) opens empty, and those tables are deleted in bounded
  pages once their columns show they are Nimbus's.
- Core hashes file content with `node:crypto`'s synchronous sha256, so a
  workerd host needs `nodejs_compat`: a compatibility date of 2026-08-04 or
  later enables it, an earlier one must list the flag.
- `destroy()` drops those tables and does not call `deleteAll()`.
- `transactionSync` must be a real transaction. An implementation that only
  calls the callback turns every atomic write into a torn one.
- `generation` must never repeat across restarts of your host. Pids derive
  from it, and a repeated generation would hand a dead process live write
  authority.

When your own SQL rows must commit with filesystem bytes, use
`SqliteVFS.withTransaction(callback)` instead of an outer
`storage.transactionSync`. Use the credentialed synchronous VFS methods inside
the callback, not the workspace's asynchronous file methods. The callback can
read its writes; revisions and watch events publish only after commit. On
rollback, Nimbus drops its cached chunks and inodes, so every later read
comes from SQLite, and returns open file descriptions to the inodes they
named before rethrowing with the original error as `cause`.

The method must own the outermost transaction on the same SQL host. Do not
nest it or start asynchronous work inside it. The host's transaction primitive
must support nested savepoints for individual VFS writes. If reading those
inodes back also fails, Nimbus throws an `AggregateError` carrying both
failures; discard that VFS instance and reopen it after storage recovers.

## Publishing changed rows

For cross-database sync, export changed rows from a source snapshot and send
only the chunk hashes `wantChunks` reports missing. Import into an empty
staging root before taking a publication lease; unchanged files need no byte
transfer.

Acquire `vfs.acquireGlobalExclusiveMutation()`, then bind
`vfs.as(cred, { mutationOwner: lease.owner })`. Recheck the destination revision
and expected content keys before publishing through that view's rename,
deletion and metadata methods. A subtree lease authorizes only mutations
inside its root; moving from a separate staging root needs the global lease.
The capability does not change the credential's permissions.

Release the lease in `finally`. Mutations through the bound view then fail
with `ESTALE`. `copyTreeAsync` and `writeStream` carry the bound owner through
their slices without leaving an ambient owner across awaits. A quiesced
snapshot waits for the lease to end.

This is not an all-files atomic apply: readers can observe committed prefixes.
The caller owns the saved publication plan, conflict checks and replay after
interruption. The staged-apply test reopens the database and replays a prefix
of nested replacements/deletions, preserving untouched inode identities and
content keys.

## Host-owned shared directories

Ordinary setgid, default ACLs, chmod and rename keep POSIX behavior. A trusted
host can opt an existing kernel-owned, setgid directory with a group-rwx
default ACL into owner/group-coupled permissions:

```ts
const revoke = workspace.vfs.registerSharedDirectory('/shared');
// Call revoke() when the host no longer delegates this policy.
```

Only strict descendants are covered. Creation, chmod and native tree adoption
mirror owner rwx into the registered group; directories retain setgid. Within
this explicit domain `chmod 755` means `2775` on a directory, and `chmod 600`
means `660` on a file. Outside it, confined owners can narrow to `700`/`600` without
granting group or other access. Group membership never permits chmod of
another owner's inode; other-bit widening, setuid and sticky-bit removal keep
their existing checks. A nonkernel rename cannot re-share a foreign-owned
entry whose metadata would change. Symlink targets outside the domain stay
outside it. File descriptors use the current linked inode without repeating
parent search; detached descriptors receive no sharing grant.
Membership includes the credential's primary gid or any supplementary group.

The registration belongs to this engine instance, not a snapshot or exported
row. Re-register after reopening. Duplicate or overlapping registrations fail
with EBUSY. Moving, replacing or deleting the root, reducing its permissions
or default ACL, changing its owner/group, rotating the filesystem incarnation,
or restoring/importing a scope covering it revokes the grant permanently.
An authorized root publication that fails may also revoke it; rollback does
not restore authority. Failed guest permission/lease checks do not revoke it.
The returned disposer cannot revoke a later registration at the same path.

Registration does not rewrite existing descendants. Subsequent descendant
restore/import/copy operations apply the current destination policy while
preserving content references and the existing bounded publication contract.
Replay checks compare policy-normalized metadata; changing or revoking the
policy during an import can refuse replay rather than reinterpret earlier
rows. Revocation stops future delegation, not permissions already committed.
No guest RPC or setfacl option exposes this administrator API, and no host or
application is opted in automatically.


## Inode identities in row imports

Export rows carry `ino`; each page carries the source allocator's exclusive
`nextIno` high-water. A whole-root export imported at `/` preserves those
numbers only in a fresh identity domain: allocator at 2, no live or historical
inodes, snapshots, other jobs or open descriptions. Pre-staged import chunks
do not consume inode identities. A used-but-empty filesystem, subtree import
or staging import allocates destination-local inode numbers instead.
Import before booting/seeding a `NimbusWorkspace` when preserving full-tree
inode numbers is required.

The import job records that decision and the first source high-water. Later
source allocations may raise exported headers, but cannot enlarge the job's
reserved identity range. Ordinary destination allocations start above that
range. Active import progress follows the job cursor, not unrelated live
paths; a reset before cursor persistence replays committed rows harmlessly.
Invalid IDs and collisions are refused before publishing the page. Content
keys remain portable, and page digests do not include local inode identity.
Collision checks include live rows, unlinked open descriptions and rows still
visible to snapshots. Fully deleted, unreferenced identities do not require a
historical seen-ID table; the allocator still stays above the reserved bound.
Rows also preserve directory default ACLs; ACL-only changes participate in
`diff` and `pageDigest`, so imported shared directories retain inheritance.

Identity-validation indexes belong to active preserving imports. They are
created while the indexed tables are empty, retained across restarts, and
dropped transactionally when no preserving job needs them. Ordinary trees
pay no permanent identity-index cost. Freed index pages remain part of SQLite
database-size accounting until reused; they are not deducted as an exemption.

## Bounded export pages

`exportPage` frames are bounded by rows, chunk references and serialized
bytes, metadata included. A file whose manifest does not fit is exported as
fragments: rows for the same path carry `pieceOffset` and consecutive
references, and the cursor `next` is opaque, a (path, byte offset) position.
Pass `next` back unchanged; do not construct cursors. Rows and page
boundaries follow SQLite's path order (UTF-8 bytes), which differs from a JS
string sort for names outside the BMP; the importer compares in the same order.

The importer keeps one pending manifest per job, pinned against GC and
recorded durably with its offset, so fragments survive a reset and a
replayed fragment is verified against what already landed rather than applied
twice. A fragment out of order, a changed metadata field, or a final digest
that does not match the row's content key refuses the page before writing.
The inode row publishes only when the last fragment completes the file's
size and digest. Lazy imports (N17) still admit fragments naming pending
chunks without their bytes.

## Mounts in df, mount and /proc/mounts

The workspace has one namespace: a `CompositeVFS` at `ws.filesystem.vfs`,
with SQLite at `/`, `/proc` and `/dev`. Mount your own filesystems on it.
`df`, `mount` and `/proc/mounts` list every mount in mount order. SQLite at
`/` reports its real usage: size is the 10 GB Durable Object storage limit,
used is the file bytes stored, available is the limit less the database's
size where the host reports `sql.databaseSize`. A mounted VFS describes
itself with `describe()` and `usage()`. Without them it is listed as source
`none`, type `vfs`, with no usage.

```ts
import { NimbusWorkspace } from '@nimbus-sh/core';
import { MemoryVFS } from '@nimbus-sh/core/vfs/memory.js';

const ws = await NimbusWorkspace.create({ sql, transactions, generation });

// Any VFS can be mounted. This one also says what it is, for df and mount.
const shared = Object.assign(new MemoryVFS(), {
  describe: () => ({ source: 'r2:team-bucket', type: 'r2', options: ['rw'] }),
  usage: async () => null, // or { size, used, available } in bytes
});
ws.filesystem.vfs.mount('/shared', shared);

await ws.exec('mount'); // ... r2:team-bucket on /shared type r2 (rw)
```

`df` hides a mount whose `usage()` returns `null` unless given `-a` or a path
on it. `/proc/mounts` never shows usage.

A mounted VFS without `writeRange` cannot write part of a file in place. A
process's open file on it buffers its writes (at most 8 MiB per descriptor;
a write past that fails with `EFBIG`) and writes the whole file back on
`fsync`, on the last `close` and when the process exits. The process that
wrote reads and stats its own writes at once. Another process sees the
mount's content, and so the writes only after that write-back.

A mounted VFS without `readRange` answers a ranged read through the
namespace with ENOTSUP, rather than read the whole file in its place. A
process's readers (`cat`, `head`, `tail`, a descriptor's `read`) then read
the whole file and cut it; `readRangeOrWhole` from
`@nimbus-sh/core/vfs/vfs.js` does the same for a reader of your own that can
bear it.

By default the namespace resolves a mounted path one component at a time,
asking the backend for a stat of each directory on the way. A backend that
resolves a whole path itself, as a network filesystem's server does (a
device tunnel, a container, a Drive, where every call is a round trip), is
mounted with `resolvesPaths`:

```ts
ws.filesystem.vfs.mount('/pc', ({ cred }) => devices.for(cred.uid), {
  resolvesPaths: true,
  absentReason: () => 'no device connected',
});
await ws.fs.readFileString('/pc/home/me/a/b/c.txt'); // one call: readFile('/home/me/a/b/c.txt')
```

Every operation on a path inside it (stat, readdir, read, write, `mkdir -p`,
rename, unlink, realpath) is then one call with the mount-relative path. The
namespace stats no directory on the way, checks no parent, and reads no link
inside the mount. The backend follows its own links within its own tree and
answers for every component itself: a device may refuse a stat of the
directories above the one its user consented to (EACCES) and still serve the
files in it, and a backend may make a write's missing parents. `..` inside
the mount is lexical. The namespace still owns the way in: root links that
lead to the mount, ENXIO with `absentReason` while the source answers null,
the mount point itself (EBUSY, EISDIR, `mkdir -p` has nothing to do), EROFS
under `readOnly`, EXDEV across mounts (so `mv` and `ws.fs.move` copy), and
any mount nested inside it (the way to one is looked up and searched here,
since the backend never sees that path). Permissions inside the mount are
the backend's: a view's credential reaches it through its `as`. `readlink`
answers a link's text as written; where the namespace follows a link
itself (a node program's staged view and data plan, a process's walks, the
shell's `realpath` and `readlink -f`), `CompositeVFS.linkLeadsTo` re-roots
an absolute target at the mount point, as the backend reads it, and answers
null when a mount nested in it covers that name (the backend follows the
link to a file the namespace cannot name: hand the link's own path to the
namespace); a process's bridge answers the same as `linkLeadsTo`. A WASI program (`python3`, `ruby`, the shell's
wasm commands) reaches the mount through a preopen the same way, one call
per lookup, when the preopen holds the mount point; beneath a preopen
inside the mount every component is looked up, so the backend cannot
follow a link out of it.

A node process's synchronous `fs` and `require` see a mount, one without a
`sync` face included, where its launch names it: its working directory, its
program's directory and arguments, the literal paths its code names, and the
files its module map was read from. A directory named there is listed whole,
breadth first, up to 8192 names per launch (`MOUNT_LIST_NAME_LIMIT`), and so
is every directory from the mount point down to it. A mount the launch does
not name is not walked. A synchronous call on a mounted path the launch did
not list, or past the bound, answers EAGAIN ("/shared is an asynchronous
mount; this caller cannot wait for it") and names the `fs.promises` form that
reads it; a missing name in a listed directory is ENOENT. On a mount with
`resolvesPaths`, a directory whose parent the backend will not list is
stat-ed and listed on its own, so a node program in a device's consented
directory reads it synchronously too. The process holds the mount's names
and content as of its launch, plus its own writes, which reach the mount
through its write-back.

## What the worker package adds

Resident processes (long-running servers, attached TUIs), the session
protocol, port routing to the public internet, and the hosted terminal all
live in [`@nimbus-sh/worker`](https://www.npmjs.com/package/@nimbus-sh/worker).
That package composes on this one. If you want the full hosted product shape,
start from `npx create-nimbus-app`.

## License

MIT.
