#!/usr/bin/env bun
// wasm-runner/memory-cap-honesty — running out of memory must be something
// the PROGRAM reports, not something the session dies of.
//
// Modules built by wasi-sdk declare a memory minimum and no maximum, so a
// guest `memory.grow` keeps succeeding until the isolate hosting it is killed.
// From inside, every allocation appeared to work right up to the moment the
// process vanished; from outside, a session simply stopped answering. Nobody
// gets a diagnostic.
//
// wasm-runner now installs a declared maximum on every module it dispatches.
// Past that maximum the grow instruction returns -1, dlmalloc's sbrk fails,
// and malloc returns NULL — so the program takes its own error path.
//
// This probe compiles a C program that allocates until malloc says no, and
// checks the two things that matter:
//   1. the program itself reports the failure and exits normally, and
//   2. the session is still alive afterwards.
//
// (2) is the whole point. An uncapped build of this program does not fail
// here — it takes the session with it, and there is no output to assert on.

import { mintSession, Terminal, makeAsserter, stripAnsi, heredocCommand } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('wasm-runner/memory-cap-honesty');
console.log(`wasm-runner/memory-cap-honesty — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install clang', 180_000);

// Two things this program has to get right, both learned the hard way:
//
//   - Every chunk is written AND read back. An allocation whose result is
//     never observed is dead, and LLVM deletes the malloc/memset pair
//     outright — an earlier version of this probe reported "never refused"
//     from a binary whose memory never grew past its initial 17 pages.
//   - Counters are `int` chunk counts, not byte totals. `long` is 32 bits on
//     wasm32, so a byte total wraps to exactly 0 at 4 GiB.
//
// It also reports `memory_size` directly, so a run that never grows can never
// again be mistaken for a run that grew and was refused.
const hogC = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHUNK (8 * 1024 * 1024)

static char *kept[512];

int main(void) {
  for (int i = 0; i < 512; i++) {
    char *p = malloc(CHUNK);
    if (!p) {
      printf("REFUSED_AT %d MiB pages=%d\\n", i * 8,
             (int)__builtin_wasm_memory_size(0));
      long sum = 0;
      for (int j = 0; j < i; j++) sum += kept[j][j];
      printf("checksum=%ld\\n", sum);
      return 0;
    }
    memset(p, 1, CHUNK);
    kept[i] = p;
  }
  printf("NEVER_REFUSED pages=%d\\n", (int)__builtin_wasm_memory_size(0));
  return 0;
}`;
await t.run(heredocCommand('hog.c', hogC), 15_000);

{
  const { output } = await t.run('clang hog.c -o hog', 300_000);
  const stripped = stripAnsi(output);
  const compiled = !/error:|fatal:|command not found/i.test(stripped);
  a.check('hog.c compiles', compiled, compiled ? '' : JSON.stringify(stripped.slice(-500)));
}

{
  const { output, elapsed } = await t.run('./hog', 180_000);
  const stripped = stripAnsi(output);
  const m = stripped.match(/REFUSED_AT (\d+) MiB pages=(\d+)/);
  const refusedAt = m ? parseInt(m[1], 10) : null;
  const pages = m ? parseInt(m[2], 10) : null;

  a.check('the guest is told its allocation failed, by its own malloc',
    m !== null,
    m !== null ? `refused at ${refusedAt} MiB, ${pages} pages (elapsed=${elapsed}ms)`
               : `output=${JSON.stringify(stripped.slice(-500))}`);

  // DEFAULT_WASM_PROCESS_LIMIT_BYTES is 128 MiB = 2048 pages. Stopping right
  // below that is the cap doing its job; sailing past it means the cap never
  // reached the module, and stopping near zero means it landed below what the
  // module needs to be useful.
  const capped = pages !== null && pages <= 2048;
  a.check('it stopped below the 2048-page (128 MiB) declared maximum',
    capped, `grew to ${pages} pages`);
  const useful = refusedAt !== null && refusedAt >= 32;
  a.check('after being given a useful amount of memory — at least 32 MiB',
    useful, `refused at ${refusedAt} MiB`);
}

// The reason this change exists. An uncapped grow kills the isolate hosting
// the process; the session is what the user notices losing.
{
  const { output } = await t.run('echo STILL_ALIVE_$((6*7))', 30_000);
  const stripped = stripAnsi(output);
  const alive = /STILL_ALIVE_42/.test(stripped);
  a.check('the session survives the allocation failure and still runs commands',
    alive, alive ? '' : `output=${JSON.stringify(stripped.slice(-400))}`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
