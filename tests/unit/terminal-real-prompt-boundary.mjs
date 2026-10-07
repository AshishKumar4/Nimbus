import assert from 'node:assert/strict';
import { Terminal, stripAnsi } from '../behavioral/_driver.mjs';
const terminal = {
  buf: '',
  async waitFor(predicate) {
    this.buf = '\ruser@nimbus:~$ ';
    assert.equal(predicate(stripAnsi(this.buf)), false, 'a redraw prefix is not a returned command prompt');
    this.buf += 'python -c "1/0"\r\r\nTraceback (most recent call last):\r\n  File "<string>", line 1, in <module>\r\n';
    assert.equal(predicate(stripAnsi(this.buf)), false, 'a traceback header ending in > is not a shell prompt');
    this.buf += 'ZeroDivisionError: division by zero\r\nuser@nimbus:~$ ';
    assert.equal(predicate(stripAnsi(this.buf)), true, 'the real prompt after the final error line completes the command');
  },
};
await Terminal.prototype.waitForNewPrompt.call(terminal, 1000);
console.log('terminal-real-prompt-boundary: redraw prefixes and prompt-shaped program output never complete a command');
