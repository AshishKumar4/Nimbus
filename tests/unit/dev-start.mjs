import assert from 'node:assert/strict';
import { startDevCommand, frameworkProxyHost } from '../behavioral/_dev-start.mjs';

function terminal(output, completed = false) {
  const commands = [];
  const t = {
    commands, buf: '', submission: null,
    reset() { this.buf = ''; },
    cmd(command) { commands.push(command); this.submission = { end: null }; },
    async waitFor(predicate) {
      this.buf = output;
      if (completed) this.submission.end = output.length;
      if (!predicate(output)) throw new Error('readiness timeout');
    },
  };
  return t;
}
const resident = terminal('[facet started (long-running): pid=41]\nready in 1ms');
const started = await startDevCommand({ terminal: resident, cwd: '/app', command: 'npm run dev' });
assert.equal(started.pid, 41);
assert.equal(started.ready, true);
assert.deepEqual(resident.commands, [`cd /app && __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=${frameworkProxyHost} npm run dev`]);
const browser = terminal('VITE v8 ready');
const ready = await startDevCommand({ terminal: browser, cwd: '/app', command: 'npm run dev', ready: text => text.includes('VITE v8') });
assert.equal(ready.ready, true);
assert.equal(browser.commands.length, 1);
const failed = terminal('user@nimbus: a prompt-shaped log, but command ended', true);
const stopped = await startDevCommand({ terminal: failed, cwd: '/app', command: 'dev' });
assert.equal(stopped.ready, false);
assert.equal(stopped.pid, 0);
assert.equal(failed.commands.length, 1, 'a failed first launch never retries the command');
const timeout = terminal('still compiling');
assert.equal((await startDevCommand({ terminal: timeout, cwd: '/app', command: 'dev' })).ready, false);
console.log('dev-start: one command boundary for browser and framework readiness policies');
