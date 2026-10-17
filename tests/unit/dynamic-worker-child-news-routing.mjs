#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { generateEntrypointCode } from '../../packages/worker/src/facets/manager.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { generatedModuleSet, importModuleSet } from './lib/module-map-bundle.mjs';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';
import { createAuthority, facetSupervisor, runScenarios, until } from './lib/resident-body.mjs';

await runScenarios(fileURLToPath(import.meta.url), {
  async childReplies() {
    const authority = createAuthority();
    const reads = { 1: [], 2: [] };
    const waits = [];
    const reports = [];
    const { supervisor, log } = facetSupervisor(authority, {
      cpSpawn: async (request) => {
        assert.equal(request.command, 'node');
        assert.deepEqual(request.args, ['child.js']);
        return { childPid: 77 };
      },
      cpReadOutput: (pid, fd, sinceSeq) => {
        assert.equal(pid, 77);
        const reply = Promise.withResolvers();
        reads[fd].push({ ...reply, sinceSeq });
        return reply.promise;
      },
      cpWait: (pid, _waitMs, _acquire, knownStarted) => {
        assert.equal(pid, 77);
        const reply = Promise.withResolvers();
        waits.push({ ...reply, knownStarted });
        return reply.promise;
      },
      cpBlocked: async (report) => { reports.push({ ...report, stdout: log.stdout }); },
    });
    const program = `
const child = require('child_process').spawn('node', ['child.js']);
let timer;
child.on('spawn', () => console.log('spawn:' + child.pid));
child.stdout.on('data', (data) => {
  console.log('stdout:' + String(data));
  if (String(data) === 'late') timer = setInterval(() => {}, 1000);
  else clearInterval(timer);
});
child.stderr.on('data', (data) => console.log('stderr:' + String(data)));
child.on('exit', (code, signal) => console.log('exit:' + code + ':' + signal));
child.on('close', (code, signal) => console.log('close:' + code + ':' + signal));
`;
    const generated = await generateEntrypointCode(program, { bundle: {} }, false, nodeFacetSources(generateShimsCode()));
    const entry = await importModuleSet(generatedModuleSet(generated, 'runner.mjs'), 'runner.mjs');
    const running = entry.default.fetch(new Request('http://facet/', {
      method: 'POST',
      body: JSON.stringify({
        argv: [], env: {}, cwd: '/home/user', filename: '/home/user/main.js', dirname: '/home/user',
        stdin: '', cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, pid: log.pid,
      }),
    }), { SUPERVISOR: supervisor });
    const blockedAt = (frontier) => reports.find((report) => report.blocked && report.frontier === frontier);
    await until(() => reads[1].length === 1 && reads[2].length === 1 && waits.length === 1 && blockedAt(0), 'the initial child polls and blocked report');
    assert.equal(waits[0].knownStarted, false);

    // Output arrives ahead of the start reply; it is applied without acknowledging the gap.
    const beforeOutput = reports.length;
    reads[1][0].resolve({ chunks: [{ seq: 1, data: new TextEncoder().encode('late') }], closed: false, news: [2] });
    await until(() => reads[1].length === 2 && reports.length > beforeOutput && !reports.at(-1).blocked, 'the output and the timer keeping the parent runnable');
    assert.equal(reads[1][1].sinceSeq, 1);
    assert.equal(reports.at(-1).frontier, 0, 'out-of-order news does not advance the reported frontier');
    const beforeResume = reports.length;
    reads[1][1].resolve({ chunks: [{ seq: 2, data: new TextEncoder().encode('resume') }], closed: false, news: [2] });
    await until(() => reads[1].length === 3 && reports.length > beforeResume && reports.at(-1).blocked, 'the parent blocked again after clearing its timer');
    assert.equal(reads[1][2].sinceSeq, 2);
    assert.equal(reports.at(-1).frontier, 0, 'duplicate news still leaves the earlier gap unacknowledged');

    waits[0].resolve({ done: false, started: true, news: [1] });
    await until(() => waits.length === 2 && blockedAt(2), 'start and output news acknowledged together');
    assert.equal(waits[1].knownStarted, true);
    assert.equal(blockedAt(2).stdout, 'spawn:77\nstdout:late\nstdout:resume\n', 'the output is observable before its news is acknowledged');

    waits[1].resolve({ done: true, started: true, exitCode: 7, signal: null, news: [3, 2] });
    await until(() => blockedAt(3), 'exit news acknowledged while the streams remain open');
    assert.equal(blockedAt(3).stdout, 'spawn:77\nstdout:late\nstdout:resume\nexit:7:null\n', 'exit is observable before its news is acknowledged');

    reads[1][2].resolve({ chunks: [], closed: true, news: [4] });
    await until(() => blockedAt(4), 'stream-end news acknowledged while stderr remains open');
    reads[2][0].resolve({ chunks: [], closed: true, news: [5] });
    const result = await (await running).json();
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(log.stderr, '');
    assert.equal(log.stdout, 'spawn:77\nstdout:late\nstdout:resume\nexit:7:null\nclose:7:null\n');
    assert.deepEqual(log.exit, { code: 0, reason: '' });
    assert.ok(reports.every((report, i) => report.seq === i + 1), 'blocked reports retain their send order');
  },
});
