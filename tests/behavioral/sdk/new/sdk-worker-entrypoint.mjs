import { BASE, AUTH_TOKEN, makeAsserter } from '../../_driver.mjs';
import { Nimbus } from '../../../../packages/sdk/src/index.ts';

const a = makeAsserter('sdk/new/sdk-worker-entrypoint');
const box = Nimbus.connect({ endpoint: BASE, token: AUTH_TOKEN }).sandbox(`host-exports-${Date.now()}`);
try {
  await box.ready();
  await box.files.write('/mnt/data/host-export.txt', 'mounted filesystem\n');
  await box.files.write('/home/user/host-export.js', `
const fs = require('fs');
(async () => {
  process.stdout.write(await fs.promises.readFile('/mnt/data/host-export.txt', 'utf8'));
})();
`);
  const result = await box.exec('node host-export.js');
  a.check('the shared host registry supports session, loader and supervisor RPC',
    result.exitCode === 0 && result.stdout === 'mounted filesystem\n', JSON.stringify(result));
  a.check('the probe retains its overridden session filesystem', await box.files.read('/mnt/data/host-export.txt') === 'mounted filesystem\n');
} finally {
  const destroyed = await box.destroy({ reason: 'sdk-worker-entrypoints-probe-complete' });
  a.check('the SDK-owned sandbox is destroyed', destroyed.ok === true && typeof destroyed.destroyedAt === 'number');
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
