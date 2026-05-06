# Probe: @tailwindcss/vite — `pre-compile failed at facet startup: Cannot use import statement outside a module`

> Static-analysis probe + a reproduction script that demonstrates
> `looksLikeEsm()` returns `false` on the affected source.

## 1. Re-cited runtime evidence

`/workspace/worktrees/verify-90993b3/audit/probes/verify-90993b3/packages-local/tailwindcss-vite.out.txt:135-140`

```
Error: Cannot load module 'home/user/app/node_modules/@tailwindcss/vite/dist/index.mjs': pre-compile failed at facet startup: Cannot use import statement outside a module
    at __loadModule (runner.js:2668:17)
```

The `(runner.js:2668:17)` site corresponds to the throw inside
`__loadModule`'s `__compileFailures`-routed branch — see
`src/node-shims.ts:2170-2174`.

That branch fires when the source was IN the bundle, the per-startup
`new Function(... source ...)` (facet-manager.ts:215) threw
SyntaxError "Cannot use import statement outside a module", and
`__compileFailures` recorded the message.

So the file IS in the bundle — but our ESM→CJS pre-pass never
transformed it.

## 2. The actual source: `@tailwindcss/vite/dist/index.mjs`

Downloaded `@tailwindcss/vite-4.1.5.tgz` @ `/tmp/ts-probe/tw/package/dist/index.mjs`.

The file is **single-line minified**. First `import` keyword sits
inside the line at byte offset 792:

```
$ node -e 'const s = require("fs").readFileSync("/tmp/ts-probe/tw/package/dist/index.mjs","utf8");
           console.log("import pos:", s.indexOf("import"));
           console.log("char before import:", JSON.stringify(s[s.indexOf("import")-1]));'
import pos: 792
char before import: ";"
```

Verbatim head of the line (truncated for readability):
```
var C=(r,e)=>(e=Symbol[r])?e:Symbol.for("Symbol."+r),D=r=>{...};...};import{compile as M,...}from"@tailwindcss/node";...
```

Top-level `;import{...}from"..."` and `;export{O as default}` —
both preceded by `;` on the same line.

## 3. Why the ESM→CJS pre-pass skips it

`src/facet-manager.ts:766-776` defines `looksLikeEsm`:

```
766: function looksLikeEsm(src: string): boolean {
769:   const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
772:   const importStmt = /(^|\n)\s*import\s+(['"][^'"]+['"]|[\w*$]|\{)/;
774:   const exportStmt = /(^|\n)\s*export\s+(default\b|\{|\*|let\b|const\b|var\b|function\b|class\b|async\b|type\b)/;
775:   return importStmt.test(stripped) || exportStmt.test(stripped);
776: }
```

**Both regexes anchor with `(^|\n)`** — they require either
start-of-string or a newline before optional whitespace before
`import`/`export`. A `;` (or any non-newline char) directly before
the keyword **fails the anchor**.

Reproduction:
```
$ node -e 'const s = require("fs").readFileSync("/tmp/ts-probe/tw/package/dist/index.mjs","utf8");
           const importStmt = /(^|\n)\s*import\s+(['\''"][^'\''"]+['\''"]|[\w*$]|\{)/;
           const exportStmt = /(^|\n)\s*export\s+(default\b|\{|\*|let\b|const\b|var\b|function\b|class\b|async\b|type\b)/;
           console.log("looksLikeEsm:", importStmt.test(s) || exportStmt.test(s));'
looksLikeEsm: false
```

`looksLikeEsm` returns false → `transformEsmInBundle` skips the file
→ the original ESM source ships in the bundle → workerd's
`new Function(...)` rejects it at facet startup → __compileFailures
records the SyntaxError → __loadModule surfaces it as "pre-compile
failed at facet startup: ...".

## 4. Generality of the bug

Any ESM file that's been minified by tsup / esbuild / rollup with
`legalComments=none` and statement-level minification produces
single-line output where the first `import`/`export` is preceded by
non-newline punctuation (typically `;` or `}`).

Probable other regressions in the verify-90993b3 cohort caused by
the same regex blind spot — to be confirmed by re-running probes
post-fix:
- any `.mjs` shipped from a tsup/rollup minified bundle.

## 5. Fix sketch (per §C)

The regex needs **two** changes (verified by `run-checks.cjs`):

**(F1a)** Relax the leading anchor to also accept `;` and `}`
(post-statement boundaries, common after minification):

```ts
const importStmt = /(^|[\n;}])\s*import[\s{]/;
const exportStmt = /(^|[\n;}])\s*export[\s{*]/;
```

**(F1b)** Replace `import\s+` with `import[\s{]` (and similarly for
`export`) — minified ESM has NO whitespace between the keyword and
the brace: `import{compile as M}from"@tailwindcss/node"`. The
original `\s+` rejects this entirely (and was a separate latent bug
even with the original `(^|\n)` anchor — any well-formed minified
ESM matches if and only if BOTH (F1a) and (F1b) land).

The simplified body `[\s{]` (or `[\s{*]` for export) replaces the
much longer `(['"][^'"]+['"]|[\w*$]|\{)` alternation. The simpler
form is also more permissive on edge-case ESM:
- `import "side-effect-module"` → opens with `\s` ✅
- `import x from "y"` → opens with `\s` ✅
- `import{x} from "y"` (minified) → opens with `{` ✅
- `import * as y from "z"` (rare with ;) → opens with `\s` ✅

False-positive guard verified: `var importedX = 1;` doesn't match
because there's no `[\s{]` directly after `import` (the next char
is `e`).

LOC estimate: 2 lines changed at `src/facet-manager.ts:772,774`.

Verbatim verified by `audit/probes/x5z5-investigation/run-checks.cjs`
test 6 ("amended regex with [\\n;}] anchor + import[\\s{] catches it
— fixed regex passes all 3 cases").

## 6. Predicted ✅ flip

**+1** for `@tailwindcss/vite`. Possibly other minified-ESM packages
in the broader cohort (verify-90993b3 has ~33 packages; need a
re-probe sweep to confirm — but at minimum the 1 named flip).

## 7. Risk

False positives. Eg. `;import("./foo")` (dynamic import expression
preceded by `;`) — currently NOT matched by the static regex
(`import\s+\(` is excluded by the `(['"]|[\w*$]|\{)` lookahead).
Still safe under (F1).

A non-ESM file that contains `;export = ...` (TypeScript-style CJS)
in its body would be miscategorised as ESM — but that file would
already be `.cjs` or have `module.exports = ...` shape, and
esbuild's CJS-to-CJS transform is a no-op so the cost is one wasted
transform call, not a correctness break.

## 8. Dependencies

- Independent of the other 3 Z5 packages.
- Independent of W2.6b.
- Independent of X.5-NPQO (the diff is in `src/facet-manager.ts`,
  not `src/node-shims.ts`).
