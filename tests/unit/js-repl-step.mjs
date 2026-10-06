#!/usr/bin/env bun
/**
 * The JavaScript REPL's facet step (js-repl.ts jsReplStepFacetFn), the one
 * evaluation protocol `node` and `bun` share. It runs as the facet runs it:
 * from its own source text, with no module scope, on V8, against the global
 * console and process.exit of the process it runs in.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { jsReplStepFacetFn } from '../../packages/worker/src/runtime/js-repl.ts';

// The facet is V8 (workerd), and the incomplete-input patterns are V8's
// messages, so the step runs under real node, from its own source text.
const SOURCES = [
  '1 + 1',
  'const x = 5',
  'x * 2',
  '`open template',
  'Promise.resolve(42)',
  'Promise.reject(new Error("later"))',
  'throw new Error("boom")',
  '[1, { a: "b" }]',
  'process.exit(3)',
  // Last: every later push would replay its output.
  'console.error("to stderr")',
];
const script = `
const step = (${jsReplStepFacetFn.toString()});
const out = process.stdout.write.bind(process.stdout);
const saved = { console: globalThis.console, exit: process.exit };
const results = [];
try {
  results.push(['uninitialised', await step({ name: 'node', mode: 'push', source: '1' })]);
  results.push(['init', await step({ name: 'node', mode: 'init' })]);
  for (const source of ${JSON.stringify(SOURCES)}) results.push([source, await step({ name: 'node', mode: 'push', source })]);
  results.push(['bun init', await step({ name: 'bun', mode: 'init' })]);
  results.push(['bun sees none of node', await step({ name: 'bun', mode: 'push', source: 'typeof x' })]);
} finally {
  globalThis.console = saved.console;
  process.exit = saved.exit;
}
out(JSON.stringify(results));
`;
// Every push replays the lines before it, a rejected promise's line too; a
// facet logs what nobody handles rather than dying of it.
const run = spawnSync('node', ['--unhandled-rejections=warn', '--input-type=module', '-e', script], { encoding: 'utf8' });
assert.equal(run.status, 0, run.stderr);
const results = JSON.parse(run.stdout);

const byName = new Map(results);
assert.deepEqual(byName.get('uninitialised'), { stdout: '', stderr: '', error: 'node repl not initialised' });
assert.deepEqual(byName.get('init'), { stdout: '', stderr: '' });
assert.deepEqual(byName.get('1 + 1'), { stdout: '2\n', stderr: '' });
assert.deepEqual(byName.get('const x = 5'), { stdout: '', stderr: '' }, 'a declaration runs as a statement');
assert.deepEqual(byName.get('x * 2'), { stdout: '10\n', stderr: '' }, 'earlier lines replay before the next');
assert.deepEqual(byName.get('`open template'), { stdout: '', stderr: '', incomplete: true });
assert.deepEqual(byName.get('Promise.resolve(42)'), { stdout: '42\n', stderr: '' }, 'a thenable is awaited');
assert.match(byName.get('Promise.reject(new Error("later"))').stderr, /^Error: later\n/);
assert.match(byName.get('throw new Error("boom")').stderr, /^Error: boom\n/);
assert.equal(byName.get('[1, { a: "b" }]').stdout, "[ 1, { a: 'b' } ]\n", 'values print as util.inspect does');
// A console call's value is undefined, as Node's console returns: nothing more prints.
assert.deepEqual(byName.get('console.error("to stderr")'), { stdout: '', stderr: 'to stderr\n' });
assert.deepEqual(byName.get('process.exit(3)'), { stdout: '', stderr: '', exit: true, exitCode: 3 });
assert.deepEqual(byName.get('bun sees none of node'), { stdout: "'undefined'\n", stderr: '' });

console.log('js-repl-step: ok');
