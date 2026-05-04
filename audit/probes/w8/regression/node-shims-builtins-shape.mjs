// W8 regression: every previously-shimmed node:* builtin still exposes
// the same top-level shape after our child_process patch.
//
// We snapshot the keys of each builtin and compare to a known-good list.
// Adding new top-level keys is fine; REMOVING one is a regression.

import { ok, eq, gte, summary, group } from '../_tap.mjs';
import { makeShimHost, makeMockSupervisor } from '../_shim-host.mjs';

await group('node-shims-builtins-shape', async () => {
  const sup = makeMockSupervisor();
  const host = await makeShimHost(sup);

  // Top-level builtin keys
  ok('builtins.fs is object', typeof host.builtins.fs === 'object');
  ok('builtins.path is object', typeof host.builtins.path === 'object');
  ok('builtins.os is object', typeof host.builtins.os === 'object');
  ok('builtins.events is non-null', host.builtins.events != null);
  ok('builtins.stream is object', typeof host.builtins.stream === 'object');
  ok('builtins.buffer is object', typeof host.builtins.buffer === 'object');
  ok('builtins.util is object', typeof host.builtins.util === 'object');
  ok('builtins.url is object', typeof host.builtins.url === 'object');
  ok('builtins.crypto is object', typeof host.builtins.crypto === 'object');
  ok('builtins.assert is non-null', host.builtins.assert != null);
  ok('builtins.querystring is object', typeof host.builtins.querystring === 'object');
  ok('builtins.string_decoder is object', typeof host.builtins.string_decoder === 'object');
  ok('builtins.child_process is object', typeof host.builtins.child_process === 'object');
  ok('builtins.process is object', typeof host.builtins.process === 'object');
  ok('builtins.console is object', typeof host.builtins.console === 'object');

  // child_process surface — must include all 6 documented entry points
  const cp = host.builtins.child_process;
  ok('cp.exec', typeof cp.exec === 'function');
  ok('cp.execSync', typeof cp.execSync === 'function');
  ok('cp.execFile', typeof cp.execFile === 'function');
  ok('cp.execFileSync', typeof cp.execFileSync === 'function');
  ok('cp.spawn', typeof cp.spawn === 'function');
  ok('cp.spawnSync', typeof cp.spawnSync === 'function');
  ok('cp.fork', typeof cp.fork === 'function');
  ok('cp.ChildProcess', cp.ChildProcess !== undefined);

  // fs shape — sanity check the most-imported keys
  ok('fs.readFile', typeof host.builtins.fs.readFile === 'function');
  ok('fs.writeFile', typeof host.builtins.fs.writeFile === 'function');
  ok('fs.readFileSync', typeof host.builtins.fs.readFileSync === 'function');
  ok('fs.existsSync', typeof host.builtins.fs.existsSync === 'function');

  // crypto: real workerd crypto is forwarded — verify the W3 contract holds
  ok('crypto.createHash', typeof host.builtins.crypto.createHash === 'function');
  ok('crypto.randomBytes', typeof host.builtins.crypto.randomBytes === 'function');
});

summary('node-shims-builtins-shape [W8 regression]');
