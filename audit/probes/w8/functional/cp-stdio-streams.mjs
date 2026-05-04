#!/usr/bin/env bun
// W8 functional: child.stdout / child.stderr behave like real Readables —
// they support .on('data'), .on('end'), .pipe(), and .setEncoding('utf8').
//
// This is the MAJOR-D fix from W8-plan.md §8.5: child stream shape MUST
// be backed by stream.Readable (workerd's), not a bare EventEmitter,
// because cross-spawn / esbuild / concurrently rely on Readable methods.

import { ok, eq, includes, summary, group } from '../_tap.mjs';
import { makeShimHost, makeMockSupervisor } from '../_shim-host.mjs';

await group('cp-stdio-streams', async () => {
  const sup = makeMockSupervisor();
  const host = await makeShimHost(sup);
  const cp = host.childProcessMod;

  const child = cp.spawn('echo', ['streamy']);
  ok('child.stdout has setEncoding', typeof child.stdout.setEncoding === 'function');
  ok('child.stdout has pause', typeof child.stdout.pause === 'function');
  ok('child.stdout has resume', typeof child.stdout.resume === 'function');
  ok('child.stdout has pipe', typeof child.stdout.pipe === 'function');

  // Test pipe(): pipe child.stdout into a sink stream and verify chunks land.
  // setEncoding('utf8') on the source so chunks arrive as strings (Node
  // semantics; default chunk type is Buffer otherwise).
  child.stdout.setEncoding('utf8');
  const Writable = host.streamMod.Writable;
  const td = new TextDecoder('utf-8');
  const sink = new Writable({
    write(chunk, enc, cb) {
      const s = typeof chunk === 'string' ? chunk : td.decode(chunk);
      sink._captured = (sink._captured || '') + s;
      cb();
    },
  });
  child.stdout.pipe(sink);

  // Drain
  await host.drainPending();
  await host.pause(30);
  await host.drainPending();
  await host.pause(30);
  await host.drainPending();

  includes('sink captured stdout', sink._captured || '', 'streamy');
});

summary('cp-stdio-streams');
