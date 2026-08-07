#!/usr/bin/env bun
// static-checks/no-this-in-facet-fns — a facet function may not contain the
// token `this` anywhere the bundler will keep it.
//
// The loader serializes a facet function with fn.toString() and refuses it if
// the source matches /\bthis\b/, because a remote isolate has no receiver to
// bind (see src/loaders/vendor/serialize.ts). That guard is a plain regex, so
// it cannot tell a `this` that needs binding from the English word in a
// sentence.
//
// WHAT MAKES THIS CLASS DANGEROUS
//   The word is harmless where the bundler drops it and fatal where it does
//   not, so the day someone moves the same sentence from one position into
//   another, every dispatch through that function begins failing at runtime
//   with an error that blames `this`. That is what happened to wasmFacetCall:
//   eight occurrences sat in its comments for months, then wasi-threads parity
//   put one in a shared-memory error string and `wasm-runner` stopped working
//   entirely (hand-crafted-add 4/7, pthread-parity 3/10, clang/hello-world 4/5).
//
// WHY THIS RUNS THE BUNDLER INSTEAD OF BLANKING COMMENTS
//   It used to blank comments with a scanner and match what was left, on the
//   rule "bundling strips comments, it does not strip strings". That rule is
//   not true, and a green run on a broken tree is how it was found: esbuild
//   DROPS a standalone comment but KEEPS one attached to an object-literal
//   property or a call argument. A comment added directly above `getMemory:`
//   inside wasmFacetCall survived into the deployed bundle and broke all 38
//   WASI, wasm-runner and clang probes, while this check reported 9 pass /
//   0 fail and counted the very occurrence as "stripped when bundled".
//
//   So it no longer models the bundler — it RUNS it, and matches the output.
//   Whatever esbuild actually keeps is what the loader will actually see.
//
//   THE GENERAL RULE, because the specific one keeps being relearned here:
//   a checker that MODELS the system will eventually disagree with it; a
//   checker that RUNS the system cannot. This file has now been wrong twice in
//   the same direction — once with a hardcoded list of four files that had all
//   been deleted, and once with a comment model that was merely almost right.
//   Both times it reported success while the regression it exists to catch was
//   live. Calling esbuild costs milliseconds per file. If you are tempted to
//   drop it for a regex because this got slower, you are rebuilding the same
//   defect a third time.
//
//   Occurrences the bundler drops are still counted and reported but do not
//   fail: flagging those would make the check cry wolf on harmless lines,
//   which is how a guard gets switched off.
//
// WHY dist AND NOT src
//   dist is what the worker is bundled from, it is committed, and it is plain
//   JavaScript — no type annotations whose braces would confuse a body scan.
//   Checking it checks what ships.
//
// WHY DISCOVERY AND NOT A LIST
//   The previous version of this check carried a hand-written list of four
//   files. All four had since been deleted, so it reported "0 pass / 0 fail"
//   and guarded nothing while the regression it existed to catch shipped.
//   Facet functions are now found by following `.submit(...)` call sites, and
//   the run fails outright if discovery collapses.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { transform } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const DIST = join(REPO, 'packages', 'worker', 'dist');

/** A facet function is reached through `pool.submit(fn, …)`; nothing else serializes one. */
const SUBMIT = '.submit(';

/**
 * The floor that keeps this check from going quiet again. If a refactor
 * renames `submit` or moves dispatch elsewhere, discovery drops and the run
 * fails rather than printing a cheerful zero.
 */
const MIN_EXPECTED_FACET_FNS = 3;

// ── scanning ────────────────────────────────────────────────────────────────
//
// One pass that understands strings, template literals, regex literals and
// comments. It returns a same-length copy with every comment byte replaced by
// a space, so offsets still line up with the original and anything found in
// the blanked text can be reported at its real line number.

const ID_TAIL = /[A-Za-z0-9_$)\]]/;

function blankComments(src) {
  const out = src.split('');
  let i = 0;
  let lastSignificant = '';
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (c === '/' && next === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < src.length) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      lastSignificant = quote;
      continue;
    }
    // A `/` is a regex literal unless the previous significant character could
    // end an expression, in which case it is division.
    if (c === '/' && !ID_TAIL.test(lastSignificant)) {
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') { while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; } }
        if (src[i] === '/') { i++; break; }
        if (src[i] === '\n') break;
        i++;
      }
      lastSignificant = '/';
      continue;
    }
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return out.join('');
}

