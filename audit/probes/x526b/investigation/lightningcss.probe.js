
Error.stackTraceLimit = Infinity;
try {
  const m = require('lightningcss');
  console.log('OK keys:', Object.keys(m).slice(0, 8));
} catch (e) {
  console.log('FAIL', e && e.constructor && e.constructor.name, e && e.message);
  console.log('---FULL STACK---');
  console.log((e && e.stack) || '(no stack)');
}
// Same disk introspection.
console.log('---LIGHTNINGCSS DISK INTROSPECTION---');
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
walk('/home/user/app/node_modules/lightningcss', 0);
