<!--
This document is edited and maintained by Claude and is presented as-is.
-->

# opencode Nimbus build recipe

Nimbus runs the opencode CLI as a single-file ESM bundle inside a workerd
Worker Loader facet (see `src/runtime/opencode-facet-runner.ts`). The bundle is
NOT `npm install opencode-ai` (that ships native shards Nimbus cannot execute);
it is produced from the opencode source with Nimbus-specific build flags and
source patches, then staged by `scripts/bundle-opencode.mjs`.

This directory captures the parts of that recipe that live outside the source
clone, so the staged bundle is reproducible.

## Files

- `build-node.ts` — the `Bun.build` recipe (target node, `conditions:["node"]`,
  `format:"esm"`). Reference copy; runs from inside the opencode clone at
  `packages/opencode/build-node.ts` (it needs the clone's resolve-hook stub
  files: `bun-shim.ts`, `bun-ffi-shim.ts`, `bun-sqlite-shim.ts`, `pty-stub.ts`,
  `opentui-native-stub.ts`, and `script/generate.ts`).

  Nimbus-relevant defines:
  - `import.meta.url` → a synthetic absolute file URL so the bundle's
    top-level `createRequire(import.meta.url)` constructs (in a Worker Loader
    ESM module `import.meta.url` is otherwise `undefined`).

- `nimbus-defer-global-io.patch` — source patches that defer opencode's
  module-top-level side effects out of workerd's "global scope" (where async
  I/O, timers, and random generation are disallowed) into the request handler.
  Apply with `git apply` inside the opencode clone before building:

  | File | Change |
  |---|---|
  | `packages/core/src/global.ts` | XDG dir `fs.mkdir` Promise.all → `export async function ensureDirs()`, gated behind `__NIMBUS_OPENCODE_DEFER`. |
  | `packages/core/src/effect/observability.ts` | top-level `crypto.randomUUID()` → lazy `processID()`. |
  | `packages/opencode/src/index.ts` | top-level `await cli.parse()` → `export async function nimbusMain()` (awaits `Global.ensureDirs()` first); `ensureProcessMetadata("main")` made lazy; self-invoke gated behind `__NIMBUS_OPENCODE_DEFER`. |

  Under Bun (a normal install) `__NIMBUS_OPENCODE_DEFER` is unset, so opencode
  behaves exactly as upstream. The Nimbus runner sets the flag and invokes
  `nimbusMain()` from its `fetch` handler.

## Rebuild

```
# In the opencode clone:
git apply <this-dir>/nimbus-defer-global-io.patch
bun run packages/opencode/build-node.ts        # → /tmp/opencode-research/dist-nimbus

# In Nimbus:
node packages/worker/scripts/bundle-opencode.mjs   # restage into public/_assets
bun run --cwd packages/worker build
```
