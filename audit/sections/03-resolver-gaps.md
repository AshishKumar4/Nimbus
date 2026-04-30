# Section 03 — Resolver Gaps

> All file:line citations against HEAD `e93b18d`. Verified by direct read
> of `src/`. Behavioural evidence cross-referenced with Section 02 probe
> artifacts.

## TL;DR

There are **two parallel resolvers** in the runtime path, and they have
drifted:

| Layer | File | Lines | Coverage |
|---|---|---|---|
| **Install-time tree resolver** | `src/npm-resolver.ts` | 615-688 (`resolveExports`) + 731-750 (`resolvePackageEntry`) | ✅ proper Node.js spec impl: subpath patterns, conditions, nested conditions, arrays, imports field |
| **Runtime CJS resolver** (user-shell `node`) | `src/node-shims.ts` | 880-913 (`__resolvePkgEntry`), 920-963 (`__resolveNodeModule`), 881 (`__resolveFile` extension list) | ❌ hand-rolled, broken: only `entry.require\|default\|import`, no conditions, no subpath patterns, no imports field, no null-target |

The install resolver `resolvePackageEntry` is **already exported**
(`npm-resolver.ts:731`) and could be reused by the runtime resolver.
**It isn't.** The runtime resolver re-implements a strict subset by hand
and gets it wrong.

This is the root cause of the 18+ ⚠️ packages in Section 02.

## Gap-by-gap audit

### 3.1 `package.json#exports` — RUNTIME RESOLVER PARTIAL ⚠️

**Install resolver** (`src/npm-resolver.ts:625-688`): correctly handles all
spec features — string shorthand, subpath maps, conditional maps,
subpath wildcards (`./*`), nested conditions, array fallbacks. Comment at
`:622-623` is honest about coverage.

**Runtime resolver** (`src/node-shims.ts:897-905`):
```js
if (pkg.exports) {
  let entry = pkg.exports;
  if (typeof entry === "object" && entry["."]) entry = entry["."];
  if (typeof entry === "object") entry = entry.require || entry.default || entry.import;
  if (typeof entry === "string") {
    const resolved = __resolveFile(pkgDir + "/" + entry.replace(/^\\.\\//,""));
    if (resolved) return resolved;
  }
}
```

Gaps:
- Only handles entry `"."` — every other subpath is dropped.
- Only top-level conditions `require`/`default`/`import`. Misses `node`, `browser`, `worker`, `development`, `production`, `types`.
- No nesting: `{ ".": { "node": { "default": "..." } } }` falls through.
- No array fallback.
- No subpath wildcards: `"./*": "./dist/*.js"` ignored.
- No null-target enforcement (private subpaths leak via fallthrough).
- The replace `^\\.\\/` is over-cautious-buggy: matches literal `\.\` not `./`.

**Subpath resolution path** (`src/node-shims.ts:944-947`):
```js
if (subpath) {
  const resolved = __resolveFile(nmDir + "/" + subpath);
  if (resolved) return resolved;
}
```
**Subpath never consults `pkg.exports`.** This is why
`require('react/jsx-runtime')` fails — the resolver looks at the
filesystem path `node_modules/react/jsx-runtime{.js,.mjs,...}` directly,
ignoring that `react`'s `exports` map says `"./jsx-runtime": "./jsx-runtime.js"`.

For packages like `@libsql/client` whose subpath `@libsql/core/config`
resolves through nested `exports`, the lookup fails entirely and falls
to extension-probing on a path that doesn't exist.

### 3.2 `package.json#imports` (`#name`) — RUNTIME ENTIRELY MISSING ❌

Install resolver supports it (same `resolveExports` function applies — see
the comment at `npm-resolver.ts:651-653` calling out the dual use).

Runtime resolver has **zero** handling. `__requireFrom` at
`src/node-shims.ts:1040+` doesn't recognize `#name` specifiers as a
distinct kind. They fall through `__resolveNodeModule` (which is for
bare specifiers) and fail with `Cannot find module '#name'`.

**Affected packages on the npm public top-1k**: `vfile@5+`, `unified@10+`,
`remark@14+`, `mdx`, `unist-util-*` chain. Not in Section 02 probe set —
add to W2 verification cohort.

### 3.3 `peerDependencies` — ABSENT ❌🔴

```bash
$ grep -lrn "peerDep" src/ --include="*.ts" 2>/dev/null | grep -v generated
(zero matches)
```

**Verified: 0 references in 47 non-generated TS files in `src/`.**

