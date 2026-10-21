#!/usr/bin/env bun
// sdk/node-compat-child-process — one program over Node's child_process
// (Kinu ask 67), run by the hosted workspace's node (its facet) and through
// createNodeCompat over the same session from outside it, over the remote
// API, answers value for value (tests/unit/lib/node-child-process-differential.mjs):
// exec exiting 3, a program killed by SIGTERM, execFile of a missing
// program, and spawn('cat') echoing every byte value and 1 MiB to a slow
// reader. Fails when either side drifts.
import { BASE, AUTH_TOKEN, makeAsserter } from '../../_driver.mjs';
import { childDifferential, programSource } from '../../../unit/lib/node-child-process-differential.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('sdk/node-compat-child-process');
const { Nimbus } = await import('../../../../packages/sdk/src/index.ts');
const { createNodeCompat, nodeFacesOf } = await import('../../../../packages/core/src/node-compat/index.ts');
const box = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) }).sandbox(`node-compat-child-process-${Date.now()}`);

try {
  const root = '/home/user/children';
  await box.files.mkdir(root);
  await box.files.write(`${root}/program.js`, programSource());
  const ran = await box.exec(`cd ${root} && node program.js`);
  a.check('the hosted node runs the program', ran.exitCode === 0, ran.stderr.slice(0, 800));
  const facet = ran.exitCode === 0 ? JSON.parse(ran.stdout) : {};
  const facade = await childDifferential(createNodeCompat(nodeFacesOf(box), { cwd: root }).childProcess);
  for (const key of Object.keys(facade)) {
    const ours = JSON.stringify(facade[key]);
    const theirs = JSON.stringify(facet[key]);
    a.check(`${key}: the facet's and the facade's agree`, ours === theirs, `facade ${ours} facet ${theirs}`);
  }
  a.check('every byte, and 1 MiB to a slow reader, in order', facade.bytes?.same === true && facade.mebibyte?.same === true, JSON.stringify([facade.bytes, facade.mebibyte]));
  const { childProcess } = createNodeCompat(nodeFacesOf(box), { cwd: root });
  let refused = null;
  try { childProcess.execSync('true'); } catch (error) { refused = error.code; }
  a.check('execSync refuses: ERR_NIMBUS_SYNC_CHILD_PROCESS', refused === 'ERR_NIMBUS_SYNC_CHILD_PROCESS', String(refused));
} finally {
  await box.destroy({ reason: 'node-compat-child-process-complete' }).catch(() => {});
}
const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
