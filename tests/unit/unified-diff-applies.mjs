#!/usr/bin/env bun
// Every patch the git command prints must be one real git applies: `git apply`
// turns the old file into the new one, byte for byte. jsdiff and xdiff can
// place a hunk differently where an edit has more than one minimal form, so
// this is the property the patch body is held to (the framing is held to
// git's bytes in git-worktree-commands-match-git.mjs). The corpus is seeded:
// duplicate lines, blank lines, CRLF, missing final newlines, empty sides,
// adds and deletes, at several context widths.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { absentSpec, formatPatch } from '../../packages/worker/src/git/unified-diff.ts';

const GIT_ENV = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(0x5eed);
const pick = (items) => items[Math.floor(random() * items.length)];
const int = (max) => Math.floor(random() * max);
// Repeated lines give Myers more than one minimal edit to choose from.
const VOCABULARY = ['', '', '}', '{', '  return;', 'same', 'same', '\tindented', 'int main(void) {', '// note', 'éè ünicode', 'trailing ', 'x'.repeat(120)];

function lines(count) {
  return Array.from({ length: count }, (_, i) => (random() < 0.55 ? pick(VOCABULARY) : `line ${i} ${int(1000)}`));
}

function mutate(base) {
  const out = [...base];
  for (let edits = 1 + int(6); edits > 0; edits--) {
    const at = int(out.length + 1);
    const span = 1 + int(5);
    const op = int(4);
    if (op === 0) out.splice(at, 0, ...lines(span));
    else if (op === 1) out.splice(at, span);
    else if (op === 2) out.splice(at, span, ...lines(1 + int(5)));
    else out.splice(int(out.length + 1), 0, ...out.slice(at, at + span));
  }
  return out;
}

function render(text, eol, finalNewline) {
  if (text.length === 0) return Buffer.alloc(0);
  return Buffer.from(text.join(eol) + (finalNewline ? eol : ''), 'utf8');
}

function spec(path, data) {
  const oid = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  return { path, valid: true, oid, mode: 0o100644, data: new Uint8Array(data) };
}

const cases = [];
for (let i = 0; i < 320; i++) {
  const eol = random() < 0.15 ? '\r\n' : '\n';
  const base = lines(int(60));
  const next = mutate(base);
  const before = render(base, eol, random() < 0.8);
  const after = render(next, eol, random() < 0.8);
  const kind = i % 16 === 0 ? 'add' : i % 16 === 1 ? 'delete' : 'modify';
  cases.push({ path: `f${i}`, kind, before: kind === 'add' ? null : before, after: kind === 'delete' ? null : after });
}

const scratch = mkdtempSync(join(tmpdir(), 'nimbus-unified-diff-'));
try {
  let applied = 0;
  for (const context of [0, 1, 3, 5]) {
    const dir = mkdtempSync(join(scratch, `u${context}-`));
    let patch = '';
    for (const { path, before, after } of cases) {
      if (before) writeFileSync(join(dir, path), before);
      if (before && after && before.equals(after)) continue;
      patch += formatPatch({
        one: before ? spec(path, before) : absentSpec(path),
        two: after ? spec(path, after) : absentSpec(path),
      }, context);
    }
    writeFileSync(join(dir, 'all.patch'), Buffer.from(patch, 'latin1'));
    const args = ['apply', ...(context === 0 ? ['--unidiff-zero'] : []), 'all.patch'];
    const result = spawnSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
    assert.equal(result.status, 0, `git apply -U${context}: ${result.stderr}`);
    for (const { path, after } of cases) {
      if (after === null) assert.equal(existsSync(join(dir, path)), false, `-U${context} ${path}: git apply left a deleted file`);
      else assert.ok(readFileSync(join(dir, path)).equals(after), `-U${context} ${path}: git apply did not reproduce the new file`);
      applied++;
    }
  }
  console.log(`unified-diff-applies: ${applied} patches applied by git apply and reproduced the new file`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
