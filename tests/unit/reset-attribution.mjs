#!/usr/bin/env bun
// scripts/ci/lib/reset-attribution.mjs: how remote-probes attributes a red
// row that shows a reset or an overload. It reads the platform's record
// (Workers Logs and trace exceptions) through the telemetry API; here that
// API is a fixture holding a Preview's events, and every query the reader
// makes is answered from it by its filters, as the API filters. The class
// must come from the exact error on the session's own object, never from
// the probe's symptom, and only a platform storage reset alone regrades.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attributeRow, describeAttribution, showsResetSymptom, telemetry } from '../../scripts/ci/lib/reset-attribution.mjs';

const BASE = 'https://tw-pp-abc123-b-nimbus-probe-previews.example.workers.dev';
const SLUG = 'tw-pp-abc123-b';
const minted = Date.parse('2026-10-16T15:00:00.000Z');
const at = (seconds) => minted + seconds * 1000;
const STORAGE = 'Internal error in Durable Object storage caused object to be reset; reference = abc';
const MEMORY = "Durable Object's isolate exceeded its memory limit and was reset.";

/** One telemetry event: on `object` (null for the router), at `seconds` after the mint. */
function event({ object = null, sid = '', seconds, level = 'info', message = '', error, outcome, trace, slug = SLUG, type = 'cf-worker-event' }) {
  return {
    timestamp: at(seconds), source: { message }, text: sid,
    $workers: { preview: { slug }, scriptName: 'nimbus-probe-previews', executionModel: object ? 'durableObject' : 'stateless', ...(object ? { durableObjectId: object } : {}), ...(outcome ? { outcome } : {}) },
    $metadata: { level, type, ...(error ? { error } : {}), ...(trace ? { traceId: trace } : {}) },
  };
}

/** The API's filtering over `events`: each filter by key and operation, the needle over the event's text. */
function api(events) {
  const queries = [];
  const read = (record, key) => key.split('.').reduce((value, part) => value?.[part], record);
  const request = async (url, init) => {
    const body = JSON.parse(init.body);
    queries.push(body);
    assert.equal(init.headers.Authorization, 'Bearer observability-token');
    assert.match(url, /\/accounts\/acct\/workers\/observability\/telemetry\/query$/);
    const { from, to } = body.timeframe;
    const found = events.filter((e) => e.timestamp >= from && e.timestamp <= to
      && body.parameters.filters.every(({ key, operation, value }) => (operation === 'neq' ? read(e, key) !== value : read(e, key) === value))
      && (!body.parameters.needle || JSON.stringify(e).includes(body.parameters.needle.value)));
    return Response.json({ result: { events: { events: found.slice(0, body.limit) } } });
  };
  return { request, queries };
}

