// The manifest must reject losing the composite declarations it relies on.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isClassDeclaration, isIdentifier } from 'tsrs/unstable/ast';
import { withTsrs } from './lib/tsrs-program.mjs';

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
  // Each member's declarations, as [full start, end]: the text a mutation removes.
  const spans = withTsrs({}, (api) => {
    const parsed = api.createSourceFile(path, source).sourceFile;
    const composite = parsed.statements.find((node) => isClassDeclaration(node) && node.name?.text === 'CompositeVFS');
    assert.ok(composite);
    return Object.fromEntries(['route', 'feedList'].map((member) => [member, composite.members
      .filter((node) => node.name && isIdentifier(node.name) && node.name.text === member)
      .map((node) => [node.getFullStart(), node.end])]));
  });
  for (const [member, declarations] of Object.entries(spans)) {
    assert.ok(declarations.length > 0, `the mutation target ${member} exists`);
    let without = source;
    for (const [start, end] of [...declarations].reverse()) without = without.slice(0, start) + without.slice(end);
    writeFileSync(path, without);
    assert.equal(check().status, 1, `losing ${member} must invalidate the manifest`);
    writeFileSync(path, source);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log('lean-traceability-references: live routing and listing targets are checked');
