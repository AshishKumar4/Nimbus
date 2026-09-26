// @serial
// The Lean corpus (lean/): it builds with no sorry, the proofs of False from
// tempting axioms still fail, every fixture is exactly what the models
// generate, and lean/traceability.yaml holds (every theorem enrolled, kernel
// axioms only, every tsRef resolves, every fixture bridged to a test that reads
// it). The refinement tests themselves are ordinary unit files. About 20 s from
// a clean lean/.lake; needs Lean 4.16 via elan (`lake`).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const lean = new URL('../../lean/', import.meta.url).pathname;
const lake = [process.env.LAKE, join(homedir(), '.elan/bin/lake'), 'lake']
  .find((candidate) => candidate && (candidate === 'lake' || existsSync(candidate)));

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { cwd: lean, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) {
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${cmd} ${args.join(' ')} failed${result.error ? `: ${result.error.message}` : ''}`);
  }
  return result.stdout;
}

const env = { ...process.env, LAKE: lake, PATH: `${join(lake, '..')}:${process.env.PATH}` };

run(lake, ['build'], { env });
console.log(run('bash', ['check-no-false.sh'], { env }).trim().split('\n').at(-1));

run(lake, ['build', 'fixtures'], { env });
const fresh = mkdtempSync(join(tmpdir(), 'nimbus-lean-fixtures-'));
try {
  run(join(lean, '.lake/build/bin/fixtures'), [fresh]);
  const names = readdirSync(join(lean, 'fixtures')).sort();
  const generated = readdirSync(fresh).sort();
  if (JSON.stringify(names) !== JSON.stringify(generated)) {
    throw new Error(`lean/fixtures holds ${names.join(', ')} but the models generate ${generated.join(', ')}`);
  }
  for (const name of names) {
    if (readFileSync(join(lean, 'fixtures', name), 'utf8') !== readFileSync(join(fresh, name), 'utf8')) {
      throw new Error(`lean/fixtures/${name} is not what the model generates; in lean/ run ` +
        '`lake build fixtures && .lake/build/bin/fixtures fixtures` and review the diff');
    }
  }
} finally {
  rmSync(fresh, { recursive: true, force: true });
}

console.log(run('node', ['check-traceability.mjs'], { env }).trim());
