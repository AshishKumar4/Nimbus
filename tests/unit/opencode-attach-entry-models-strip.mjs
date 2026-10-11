#!/usr/bin/env bun
// Guard: the attach entry strips the embedded models.dev catalog whatever
// minified shape the bundler gives it. The anchor used to be pinned to one
// set of identifiers (`a=e.fn(...)`, `=e.sync(()=>({`) and to the FOLDED form
// of upstream's `typeof OPENCODE_MODELS_DEV === "undefined"` guard, so a chunk
// graph that renamed either binding, or a bundler that left the guard
// unfolded (bun 1.4.0 does), silently skipped the strip and shipped the
// multi-MB literal into the memory-tight attach facet.
//
// Both shapes, with renamed identifiers, must strip; an unrecognised shape
// must keep the literal (correctness over optimisation).

import assert from 'node:assert/strict';
import { buildOpencodeAttachEntryFromSources } from '../../packages/worker/scripts/build-opencode-attach-entry.mjs';

// The strip requires a literal of at least 1 MiB between anchor and open.
const MARKER = 'NIMBUS_MODELS_CATALOG_SENTINEL';
const catalog = `{"${MARKER}":"${'x'.repeat(1024 * 1024 + 64)}"}`;

const entry = [
  'export const cli = [',
  '  { command:"attach <url>", handler: async () => import("./chunk-attachtui.js") },',
  '];',
].join('\n');

function chunk(body) {
  return `import{fn as __fn,sync as __sync}from"./chunk-effect.js";var Qx={sync:__sync,fn:__fn};${body}export{Qx};`;
}

const effectChunk = 'export const sync=(f)=>({run:f});export const fn=(n)=>(f)=>f;';

const cases = [
  {
    label: 'folded guard, renamed identifiers',
    body: `var Zq=Qx.sync(()=>(${catalog})),Wv=Qx.fn("ModelsDev.fetchAndWrite")(function*(){});`,
  },
  {
    label: 'unfolded guard, renamed identifiers',
    body: `var Zq=Qx.sync(()=>typeof${catalog}>"u"?void 0:${catalog}),Wv=Qx.fn("ModelsDev.fetchAndWrite")(function*(){});`,
  },
];

for (const c of cases) {
  const out = await buildOpencodeAttachEntryFromSources(entry, {
    'chunk-attachtui.js': chunk(c.body),
    'chunk-effect.js': effectChunk,
  });
  assert.ok(
    !out.includes(MARKER),
    `${c.label}: the embedded catalog literal must be stripped from the attach entry`,
  );
  assert.ok(
    out.includes('the embedded models.dev catalog is stripped from the attach client'),
    `${c.label}: the stripped thunk fails loud if the client ever evaluates it`,
  );
  console.log(`  [ok] ${c.label}: catalog stripped`);
}

// An unrecognised shape keeps the literal.
{
  const out = await buildOpencodeAttachEntryFromSources(entry, {
    'chunk-attachtui.js': chunk(
      `var Zq=Qx.sync(()=>[${catalog}]),Wv=Qx.fn("ModelsDev.fetchAndWrite")(function*(){});`,
    ),
    'chunk-effect.js': effectChunk,
  });
  assert.ok(out.includes(MARKER), 'an unrecognised shape keeps the catalog literal');
  console.log('  [ok] unrecognised shape: literal kept');
}

console.log('opencode-attach-entry-models-strip OK');
