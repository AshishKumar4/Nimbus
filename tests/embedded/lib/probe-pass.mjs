// Lifecycle probe, pass path: asserts the fixture answered an authorized GET.
import assert from 'node:assert/strict';
const r = await fetch(`${process.env.BASE}/health`, {
  headers: { Authorization: `Bearer ${process.env.NIMBUS_PROBE_TOKEN}` },
});
assert.equal(r.status, 200, `health: ${r.status}`);
assert.deepEqual(await r.json(), { ok: true, token: 'seen' });
console.log('PROBE_RESULT=pass');