const dir = mkdtempSync(join(tmpdir(), 'reset-attribution-'));
try {
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, 'observability-token\n');
  const output = (sids) => `error: Terminal closed while waiting for submitted shell batch after 575ms (close code 1006 (abnormal — no close frame)): Connection ended
sessions this probe minted on https://tw-suite-nimbus-probe-previews.example.workers.dev (exit 1):
${sids.map((sid) => `  ${sid}  minted ${new Date(minted).toISOString()}  on ${BASE}`).join('\n')}
`;
  const attribute = async (events, sids) => {
    const { request, queries } = api(events);
    const reader = telemetry({ account: 'acct', tokenFile, request });
    return { result: await attributeRow(reader, { output: output(sids), base: 'https://tw-suite-nimbus-probe-previews.example.workers.dev', until: at(600) }), queries };
  };

  assert.equal(telemetry({ account: 'acct', tokenFile: join(dir, 'missing') }), null, 'no token, no reader');
  assert.ok(showsResetSymptom('close code 1006 (abnormal'));
  assert.ok(showsResetSymptom('status=503 body={"code":"E_NIMBUS_DO_OVERLOADED"}'));
  assert.ok(!showsResetSymptom('close code 1000 (normal)'));

  // The platform storage reset, recorded only as the exception its invocation
  // ended with (Workers Logs keeps no message on the invocation; its trace does).
  {
    const events = [
      event({ object: 'obj-1', sid: 'quiet-fox-0001', seconds: 1, message: 'GET /ws' }),
      event({ object: 'obj-1', seconds: 20, level: 'error', outcome: 'exception', trace: 't-1', message: 'NimbusSession.jsrpc', error: 'NimbusSession.jsrpc' }),
      event({ seconds: 20, level: 'error', type: 'span_event', trace: 't-1', message: 'exception', error: STORAGE, slug: undefined }),
      // Another Preview's object with the same error is not this session's.
      event({ object: 'obj-9', sid: 'quiet-fox-0001', seconds: 5, level: 'error', message: MEMORY, slug: 'tw-other' }),
    ];
    const { result, queries } = await attribute(events, ['quiet-fox-0001']);
    assert.equal(result.regrade, true, JSON.stringify(result));
    assert.deepEqual(result.sessions.map((s) => [s.sid, s.object, s.classes.map((c) => c.kind)]), [['quiet-fox-0001', 'obj-1', ['platform storage reset']]]);
    assert.ok(queries.every((q) => q.parameters.filters.some(({ key, value }) => (key === '$workers.preview.slug' && value === SLUG) || key === '$workers.durableObjectId' || key === '$metadata.traceId')),
      'every query is scoped to the session\'s own Preview, object or trace');
    assert.match(describeAttribution(result)[0], /quiet-fox-0001: object obj-1…: platform storage reset at 2026-10-16T15:00:20.000Z/);
  }

  // The isolate memory reset is Nimbus's own memory: attributed, never regraded,
  // and it holds a row red even beside a storage reset on another session.
  {
    const events = [
      event({ object: 'obj-1', sid: 'quiet-fox-0001', seconds: 1, message: 'GET /ws' }),
      event({ object: 'obj-1', seconds: 30, level: 'warn', message: `[B'.3] appendScrollback failed: ${MEMORY}` }),
      event({ object: 'obj-2', sid: 'calm-owl-0002', seconds: 2, message: 'GET /ws' }),
      event({ object: 'obj-2', seconds: 31, level: 'warn', message: `[sqlite-vfs] writeBatch failed: ${STORAGE}` }),
    ];
    const alone = await attribute(events, ['quiet-fox-0001']);
    assert.equal(alone.result.regrade, false);
    assert.deepEqual(alone.result.sessions[0].classes.map((c) => c.kind), ['isolate memory reset']);
    const both = await attribute(events, ['quiet-fox-0001', 'calm-owl-0002']);
    assert.equal(both.result.regrade, false, 'a storage reset regrades only when nothing else reset');
    const storageOnly = await attribute(events, ['calm-owl-0002']);
    assert.equal(storageOnly.result.regrade, true);
  }

  // The router's refusal names the session too: an overload is attributed from
  // the router's own line, and stays red.
  {
    const events = [
      event({ object: 'obj-3', sid: 'ripe-elm-0003', seconds: 1, message: 'GET /port/3000/' }),
      event({ sid: 'ripe-elm-0003', seconds: 40, level: 'error', message: 'GET https://x/s/ripe-elm-0003/port/3000/', error: 'Durable Object is overloaded. Requests queued for too long.' }),
    ];
    const { result } = await attribute(events, ['ripe-elm-0003']);
    assert.deepEqual(result.sessions[0].classes.map((c) => c.kind), ['overloaded']);
    assert.equal(result.regrade, false);
  }

  // The symptom alone is never a class: a session whose object logged no reset
  // is unattributed, and one no log names yet has no object.
  {
    const events = [event({ object: 'obj-4', sid: 'bold-ash-0004', seconds: 1, message: 'GET /ws' })];
    const { result } = await attribute(events, ['bold-ash-0004', 'not-logged-0005']);
    assert.deepEqual(result.sessions.map((s) => [s.sid, s.object, s.classes.length]), [['bold-ash-0004', 'obj-4', 0], ['not-logged-0005', null, 0]]);
    assert.equal(result.regrade, false);
    assert.deepEqual(describeAttribution(result), ['bold-ash-0004: object obj-4…: no reset or overload error logged', 'not-logged-0005: no log names this session yet']);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('reset-attribution: ok');
