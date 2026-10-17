/**
 * The host's GNU bash 5.2 as a differential oracle, on armada only (AGENTS.md:
 * reference programs run there too). Each script runs in a child bounded in
 * time and address space: a trap that starts itself again grows without
 * bound, and must end at its cap rather than take the machine down.
 *
 * Directory note: lives under tests/unit/lib/ so the suite does not run it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runScript } from './bash-preamble.mjs';

const NATIVE_TIMEOUT_MS = 5000;
const NATIVE_MEMORY_KIB = 256 * 1024;
const ENV = { PATH: '/usr/bin:/bin', HOME: '/tmp', LC_ALL: 'C' };

/** The reference's version, asserted to be GNU bash 5.2. */
function nativeBashVersion() {
  const version = spawnSync('bash', ['--norc', '--noprofile', '-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8', timeout: NATIVE_TIMEOUT_MS, env: ENV });
  assert.match(version.stdout ?? '', /^5\.2\./, `the reference is GNU bash 5.2 (found ${JSON.stringify(version.stdout)})`);
  return version.stdout.trim();
}

/** `script` under the host's bash, capped at NATIVE_MEMORY_KIB of address space and NATIVE_TIMEOUT_MS: its stdout and status. */
function nativeBash(script, compareStderr) {
  const run = spawnSync('bash', ['--norc', '--noprofile', '-c', `ulimit -v ${NATIVE_MEMORY_KIB} && exec bash --norc --noprofile -c "$1"`, 'native', script], {
    encoding: 'utf8', timeout: NATIVE_TIMEOUT_MS, killSignal: 'SIGKILL', cwd: '/tmp', env: ENV,
  });
  assert.equal(run.error, undefined, `native bash ran ${JSON.stringify(script)} within its bounds`);
  return { stdout: run.stdout, code: run.status, ...(compareStderr ? { stderr: run.stderr } : {}) };
}

/** `script` under Nimbus's wasm bash, through the real runner: its stdout and status. */
async function wasmBash(script, compareStderr, runnerOptions) {
  const r = await runScript(script, { dirs: ['tmp'], modes: { tmp: 7 }, ...runnerOptions });
  assert.equal(r.state, 'exited', `${script}: ${r.error ?? r.stderr}`);
  return { stdout: r.stdout, code: r.exitCode, ...(compareStderr ? { stderr: r.stderr } : {}) };
}

/**
 * Each of `cases` under the host's bash and under the wasm bash: the same
 * stdout and status, or a failure that names every case that differs.
 * Answers the reference's version.
 */
export async function assertMatchesNativeBash(cases, { compareStderr = false, ...runnerOptions } = {}) {
  const version = nativeBashVersion();
  const failures = [];
  for (const script of cases) {
    const expected = nativeBash(script, compareStderr);
    const actual = await wasmBash(script, compareStderr, runnerOptions);
    try {
      assert.deepEqual(actual, expected);
      console.log(`  ✓ ${script}`);
    } catch {
      failures.push(script);
      console.log(`  ✗ ${script}\n      native ${JSON.stringify(expected)}\n      wasm   ${JSON.stringify(actual)}`);
    }
  }
  assert.deepEqual(failures, []);
  return version;
}
