#!/usr/bin/env bun

import assert from 'node:assert/strict';
import {
  buildPreviewHost,
  isPreviewHostRequest,
  isPreviewHostSafeSid,
  parsePreviewHost,
  readPreviewHostSuffix,
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

// ── build ↔ parse is a bijection ──────────────────────────────────────────
// Every (sid, port) must have exactly ONE valid origin. A second spelling is
// a second browser origin with its own cookie jar, so the attach cookie set
// on the canonical host is simply absent on the twin.
for (const padded of ['03000', '0000003000', '00', '0065535']) {
  assert.equal(
    parsePreviewHost(`${padded}--nimble-otter-4271.${suffix}`, suffix),
    null,
    `leading-zero port "${padded}" must not address a preview host`,
  );
}
assert.deepEqual(
  parsePreviewHost(`65535--nimble-otter-4271.${suffix}`, suffix),
  { port: 65535, sid: 'nimble-otter-4271' },
);
for (const port of [1, 80, 3000, 8080, 65535]) {
  const host = buildPreviewHost('nimble-otter-4271', port, suffix);
  assert.deepEqual(parsePreviewHost(host, suffix), { port, sid: 'nimble-otter-4271' });
}

// A trailing-dot FQDN is the same origin to DNS but a different string to
// `endsWith`; unnormalized it fell through to the asset fallthrough and served
// the Nimbus landing page on a distinct origin.
assert.deepEqual(
  parsePreviewHost(`3000--nimble-otter-4271.${suffix}.`, suffix),
  { port: 3000, sid: 'nimble-otter-4271' },
);
assert.deepEqual(
  parsePreviewHost(`3000--nimble-otter-4271.${suffix}.:8787`, suffix),
  { port: 3000, sid: 'nimble-otter-4271' },
);
assert.deepEqual(
  parsePreviewHost(`3000--nimble-otter-4271.${suffix}`, `${suffix}.`),
  { port: 3000, sid: 'nimble-otter-4271' },
);
// ...but only ONE dot: a root-label-doubled host is still not this suffix.
assert.equal(parsePreviewHost(`3000--nimble-otter-4271.${suffix}..`, suffix), null);

// ── suffix binding is narrowed at the boundary ────────────────────────────
// Bindings are `any`; anything that is not a non-empty string means "previews
// are off" rather than a throw on every request the router handles.
assert.equal(readPreviewHostSuffix({ NIMBUS_PREVIEW_HOST_SUFFIX: suffix }), suffix);
for (const bad of [undefined, null, '', 1234, true, {}, [], () => {}]) {
  assert.equal(readPreviewHostSuffix({ NIMBUS_PREVIEW_HOST_SUFFIX: bad }), null, String(bad));
}
assert.equal(readPreviewHostSuffix(undefined), null);
assert.equal(readPreviewHostSuffix(null), null);
assert.equal(readPreviewHostSuffix({}), null);

// ── the embedder predicate agrees with the router's parse, always ─────────
const env = { NIMBUS_PREVIEW_HOST_SUFFIX: suffix };
for (const host of [
  `3000--nimble-otter-4271.${suffix}`,
  `3000--nimble-otter-4271.${suffix}.`,
  `65535--a.${suffix}`,
  `03000--nimble-otter-4271.${suffix}`,
  `3000--sdk.sandbox.${suffix}`,
  `www.${suffix}`,
  suffix,
  'nimbus.ashishkumarsingh.com',
]) {
  const url = new URL(`https://${host}/login?x=1`);
  assert.equal(
    isPreviewHostRequest(url, env),
    parsePreviewHost(url.host, suffix) !== null,
    `${host}: predicate must not diverge from the parse`,
  );
}
assert.equal(isPreviewHostRequest(new URL(`https://3000--a.${suffix}/`), {}), false);

console.log('preview-host-scheme: ok');
