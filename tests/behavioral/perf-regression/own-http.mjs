#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mintSession, deleteSession, connectProcessTerminal, Terminal, heredocCommand } from '../_driver.mjs';

async function benchmark() {
  const http = require('node:http');
  const server = http.createServer((_request, response) => response.end('ok'));
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '0.0.0.0', resolve);
  });
  const url = 'http://localhost:' + server.address().port;
  const one = async kind => {
    if (kind === 'fetch') {
      const response = await fetch(url);
      if (!response.ok || await response.text() !== 'ok') throw new Error('listener not ready');
      return;
    }
    await new Promise((resolve, reject) => {
      const request = http.get(url, response => {
        let body = ''; response.on('data', part => { body += part; });
        response.on('error', reject);
        response.on('end', () => body === 'ok' ? resolve() : reject(new Error(body)));
      });
      request.on('error', reject);
    });
  };
  try {
    const until = Date.now() + 30_000;
    for (;;) {
      try { await one('fetch'); break; }
      catch (error) {
        if (Date.now() >= until) throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    const rows = [];
    for (let round = 0; round < 3; round++) for (const kind of ['http', 'fetch']) {
      for (let i = 0; i < 25; i++) await one(kind);
      const begin = performance.now();
      for (let i = 0; i < 300; i++) await one(kind);
      // workerd's clock advances on I/O, not pure JS/microtasks. One real
      // timer turn per batch makes elapsed wall time observable on both
      // implementations; its barrier cost makes this a conservative rate.
      await new Promise(resolve => setTimeout(resolve, 0));
      const elapsedMs = performance.now() - begin;
      if (!(elapsedMs > 0)) throw new Error('wall clock did not advance');
      rows.push({ kind, round, requests: 300, elapsedMs, reqPerSecond: 300000 / elapsedMs });
    }
    console.log('OWN_HTTP_BENCH ' + JSON.stringify({ version: process.version, rows }));
  } finally { await new Promise(resolve => server.close(resolve)); }
}
const program = `(${benchmark.toString()})().catch(error => { console.error(error.stack); process.exit(1); });`;
const node = spawnSync('node', ['-e', program], { encoding: 'utf8', timeout: 60_000 });
assert.equal(node.status, 0, node.stderr);
console.log('HOST_NODE ' + node.stdout.trim());
const sid = await mintSession();
const terminal = new Terminal(sid);
try {
  await terminal.connect(); await terminal.waitForPrompt(30_000);
  await terminal.run(heredocCommand('/home/user/own-http-bench.js', program), 30_000);
  const started = await terminal.run('node /home/user/own-http-bench.js', 120_000);
  let output = started.output;
  const pid = Number(output.match(/(?:long-running\): |started[^\n]*?)pid=(\d+)/)?.[1] ?? 0);
  if (!output.includes('OWN_HTTP_BENCH ') && pid > 0) {
    const processTerminal = await connectProcessTerminal(sid, pid);
    await processTerminal.waitFor(text => text.includes('OWN_HTTP_BENCH '), 240_000, 'own HTTP benchmark');
    output += '\n' + processTerminal.output; processTerminal.ws.close();
  }
  const line = output.match(/OWN_HTTP_BENCH [^\r\n]+/)?.[0];
  assert.ok(line, output); console.log('NIMBUS ' + line);
} finally {
  await terminal.close(); assert.ok((await deleteSession(sid)).ok, 'benchmark session deleted');
}