The `ResolvedPackage` interface at `src/npm-resolver.ts:64`:
```ts
exports: any;          // package.json exports field (raw)
```
…has slots for `exports`/`main`/`module`/`bin` but no `peerDeps`/`peerDepsMeta`.

`buildSpecs` at `src/npm-installer.ts:806-854`:
- reads `pkgJson.dependencies` (`:837`)
- reads `pkgJson.devDependencies` if not production (`:845`)
- **never reads `pkgJson.peerDependencies` or `peerDependenciesMeta`**

`resolveTree` at `src/npm-resolver.ts:540-549`:
- enqueues only transitive `dependencies` (`:545`)
- **never enqueues peer deps from a transitive package**

**User-visible impact**: a project that installs `@radix-ui/react-dialog`
but doesn't list `react`/`react-dom` in its own `package.json` will silently
not get them — even though `@radix-ui/react-dialog`'s peer requirement is
explicit. (The Section 02 probes *manually added* `react@18.3.1
react-dom@18.3.1` to Radix/framer-motion/react-remove-scroll installs to
work around this; without that addition every Radix install would fail
upstream.)

### 3.4 `optionalDependencies` — ABSENT ❌

Same pattern: 0 grep refs to `optionalDep` in non-generated source. The
skip list at `src/npm-resolver.ts:754-765` happens to include `fsevents`
and `chokidar`, masking some symptoms.

`@swc/core` and `@tailwindcss/oxide` and other npm-bug-4828 victims fail
with `"Cannot find native binding"` because the platform-specific
`*-linux-x64-gnu` opt-deps are listed as `optionalDependencies` and Nimbus
silently drops them.

### 3.5 Subpath resolution — extensions list incomplete

`src/node-shims.ts:881`:
```js
const exts = ["", ".js", ".mjs", ".cjs", ".json", "/index.js", "/index.json", "/index.mjs"];
```

Missing: `.ts`, `.tsx`, `.cts`, `.mts`, `.jsx`. The user-shell `node`
runner can't load `.ts` (it would need transpilation anyway), but the
gap breaks subpath probes that should match a `.cts` or `.mjs` index in
non-standard layouts.

### 3.6 Bare → `node:*` aliasing — MISSING in BROWSER PATH 🔴

This is a separate issue from the runtime resolver — affects the
browser-side `vite-dev-server.ts` only.

`src/vite-dev-server.ts:507-521 resolveBareSpecifier`:
```js
function resolveBareSpecifier(specifier, aliases, basePath) {
  if (specifier.startsWith('@modules/')) return null;
  if (specifier.startsWith('http://') || specifier.startsWith('https://')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return null; // skip node: et al
  if (aliases) { … }
  if (specifier.endsWith('.css') || specifier.includes('.css?')) return null;
  return makeModuleUrl(basePath, specifier);
}
```

Line 512 skips `node:crypto` (because of the protocol regex), but a bare
`crypto` falls through to line 520 → rewritten to
`/preview/@modules/crypto` → 404 in browser (no such VFS path). There's
no `NODE_BUILTINS` set checked between line 513 and line 520.

**Browser-side impact**: any package that imports `import { Buffer } from
'buffer'` or `require('crypto')` instead of `'node:crypto'` 404s in
the browser bundle. Mossaic-class.

### 3.7 Multi-version resolution — DEAD CODE ⚠️

`src/npm-resolver.ts:599-601`:
```js
for (const [name, pkg] of resolved) {
  root.set(name, pkg);
}
```

