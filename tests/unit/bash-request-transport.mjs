#!/usr/bin/env bun
// bashRequestStep is what a signal-capable facet host (IsolatePool's
// submitRequest) actually runs: the FUNCTION SOURCE evaluated verbatim in the
// preamble's scope, handed a real Request. A free variable the serialized body
// cannot see in-facet is a runtime ReferenceError — exactly what the
// PREAMBLE_MISSING_SLICE constant was — so this drives the actual serialized
// fn through the real preamble, the same way LocalFacetHost and the loader
// pool do, and asserts the slice the wire would carry.
//
// Also pinned: with no preamble installed the step reports its own failure
// instead of throwing (a dead preamble must not hang a Request).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BASH_RUNNER_PREAMBLE, bashRequestStep, bashFacetStep } from '../../packages/core/src/runtime/bash-runner.ts';

const wasmDir = fileURLToPath(new URL('../../packages/worker/wasm/bash/', import.meta.url));
const applets = readFileSync(`${wasmDir}coreutils/busybox.applets`, 'utf8')
  .split('\n').map((l) => l.trim()).filter(Boolean);

/** A facet scope: preamble evaluated against a stand-in globalThis, then the
 *  submitted function evaluated inside it — mirrors LocalFacetHost.scope. */
function facetScope() {
  const scope = {
    __NIMBUS_WASM: {
      'bash.async.wasm': new WebAssembly.Module(readFileSync(`${wasmDir}bash.async.wasm`)),
      'cu_busybox.wasm': new WebAssembly.Module(readFileSync(`${wasmDir}coreutils/busybox.wasm`)),
    },
  };
  const evaluate = new Function('globalThis', `${BASH_RUNNER_PREAMBLE}\nreturn (source) => eval(source);`).call(scope, scope);
  return { scope, evaluate };
}

const stepRequest = (args) => new Request('https://bash-facet.invalid/step', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(args),
});

const bootArgs = (script) => ({
  op: 'boot',
  argv: ['bash', '-c', script],
  environ: ['PATH=/bin:/usr/bin', 'HOME=/home/user', 'NIMBUS_PWD=/', 'TERM=dumb'],
  cwd: '/',
  fsSnapshot: { files: {}, dirs: [], modes: {} },
  stdinData: '',
  stdinClosed: true,
  stdinTty: false,
  busyboxApplets: applets,
});

// ── Request transport runs real bash and answers a real slice ───────────────
{
  const { scope, evaluate } = facetScope();
  const scopedStep = evaluate(`(${bashRequestStep.toString()})`);

  const response = await scopedStep(stepRequest(bootArgs('printf "transport-ok\\n"')));
  assert.ok(response instanceof Response);
  const slice = await response.json();
  assert.equal(slice.state, 'exited', JSON.stringify(slice));
  assert.equal(slice.exitCode, 0);
  assert.equal(slice.stdout, 'transport-ok\n');

  // The warm session the boot left on this isolate's S answers feeds.
  const fed = await scopedStep(stepRequest({ op: 'feed', data: '', eof: true }));
  const fedSlice = await fed.json();
  assert.ok(['exited', 'need-input', 'error'].includes(fedSlice.state),
    `feed returned a non-slice payload: ${JSON.stringify(fedSlice)}`);

  // The preamble's own validation rejects what is not a boot/feed payload.
  const bad = await scopedStep(new Request('https://bash-facet.invalid/step', {
    method: 'POST', body: '{"op":"bogus"}', headers: { 'content-type': 'application/json' },
  }));
  const badSlice = await bad.json();
  assert.equal(badSlice.state, 'error');
  assert.match(badSlice.error, /unknown step op/);
  assert.ok(scope.__bashStep !== undefined, 'preamble did not install __bashStep');
}

// ── Classic submit transport over the same serialized preamble ──────────────
{
  const { evaluate } = facetScope();
  const scopedFacetStep = evaluate(`(${bashFacetStep.toString()})`);
  const slice = await scopedFacetStep(bootArgs('printf "submit-ok\\n"'), {});
  assert.equal(slice.state, 'exited', JSON.stringify(slice));
  assert.equal(slice.stdout, 'submit-ok\n');
}

// ── No preamble installed: the step reports, it does not throw ──────────────
{
  const bare = new Function('globalThis', 'return (source) => eval(source);')({});
  const scopedStep = bare(`(${bashRequestStep.toString()})`);
  const response = await scopedStep(stepRequest(bootArgs('true')));
  const slice = await response.json();
  assert.equal(slice.state, 'error');
  assert.equal(slice.exitCode, 127);
  assert.match(slice.error, /preamble missing/);

  const scopedFacetStep = bare(`(${bashFacetStep.toString()})`);
  const result = await scopedFacetStep(bootArgs('true'));
  assert.equal(result.state, 'error');
  assert.match(result.error, /preamble missing/);
}

console.log('bash-request-transport: all assertions passed');
