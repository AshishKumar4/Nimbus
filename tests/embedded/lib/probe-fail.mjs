// Lifecycle probe, fail path: the fixture works, the assertion does not.
import assert from 'node:assert/strict';
const r = await fetch(`${process.env.BASE}/health`, {
  headers: { Authorization: `Bearer ${process.env.NIMBUS_PROBE_TOKEN}` },
});
assert.equal(r.status, 418, `health: ${r.status} — should have failed here`);
console.log('PROBE_RESULT=unreached');
