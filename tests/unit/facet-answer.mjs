#!/usr/bin/env bun
// What a request-shaped task answers through its pool, read as the bash and
// python runners read it (facetAnswer): its JSON, or the failure it threw,
// with its message. The bash runner read a failure as a slice and said only
// "facet returned an invalid payload".

import assert from 'node:assert/strict';
import { facetAnswer } from '../../packages/core/src/runtime/facet-host.ts';
import { assembleLoaderWorkerModuleSource } from '../../packages/fabric/src/isolate-pool.ts';
import { importModuleSet } from './lib/module-map-bundle.mjs';

const task = async (request) => {
  const args = await request.json();
  if (args.fail) throw new Error(`the task failed: ${args.fail}`);
  return Response.json({ echoed: args });
};
const { default: Entry } = await importModuleSet({ 'worker.js': assembleLoaderWorkerModuleSource({ fnSource: task.toString(), hasBindings: false }) }, 'worker.js');
const answer = (args) => new Entry({}, {}).fetch(new Request('https://facet.internal/step', { method: 'POST', body: JSON.stringify(args) })).then(facetAnswer);

assert.deepEqual(await answer({ step: 1 }), { echoed: { step: 1 } }, 'an answer is the task\'s JSON');
await assert.rejects(answer({ fail: 'no slot' }), { message: 'the task failed: no slot' }, 'a failure is thrown with the task\'s message');
await assert.rejects(facetAnswer(new Response('{}', { status: 502 })), { message: /HTTP 502/ }, 'a failure with no message says its status');
console.log('facet-answer: ok');
