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

Files written through `.fs` are owned by the session user (uid 1000), not
root. The shell enforces the same permission model either way: a root-owned
`/etc/passwd` refuses a write from `.fs`, and `id` resolves names through
it.

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
keeps its files there. Nimbus updates `/etc/passwd` and `/etc/profile` only
when they are still exactly what it seeded.

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

A node process's synchronous `fs` and `require` see a mount, one without a
`sync` face included, where its launch names it: its working directory, its
program's directory and arguments, the literal paths its code names, and the
files its module map was read from. A directory named there is listed whole,
breadth first, up to 8192 names per launch (`MOUNT_LIST_NAME_LIMIT`), and so
is every directory from the mount point down to it. A mount the launch does
not name is not walked. A synchronous call on a mounted path the launch did
not list, or past the bound, answers EAGAIN ("/shared is an asynchronous
mount; this caller cannot wait for it") and names the `fs.promises` form that
reads it; a missing name in a listed directory is ENOENT. The process holds
the mount's names and content as of its launch, plus its own writes, which
reach the mount through its write-back.

## What the worker package adds

Resident processes (long-running servers, attached TUIs), the session
protocol, port routing to the public internet, and the hosted terminal all
live in [`@nimbus-sh/worker`](https://www.npmjs.com/package/@nimbus-sh/worker).
That package composes on this one. If you want the full hosted product shape,
start from `npx create-nimbus-app`.

## License

MIT.