/** Offset of the `{` opening the body of the function whose signature starts at `from`. */
function bodyStart(text, from) {
  let i = text.indexOf('(', from);
  if (i < 0) return -1;
  let depth = 0;
  for (; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  while (i < text.length && /\s/.test(text[i])) i++;
  return text[i] === '{' ? i : -1;
}

/** End offset (exclusive) of the block opened at `open`. */
function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** Every `<name>` handed to `.submit(`, in source order. */
function submittedNames(blank) {
  const names = [];
  let at = 0;
  for (;;) {
    const hit = blank.indexOf(SUBMIT, at);
    if (hit < 0) return names;
    at = hit + SUBMIT.length;
    const arg = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*[,)]/.exec(blank.slice(at));
    if (arg) names.push(arg[1]);
  }
}

/** Locate the function bound to `name`, returning its body range. */
function facetFnRange(blank, name) {
  const decl = new RegExp(
    `(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s+)?function\\b|` +
    `(?:async\\s+)?function\\s+${name}\\s*\\(`,
  ).exec(blank);
  if (!decl) return null;
  const open = bodyStart(blank, decl.index);
  if (open < 0) return null;
  const close = matchBrace(blank, open);
  if (close < 0) return null;
  return { open, close };
}

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const lineOf = (src, offset) => src.slice(0, offset).split('\n').length;

// ── run ─────────────────────────────────────────────────────────────────────

console.log('static-checks/no-this-in-facet-fns');

if (!existsSync(DIST)) {
  console.log(`  ✗ ${relative(REPO, DIST)} is missing — run \`bun run --cwd packages/worker build\``);
  process.exit(1);
}

let pass = 0;
let fail = 0;
let discovered = 0;

for (const file of jsFiles(DIST)) {
  const src = readFileSync(file, 'utf-8');
  if (!src.includes(SUBMIT)) continue;
  const rel = relative(REPO, file);
  // What the deploy actually emits. Same settings the worker is bundled with —
  // no minification, which is exactly the configuration that keeps comments the
  // scanner used to assume were gone.
  const bundled = (await transform(src, { loader: 'js', target: 'esnext' })).code;
  // Comments are still blanked, but only to report which occurrences the
  // bundler chose to drop. Nothing passes or fails on this copy.
  const blank = blankComments(src);

  for (const name of new Set(submittedNames(blank))) {
    const range = facetFnRange(bundled, name);
    if (!range) continue;   // a parameter, or defined in another module
    discovered++;

    const body = bundled.slice(range.open, range.close);
    const rawRange = facetFnRange(blank, name);
    const rawCount = rawRange
      ? [...src.slice(rawRange.open, rawRange.close).matchAll(/\bthis\b/g)].length
      : 0;
    const live = [...body.matchAll(/\bthis\b/g)];
    const dropped = Math.max(0, rawCount - live.length);
    const note = dropped > 0 ? ` (${dropped} more in source, dropped by the bundler)` : '';

    if (live.length === 0) {
      console.log(`  ✓ ${rel}::${name} — no \`this\` the bundler would keep${note}`);
      pass++;
      continue;
    }
    console.log(`  ✗ ${rel}::${name} — ${live.length} \`this\` survive(s) bundling${note}:`);
    // Offsets are into the BUNDLED text, so the surrounding bundled line is
    // quoted rather than a source line number that would not correspond.
    const bundledLines = bundled.split('\n');
    for (const m of live) {
      const line = lineOf(bundled, range.open + m.index);
      console.log(`      bundled line ${line}: ${(bundledLines[line - 1] || '').trim().slice(0, 120)}`);
    }
    fail++;
  }
}

if (discovered < MIN_EXPECTED_FACET_FNS) {
  console.log(
    `  ✗ discovery found only ${discovered} facet function(s), expected at least ` +
    `${MIN_EXPECTED_FACET_FNS} — dispatch moved and this check is no longer looking at it`,
  );
  fail++;
}

console.log(`\n  ──── [static-checks/no-this-in-facet-fns] ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
