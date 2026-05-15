#!/usr/bin/env bun
// winwin-w2/install-partial-detectable — manifest-first invariant.
//
// The pre-loop write of manifest.json (package-manager.ts:253-255) is
// the partial-install-detectable contract: the idempotent re-install
// branch trusts manifest.json presence as "install completed". W2's
// parallelization MUST preserve this — manifest.json must exist on
// disk by the time any blob write completes.
//
// Indirect assertion: after a successful install, the runtime's
// manifest.json must be present at the expected path AND must
// parse as JSON with the expected name/version fields.

import { mintSession, Terminal, makeAsserter, stripAnsi, BASE } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('winwin-w2/install-partial-detectable');
console.log(`winwin-w2/install-partial-detectable — ${BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Install python.
const { output: ir } = await t.run('nimbus install python', 180_000);
const s1 = stripAnsi(ir);
a.check('install completed', /installed at/.test(s1),
  `tail=${JSON.stringify(s1.slice(-200))}`);

// Discover installed version from --list output.
const { output: lo } = await t.run('nimbus install --list', 15_000);
const sList = stripAnsi(lo);
const verMatch = sList.match(/python@([\w.-]+)/);
const version = verMatch ? verMatch[1] : null;
a.check('--list reports python version', version !== null,
  `tail=${JSON.stringify(sList.slice(-200))}`);
if (!version) {
  await t.close();
  const sum = a.summary();
  process.exit(sum.fail > 0 ? 1 : 0);
}

// manifest.json present at the expected path.
const manifestPath = `~/.nimbus/runtimes/python/${version}/manifest.json`;
const { output: lso } = await t.run(`ls -la ${manifestPath}`, 10_000);
const s3 = stripAnsi(lso);
const present = /manifest\.json/.test(s3) && !/No such file/i.test(s3);
a.check('manifest.json present at expected path', present,
  `path=${manifestPath} output=${JSON.stringify(s3.slice(-200))}`);

// manifest.json parses as JSON with expected name/version fields.
const { output: catOut } = await t.run(`cat ${manifestPath}`, 10_000);
const sCat = stripAnsi(catOut);
let parsed = null;
let parseErr = null;
try {
  // Strip prompt + trailing prompt artifacts; find the JSON body.
  const start = sCat.indexOf('{');
  const end = sCat.lastIndexOf('}');
  if (start >= 0 && end > start) {
    parsed = JSON.parse(sCat.slice(start, end + 1));
  }
} catch (e) {
  parseErr = e?.message || String(e);
}
a.check('manifest.json parses as JSON with name=python',
  parsed && parsed.name === 'python',
  `parsed=${JSON.stringify(parsed)?.slice(0, 200)} parseErr=${parseErr}`);
a.check('manifest.json reports matching version',
  parsed && parsed.version === version,
  `parsed.version=${parsed?.version} expected=${version}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
