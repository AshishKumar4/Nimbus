import assert from 'node:assert/strict';
import { terminalCommandRunner } from './lib/workerd-probe.mjs';

let status = 0;
const terminal = {
  buf: '',
  reset() { this.buf = ''; },
  cmd(line) { this.line = line; this.buf = line + '\r\n'; },
  async waitFor(done) {
    assert.equal(done(this.buf), false, 'the echoed marker with $? is not completion');
    this.buf += 'HTTP/1.1 200 OK >\r\n';
    assert.equal(done(this.buf), false, 'prompt-shaped program output is not completion');
    this.buf += '1.0.0\r\n';
    const marker = /(__NIMBUS_DONE_\d+__)/.exec(this.line)[1];
    this.buf += marker + status;
    assert.equal(done(this.buf), false, 'a status without a returned prompt is not completion');
    this.buf += '\r\nuser@nimbus:~$ ';
    assert.equal(done(this.buf), true);
  },
};
const run = terminalCommandRunner(terminal);
for (status of [0, 7]) {
  assert.deepEqual(await run('program'), { stdout: 'HTTP/1.1 200 OK >\n1.0.0\n', status });
}
console.log('terminal-command-marker: echo, interim output and partial status wait for the actual completion marker');
