#!/usr/bin/env bun
/**
 * wasi-stat-dot — a WASI program's stat of "." and of its preopen answers
 * the directory, as a stat of any other name does.
 *
 * Go's os.Getwd on wasip1 stats "." before anything else, so a refusal here
 * stops every Go program at startup (TypeScript 7's tsc said "Error getting
 * current directory: stat .: I/O error" under wasm-runner). Both preopens a
 * guest gets are covered: the session root (the language runtimes) and a
 * directory beneath it (wasm-runner's "/" is the shell's cwd).
 */

import assert from 'node:assert/strict';
import { residentGuest } from './lib/wasi-resident-guest.mjs';

const DIRECTORY = 3;
const describe = async (fn) => { try { return JSON.stringify(await fn()); } catch (error) { return `${error?.constructor?.name}: ${error?.message} (code ${error?.code})`; } };

for (const preopen of ['', 'home/user', 'home/user/proj/app']) {
  const guest = await residentGuest({ preopen });
  try {
    // Go sends its cwd ($PWD, the shell's) joined and cleaned: under a cwd
    // preopen that is the preopen's own path re-stated.
    for (const name of ['.', './.', ...(preopen ? [preopen, `${preopen}/.`, `${preopen}/`] : [])]) {
      let answer;
      try {
        answer = await guest.stat(name);
      } catch (error) {
        const raw = await describe(() => guest.authority.stat({ root: preopen, path: name, beneath: true }, { followSymlinks: true }));
        assert.fail(`preopen '${preopen}': stat '${name}' was refused (${error.message}); the session's own stat of it answers ${raw}`);
      }
      assert.equal(answer.filetype, DIRECTORY, `preopen '${preopen}': stat '${name}' is the directory`);
    }
    const root = await guest.statPreopen().catch(async (error) => {
      const raw = await describe(() => guest.authority.stat(`/${preopen}`, { followSymlinks: true }));
      assert.fail(`preopen '${preopen}': fd_filestat_get of the preopen was refused (${error.message}); the session's own stat of it answers ${raw}`);
    });
    assert.equal(root.filetype, DIRECTORY, `preopen '${preopen}': the preopen is a directory`);
  } finally {
    await guest.dispose();
  }
}
console.log('wasi-stat-dot: ok');
