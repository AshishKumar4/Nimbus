
Error.stackTraceLimit = Infinity;
try {
  const m = require('ts-jest');
  console.log('OK typeof:', typeof m);
} catch (e) {
  console.log('FAIL', e && e.constructor && e.constructor.name, e && e.message);
  console.log('---FULL STACK---');
  console.log((e && e.stack) || '(no stack)');
}
// Probe ts.sys availability separately to disambiguate "typescript fully
// loaded but realpathSync.native is undefined" from "typescript was
// evicted from bundle".
console.log('---TYPESCRIPT INTROSPECTION---');
try {
  const ts = require('typescript');
  console.log('typescript version:', ts.version);
  console.log('typescript.sys is:', typeof ts.sys);
} catch (e) {
  console.log('typescript require failed:', e && e.message);
}
