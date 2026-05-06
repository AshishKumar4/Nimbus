# X.5-Q investigation — undici `node:util/types` surface area

**Goal:** decide whether `util.types`'s current 3-method polyfill (isDate, isRegExp, isPromise at `src/node-shims.ts:707`) is enough for jsdom's bundled undici, OR whether we must expand the polyfill before subpath registration.

## Method

1. Installed `jsdom@29.1.1` in `/tmp/jsdom-investigate/`. It pulled `undici@7.25.0` (the version that fires at runtime today — see VERIFY-90993B3 §3 bucket Q).
2. Also installed `undici@8.2.0` standalone in `/tmp/undici-investigate/` for parity check.
3. Grepped both trees for `node:util/types`, `util/types`, and `util.types.<X>` patterns.

## Findings

### undici@7.25.0 (jsdom-bundled)

| File | Line | Import |
|---|---:|---|
| `lib/web/fetch/util.js` | 11 | `const { isUint8Array } = require('node:util/types')` |
| `lib/web/fetch/body.js` | 14 | `const { isUint8Array } = require('node:util/types')` |
| `lib/web/websocket/websocket.js` | 3 | `const { isArrayBuffer } = require('node:util/types')` |
| `lib/web/fetch/headers.js` | 687 | `if (!util.types.isProxy(V) && …)` (via parent `util` import) |
| `lib/mock/mock-utils.js` | 365 | comment only — `// util.types.isPromise is likely needed for jest.` (no real call) |

**Distinct symbols actually called:** `isUint8Array`, `isArrayBuffer`, `isProxy` (3 symbols).

### undici@8.2.0 (standalone)

Same 3 symbols (`isUint8Array`, `isArrayBuffer`, `isProxy`); body/util/util/websocket files unchanged in spirit. No new dependents on `util.types.*`.

### Source files snapshotted into this dir for record

- `undici-fetch-util.js` — verbatim snapshot of jsdom's `node_modules/undici/lib/web/fetch/util.js`
- `undici-fetch-headers.js` — verbatim snapshot
- `undici-websocket.js` — verbatim snapshot

## Verdict

The current 3-method polyfill (`isDate`, `isRegExp`, `isPromise`) **does not cover** the symbols undici dereferences. A bare 2-LOC subpath registration mirroring M-2 (dns/promises) would still fail at first dereference (`isUint8Array is not a function`).

**Decision:** EXPAND `util.types` polyfill to cover the undici-required surface AT MINIMUM:

- `isDate`, `isRegExp`, `isPromise` (preserve existing — used elsewhere)
- `isUint8Array` — `(v) => v instanceof Uint8Array`
- `isArrayBuffer` — `(v) => v instanceof ArrayBuffer`
- `isProxy` — `(v) => false` (no userland-visible Proxy detection in V8 — Node returns false unless using `node:util/types` C++ binding; safest fallback is constant-false)

While we're at it, add a few more cheap one-liners that are commonly imported alongside (defensive, ~10 extra LOC, no observable cost):

- `isAnyArrayBuffer` — `(v) => v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer)`
- `isArrayBufferView` — `(v) => ArrayBuffer.isView(v)`
- `isMap` — `(v) => v instanceof Map`
- `isSet` — `(v) => v instanceof Set`
- `isWeakMap` — `(v) => v instanceof WeakMap`
- `isWeakSet` — `(v) => v instanceof WeakSet`
- `isNativeError` — `(v) => v instanceof Error`
- `isAsyncFunction` — `(v) => v?.constructor?.name === 'AsyncFunction'`
- `isGeneratorFunction` — `(v) => v?.constructor?.name === 'GeneratorFunction'`
- `isTypedArray` — `(v) => ArrayBuffer.isView(v) && !(v instanceof DataView)`
- `isBoxedPrimitive` — `(v) => v instanceof Boolean || v instanceof Number || v instanceof String || v instanceof Symbol || v instanceof BigInt`

THEN register the subpath via the M-2 mirror (2 LOC):

```ts
builtins["util/types"] = builtins.util.types;
builtins["node:util/types"] = builtins["util/types"];
```

Total scope: ~15-20 LOC for the polyfill expansion + 2 LOC registration.

## Risk

- `isProxy` returning constant-false could mask edge bugs in user code that branches on Proxy detection. Acceptable: undici uses it as a "skip-if-proxy" optimization in headers.js line 687 — falling through to the non-proxy branch is correct behavior for our facet (no Proxy wrapping happens at this layer).
- All other symbols are pure `instanceof` checks — zero risk.

## Done state

The polyfill expansion + subpath registration must:

1. `require('node:util/types')` returns an object with all 13 keys.
2. `require('util/types')` returns the same object.
3. `require('node:util/types').isUint8Array(new Uint8Array())` === `true`.
4. `require('node:util/types').isArrayBuffer(new ArrayBuffer(8))` === `true`.
5. `require('node:util/types').isProxy({})` === `false` (constant-false fallback).
6. jsdom's e2e probe flips ⚠ → ✅.
