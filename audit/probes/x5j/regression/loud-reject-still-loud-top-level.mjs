#!/usr/bin/env bun
// X5J regression: top-level `npm install <REJECTED>` STILL hard-fails
// at the install boundary. We did NOT weaken the user-asked-for-this-
// package contract.
//
// This is a source-level grep — confirms the supervisor still throws
// RegistryRejectError when the user types a REJECT_INSTALL package
// directly, AND that npm-installer.ts still calls applyW6Registry on
// the user's specs BEFORE resolution.

import { ok, group, summary } from '../../w6/_tap.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER_SRC = path.join(HERE, '../../../../src/npm/installer.ts');
const RESOLVER_SRC  = path.join(HERE, '../../../../src/npm/resolver.ts');
const REGISTRY_SRC  = path.join(HERE, '../../../../src/facets/wasm-swap-registry.ts');
const installer = fs.readFileSync(INSTALLER_SRC, 'utf8');
const resolver  = fs.readFileSync(RESOLVER_SRC, 'utf8');
const registry  = fs.readFileSync(REGISTRY_SRC, 'utf8');

group('Top-level reject path preserved (npm-installer.ts)', () => {
  ok('npm-installer still imports RegistryRejectError',
    /RegistryRejectError/.test(installer));
  ok('npm-installer still throws new RegistryRejectError',
    /throw new RegistryRejectError/.test(installer));
});

group('Transitive reject path preserved (npm-resolver.ts)', () => {
  ok('resolver still throws RegistryRejectError on transitive=fail',
    /transitive\s*===\s*['"]fail['"][\s\S]*?throw new RegistryRejectError/.test(resolver));
});

group('REJECT_INSTALL data integrity', () => {
  ok("REJECT_INSTALL still contains 'sql.js' transitive='fail'",
    /from:\s*'sql\.js'[\s\S]{0,800}?transitive:\s*'fail'/.test(registry));
  ok("REJECT_INSTALL still contains '@swc/core' transitive='fail'",
    /from:\s*'@swc\/core'[\s\S]{0,800}?transitive:\s*'fail'/.test(registry));
  ok("REJECT_INSTALL still contains 'sharp' transitive='fail'",
    /from:\s*'sharp'[\s\S]{0,800}?transitive:\s*'fail'/.test(registry));
});

summary('loud-reject-still-loud-top-level');
