#!/usr/bin/env bun
// A barrel's synthetic entry re-exports each name a program imports from the
// module the barrel's code really takes it from, as the JavaScript parser
// reads the barrel: what a comment or a string says is no export, every
// declarator of `export const a = 1, b = 2` is one, and `export * as ns` is
// one name. Checked by importing the entry: each name is the real one.
//
// Red before: four regular expressions read the barrel's text, so a
// commented-out or quoted `export { X } from './old.js'` after the real one
// won, `export const a = 1, b = 2` gave only a, and `export * as ns` was not
// read at all.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSyntheticEntry } from '../../packages/worker/src/runtime/barrel-synthesizer.ts';
import { FakeVfs } from './lib/fake-require-fs.mjs';

const KIT = {
  'package.json': JSON.stringify({ name: 'kit', type: 'module', module: 'index.js' }),
  'index.js': [
    "export { Foo } from './new.js';",
    "/* export { Foo } from './old.js'; */",
    "export { default as Baz } from './baz.js';",
    "export const note = \"export { Baz } from './fake.js'\";",
    "export * from './many.js';",
    "export * as ns from './ns.js';",
    '',
  ].join('\n'),
  'new.js': "export function Foo() { return 'new'; }\n",
  'old.js': "export function Foo() { return 'old'; }\n",
  'baz.js': "export default function Baz() { return 'baz'; }\n",
  'fake.js': "export function Baz() { return 'fake'; }\n",
  'many.js': "export const a = 1, b = 2;\nexport const { c, d: e } = { c: 3, d: 4 };\n// export const f = 6;\n",
  'ns.js': 'export const x = 1;\n',
};
const NAMES = ['Foo', 'Baz', 'a', 'b', 'c', 'e', 'ns'];

const files = Object.fromEntries(Object.entries(KIT).map(([path, text]) => [`app/node_modules/kit/${path}`, text]));
const entry = buildSyntheticEntry(new FakeVfs(files), 'app/node_modules', 'kit', new Set(NAMES));
assert.ok(entry, 'an entry is synthesized');

// The entry and the package, as files: import the entry and read each name.
const root = mkdtempSync(join(tmpdir(), 'barrel-exports-parsed-'));
try {
  for (const [path, text] of Object.entries(KIT)) {
    const at = join(root, 'node_modules/kit', path);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, text);
  }
  writeFileSync(join(root, 'entry.mjs'), entry.code);
  const m = await import(pathToFileURL(join(root, 'entry.mjs')).href);
  const got = { Foo: m.Foo?.(), Baz: m.Baz?.(), a: m.a, b: m.b, c: m.c, e: m.e, nsX: m.ns?.x };
  assert.deepEqual(got, { Foo: 'new', Baz: 'baz', a: 1, b: 2, c: 3, e: 4, nsX: 1 }, entry.code);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// A barrel the parser cannot read is no barrel to synthesize from: the caller refuses the import (synth-null).
const broken = { ...files, 'app/node_modules/kit/index.js': "export { Foo } from './new.js'\nexport {{ broken" };
assert.equal(buildSyntheticEntry(new FakeVfs(broken), 'app/node_modules', 'kit', new Set(['Foo'])), null, 'an unparsable barrel gives no entry');

console.log('barrel-exports-parsed: ok');
