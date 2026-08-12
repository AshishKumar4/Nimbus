#!/usr/bin/env bun

import assert from 'node:assert/strict';
import {
  DEFAULT_FACET_BUNDLE_PROFILE,
  bundleProfileForNpmBin,
  parseFacetBundleProfile,
} from '../../packages/core/src/runtime/bundle-profile.ts';

assert.equal(DEFAULT_FACET_BUNDLE_PROFILE, 'runtime');
assert.equal(parseFacetBundleProfile('runtime'), 'runtime');
assert.equal(parseFacetBundleProfile('scaffold'), 'scaffold');
assert.equal(parseFacetBundleProfile('unknown'), undefined);

assert.equal(
  bundleProfileForNpmBin({ name: 'create-vite', packageName: 'create-vite' }),
  'scaffold',
);
assert.equal(
  bundleProfileForNpmBin({ name: 'pi', packageName: '@earendil-works/pi-coding-agent' }),
  'runtime',
);
assert.equal(
  bundleProfileForNpmBin({ name: 'cowsay', packageName: 'cowsay' }),
  'runtime',
);
assert.equal(
  bundleProfileForNpmBin({ name: 'foo', packageName: '@scope/create-foo' }),
  'scaffold',
);

console.log('bundle-profile: ok');
