// W8 minimal TAP-style runner. Lifted from w5/_tap.mjs for consistency.
// Usage:
//   import { ok, eq, gte, throws, summary, group } from '../_tap.mjs';
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

export function includes(label, haystack, needle) {
  const has = String(haystack).includes(String(needle));
  ok(label, has, has ? '' : `haystack=${JSON.stringify(String(haystack).slice(0,200))} needle=${JSON.stringify(needle)}`);
}

export async function rejects(label, fn, matchSubstr) {
  let threw = false;
  let msg = '';
  try { await fn(); } catch (e) { threw = true; msg = (e && e.message) || String(e); }
  if (matchSubstr) {
    ok(label, threw && msg.includes(matchSubstr),
      threw ? `expected message to include '${matchSubstr}', got: ${msg}` : 'did not throw');
  } else {
    ok(label, threw, 'did not throw');
  }
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

export function summary(label) {
  console.log('');
  console.log(`# ${label}: ${_passed} passed, ${_failed} failed`);
  if (_failed > 0) {
    console.log('# failures:');
    for (const f of _fails) console.log(`#   - ${f.label}${f.detail ? ': ' + f.detail : ''}`);
    process.exit(1);
  }
  process.exit(0);
}

export function group(name, fn) {
  console.log(`# ${name}`);
  return fn();
}
