# Probe-quality contract

A behavioral probe MUST pass IF AND ONLY IF the user-observable feature
works.

When the feature breaks for a real user, the probe MUST go red. When
the probe is green, no real user can observe the failure under that
probe's scenario.

A green probe asserting on the wrong thing is **strictly worse than no
probe at all**. It enters a regression-blind period that ends when an
unrelated change happens to expose the bug — possibly weeks later,
possibly only when a customer reports it.

This document is the contract every behavioral probe is held to. Read
it before opening a `tests/behavioral/*` PR.

## Anti-patterns (forbidden)

These are PASS criteria that a probe **must not** rely on as the sole
signal that a feature works.

### ❌ HTTP 200 alone

```js
const r = await fetch(`${BASE}/s/${sid}/preview/`);
check('preview reachable', r.status === 200);
```

The dev server returning `200 OK` says nothing about whether the
served HTML/JS will execute correctly in the user's browser. Vite
returns 200 for the SPA shell even when every imported module is
broken; the user's iframe loads, then crashes.

**When 200 is acceptable:** as a *gating* check before a stronger
runtime assertion. ("If we can't reach /preview/ at all, the
runtime assertion is meaningless. So 200 is a precondition, not the
verdict.")

### ❌ Regex on bundle output

```js
const code = await fetch(`${BASE}/s/${sid}/preview/@modules/foo`)
  .then((r) => r.text());
check('no broken pattern', !/var X = __toCommonJS\(.../.test(code));
```

Bundlers emit the same semantic output via many syntactic shapes.
A fix today produces shape A; tomorrow's esbuild upgrade produces
shape B; the regex was tuned to A and passes when shape B is
broken in the same way. This is exactly the false-GREEN we hit on
2026-05-10 with `_objectWithoutPropertiesLoose2 is not a function`:
the regex correctly excluded one syntactic shape; the runtime
crashed because of a different one.

**When regex on bundle is acceptable:** when the bundle's syntactic
shape IS the contract under test. Example:
`tests/behavioral/preview/subpath-imports.mjs` asserts "no literal
`#minpath` token in served bundle" — the contract under test IS
"the rewriter erased the `#X` specifier." The runtime gap (browser
crashes on `#X`) is downstream from that structural fact;
asserting structurally is direct here.

### ❌ Marker-substring in HTML shell

```js
const r = await fetchPreview(sid);
check('marker', r.html.includes('<div id="root">'));
```

The `<div id="root">` is in the static `index.html`; it's there
whether or not the React app actually mounts. Vite serves the
shell; the JS may fail to parse, fail to load, fail to import a
dependency, fail to render — none of which will affect the
shell's text.

**When marker-substring is acceptable:** for the static HTML
template itself (e.g. an SSR framework that emits a full rendered
page). Even then, prefer a runtime DOM assertion via Puppeteer.

### ❌ Console echo / shell command output

```js
const r = await t.run('cat /proc/cpuinfo');
check('shell works', r.output.includes('processor'));
```

This conflates "shell parsed the command" with "the underlying
operation worked." A shim that prints fake output, an upstream
that returns a stale cached response, a buggy path resolver — any
of these can satisfy a substring match.

**When command-output is acceptable:** when the command is the
canonical interface to the feature AND the output's MEANING
(not just presence) is asserted. Example:
`tests/behavioral/runtime-pkg/strict-mode-bin.mjs` asserts
`cowsay hello` produces a specific multi-line ASCII art shape.

### ❌ "It exited 0"

```js
const r = await t.run('node script.js');
check('script ran', r.exitCode === 0);
```

A facet that crashes silently can still report exit 0. A wrapper
that swallows errors. A no-op `--help` that the script falls back
to. Exit 0 says "the dispatch chain didn't crash"; it does not
say "the work the user expected got done."

**When exit 0 is acceptable:** when the command's contract is
"this either succeeds or exits non-zero with a diagnostic" and a
companion runtime assertion checks the side-effect.

## Required patterns (the bar to meet)

### ✅ Drive the literal user flow

Whatever the user does to trigger the bug, the probe does too.

- User opens iframe → probe opens iframe.
- User clicks a button → probe clicks the same button (or
  programmatically dispatches the same DOM event the click would
  fire).
- User runs `npm install && npm run dev` → probe runs the same.

For preview / iframe flows the canonical driver is real Chrome via
`puppeteer-core`. See `tests/behavioral/_runtime-behavioral-template.mjs`.

### ✅ Assert observable behaviour

The thing the probe checks is the thing the user would notice.

- `body.innerText` contains the expected route's content text.
- A click navigates the URL to the expected path.
- Typing in an editor updates the editor's textContent.
- A failed import surfaces as a `pageerror` (which the probe
  captures and asserts is empty).

### ✅ Negative assertions with full keyword lists

If a probe says "no runtime error fired," it should check for the
broad family:

```js
const errors = ctx.collectErrors();
const verbatim = ['TypeError', 'is not a function', 'is not defined',
                  'Cannot read prop', 'Failed to resolve', 'Uncaught'];
const observed = errors.filter((e) =>
  verbatim.some((kw) => (e.message || e.text || '').includes(kw)));
check('no runtime errors', observed.length === 0,
      observed.map((e) => e.message || e.text).join('\n'));
```

### ✅ Self-document the feature contract

Every probe header MUST include:
- The user-visible scenario it covers.
- The exact symptom it would observe in the broken case.
- The route / URL / shell command sequence it drives.

This is the test of a probe's clarity: a stranger reading the
header should know whether the probe is structural or runtime
without reading its assertions.

## Categorisation

Every probe is labeled R, S, H, or F:

- **R — Runtime-behavioral** (preferred). Asserts on observable
  end-user behaviour. Fails iff the user's bug happens.
- **S — Structural-only**. Acceptable ONLY when the structural
  shape IS the contract (rewriter token-scrubbing, JSON schema
  validation, byte-count after binary write). The bug class the
  probe is gating must be syntactic, not semantic.
- **H — Hybrid**. Combines structural pre-checks with runtime
  assertions. The runtime path must be the canonical pass signal;
  structural checks are diagnostics.
- **F — Forensic / capture-only**. Always exits 0; logs observed
  state. Used for documenting platform behaviour without claiming
  pass/fail.

The category MUST appear in the probe's header comment.

## Checklist for new probes

Before opening a probe PR:

- [ ] Probe header declares R / S / H / F category.
- [ ] If S: bug class is documented as syntactic, not semantic.
- [ ] If R or H: a real user could trigger the failure mode the
      probe disproves.
- [ ] Assertion message includes enough detail to debug a failure
      WITHOUT re-running the probe (the probe captures
      `body.innerText`, error stacks, response bodies).
- [ ] No `setTimeout` / `sleep` / retry / defensive-catch in
      assertion logic. (`waitForFunction` with a bounded timeout
      is the accepted shape.)
- [ ] Probe passes on a verified-correct prod build AND fails on a
      verified-buggy prod build.

The last bullet is the strongest signal that the probe's pass/fail
boundary aligns with the user's experience. **A probe that has only
ever been seen GREEN and has never failed against a real bug is
suspect by default.**

## False-GREEN incident — 2026-05-10

The framework-validation wave's `frameworks/markflow-clickthrough.mjs`
and `frameworks/cjs-esm-interop.mjs` were both 100% GREEN against prod
`eca3dca6` while a real user (driving via real Puppeteer) reproduced
the verbatim user-reported `TypeError: _objectWithoutPropertiesLoose2
is not a function` on the same build.

Root cause: both probes asserted on regex over the bundle body
(`__toCommonJS(...)` wrap pattern). The fix in pre-bundle-facet.ts
DID change one syntactic shape — the bundle no longer matched the
regex. But a different upstream codepath was still emitting the
`__toCommonJS`-style namespace wrap from the on-demand bundler when
a CJS module imported react-textarea-autosize. Regex on the
*bundle for that one entry* didn't see the broken bundle for the
*other* entry.

The runtime-behavioral replacements (`tests/behavioral/frameworks/
markflow-clickthrough.mjs` and `cjs-esm-interop.mjs`) verify the
fix via Puppeteer — the bug fires in the iframe under the same
condition a real user exercises, and the probe captures it via
`page.on('pageerror')`.

Audit + per-probe categorisation: `/workspace/.seal-internal/
2026-05-10-probe-hardening/audit.md`.
