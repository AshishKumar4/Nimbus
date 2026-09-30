#!/usr/bin/env bun
// OpenTUI's span feed writes UTF-8 ANSI chunks as Uint8Array to the runner's
// TTY stdout. They must reach the terminal as the same bytes. Decoding them
// to a latin1 string before process.stdout.write (which UTF-8-encodes
// strings) double-encoded every border, spinner and icon: "┃ ⠋ é" went from
// 10 bytes to 18 and rendered as mojibake.
import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { OPENTUI_TTY_STDOUT_SRC } from '../../packages/worker/src/runtime/opencode-facet-runner.ts';

// The runner's resident stdout turns each write into bytes with the shim's
// own encoder; install the TTY stdout over exactly that path.
const install = new Function('__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + generateShimsCode() + `
  return (sent) => {
    const stdout = { write: (d, enc) => { sent.push(__nimbusOutBytes(d, enc)); return true; } };
    (function (process) {
      let __ttyC = 0, __ttyB = 0;
      const __nimbusTtyColumns = 80, __nimbusTtyRows = 24;
      ${OPENTUI_TTY_STDOUT_SRC}
    })({ stdout });
    return globalThis.__nimbusOpenTUITtyStdout;
  };`)(
  {}, {}, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user', [], {}, '/home/user/main.js', '/home/user',
);

const sent = [];
const tty = install(sent);
const frame = new TextEncoder().encode('\x1b[1;1H┃ ⠋ é');
tty.write(frame);
tty.write(frame.buffer.slice(0));
tty.write('ascii');
assert.deepEqual(sent.map((b) => [...b]), [[...frame], [...frame], [...new TextEncoder().encode('ascii')]],
  'span-feed bytes reach the terminal unchanged; strings keep their UTF-8 encoding');
delete globalThis.__nimbusOpenTUITtyStdout;
console.log('opentui-tty-stdout-bytes: ok');
