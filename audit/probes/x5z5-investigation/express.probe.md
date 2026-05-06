# Probe: express — `Object prototype may only be an Object or null: undefined`

> Static-analysis probe + cite-path. No new wrangler dev run (the existing
> verify-90993b3 probe already captured the runtime evidence with stack
> trace). This probe pins the exact src:line where the fix lands.

## 1. Re-cited runtime evidence

`/workspace/worktrees/verify-90993b3/audit/probes/verify-90993b3/packages-local/express.out.txt:44-48`

```
TypeError: Object prototype may only be an Object or null: undefined
    at Object.create (<anonymous>)
    at Object.inherits (runner.js:1110:60)
    at eval (eval at <anonymous> (runner.js:34:34), <anonymous>:157:6)
    at __loadModule (runner.js:2652:7)
```

The `runner.js:1110:60` site corresponds to the `Object.create(s.prototype, ...)`
expression in our `util.inherits` shim — see citation §3.

## 2. Express's transitive dependency that calls the shim

Express → body-parser → raw-body → readable-stream
(readable-stream@2.x is the legacy stream polyfill many older HTTP
deps still pull in via http-errors / iconv-lite chains).

Verbatim caller (downloaded readable-stream-2.3.8.tgz @ `/tmp/ts-probe/rb2/package/lib/_stream_writable.js:67-96`):

```
67: var util = Object.create(require('core-util-is'));
68: util.inherits = require('inherits');
...
78: var Stream = require('./internal/streams/stream');
...
96: util.inherits(Writable, Stream);
```

`./internal/streams/stream.js` (cited verbatim above) is one line:
```
module.exports = require('stream');
```

So `Stream = require('stream')` — the result of our
`builtins['stream']` wiring at `src/node-shims.ts:1706`.

The `inherits` package (`/tmp/ts-probe/inh/package/inherits.js`) uses
`util.inherits` when present:
```
var util = require('util');
if (typeof util.inherits !== 'function') throw '';
module.exports = util.inherits;
```

So the call chain reaches `util.inherits(Writable, Stream)` where
`Stream` = the value of `require('stream')` in our facet.

## 3. Root cause — TWO bugs stacking

### Bug A: `__streamMod` is a plain namespace object, not a callable Stream class

`src/streams.ts:380-386`:
```
return {
  Readable, Writable, Duplex, Transform, PassThrough,
  Stream: Readable,
  pipeline, finished,
  // Aliases for compatibility
  _Readable: Readable, _Writable: Writable, _Transform: Transform,
};
```

In real Node.js, `require('stream')` returns the `Stream` legacy class
(a function — historically equal to `EventEmitter` with extra .pipe()
glue) **with** `Readable`/`Writable`/etc. attached as static
properties. Code in the wild assumes `require('stream').prototype`
exists. Our object literal has no `.prototype`.

So `Stream.prototype === undefined` and
`Object.create(undefined, {...})` throws the verbatim message
"Object prototype may only be an Object or null: undefined".

### Bug B: `util.inherits` shim doesn't guard against undefined parent

`src/node-shims.ts:708`:
```
inherits: (c, s) => { c.super_ = s; c.prototype = Object.create(s.prototype, { constructor: { value: c } }); },
```

The pure-JS `inherits` package's browser fallback
(`/tmp/ts-probe/inh/package/inherits_browser.js`) wraps the same
`Object.create` call in `if (superCtor) { ... }`. Our shim doesn't
defensively check `s == null` or `s.prototype == null` first. Even
after Bug A is fixed, this is a latent footgun (any caller passing
an invalid superCtor explodes with the same opaque error).

## 4. Fix sketch (per §C)

### Primary fix (one of):

**(A1)** Make `__streamMod` a callable Stream-class proxy:
- Define a `Stream` class extending `__eventsMod` with `pipe(dest)`
- Attach `Readable`/`Writable`/etc. as own static properties
- `module.exports = Stream` instead of plain `{...}`

LOC estimate: ~20 lines in `src/streams.ts`.

**(A2)** Ship a synthetic `.prototype` on the namespace object:
```
const ns = { Readable, Writable, ..., Stream: Readable };
ns.prototype = Readable.prototype;
return ns;
```

LOC estimate: ~3 lines. **Lower-risk** — keeps the existing API surface.
The legacy Stream class IS effectively Readable in Node (per the
old node:stream contract; `Stream` superclass adds only `.pipe()`).

### Defensive fix (orthogonal but cheap):

**(B)** Guard `util.inherits` shim:
```
inherits: (c, s) => {
  if (s == null || s.prototype == null) return;  // match inherits_browser.js
  c.super_ = s;
  c.prototype = Object.create(s.prototype, { constructor: { value: c, enumerable: false, writable: true, configurable: true } });
}
```

LOC estimate: 4 lines at `src/node-shims.ts:708`.

## 5. Predicted ✅ flip

`require('express')` returns the express factory function. Probably
unblocks **+1** package directly. Possibly also unblocks any other
package that imports `readable-stream@2` and inherits Writable from
Stream — which is "lots of older middleware" (express, koa-body,
etc., body-parser standalone) but the verify cohort has only express
on it.

## 6. Risk

- Bug A's fix touches the Stream module shape. Risk: any code that
  does `require('stream').Readable.prototype` etc. continues to work
  (those access static class properties, not Stream's own prototype).
  Code that does `new (require('stream'))(...)` would now construct a
  Readable, which is closer-to-real than the current TypeError.
- Bug B's fix is defensive and side-effect-free.

## 7. Dependencies

- Independent of the other 3 Z5 packages.
- Does NOT depend on W2.6b cap work.
- Does NOT depend on the X.5-NPQO node-shims wave (which currently
  owns `src/node-shims.ts` write-lock per the dispatch).

If X.5-NPQO is touching `__streamMod` or `__utilMod`, this fix has to
land **after** X.5-NPQO merges to avoid conflicts — but the fix
landing zones (`src/streams.ts:380-386` + `src/node-shims.ts:708`)
are narrow and X.5-NPQO is likely operating elsewhere.
