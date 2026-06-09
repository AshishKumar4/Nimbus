#!/usr/bin/env bun
// agentic-cli/new/npm-bin-explicit-process-exit — foreground npm bins
// must respect process.exit even when startup leaves background promises.

import {
  deleteSession,
  heredocCommand,
  makeAsserter,
  mintSession,
  stripAnsi,
  Terminal,
} from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('agentic-cli/new/npm-bin-explicit-process-exit');

const packageJson = JSON.stringify({
  name: '@nimbus-fixtures/async-exit',
  version: '1.0.0',
  bin: { 'async-exit': './cli.js' },
}, null, 2);

const cliSource = `
function main() {
  Promise.resolve().then(() => new Promise(() => {}));
  queueMicrotask(() => {
    console.log('async exit ok');
    process.exit(0);
  });
}
main();
`;

const pendingPackageJson = JSON.stringify({
  name: '@nimbus-fixtures/pending-promise',
  version: '1.0.0',
  bin: { 'pending-promise': './cli.js' },
}, null, 2);

const pendingCliSource = `
Promise.resolve().then(() => new Promise(() => {}));
console.log('pending promise ok');
`;

const asyncMainPackageJson = JSON.stringify({
  name: '@nimbus-fixtures/async-main-exit',
  version: '1.0.0',
  bin: { 'async-main-exit': './cli.js' },
}, null, 2);

const asyncMainCliSource = `
async function main() {
  await Promise.resolve();
  await Promise.resolve();
  console.log('async main exit ok');
  process.exit(7);
}
main();
`;

const responseMutationPackageJson = JSON.stringify({
  name: '@nimbus-fixtures/response-mutation-exit',
  version: '1.0.0',
  bin: { 'response-mutation-exit': './cli.js' },
}, null, 2);

const responseMutationCliSource = `
globalThis.Response = class UserlandResponse {
  static json() {
    return { userland: true };
  }
};
console.log('response mutation ok');
process.exit(0);
`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(30_000);

  await t.run('mkdir -p /home/user/node_modules/@nimbus-fixtures/async-exit /home/user/node_modules/.bin', 10_000);
  await t.run(heredocCommand('/home/user/node_modules/@nimbus-fixtures/async-exit/package.json', packageJson), 10_000);
  await t.run(heredocCommand('/home/user/node_modules/@nimbus-fixtures/async-exit/cli.js', cliSource), 10_000);
  await t.run(heredocCommand('/home/user/node_modules/.bin/async-exit', '#!/usr/bin/env node\nrequire("../@nimbus-fixtures/async-exit/cli.js");'), 10_000);

  const run = await t.run('async-exit', 30_000);
  const output = stripAnsi(run.output);
  a.check('foreground npm bin returns after explicit process.exit',
    /async exit ok/.test(output) && /\[bin started: pid=\d+ cmd="async-exit"\]/.test(output),
    JSON.stringify(output.slice(-1000)));

  await t.run('mkdir -p /home/user/node_modules/@nimbus-fixtures/pending-promise /home/user/node_modules/.bin', 10_000);
  await t.run(heredocCommand('/home/user/node_modules/@nimbus-fixtures/pending-promise/package.json', pendingPackageJson), 10_000);
  await t.run(heredocCommand('/home/user/node_modules/@nimbus-fixtures/pending-promise/cli.js', pendingCliSource), 10_000);
  await t.run(heredocCommand('/home/user/node_modules/.bin/pending-promise', '#!/usr/bin/env node\nrequire("../@nimbus-fixtures/pending-promise/cli.js");'), 10_000);

  const pendingRun = await t.run('pending-promise', 30_000);
  const pendingOutput = stripAnsi(pendingRun.output);
  a.check('foreground npm bin returns when startup leaves only a pending Promise',
    /pending promise ok/.test(pendingOutput) && /\[bin started: pid=\d+ cmd="pending-promise"\]/.test(pendingOutput),
    JSON.stringify(pendingOutput.slice(-1000)));

  await t.run('mkdir -p /home/user/node_modules/@nimbus-fixtures/async-main-exit /home/user/node_modules/.bin', 10_000);
  await t.run(heredocCommand('/home/user/node_modules/@nimbus-fixtures/async-main-exit/package.json', asyncMainPackageJson), 10_000);
  await t.run(heredocCommand('/home/user/node_modules/@nimbus-fixtures/async-main-exit/cli.js', asyncMainCliSource), 10_000);
  await t.run(heredocCommand('/home/user/node_modules/.bin/async-main-exit', '#!/usr/bin/env node\nrequire("../@nimbus-fixtures/async-main-exit/cli.js");'), 10_000);

  const asyncMainRun = await t.run('async-main-exit; echo RC=$?', 30_000);
  const asyncMainOutput = stripAnsi(asyncMainRun.output);
  a.check('foreground npm bin observes process.exit from an unawaited async main',
    /async main exit ok/.test(asyncMainOutput) && /RC=7/.test(asyncMainOutput),
    JSON.stringify(asyncMainOutput.slice(-1000)));

  await t.run('mkdir -p /home/user/node_modules/@nimbus-fixtures/response-mutation-exit /home/user/node_modules/.bin', 10_000);
  await t.run(heredocCommand('/home/user/node_modules/@nimbus-fixtures/response-mutation-exit/package.json', responseMutationPackageJson), 10_000);
  await t.run(heredocCommand('/home/user/node_modules/@nimbus-fixtures/response-mutation-exit/cli.js', responseMutationCliSource), 10_000);
  await t.run(heredocCommand('/home/user/node_modules/.bin/response-mutation-exit', '#!/usr/bin/env node\nrequire("../@nimbus-fixtures/response-mutation-exit/cli.js");'), 10_000);

  const responseMutationRun = await t.run('response-mutation-exit; echo RC=$?', 30_000);
  const responseMutationOutput = stripAnsi(responseMutationRun.output);
  a.check('foreground npm bin can mutate global Response without corrupting Nimbus host response',
    /response mutation ok/.test(responseMutationOutput)
      && /RC=0/.test(responseMutationOutput)
      && !/Promise did not resolve to 'Response'|Incorrect type for Promise/.test(responseMutationOutput),
    JSON.stringify(responseMutationOutput.slice(-1000)));

} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
