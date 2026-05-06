# X.5-R Investigation — Phase A reproduction + root-cause

## Reproduction at HEAD `a571079`

Wrangler dev started locally on port 8787. Re-ran the original
`audit/probes/verify-700420f/run-packages-local.mjs --only=fastify` and
`--only=redis`. Outputs preserved here:

- `fastify-on-a571079.out.txt` — exit 0, smoke prints `app title: Object`.
  ✅ **Already healthy at current HEAD.** The earlier failure
  (`Cannot read properties of undefined (reading 'start')` at
  `Plugin.on (runner.js:708:38)`) was eliminated by X.5-Z5-build's
  EE-shim mixin lazy-init in `src/node-shims.ts:694-710`. Confirmed
  by inspecting current `EE.on/once` body — `(this._e ??= {})`
  unconditionally allocates the listener bag, so `plugin.once('start',
  cb)` from `avvio/boot.js:385` no longer touches an undefined
  intermediate.

- `redis-on-a571079.out.txt` — exit 1, same shape as 700420f
  (`TypeError: Class extends value undefined is not a constructor or null`
  at runner.js:34:34 → eval anon line 303 col 48). ❌ **Still broken.**

## Goalposts moved

The dispatch (VERIFY-700420F.md §4 #1) bucketed fastify + redis as
sharing a **single root cause**: "EventEmitter inheritance chain
producing undefined intermediate". That hypothesis was correct AT
700420f but X.5-Z5-build's lazy-init merge already addressed
fastify's path. Only redis remains. Bucket R degenerates to a
1-package fix.

## Root cause for redis (hard verified)

The error is NOT in `@redis/client/dist/lib/client/index.js` (which
does `const node_events_1 = require("node:events"); class RedisClient
extends node_events_1.EventEmitter`) — that file is fine because our
`require("node:events")` returns the EE class with `EE.EventEmitter
= EE` set (`src/node-shims.ts:711`).

The error IS in `@redis/client/dist/lib/client/cache.js` line 301:

```js
const stream_1 = require("stream");                     // line 4
// ...
class ClientSideCacheProvider extends stream_1.EventEmitter {   // line 301
```

Real Node's `require('stream').EventEmitter === require('events').EventEmitter`
(verified locally via `node -e`). Older code patterns import EE from
`stream` for backwards compat with the legacy stream-as-EE shape.

Our `__streamMod` (see `src/streams.ts` `generateStreamsCode`) returns
`{ Readable, Writable, Duplex, Transform, PassThrough, Stream:
Readable, pipeline, finished, _Readable, _Writable, _Transform }`
plus a non-enumerable `prototype` pointer (X.5-Z5 Defect-A fix).
**It does NOT carry `.EventEmitter`.** So `stream_1.EventEmitter` is
`undefined`, and `class … extends undefined` throws exactly the
observed message.

## Stack-frame ↔ source mapping

The redis stack (newest call last):

| Frame | Maps to |
|---|---|
| `eval at <anonymous> (runner.js:34:34), <anonymous>:303:48` | `cache.js:301` `class … extends stream_1.EventEmitter`. The 303 vs 301 offset is the 2-line CJS prologue prepended when wrapped in `new Function(exports, require, module, __filename, __dirname, code)`. col 48 lands on the `EventEmitter` token. |
| `__loadModule (runner.js:2776:7)` | Resolver's `__loadModule` evaluating `cache.js`. |
| `__requireFrom (runner.js:2867:10)` | parent's scopedRequire trying `require('./cache')`. |
| `eval … <anonymous>:17:17` | `client/index.js:15` (= `require('./cache')` after prologue). |
| `eval … <anonymous>:44:16` | `dist/index.js` requiring `./lib/client`. |

The 3-deep eval chain is the redis package import tree:
`redis` (top) → `@redis/client/dist/index.js` → `@redis/client/dist/lib/client/index.js` → `@redis/client/dist/lib/client/cache.js` (fails).

## Fix shape

Add `__streamMod.EventEmitter = __eventsMod;` after the
`builtins.stream = __streamMod;` registration in
`src/node-shims.ts:1781`. This is a pure surface-area extension of
the stream module; mirrors real Node's `require('stream').EventEmitter`
re-export. ≤2 LOC.

This is **Bucket R reduced to a stream-module surface fix**, NOT an
events-module fix. The original VERIFY-700420F.md hypothesis ("events
EE inheritance chain produces undefined") was right in spirit but
mis-pointed at the wrong shim — X.5-Z5-build already healed the
events shim's lazy-init issue; the remaining defect is a missing
re-export on the *stream* shim.

## Single-root-cause vs divergence

For the original prompt's "single bucket, single fix" framing:
- fastify: ALREADY GREEN at `a571079`. Z5-build EE lazy-init merge
  closed it.
- redis: requires a single 1-2 LOC addition to `__streamMod` to
  surface `.EventEmitter`.

Charter holds: the fix is still in `src/node-shims.ts`, scope
≤10-30 LOC, predicted +2 ✅. The +2 is half-realized via Z5-build,
the other half realized here.

## Predicted vs measured deviation table

| Pkg | 700420f forecast | a571079 measured (pre-X5R) | post-X5R predicted |
|---|---|---|---|
| fastify | EE inheritance — needs R | ✅ already green (X5Z5 effect) | ✅ |
| redis | EE inheritance — needs R | ⚠ stream.EventEmitter undefined | ✅ |

Net: from 23/33 (eb316dc baseline) → 24/33 (a571079, +1 from
X5Z5-build's express + indirect fastify recovery, see X5Z5-build
retro for cumulative count) → 25/33 (post-X5R, +1 redis).

**Note:** the actual current strict-✅ count at a571079 is unverified
in this investigation phase (only spot-checked 2 packages); a full
re-sweep is out of scope for X5R but should run as a follow-on
verify wave.
