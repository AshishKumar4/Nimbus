#!/usr/bin/env bun
// @tier slow — drives a local workerd with jq and make installed
/**
 * wasi-cli-workerd — jq and GNU make in a session (Kinu ask 72), installed
 * with `nimbus install` from a catalog staged as the publisher stages it,
 * and run by wasi-cli-runner@1 on local workerd (apps/probe), where a guest
 * parks while its children run (JSPI):
 *
 *   - jq 1.7.1, in the shell's directory;
 *   - make 4.4.1 runs its recipes as session processes (the shell's, and a
 *     program by name: tr, cat, jq), in dependency order, then nothing for
 *     an up-to-date target, and only what a changed source needs;
 *   - $(shell ...), a recursive $(MAKE) -C, and -j4;
 *   - a failing recipe stops make with its own words and status 2.
 */

import assert from 'node:assert/strict';
import { localTerminal, splitScenarioOutput, startLocalProbe } from './lib/workerd-probe.mjs';

const probe = await startLocalProbe({ runtimes: ['jq', 'make'] });
let checks = 0;
try {
  const session = await localTerminal(probe, { install: ['jq', 'make'] });
  const run = async (command, timeoutMs = 300_000) => {
    const r = await session.run(command, timeoutMs);
    // Its own lines, the session's banners dropped.
    const stdout = `${splitScenarioOutput(r.stdout.replace(/\r\n/g, '\n')).lines.join('\n')}\n`;
    console.log(`wasi-cli-workerd: ${command} -> ${r.status} ${JSON.stringify(stdout.slice(-400))}`);
    return { status: r.status, stdout };
  };
  try {
    const version = await run('jq --version');
    assert.equal(version.status, 0);
    assert.match(version.stdout, /^jq-1\.7\.1$/m);
    await run('mkdir -p proj/src proj/sub');
    await session.writeFile('proj/data.json', '{"name":"nimbus","n":[3,1,2]}\n');
    const sorted = await run('cd proj && jq -c ".n | sort" data.json; cd ~');
    assert.match(sorted.stdout, /^\[1,2,3\]$/m);
    checks++;

    await session.writeFile('proj/src/a.in', 'a\n');
    await session.writeFile('proj/src/b.in', 'b\n');
    await session.writeFile('proj/sub/Makefile', 'here:\n\t@echo in-sub\n');
    await session.writeFile('proj/Makefile', [
      'SRCS := $(sort $(wildcard src/*.in))',
      'OUTS := $(patsubst src/%.in,out/%.txt,$(SRCS))',
      'stamp := $(shell echo shell-ran)',
      'all: out/joined.txt',
      'out/joined.txt: $(OUTS)',
      '\tcat $^ > $@',
      'out/%.txt: src/%.in',
      '\t@mkdir -p out',
      '\ttr a-z A-Z < $< > $@',
      'info:',
      '\t@echo $(stamp)',
      'name.txt: data.json',
      "\tjq -r '.name' $< > $@",
      'fail:',
      '\tfalse',
      'sub:',
      '\t$(MAKE) -C sub',
      '.PHONY: all info fail sub',
      '',
    ].join('\n'));

    const built = await run('cd proj && make && cat out/joined.txt; cd ~');
    assert.equal(built.status, 0, built.stdout);
    assert.match(built.stdout, /tr a-z A-Z < src\/a\.in > out\/a\.txt\ntr a-z A-Z < src\/b\.in > out\/b\.txt\ncat out\/a\.txt out\/b\.txt > out\/joined\.txt\nA\nB\n?$/);
    const again = await run('cd proj && make; cd ~');
    assert.match(again.stdout, /make: Nothing to be done for 'all'\./);
    const changed = await run('cd proj && touch src/a.in && make; cd ~');
    assert.match(changed.stdout, /tr a-z A-Z < src\/a\.in > out\/a\.txt/);
    assert.doesNotMatch(changed.stdout, /src\/b\.in/, 'only what the changed source needs');
    checks++;

    assert.match((await run('cd proj && make -s info; cd ~')).stdout, /^shell-ran$/m);
    const named = await run('cd proj && make name.txt && cat name.txt; cd ~');
    assert.match(named.stdout, /^nimbus$/m, 'a recipe runs jq');
    const sub = await run('cd proj && make sub; cd ~');
    assert.match(sub.stdout, /make\[1\]: Entering directory '\/home\/user\/proj\/sub'\nin-sub\nmake\[1\]: Leaving directory '\/home\/user\/proj\/sub'/);
    const parallel = await run('cd proj && make -B -j4 && cat out/joined.txt; cd ~');
    assert.equal(parallel.status, 0, parallel.stdout);
    assert.match(parallel.stdout, /^A\nB\n?$/m);
    checks++;

    const failed = await run('cd proj && make fail; echo "status=$?"; cd ~');
    assert.match(failed.stdout, /make: \*\*\* \[Makefile:15: fail\] Error 1\nstatus=2/);
    checks++;
  } finally {
    await session.close();
  }
} finally {
  await probe.stop();
}
console.log(`wasi-cli-workerd: ok (${checks} checks)`);
