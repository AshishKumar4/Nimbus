import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../../packages/core/src/runtime/cpython-runner.ts', import.meta.url), 'utf8');
assert.ok(!source.includes('userCode: `${prelude}\\n${userCode}`'), 'runtime bootstrap must not shift the line numbers of the user program');
assert.ok(source.includes('bootstrapCode: prelude'), 'bootstrap travels separately from the user source');
console.log('python-user-source-boundary: traceback lines belong to user code, not runtime setup');
