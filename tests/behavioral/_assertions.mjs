// Checks and completion are the release policy's data. Human output remains
// diagnostic; the runner receives each asserter's latest state over child IPC.
import { redactCredentials } from './_session-transport.mjs';

let nextId = 0;
export function makeAsserter(label, { write = console.log, emit = (result) => process.send?.({ type: 'nimbus-probe-assertions', result }) } = {}) {
  const id = ++nextId;
  const checks = [];
  const result = (complete) => ({ id, label, complete, checks: checks.map(check => ({ ...check })) });
  emit(result(false));
  return {
    check(name, ok, detail = '') {
      const shown = ok ? '' : redactCredentials(String(detail));
      checks.push({ name, ok: Boolean(ok), detail: shown });
      write(`  ${ok ? '✓' : '✗'} ${name}${!ok && shown ? ' — ' + shown : ''}`);
      emit(result(false));
    },
    summary() {
      const pass = checks.filter(check => check.ok).length;
      const failed = checks.filter(check => !check.ok);
      write(`\n  ──── [${label}] ${pass} pass / ${failed.length} fail`);
      emit(result(true));
      return { pass, fail: failed.length, failures: failed.map(check => `${check.name}: ${check.detail}`) };
    },
    get pass() { return checks.filter(check => check.ok).length; },
    get fail() { return checks.filter(check => !check.ok).length; },
  };
}

export function completedAssertions(results) {
  if (!Array.isArray(results) || !results.length) return null;
  const checks = [];
  for (const result of results) {
    if (result?.complete !== true || !Number.isSafeInteger(result.id) || typeof result.label !== 'string'
      || !Array.isArray(result.checks) || result.checks.some(check => typeof check?.name !== 'string' || !check.name
        || typeof check.ok !== 'boolean' || typeof check.detail !== 'string')) return null;
    checks.push(...result.checks);
  }
  return checks;
}
