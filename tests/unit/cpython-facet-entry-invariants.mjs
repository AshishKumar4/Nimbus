#!/usr/bin/env bun
// cpython-facet-entry-invariants — every facet entry that drives the CPython VM
// carries the same four requirements, and they are DISCOVERED, not listed.
//
// This migration rediscovered five requirements by hitting each one, all of
// which ruby-runner already satisfied. The first version of this check listed
// the file it knew about; the very next entry point added — the REPL's — was in
// a different file and shipped without the supervisor, which cost twelve red
// probes. A hand-listed set of files rots exactly the way DEPLOYABLE_CONFIGS,
// LONG_RUNNING_BIN_NAMES and the facet this-guard's TARGETS all rotted here.
//
// So the entries are found the way facet-fn-no-module-imports finds them: by
// following `.submit(fn, …)` to the function it names. A third entry point will
// arrive as a failing test rather than as a broken prompt.

import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Both halves: the runners live in @nimbus-sh/core now, and the workerd-only
// resident-process spawn stayed behind. A discovery pass that looked in one
// would pass vacuously over the other.
const RUNTIME_DIRS = ['core', 'worker'].map((pkg) => join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', pkg, 'src', 'runtime'));

/** Brace-matched body of the function declared at `from`, parameters skipped. */
function bodyAt(src, from) {
  let i = src.indexOf('(', from);
  if (i < 0) return null;
  for (let parens = 0; i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')' && --parens === 0) { i++; break; }
  }
  let depth = 0;
  for (let j = src.indexOf('{', i); j >= 0 && j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j);
  }
  return null;
}

function functionBody(src, name) {
  const declared = new RegExp(`function\\s+${name}\\s*[(<]`).exec(src);
  if (declared) return bodyAt(src, declared.index);
  const assigned = new RegExp(
    `(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|\\()`).exec(src);
  if (assigned) return bodyAt(src, assigned.index);
  return null;
}

/**
 * Each requirement, and the failure it produces when absent. Every one of these
 * was a real defect in this migration, not a hypothetical.
 */
const REQUIREMENTS = [
  {
    name: 'publishes the supervisor before adopting it',
    test: (body) => /Reflect\.set\(globalThis,\s*'__nimbusPySupervisor'/.test(body),
    // __wasiInitFS clears the adoption on purpose, and the boot re-adopts from
    // globalThis afterwards. Adopting only here leaves a guest that reads the
    // seeded filesystem and can never write to it.
    why: 'the guest would read the filesystem and silently write nowhere',
  },
  {
    name: 'adopts the supervisor',
    test: (body) => /adopt\?\.\(supervisor\)/.test(body),
    why: 'demand-loaded reads return EIO with no supervisor',
  },
  {
    name: 'drains queued writes in a finally',
    test: (body) => /finally\s*\{[\s\S]{0,400}drain\?\.\(\)/.test(body),
    why: 'a program that wrote a file and then raised would lose the write',
  },
  {
    name: 'takes the facet env as its second parameter',
    test: (body, header) => /facetEnv/.test(header),
    why: 'the SUPERVISOR stub arrives there and nowhere else',
  },
];

const entries = [];
for (const dir of RUNTIME_DIRS)
for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
  const src = readFileSync(join(dir, file), 'utf8');
  for (const m of src.matchAll(/\.submit\w*\(\s*([A-Za-z_$][\w$]*)/g)) {
    const name = m[1];
    const body = functionBody(src, name);
    if (!body) continue;
    // Only the entries that drive THIS runtime's VM. Ruby and clang have their
    // own conventions and are covered by their own tests.
    if (!/__cpython\w*/.test(body)) continue;
    const headerAt = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
    const header = headerAt >= 0 ? src.slice(headerAt, src.indexOf(')', headerAt) + 1) : '';
    entries.push({ file, name, body, header });
  }
}

// Discovery that finds nothing passes vacuously, which is the failure mode this
// whole style of test is prone to. There are at least two entries: the one-shot
// runner and the REPL.
assert.ok(entries.length >= 2,
  `discovery found ${entries.length} CPython facet entries — it has stopped finding them`);
console.log(`  discovered ${entries.length}: ${entries.map((e) => `${e.file}::${e.name}`).join(', ')}`);

const findings = [];
for (const entry of entries) {
  for (const req of REQUIREMENTS) {
    if (!req.test(entry.body, entry.header)) {
      findings.push(`${entry.file} :: ${entry.name}() ${req.name} — without it, ${req.why}`);
    }
  }
}
assert.deepEqual(findings, [], `a CPython facet entry is missing an invariant:\n  ${findings.join('\n  ')}`);
console.log(`  ok  all ${entries.length} CPython facet entries carry every invariant`);
console.log('cpython-facet-entry-invariants: all cases passed');
