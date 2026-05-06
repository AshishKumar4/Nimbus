#!/usr/bin/env bun
// X5M-M2 functional: builtins['dns/promises'] and builtins['node:dns/promises']
// are registered, mirroring the timers/promises pattern.
//
// redis's @redis/client/dist/lib/client does require('dns/promises'); pre-fix
// __requireFrom misses because builtins['dns/promises'] wasn't an entry — only
// builtins.dns.promises (object property, not subpath) existed.
//
// Probe asserts:
//   1. The shim source contains a `builtins["dns/promises"] = ...` registration
//   2. That registration sources from `builtins.dns.promises` (the existing object)
//   3. The `node:` alias is also registered

import { ok, group, summary } from '../../w6/_tap.mjs';
import { getShimSource } from './_eval-shims.mjs';

const src = getShimSource();

group('dns/promises subpath builtin registration', () => {
  ok('builtins["dns/promises"] registration line is present',
    /builtins\["dns\/promises"\]\s*=\s*builtins\.dns\.promises/.test(src),
  );
  ok('builtins["node:dns/promises"] alias is present',
    /builtins\["node:dns\/promises"\]\s*=\s*builtins\["dns\/promises"\]/.test(src) ||
    /builtins\["node:dns\/promises"\]\s*=\s*builtins\.dns\.promises/.test(src),
  );
});

group('regression: ordering — dns/promises after dns', () => {
  const dnsIdx = src.indexOf('builtins.dns = (() =>');
  const dpIdx = src.indexOf('builtins["dns/promises"]');
  ok('builtins.dns block declared before builtins["dns/promises"]',
    dnsIdx >= 0 && dpIdx >= 0 && dnsIdx < dpIdx,
    `dns@${dnsIdx} dp@${dpIdx}`,
  );
});

group('regression: timers/promises pattern still present (sanity)', () => {
  ok('builtins["timers/promises"] still registered',
    /builtins\["timers\/promises"\]\s*=\s*\(/.test(src),
  );
  ok('builtins["node:timers/promises"] alias still registered',
    /builtins\["node:timers\/promises"\]\s*=\s*builtins\["timers\/promises"\]/.test(src),
  );
});

summary('m2-dns-promises-subpath');
