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

await ws.fs.writeFile('/home/user/hello.txt', 'hi\n');
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

Without `facets` and `runtimes` you still get the full shell and coreutils.
The wasm runtimes are a dependency you add.

`localFacetHost()` covers bun and node only. On workerd the CSP forbids
request-time `WebAssembly.instantiate`, so wasm has to ride the Worker Loader
module map. That machinery lives in `@nimbus-sh/worker` and
`@nimbus-sh/fabric`. The shell, coreutils, and filesystem need none of it.

## Sharing a database with your own app

The workspace is a tenant in a database you own:

- It creates and touches only its own tables (`inodes`, `file_chunks`,
  `content_lifecycle`, `vfs_*`).
- `destroy()` drops those tables and does not call `deleteAll()`.
- `transactionSync` must be a real transaction. An implementation that only
  calls the callback turns every atomic write into a torn one.
- `generation` must never repeat across restarts of your host. Pids derive
  from it, and a repeated generation would hand a dead process live write
  authority.

## What the worker package adds

Resident processes (long-running servers, attached TUIs), the session
protocol, port routing to the public internet, and the hosted terminal all
live in [`@nimbus-sh/worker`](https://www.npmjs.com/package/@nimbus-sh/worker).
That package composes on this one. If you want the full hosted product shape,
start from `npx create-nimbus-app`.

## License

MIT.
