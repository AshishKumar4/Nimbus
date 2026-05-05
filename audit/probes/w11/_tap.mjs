// Minimal TAP-style runner. assert/passes/fails counted; exit nonzero on fail.
let _passed = 0;
let _failed = 0;
const _fails = [];

export function ok(label, cond, detail) {
  if (cond) {
    _passed++;
    console.log(`  ok  ${label}`);
  } else {
    _failed++;
    _fails.push({ label, detail });
    console.log(`  NOT OK  ${label}` + (detail ? ` — ${detail}` : ''));
  }
}

export function eq(label, actual, expected) {
  const ok_ = JSON.stringify(actual) === JSON.stringify(expected);
  ok(label, ok_, ok_ ? '' : `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

export function neq(label, actual, expected) {
  const ok_ = JSON.stringify(actual) !== JSON.stringify(expected);
  ok(label, ok_, ok_ ? '' : `both=${JSON.stringify(actual)}`);
}

export function gte(label, actual, threshold) {
  ok(label, actual >= threshold, `actual=${actual} threshold=${threshold}`);
}

export function lte(label, actual, threshold) {
  ok(label, actual <= threshold, `actual=${actual} threshold=${threshold}`);
}

export function throws(label, fn, matchSubstr) {
  let threw = false;
  let msg = '';
  try { fn(); } catch (e) { threw = true; msg = (e && e.message) || String(e); }
  if (matchSubstr) {
    ok(label, threw && msg.includes(matchSubstr),
      threw ? `expected message to include '${matchSubstr}', got: ${msg}` : 'did not throw');
  } else {
    ok(label, threw, 'did not throw');
  }
}

export async function summary(label) {
  // Drain any pending microtasks/timers so async groups have settled.
  await new Promise(r => setImmediate(r));
  console.log('');
  console.log(`# ${label}: ${_passed} passed, ${_failed} failed`);
  if (_passed === 0 && _failed === 0) {
    // Probe ran nothing — treat as error to surface broken async-group setups.
    console.log(`# ERROR: no assertions ran for ${label}`);
    process.exit(2);
  }
  if (_failed > 0) {
    console.log('# failures:');
    for (const f of _fails) console.log(`#   - ${f.label}${f.detail ? ': ' + f.detail : ''}`);
    process.exit(1);
  }
  process.exit(0);
}

// group() awaits the body if it returns a Promise. Sync bodies remain
// supported. Probes that need async work in a group should mark the body
// `async` and `await group(...)` to keep ordering.
export async function group(name, fn) {
  console.log(`# ${name}`);
  await fn();
}
