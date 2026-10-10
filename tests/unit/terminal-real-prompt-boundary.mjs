import assert from 'node:assert/strict';
import { Terminal } from '../behavioral/_driver.mjs';
const terminal = {
  buf: '',
  submission: { end: null },
  protocol: [], promptCursor: 0,
  async waitFor(predicate) {
    this.buf = '\ruser@nimbus:~$ ';
    assert.equal(predicate(this.buf), false, 'a redraw prefix is not a returned command prompt');
    this.buf += 'python -c "1/0"\r\r\nTraceback (most recent call last):\r\n  File "<string>", line 1, in <module>\r\n';
    assert.equal(predicate(this.buf), false, 'a traceback header ending in > is not a shell prompt');
    this.buf += 'ZeroDivisionError: division by zero\r\nuser@nimbus:~$ ';
    assert.equal(predicate(this.buf), false, 'even prompt-shaped bytes cannot complete a submitted command');
    this.submission.end = this.buf.length;
    assert.equal(predicate(this.buf), true, 'only the trusted server completion ends the command');
  },
};
await Terminal.prototype.waitForPrompt.call(terminal, 1000);
console.log('terminal-real-prompt-boundary: redraw prefixes and prompt-shaped program output never complete a command');
