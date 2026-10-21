#!/usr/bin/env bun
// sdk/node-compat-differential — one program over Node's fs (Kinu ask 67),
// run by the hosted workspace's node (its facet) and through
// createNodeCompat over the same session from outside it, answers value for
// value (tests/unit/lib/node-fs-differential.mjs). The unit test
// node-compat-facade compares lifo's node with the facade the same way, so
// the three agree. Fails when either side drifts.
import { BASE, AUTH_TOKEN, makeAsserter } from '../../_driver.mjs';
import { differential, fixtureFiles, fixtureLink, programSource } from '../../../unit/lib/node-fs-differential.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('sdk/node-compat-differential');
const { Nimbus } = await import('../../../../packages/sdk/src/index.ts');
const { createNodeCompat, nodeFacesOf } = await import('../../../../packages/core/src/node-compat/index.ts');
const box = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) }).sandbox(`node-compat-differential-${Date.now()}`);

try {
  const root = '/home/user/differential';
  for (const [path, content] of Object.entries(fixtureFiles)) {
    await box.files.mkdir(`${root}/${path.slice(0, path.lastIndexOf('/'))}`);
    await box.files.write(`${root}/${path}`, content);
  }
  await box.files.symlink(fixtureLink.target, `${root}/${fixtureLink.path}`);
  await box.files.write(`${root}/program.js`, programSource('facet'));
  const ran = await box.exec(`cd ${root} && node program.js`);
  a.check('the hosted node runs the program', ran.exitCode === 0, ran.stderr.slice(0, 800));
  const facet = ran.exitCode === 0 ? JSON.parse(ran.stdout) : {};
  const facade = await differential(createNodeCompat(nodeFacesOf(box), { cwd: root }).fs, 'facade');
  for (const key of Object.keys(facade)) {
    const ours = JSON.stringify(facade[key]);
    const theirs = JSON.stringify(facet[key]);
    a.check(`${key}: the facet's and the facade's agree`, ours === theirs, `facade ${ours} facet ${theirs}`);
  }
} finally {
  await box.destroy({ reason: 'node-compat-differential-complete' }).catch(() => {});
}
const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
