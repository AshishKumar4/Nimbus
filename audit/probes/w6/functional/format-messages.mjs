// W6 functional: message formatters produce the contracted strings.

import { ok, group, summary } from '../_tap.mjs';

let mod;
try {
  mod = await import('../../../../src/facets/wasm-swap-registry.ts');
} catch (e) {
  ok('wasm-swap-registry module exists', false, e.message);
group('RegistryRejectError + isRegistryReject', () => {
  ok('RegistryRejectError exported', typeof RegistryRejectError === 'function');
  ok('isRegistryReject exported', typeof isRegistryReject === 'function');
  const r = lookupReject('sharp');
  if (r) {
    const err = new RegistryRejectError([r]);
    ok('is an Error', err instanceof Error);
    ok('has __w6_reject = true (own-property)', err.__w6_reject === true);
    ok('isRegistryReject identifies it', isRegistryReject(err));
    ok('rejects array is exposed', Array.isArray(err.rejects) && err.rejects.length === 1);
    ok('error.message contains rejection summary', err.message.includes('sharp'));
  }
  // Plain errors should not be identified as registry rejects.
  ok('isRegistryReject(plain Error) === false', !isRegistryReject(new Error('x')));
  ok('isRegistryReject(null) === false', !isRegistryReject(null));
  ok('isRegistryReject(undefined) === false', !isRegistryReject(undefined));
  ok('isRegistryReject({}) === false', !isRegistryReject({}));
  // Facet-style: an error tagged via own-property should be identified.
  const facetStyle = Object.assign(new Error('npm install rejected: sharp — …'), { __w6_reject: true });
  ok('isRegistryReject identifies facet-tagged error', isRegistryReject(facetStyle));
});

summary('w6/functional/format-messages');
}

const { formatSwapNotice, formatRejectError, formatTransitiveSkip, lookupSwap, lookupReject, RegistryRejectError, isRegistryReject } = mod;

group('formatSwapNotice', () => {
  ok('is a function', typeof formatSwapNotice === 'function');
  const swap = lookupSwap('esbuild');
  ok('swap entry available', !!swap);
  if (swap) {
    const s = formatSwapNotice(swap);
    ok('starts with [npm] prefix', s.startsWith('[npm]'));
    ok('contains [swap] tag', s.includes('[swap]'));
    ok('contains from name', s.includes('esbuild'));
    ok('contains to name', s.includes('esbuild-wasm'));
    ok('contains arrow', s.includes('→'));
    ok('contains reason substring', s.includes('Native esbuild') || s.includes('esbuild-wasm'));
    ok('contains ANSI yellow', s.includes('\x1b[33m'));
    ok('contains ANSI reset', s.includes('\x1b[0m'));
  }
});

group('formatRejectError single', () => {
  ok('is a function', typeof formatRejectError === 'function');
  const reject = lookupReject('sharp');
  ok('reject entry available', !!reject);
  if (reject) {
    const s = formatRejectError([reject]);
    ok('contains "rejected"', s.toLowerCase().includes('rejected'));
    ok('contains sharp', s.includes('sharp'));
    ok('contains reason', s.includes('libvips'));
    ok('contains ANSI red', s.includes('\x1b[31m'));
    ok('contains ❌ marker', s.includes('❌'));
  }
});

group('formatRejectError multi', () => {
  const r1 = lookupReject('sharp');
  const r2 = lookupReject('prisma');
  if (r1 && r2) {
    const s = formatRejectError([r1, r2]);
    ok('summary line counts both', s.includes('2'));
    ok('contains sharp', s.includes('sharp'));
    ok('contains prisma', s.includes('prisma'));
    ok('two ❌ markers', (s.match(/❌/g) || []).length === 2);
  }
});

group('formatTransitiveSkip', () => {
  ok('is a function', typeof formatTransitiveSkip === 'function');
  const fsev = lookupReject('fsevents');
  ok('fsevents entry available', !!fsev);
  if (fsev) {
    const s = formatTransitiveSkip(fsev);
    ok('starts with [npm]', s.startsWith('[npm]'));
    ok('contains [skip] tag', s.includes('[skip]'));
    ok('contains fsevents', s.includes('fsevents'));
    ok('contains ANSI yellow', s.includes('\x1b[33m'));
  }
});

summary('w6/functional/format-messages');
