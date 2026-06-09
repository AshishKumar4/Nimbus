#!/usr/bin/env bun
// agentic-cli/new/bun-shebang-npm-bin — npm bins must dispatch through
// their declared shebang runtime, not always through node.

import {
  deleteSession,
  heredocCommand,
  makeAsserter,
  mintSession,
  stripAnsi,
  Terminal,
} from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('agentic-cli/new/bun-shebang-npm-bin');

const packageJson = JSON.stringify({
  name: '@nimbus-fixtures/bun-bin',
  version: '1.0.0',
  bin: { 'bun-bin-fixture': './cli.ts' },
}, null, 2);

const cliSource = `#!/usr/bin/env bun
const message: string = 'BUN_BIN_OK';
console.log(message);
console.log('BUN_VERSION=' + Bun.version);
console.log('ARGV=' + process.argv.slice(2).join(','));
`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(30_000);

  await t.run('mkdir -p /home/user/node_modules/@nimbus-fixtures/bun-bin /home/user/node_modules/.bin', 10_000);
  await t.run(heredocCommand('/home/user/node_modules/@nimbus-fixtures/bun-bin/package.json', packageJson), 10_000);
  await t.run(heredocCommand('/home/user/node_modules/@nimbus-fixtures/bun-bin/cli.ts', cliSource), 10_000);
  await t.run(heredocCommand('/home/user/node_modules/.bin/bun-bin-fixture', '#!/usr/bin/env bun\n../@nimbus-fixtures/bun-bin/cli.ts'), 10_000);

  const run = await t.run('bun-bin-fixture alpha beta', 60_000);
  const out = stripAnsi(run.output);
  a.check('npm bin with Bun shebang dispatches through Bun runtime',
    /BUN_BIN_OK/.test(out)
      && /BUN_VERSION=/.test(out)
      && /ARGV=alpha,beta/.test(out)
      && !/transform error|Cannot use import statement|Unexpected token/.test(out),
    JSON.stringify(out.slice(-1000)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
