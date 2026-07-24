#!/usr/bin/env bun

import assert from 'node:assert/strict';
import {
  buildPreviewHost,
  isPreviewHostSafeSid,
  parsePreviewHost,
} from '../../packages/worker/src/_shared/preview-host.ts';

const suffix = 'nimbus-os.dev';

{
  const sid = 'nimble-otter-4271';
  const host = buildPreviewHost(sid, 3000, suffix);
  assert.equal(host, '3000--nimble-otter-4271.nimbus-os.dev');
  assert.deepEqual(parsePreviewHost(host, suffix), { port: 3000, sid });
}

{
  const sid = 'team--sandbox';
  assert.deepEqual(
    parsePreviewHost(buildPreviewHost(sid, 4173, suffix), suffix),
    { port: 4173, sid },
  );
}

{
  const sid = '1sandbox';
  assert.deepEqual(
    parsePreviewHost(buildPreviewHost(sid, 8080, suffix), suffix),
    { port: 8080, sid },
  );
}

assert.equal(parsePreviewHost(`0--nimble-otter-4271.${suffix}`, suffix), null);
assert.equal(parsePreviewHost(`65536--nimble-otter-4271.${suffix}`, suffix), null);

for (const sid of ['sdk.sandbox', 'sdk_sandbox', 'Sdk-sandbox']) {
  assert.equal(isPreviewHostSafeSid(sid), false);
}
assert.equal(parsePreviewHost(`3000--sdk.sandbox.${suffix}`, suffix), null);
assert.equal(parsePreviewHost(`3000--sdk_sandbox.${suffix}`, suffix), null);

{
  const sid = 'a'.repeat(57);
  assert.equal(isPreviewHostSafeSid(sid), false);
  assert.equal(parsePreviewHost(`3000--${sid}.${suffix}`, suffix), null);
}

assert.equal(parsePreviewHost(`3000--nimble-otter-4271.${suffix}`, undefined), null);
assert.equal(parsePreviewHost(`3000--nimble-otter-4271.${suffix}`, null), null);
assert.equal(parsePreviewHost('3000--nimble-otter-4271.example.com', suffix), null);
assert.equal(parsePreviewHost(`3000--extra.label.${suffix}`, suffix), null);

assert.deepEqual(
  parsePreviewHost('3000--NIMBLE-OTTER-4271.NIMBUS-OS.DEV', suffix),
  { port: 3000, sid: 'nimble-otter-4271' },
);
assert.deepEqual(
  parsePreviewHost(`3000--nimble-otter-4271.${suffix}:8787`, suffix),
  { port: 3000, sid: 'nimble-otter-4271' },
);

console.log('preview-host-scheme: ok');
