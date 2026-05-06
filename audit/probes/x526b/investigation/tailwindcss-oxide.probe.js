
Error.stackTraceLimit = Infinity;
try {
  const m = require('@tailwindcss/oxide');
  console.log('OK keys:', Object.keys(m).slice(0, 8));
} catch (e) {
  console.log('FAIL', e && e.constructor && e.constructor.name, e && e.message);
  console.log('---FULL STACK---');
  console.log((e && e.stack) || '(no stack)');
}
// Probe what's actually on disk inside @tailwindcss/oxide so we know
// whether it's a legit native binding gap (no JS surface) vs a cap-eviction
// of a JS file we'd otherwise have served.
console.log('---OXIDE DISK INTROSPECTION---');
const _fs = require('fs'), _path = require('path');
function walk(p, depth) {
  if (depth > 3) return;
  try {
    const st = _fs.statSync(p);
    if (st.isDirectory()) {
      const ents = _fs.readdirSync(p);
      for (const e of ents) walk(_path.join(p, e), depth + 1);
    } else {
      console.log(p, st.size);
    }
  } catch (e) {
    console.log('walk-err', p, e.message);
  }
}
walk('/home/user/app/node_modules/@tailwindcss/oxide', 0);
