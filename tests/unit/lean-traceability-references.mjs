// The manifest must reject losing the composite declarations it relies on.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from 'typescript';

const repo = new URL('../../', import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), 'nimbus-composite-references-'));
try {
  const paths = execFileSync('git', ['ls-files', '-z', '--', 'lean', 'tests/unit', 'packages/**/*.ts', 'packages/**/*.js'], { cwd: repo, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const path of paths) {
    const target = join(scratch, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repo, path), target);
  }
  const check = () => {
    const result = spawnSync('node', [join(scratch, 'lean/check-traceability.mjs'), '--manifest-only'], { cwd: scratch, encoding: 'utf8', timeout: 60_000 });
    assert.ifError(result.error);
    return result;
  };
  const baseline = check();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  const path = join(scratch, 'packages/core/src/vfs/composite.ts');
  const source = readFileSync(path, 'utf8');
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const composite = parsed.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'CompositeVFS');
  assert.ok(composite);
  for (const member of ['route', 'feedList']) {
    const declarations = composite.members.filter((node) => node.name && ts.isIdentifier(node.name) && node.name.text === member);
    assert.ok(declarations.length > 0, `the mutation target ${member} exists`);
    let without = source;
    for (const declaration of [...declarations].reverse()) without = without.slice(0, declaration.getFullStart()) + without.slice(declaration.end);
    writeFileSync(path, without);
    assert.equal(check().status, 1, `losing ${member} must invalidate the manifest`);
    writeFileSync(path, source);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log('lean-traceability-references: live routing and listing targets are checked');
