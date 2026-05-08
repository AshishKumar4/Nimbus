#!/usr/bin/env bun
// X5G functional G1: ResolvedPackage carries optionalDependencies +
// platform constraints from the registry packument.
//
// Source-level invariant probe (analogous to the X5F R2.5 probe):
// verifies the new fields appear on the type and the
// versionToResolved code path populates them.

import { ok, group, summary } from '../../w6/_tap.mjs';

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESOLVER_SRC = path.join(HERE, '../../../../src/npm/resolver.ts');
const src = fs.readFileSync(RESOLVER_SRC, 'utf8');

group('ResolvedPackage interface includes optionalDependencies', () => {
  ok('ResolvedPackage type has optionalDependencies field',
    /optionalDependencies\??\s*:\s*Record<string,\s*string>/.test(src));
});

group('versionToResolved populates optionalDependencies + os/cpu/libc', () => {
  // The versionToResolved function should pull these from vData.
  ok('reads vData.optionalDependencies',
    /vData\.optionalDependencies/.test(src));
  ok('reads vData.os',  /vData\.os\b/.test(src));
  ok('reads vData.cpu', /vData\.cpu\b/.test(src));
  ok('reads vData.libc',/vData\.libc\b/.test(src));
});

group('registryCacheToResolved restores optionalDependencies', () => {
  ok('registryCacheToResolved reads optionalDepsJson or similar',
    /optionalDeps|optionalDependencies/.test(src));
});

summary('optional-deps-parse');
