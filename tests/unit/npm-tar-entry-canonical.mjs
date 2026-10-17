#!/usr/bin/env bun
// npm-tar-entry-canonical — the tar parser must canonicalize entry paths.
// npm tarballs legitimately carry entries like "./dist/index.js"
// (agent-base, http-proxy-agent, protobufjs, ...). Left as "./dist/..",
// the noncanonical path survives into the VFS write and the w7-frame
// writer rejects it, failing the WHOLE shared install wave and dropping
// the completion markers of every shard-mate — which is why pi's own
// dist/cli.js never landed and `pi: command not found` followed a
// "successful" install.

import assert from 'node:assert/strict';
import { canonicalTarName, streamPackageEntries, streamTarEntries, parseTarHeader } from '../../packages/core/src/_shared/tarball-stream.ts';
import { ustarArchive, ustarHeader } from './lib/ustar.mjs';

// ── canonicalTarName: collapse ./ and .. ; reject root escapes ──────────
assert.equal(canonicalTarName('dist/index.js'), 'dist/index.js');
assert.equal(canonicalTarName('./dist/index.js'), 'dist/index.js');
assert.equal(canonicalTarName('dist/./cli.js'), 'dist/cli.js');
assert.equal(canonicalTarName('dist/../lib/x.js'), 'lib/x.js'); // interior .. stays in-root
assert.equal(canonicalTarName('package.json'), 'package.json');
assert.equal(canonicalTarName('a//b'), 'a/b');
// Escapes package root → '' (caller skips as no-name).
assert.equal(canonicalTarName('../evil.js'), '');
assert.equal(canonicalTarName('../../etc/passwd'), '');
assert.equal(canonicalTarName('dist/../../escape.js'), '');

// ── streamTarEntries: a "./dist/…" entry yields a canonical name ────────
// Minimal ustar archives of regular-file entries.
const tarHeader = (name, size) => ustarHeader({ name, size });
const buildTar = (entries) => ustarArchive(entries.map(([name, content]) => ({ name, data: new TextEncoder().encode(content) })));

// Sanity: parseTarHeader canonicalizes on its own — the top-level directory
// stays on the name here; package-relative stripping is streamPackageEntries'
// job, because the prefix is per-archive, not the fixed 'package' literal.
{
  const h = parseTarHeader(tarHeader('package/./dist/index.js', 3));
  assert.equal(h.name, 'package/dist/index.js', 'parseTarHeader keeps the prefix and collapses ./');
}

{
  const h = parseTarHeader(tarHeader('node/./LICENSE', 3));
  assert.equal(h.name, 'node/LICENSE', 'a non-package root passes through untouched');
}

const tar = buildTar([
  ['package/./dist/cli.js', 'cli'],
  ['package/package.json', '{"name":"x"}'],
]);
async function* once(b) { yield b; }
const names = [];
for await (const e of streamTarEntries(once(tar))) names.push(e.name);
assert.deepEqual(names.sort(), ['package/dist/cli.js', 'package/package.json'],
  'raw entries are canonical and keep their archive prefix');

// streamPackageEntries learns 'package' from the first entry and strips it.
const rel = [];
for await (const e of streamPackageEntries(once(tar))) rel.push(e.name);
assert.deepEqual(rel.sort(), ['dist/cli.js', 'package.json'],
  'package entries come out package-relative, no "./" survives');
for (const n of rel) assert.ok(!n.includes('/./') && !n.startsWith('./'), `canonical: ${n}`);

console.log('npm-tar-entry-canonical: ok');
