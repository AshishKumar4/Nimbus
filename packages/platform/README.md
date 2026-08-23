# @nimbus-sh/platform

> Part of [Nimbus](https://github.com/AshishKumar4/Nimbus), my hobby/research
> cloud OS. This README is edited and maintained with Claude (AI) and
> presented as-is.

The measured limits of the Cloudflare Workers platform, and a classifier for
the failures workerd reports only as prose.

Some Workers failures give you nothing to branch on. A Durable Object call
comes back with the words `internal error`. An isolate dies without throwing.
A write past a cap resets the object instead of failing. This package holds
the numbers those failures happen at, and the matchers that name a caught
error. No call site has to string-match its own.

Use it if you write Workers or Durable Object code. It answers whether to
retry a failed call, and what the limit is before you write past it. It has
no runtime dependencies and imports nothing from `cloudflare:`, so it loads
in workerd,
bun, and node.

## Install

```bash
npm install @nimbus-sh/platform
```

## Retry or fail

`classifyDoCall` reads a failed Durable Object call and returns one class.
It walks the cause chain, because a wrapper error drops the runtime's
`.retryable` property and only the joined prose survives. `isRetryableDoCall`
says which classes a retry may act on.

```ts
import { classifyDoCall, isRetryableDoCall, describeError } from '@nimbus-sh/platform';

export async function callWithRetry<T>(call: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      // Mint a fresh stub inside `call`: a stub that failed once is spent.
      return await call();
    } catch (error) {
      const outcome = classifyDoCall(error);
      if (attempt >= attempts || !isRetryableDoCall(outcome)) {
        throw new Error(`${outcome}: ${describeError(error)}`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
}
```

| Class | What happened | Retry |
|---|---|---|
| `superseded_isolate` | a deploy replaced the isolate mid-call | yes |
| `connection_lost` | the stub or storage connection dropped | yes |
| `storage_reset` | storage reset the object: cold start, live write, or timeout | yes |
| `retryable_flag` | the runtime flagged the error `retryable` itself | yes |
| `overloaded` | the object shed the call under queue pressure | never |
| `permanent` | the call ran and the answer is the error | no |

`overloaded` is checked first and vetoes the rest, because retrying an
overloaded object is what overloaded it. Cloudflare's own error-handling
guidance forbids it.

`describeError` gives one line you can log: the error's class, whether the
text came from a remote isolate, and the condition it classifies as. Reach
for it wherever you would otherwise write `e?.message ?? String(e)` and get
back the word `internal error`.

## Naming what died

`classifyError` maps an error, or a bare stderr line, to one cause:
`sqlite_nomem`, `sqlite_full`, `oom`, `cpu_exceeded`, `clone_refused`,
`rpc_timeout`, `subrequest_cap`, `dynamic_worker_cap`, `condemnation`,
`hard_evict`, or `unknown`.

```ts
import { classifyError } from '@nimbus-sh/platform';

export function remedy(error: unknown): string {
  switch (classifyError(error)) {
    case 'sqlite_full':   return 'drain data; reads and DELETEs still work at the wall';
    case 'sqlite_nomem':  return 'retry with a smaller transaction';
    case 'clone_refused': return 'ship the payload in slices under the RPC envelope';
    case 'cpu_exceeded':  return 're-enter the object; yielding inside the turn buys nothing';
    default:              return 'unclassified: keep the message and widen the rules';
  }
}
```

The split between `sqlite_full` and `sqlite_nomem` carries the remedy. At the
storage wall, reads and deletes keep working and you drain data; on NOMEM you
ask for a smaller transaction.

Both `exceededMemory` and `exceededCpu` are uncatchable inside the isolate
that dies. Only a caller across an RPC boundary sees the message, and
isolates also vanish with no message at all. A low `cpu_exceeded` count is
therefore not evidence that CPU was not the cause.

`isTransientDoReset` and `isDoOverloaded` answer those two narrower questions
on their own.

## Limits

Every constant is a fact about the platform: a hard ceiling, or a measured
envelope proven safe against one.

```ts
import { MAX_RPC_SAFE_PAYLOAD_BYTES } from '@nimbus-sh/platform';

export function* slices(bytes: Uint8Array): Generator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += MAX_RPC_SAFE_PAYLOAD_BYTES) {
    yield bytes.subarray(at, at + MAX_RPC_SAFE_PAYLOAD_BYTES);
  }
}
```

| Constant | Value | What it bounds |
|---|---|---|
| `CHUNK_SIZE` | 65,536 | the storage and wire quantum every other bound is counted in |
| `MAX_TX_BLOB_BYTES` | 1 MiB | bytes one storage transaction may hold outstanding; the platform resets the object over the turn, not the total |
| `MAX_TX_LOGICAL_ROWS` / `MAX_TX_SQL_EXECS` | 256 / 64 | rows and execs in that same transaction |
| `SQLITE_MAX_ROW_BYTES` | 2,000,000 | bytes per ROW, key length included; budget values against the row bound |
| `SQLITE_MAX_STATEMENT_BYTES` | 100 KiB | SQL text per exec |
| `SQLITE_MAX_BOUND_PARAMETERS` | 100 | bound parameters per query; a batched insert breaches this first |
| `DO_STORAGE_LIMIT_BYTES` | 10,000,000,000 | storage per Durable Object, shared by every facet and clone under it, with no copy-on-write credit |
| `BLOCK_CONCURRENCY_CANCEL_MS` | 30,000 | how long a `blockConcurrencyWhile()` callback may run before the object is reset |
| `WS_ATTACHMENT_LIMIT_BYTES` | 16,384 | serialized bytes per hibernatable WebSocket attachment |
| `MAX_RPC_SAFE_PAYLOAD_BYTES` | 28 MiB | bytes to send in one RPC value, under the platform's 32 MiB |

Each constant's doc comment carries the measurement that set it, and says
whether the value is documented by Cloudflare or probed. `SQLITE_MAX_ROW_BYTES`
is 2,000,000 against a measured single-value ceiling of 2,199,981 bytes,
because budgeting a row against the value ceiling would be wrong.

The supervisor budget constants (`SUPERVISOR_HEAP_CEILING_BYTES` and the
allocation budgets beside it) are Nimbus policy derived from the 128 MiB
isolate ceiling. They are soft admission targets, and the doc comments say so.

## The rest of the surface

- `heap-estimate.js` / `heavy-alloc-coord.js` / `weighted-credit-pool.js` —
  an instrumented heap model for a supervisor Durable Object, and the
  weighted admission budget that holds allocations under it.
  `estimateSupervisorHeap` returns a lower bound, and `HEAP_BLIND_SPOTS`
  names the allocation sites it cannot see.
- `diag-counters.js` / `install-phase.js` — deterministic allocation-site
  counters, because `process.memoryUsage()` returns 0 in a Durable Object,
  plus the phase taxonomy they report against.
- `oom-discriminator.js` — the failure ring that attributes a death after the
  fact: `recordFailure`, `getFailures`, and a snapshot pair that carries the
  ring across a reset.
- `rpc-dispose.js` — `disposeRpcResource` and `disposeRpcResources`, explicit
  `Symbol.dispose` for RPC values, including on error paths.
- `w7-frame.js` — the incremental typed record format for streamed bulk
  filesystem writes, with `encodeWriteBatchStream` and the batch payload
  types it encodes.

## Related packages

[`@nimbus-sh/core`](https://www.npmjs.com/package/@nimbus-sh/core) is the
backend-agnostic OS, and
[`@nimbus-sh/fabric`](https://www.npmjs.com/package/@nimbus-sh/fabric) is the
Durable Object machinery. Both are built on the limits and the taxonomy here.

## License

MIT.
