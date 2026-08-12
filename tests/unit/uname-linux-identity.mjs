#!/usr/bin/env bun
/**
 * uname-linux-identity — `uname` reports the system third-party scripts gate on.
 *
 * Nearly every `curl … | bash` installer opens with
 *
 *     case "$(uname -s)" in Darwin|Linux) ;; *) die "… is not supported" ;; esac
 *
 * `uname` used to answer `Lifo`, so every one of them took its unsupported
 * branch. That is what sent the reported Proteus install down its error path.
 * The machine name stays honest — the code that runs here is wasm.
 */

import assert from 'node:assert/strict';

import { Sandbox } from '../../packages/worker/src/substrate/lifo/sandbox/Sandbox.ts';

const box = await Sandbox.create({ persist: false });

async function stdoutOf(line) {
  const result = await box.shell.execute(line, {});
  assert.equal(result.exitCode, 0, `${line} exited ${result.exitCode}`);
  return (result.stdout ?? '').trim();
}

assert.equal(await stdoutOf('uname'), 'Linux');
assert.equal(await stdoutOf('uname -s'), 'Linux');
assert.equal(await stdoutOf('uname -o'), 'GNU/Linux');
assert.equal(await stdoutOf('uname -n'), 'nimbus');
assert.equal(await stdoutOf('uname -m'), 'wasm');
assert.equal(await stdoutOf('uname -sm'), 'Linux wasm');
assert.match(await stdoutOf('uname -a'), /^Linux nimbus .* wasm GNU\/Linux$/);

assert.equal(
  await stdoutOf('case "$(uname -s)" in Darwin|Linux) echo SUPPORTED ;; *) echo UNSUPPORTED ;; esac'),
  'SUPPORTED',
  'the installer platform gate must select the Linux branch');

box.destroy();
console.log('uname linux identity: ok');
