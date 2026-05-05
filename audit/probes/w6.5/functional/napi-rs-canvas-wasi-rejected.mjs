#!/usr/bin/env bun
// W6.5 functional: @napi-rs/canvas-wasm32-wasi (which doesn't exist on npm)
// AND @napi-rs/canvas (native-only) are both in REJECT_INSTALL.

import { ok, group, summary } from '../../w6/_tap.mjs';

const reg = await import('../../../../src/wasm-swap-registry.ts');

group('@napi-rs/canvas-wasm32-wasi is rejected', () => {
  const e = reg.lookupReject('@napi-rs/canvas-wasm32-wasi');
  ok('REJECT entry exists', !!e);
  if (!e) return;
  ok('reason notes the package does not exist OR points to absence', /404|does not exist|not publish|no WASM/i.test(e.reason));
  ok('suggest mentions canvaskit-wasm OR resvg', /canvaskit|resvg/i.test(e.suggest || ''));
  ok('transitive policy is fail', e.transitive === 'fail');
});

group('@napi-rs/canvas (native-only) is rejected', () => {
  const e = reg.lookupReject('@napi-rs/canvas');
  ok('REJECT entry exists', !!e);
  if (!e) return;
  ok('reason mentions native bindings', /native|binding/i.test(e.reason));
  ok('suggest mentions a Workers-compatible alternative', /canvaskit|resvg|server-side/i.test(e.suggest || ''));
  ok('transitive policy is fail', e.transitive === 'fail');
});

summary('napi-rs-canvas-wasi-rejected');
