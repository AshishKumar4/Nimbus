#!/usr/bin/env bun
// W6.5 regression: facet path produces registryEvents and supervisor drains them.
//
// Inspection-based, since the facet runs in a NimbusFacetPool isolate that's
// not easily mocked. The probe asserts:
//
//   1. ResolveFacetResult interface declares `registryEvents: RegistryEvent[]`
//   2. resolveTreeInFacet returns the field
//   3. The preamble (npm-resolve-preamble.ts) defines a __pendingEvents
//      array + push helpers used at swap/skip/reject sites
//   4. npm-installer.ts:580ish drains result.registryEvents via emitRegistryEvent

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../../w6/_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');

const facetSrc = readFileSync(path.join(ROOT, 'src', 'npm', 'resolve-facet.ts'), 'utf8');
const preambleSrc = readFileSync(path.join(ROOT, 'src', 'loaders', 'npm-resolve-preamble.ts'), 'utf8');
const installerSrc = readFileSync(path.join(ROOT, 'src', 'npm', 'installer.ts'), 'utf8');

group('ResolveFacetResult interface adds registryEvents', () => {
  ok(
    'interface declares registryEvents field',
    /registryEvents\s*:\s*[^;]*\[\s*\]?/.test(facetSrc) ||
    /registryEvents\s*:\s*Array</.test(facetSrc),
  );
});

group('resolveTreeInFacet collects pending events', () => {
  // The array initialization lives in the PREAMBLE (which gets injected
  // into the facet isolate at runtime); the facet body pushes via
  // __EMIT_EVENT and drains via __DRAIN_EVENTS at return.
  ok(
    'preamble initializes __pendingEvents array',
    /__pendingEvents\s*=\s*\[\s*\]/.test(preambleSrc),
  );
  ok(
    'facet body calls __EMIT_EVENT at swap site',
    /__EMIT_EVENT\s*\(\s*\{[\s\S]{0,80}?type:\s*['"]swap['"]/.test(facetSrc),
  );
  ok(
    'facet body calls __EMIT_EVENT at transitive-skip site',
    /__EMIT_EVENT\s*\(\s*\{[\s\S]{0,80}?type:\s*['"]transitive-skip['"]/.test(facetSrc),
  );
  ok(
    'facet body calls __EMIT_EVENT at reject site',
    /__EMIT_EVENT\s*\(\s*\{[\s\S]{0,80}?type:\s*['"]reject['"]/.test(facetSrc),
  );
  ok(
    'returns registryEvents in result',
    /return\s*\{[\s\S]*?registryEvents/.test(facetSrc) ||
    /registryEvents:\s*[\s\S]{0,60}__DRAIN_EVENTS/.test(facetSrc),
  );
});

group('preamble has push helpers at decision sites', () => {
  // Either explicit __EMIT_EVENT helper, or push directly into __pendingEvents.
  ok(
    'preamble has event-collection mechanism',
    /__pendingEvents|__EMIT_EVENT|registryEvents/.test(preambleSrc),
  );
});

group('supervisor drains registryEvents from facet result', () => {
  // The drain reads via `(result as any).registryEvents` for soft-fail
  // forward-compat — older facet builds may not have the field.
  ok(
    'installer reads facet registryEvents',
    /\(result as any\)\.registryEvents|result\.registryEvents/.test(installerSrc),
  );
  ok(
    'installer emits each event',
    /for\s*\(\s*const\s+ev\s+of\s+facetEvents\)[\s\S]{0,200}?emitRegistryEvent\s*\(\s*ev\s*\)/.test(installerSrc),
  );
});

summary('event-fires-from-facet');
