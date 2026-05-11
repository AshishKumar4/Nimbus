#!/usr/bin/env bun
// wasi-paths/new/abs-mkdir-rmdir-stat — exercise mkdir/rmdir/stat with
// absolute /home/user paths. All path-syscalls go through the resolver.
//
// Asserts:
//   1. mkdir("/home/user/new-dir") creates dir at /home/user/new-dir
//      (visible from shell via existsSync).
//   2. stat reports it as a directory.
//   3. rmdir removes it (existsSync returns false post-rmdir).

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('wasi-paths/new/abs-mkdir-rmdir-stat');

const CSRC = `#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>
int main(void){
  if (mkdir("/home/user/new-dir", 0755) != 0) { printf("MKDIR_FAIL\\n"); fflush(stdout); return 1; }
  struct stat st;
  if (stat("/home/user/new-dir", &st) != 0) { printf("STAT_FAIL\\n"); fflush(stdout); return 2; }
  if (!S_ISDIR(st.st_mode)) { printf("NOT_DIR\\n"); fflush(stdout); return 3; }
  printf("DIR_CREATED\\n"); fflush(stdout);
  if (rmdir("/home/user/new-dir") != 0) { printf("RMDIR_FAIL\\n"); fflush(stdout); return 4; }
  printf("DIR_REMOVED\\n"); fflush(stdout);
  return 0;
}`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run('nimbus install clang', 300_000);
await t.run(heredocCommand('/home/user/d.c', CSRC), 30_000);
const rc = await t.run('clang -O0 -o /home/user/d /home/user/d.c', 240_000);
const compileOK = !/error:|Assertion failed/.test(stripAnsi(rc.output));
a.check('clang compiles', compileOK, compileOK ? '' : JSON.stringify(stripAnsi(rc.output).slice(-400)));

// Phase 1: run program, expect both DIR_CREATED and DIR_REMOVED on stdout.
const rr = await t.run('/home/user/d ; echo RUN_EXIT=$?', 60_000);
const out = stripAnsi(rr.output);
a.check('DIR_CREATED printed', /DIR_CREATED/.test(out), JSON.stringify(out.slice(-300)));
a.check('DIR_REMOVED printed', /DIR_REMOVED/.test(out), JSON.stringify(out.slice(-300)));
a.check('exit code 0', /RUN_EXIT=0/.test(out), JSON.stringify(out.slice(-200)));

// Phase 2: post-run, dir should be absent (it was removed).
const rExists = await t.run(`node -e "console.log(require('fs').existsSync('/home/user/new-dir') ? 'EXISTS' : 'ABSENT')"`, 15_000);
const absent = /ABSENT/.test(stripAnsi(rExists.output));
a.check('/home/user/new-dir ABSENT after rmdir', absent,
  absent ? '' : JSON.stringify(stripAnsi(rExists.output).slice(-200)));

// Phase 3: the double-prefix path should never have existed.
const rBuggy = await t.run(`node -e "console.log(require('fs').existsSync('/home/user/home/user/new-dir') ? 'EXISTS' : 'ABSENT')"`, 15_000);
const buggyAbsent = /ABSENT/.test(stripAnsi(rBuggy.output));
a.check('/home/user/home/user/new-dir ABSENT (no double-prefix)', buggyAbsent,
  buggyAbsent ? '' : JSON.stringify(stripAnsi(rBuggy.output).slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