The `nested` Map is initialized at `:580` and immediately abandoned. Comments
at `:603-605` are explicit:
> Phase 3: Future — handle cases where multiple versions of the same name
> are needed (peer dependency conflicts). For now, our resolver picks one
> version per name (same as npm's flat tree), so nested is always empty.

Combined with `resolveTree:540-541` (`if (resolved.has(pkg.name)) continue`)
which is first-version-wins:
> // Brief idle window between waves — the diag layer surfaces this …

A project that pulls in two transitive deps requiring incompatible majors
(e.g. `react@17` + `react@18`) silently gets whichever arrives first in
BFS order. The second consumer gets the wrong React.

### 3.8 Install protocols — REGISTRY ONLY ⚠️

`src/npm-installer.ts:806-826 buildSpecs`:
```ts
const atIdx = pkg.lastIndexOf('@');
if (atIdx > 0 && !pkg.startsWith('@')) {
  specs[pkg.substring(0, atIdx)] = pkg.substring(atIdx + 1);
} else if (pkg.startsWith('@') && pkg.indexOf('@', 1) > 0) {
  …
}
```

This parser handles `pkg@version` and `@scope/pkg@version` only. Anything
else (`file:./local`, `link:`, `git+ssh://`, `github:user/repo`,
`workspace:^`, `npm:alias@1`, `https://example.com/foo.tgz`) is misparsed
or treated as a literal range string, then fed to the registry which
rejects it.

### 3.9 `isLockfileValid` — RANGE NOT CHECKED 🟠

`src/npm-installer.ts:861-871`:
```ts
private isLockfileValid(lockfile, specs): boolean {
  for (const name of Object.keys(specs)) {
    if (shouldSkipPackage(name)) continue;
    if (!lockfile.has(name)) return false;
  }
  return true;
}
```

The check is "every spec name is also a key in the lock". It does **not**
verify that the locked version still satisfies the current range. So
editing `package.json` from `"react": "^17.0.0"` → `"react": "^18.0.0"`
leaves the lockfile valid, and installs continue using `react@17.x`
silently.

### 3.10 `browser` field — IGNORED 🟡

`src/npm-resolver.ts:731-750 resolvePackageEntry`:
```ts
if (subpath === '.') {
  if (pkg.module) return pkg.module;
  if (pkg.main) return pkg.main;
}
```

`pkg.browser` (string OR object map per
https://github.com/defunctzombie/package-browser-field-spec) is never
consulted. Older browser-targeted polyfills like `crypto-browserify` that
set `"browser": "./browser.js"` get the Node entry instead.

### 3.11 `engines` field — IGNORED 🟢

Zero handling. No warnings on mismatch. Low-impact since workerd's "Node
20.0.0" identification is itself faked.

## Side-by-side: install resolver vs runtime resolver

| Feature | Install (`npm-resolver.ts:625`) | Runtime (`node-shims.ts:889`) |
|---|---|---|
| String shorthand `exports` | ✅ `:633-635` | ✅ `:901-904` |
| Subpath map `{".": …, "./feat": …}` | ✅ `:660-663` | ❌ only `"."` |
| Subpath wildcards `"./*": "./*.js"` | ✅ `:666-677` | ❌ not at all |
| Conditional map (top-level) | ✅ `:683` + `:710-720` | ⚠️ only `require\|default\|import` |
| Nested conditions | ✅ `:712` recursion | ❌ flat lookup |
| Array fallback | ✅ `:638-643` | ❌ |
| `imports` field (`#name`) | ✅ same fn handles it (`:651-654`) | ❌ unhandled |
| `node`/`browser`/`worker` conditions | ✅ pass via `conditions` arg | ❌ not even an arg |
| Caller can pass conditions | ✅ `:628` | ❌ no arg |
| Subpath honours exports | ✅ via `subpath !== '.'` path | ❌ direct `__resolveFile` at `:946` |

## Why the install resolver isn't reused at runtime

Because `node-shims.ts` runs **inside the user's `node` shell** (a
dynamic-worker facet). The shim is generated as a string preamble by
`facet-manager.ts` and prepended to the user's script. It can't import
`./npm-resolver.js` because that's TypeScript that runs in the supervisor.

A fix could either:
- a) Inline a compiled copy of `resolveExports` + `resolvePackageEntry` into the shim preamble
- b) Pre-resolve all import paths at install time and inject a resolution map into the VFS bundle (more work but eliminates runtime resolution drift)
- c) Have facet RPC the supervisor for resolution (round-trip cost per `require()`)

Option (a) is the W2 surgical fix — copy `resolveExports`'s
~75 LOC into `node-shims.ts` between `:880` and `:914`.

## Citations

- Install resolver: `src/npm-resolver.ts:615-688`
- `resolvePackageEntry`: `src/npm-resolver.ts:731-750`
- Runtime resolver: `src/node-shims.ts:880-913`
- Bare specifier handler: `src/vite-dev-server.ts:507-521`
- `buildSpecs`: `src/npm-installer.ts:806-854`
- `isLockfileValid`: `src/npm-installer.ts:861-871`
- `computeHoistPlan`: `src/npm-resolver.ts:576-608`
- `SKIP_PACKAGES`/`SKIP_PREFIXES`: `src/npm-resolver.ts:754-783`
- `peerDependencies` zero-grep: `grep -lrn "peerDep" src/ --include="*.ts" | grep -v generated` returns nothing
- Node.js exports spec: https://nodejs.org/api/packages.html#conditional-exports
- npm 4828 (optDep platform pkg): https://github.com/npm/cli/issues/4828
- Browser field spec: https://github.com/defunctzombie/package-browser-field-spec
