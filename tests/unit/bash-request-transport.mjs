#!/usr/bin/env bun
// bashRequestStep is what a signal-capable facet host (IsolatePool's
// submitRequest) actually runs: the FUNCTION SOURCE evaluated verbatim in the
// preamble's scope, handed a real Request. A free variable the serialized body
// cannot see in-facet is a runtime ReferenceError — exactly what the
// PREAMBLE_MISSING_SLICE constant was — so this drives the actual serialized
// fn through the real preamble, the same way LocalFacetHost and the loader
// pool do, and asserts the slice the wire would carry.
//
// The step also carries the supervisor binding the host installs: every syscall
// bash makes lands on a credential-bound authority, so the scope here is the
// shared loadPreamble one (real SqliteVFS, real /bin multicall entries).
//
// Also pinned: with no preamble installed the step reports its own failure
// instead of throwing (a dead preamble must not hang a Request).

import assert from 'node:assert/strict';
import { bashRequestStep, bashFacetStep } from '../../packages/core/src/runtime/bash-runner.ts';
import { loadPreamble } from './lib/bash-preamble.mjs';

const stepRequest = (args) => new Request('https://bash-facet.invalid/step', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(args),
});

const bootArgs = (session, script) => ({
  op: 'boot',
  argv: ['bash', '-c', script],
  environ: ['PATH=/bin:/usr/bin', 'HOME=/home/user', 'NIMBUS_PWD=/', 'TERM=dumb'],
  cwd: '/',
  cred: session.cred,
  parking: 'none',
  coreutilsRoot: '/bin',
  stdinData: '',
  stdinClosed: true,
  stdinTty: false,
  busyboxApplets: session.applets,
});

// A boot leaves a warm session on its own scope, so each transport gets one.
const request = loadPreamble();
const submit = loadPreamble();

try {
  // ── Request transport runs real bash and answers a real slice ─────────────
  {
    const { scope, bindings, evaluate } = request;
    const scopedStep = evaluate(`(${bashRequestStep.toString()})`);

    const response = await scopedStep(stepRequest(bootArgs(request, 'printf "transport-ok\\n"')), bindings);
    assert.ok(response instanceof Response);
    const slice = await response.json();
    assert.equal(slice.state, 'exited', JSON.stringify(slice));
    assert.equal(slice.exitCode, 0);
    assert.equal(slice.stdout, 'transport-ok\n');

    // The warm session the boot left on this isolate's S answers feeds.
    const fed = await scopedStep(stepRequest({ op: 'feed', data: '', eof: true }), bindings);
    const fedSlice = await fed.json();
    assert.ok(['exited', 'need-input', 'error'].includes(fedSlice.state),
      `feed returned a non-slice payload: ${JSON.stringify(fedSlice)}`);

    // The preamble's own validation rejects what is not a boot/feed payload.
    const bad = await scopedStep(new Request('https://bash-facet.invalid/step', {
      method: 'POST', body: '{"op":"bogus"}', headers: { 'content-type': 'application/json' },
    }), bindings);
    const badSlice = await bad.json();
    assert.equal(badSlice.state, 'error');
    assert.match(badSlice.error, /unknown step op/);
    assert.ok(scope.__bashStep !== undefined, 'preamble did not install __bashStep');
  }

  // ── Classic submit transport over the same serialized preamble ────────────
  {
    const { bindings, evaluate } = submit;
    const scopedFacetStep = evaluate(`(${bashFacetStep.toString()})`);
    const slice = await scopedFacetStep(bootArgs(submit, 'printf "submit-ok\\n"'), bindings);
    assert.equal(slice.state, 'exited', JSON.stringify(slice));
    assert.equal(slice.stdout, 'submit-ok\n');
  }

  // ── No preamble installed: the step reports, it does not throw ────────────
  {
    const bare = new Function('globalThis', 'return (source) => eval(source);')({});
    const scopedStep = bare(`(${bashRequestStep.toString()})`);
    const response = await scopedStep(stepRequest(bootArgs(request, 'true')));
    const slice = await response.json();
    assert.equal(slice.state, 'error');
    assert.equal(slice.exitCode, 127);
    assert.match(slice.error, /preamble missing/);

    const scopedFacetStep = bare(`(${bashFacetStep.toString()})`);
    const result = await scopedFacetStep(bootArgs(request, 'true'));
    assert.equal(result.state, 'error');
    assert.match(result.error, /preamble missing/);
  }
} finally {
  await request.dispose();
  await submit.dispose();
}

console.log('bash-request-transport: all assertions passed');
