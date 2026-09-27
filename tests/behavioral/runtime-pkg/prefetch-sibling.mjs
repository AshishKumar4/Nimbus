#!/usr/bin/env bun
// runtime-pkg/prefetch-sibling — G3 probe.
//
// When a bin does `require('./helper')` from a sibling file in the bin
// directory, the prefetch resolver may miss it. The static walk in
// require-resolver.ts:534 follows entry-code requires to entry-file's
// directory (post runtime primitive support), but BIN's commonly do
// `require('../lib/foo')` plus `./helper-shared.js` — and those second-
// step requires can be missed if the helpers themselves do dynamic
// requires or computed paths.
//
// Probe: install a custom package whose .bin entry uses a SIBLING
// helper file that itself uses `require('./inner')` two levels deep.
// All three files must be in the prefetch bundle for the bin to run.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[G3] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(15_000).catch(() => {});

await t.run('mkdir -p /home/user/g3-probe/node_modules/.bin', 5_000);
await t.run('mkdir -p /home/user/g3-probe/node_modules/sibling-cli/lib /home/user/g3-probe/node_modules/sibling-cli/bin', 5_000);
await t.run('cd /home/user/g3-probe', 5_000);
await t.run('node -e "require(\'fs\').writeFileSync(\'package.json\', JSON.stringify({name:\'p\',version:\'1.0.0\'}))"', 10_000);

// Set up a 3-file CLI:
//
//   node_modules/sibling-cli/lib/inner.js     — leaf helper
//   node_modules/sibling-cli/lib/main.js      — requires './inner'
//   node_modules/sibling-cli/bin/sibling-cli  — bin shim, requires '../lib/main'
//   node_modules/.bin/sibling-cli             — Nimbus-style require shim
//
// The bin shim path triggers the prefetch resolver. If the resolver
// only walks one require-step, it'll have main.js but miss inner.js
// → at runtime, main.js's `require('./inner')` throws 'Cannot find
// module'.

const innerCode = "module.exports = { val: 'INNER-PRESENT' };\n";
const mainCode  = "var inner = require('./inner');\nconsole.log('SIBLING-OK:' + inner.val);\nprocess.exit(0);\n";
const binCode   = "#!/usr/bin/env node\n" + "require('../lib/main');\n";
const installerShim = "#!/usr/bin/env node\n" +
                      "require('/home/user/g3-probe/node_modules/sibling-cli/bin/sibling-cli');\n";

// fs.writeFileSync does not create missing parents (ENOENT, as in Node), so
// every directory above is made explicitly. Each write reports the size it
// left on disk, and a write that did not land stops the probe.
async function writeFile(path, content) {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const r = await t.run(
    `node -e "var f=require('fs'); f.writeFileSync('${path}', Buffer.from('${b64}','base64').toString('utf8')); console.log('WROTE ' + f.statSync('${path}').size)"`,
    10_000,
  );
  const bytes = Buffer.byteLength(content, 'utf8');
  if (!new RegExp(`^WROTE ${bytes}\\r?$`, 'm').test(stripAnsi(r.output))) {
    throw new Error(`[G3] setup: writing ${path} did not leave ${bytes} bytes on disk:\n${stripAnsi(r.output).slice(-500)}`);
  }
}

await writeFile('node_modules/sibling-cli/lib/inner.js', innerCode);
await writeFile('node_modules/sibling-cli/lib/main.js',  mainCode);
await writeFile('node_modules/sibling-cli/bin/sibling-cli', binCode);
await writeFile('node_modules/.bin/sibling-cli', installerShim);

// Verify all four files are on disk, each by its own absolute path.
const FILES = [
  '/home/user/g3-probe/node_modules/sibling-cli/lib/inner.js',
  '/home/user/g3-probe/node_modules/sibling-cli/lib/main.js',
  '/home/user/g3-probe/node_modules/sibling-cli/bin/sibling-cli',
  '/home/user/g3-probe/node_modules/.bin/sibling-cli',
];
const lsResult = await t.run(
  `node -e "var f=require('fs'); console.log('EXISTS ' + JSON.stringify(${JSON.stringify(FILES).replaceAll('"', "'")}.map(function (p) { return [p, f.statSync(p, { throwIfNoEntry: false })?.isFile() === true]; })))"`,
  30_000,
);
const lsOut = stripAnsi(lsResult.output);
const existsLine = /^EXISTS (\[.*\])\r?$/m.exec(lsOut);
const exists = existsLine ? new Map(JSON.parse(existsLine[1])) : new Map();
const allExist = FILES.every((file) => exists.get(file) === true);

// Run via .bin shim.
const r = await t.run('sibling-cli', 60_000);
const rOut = stripAnsi(r.output);
const ok = /^SIBLING-OK:INNER-PRESENT\r?$/m.test(rOut);

await t.close();

const findings = {
  gap: 'G3',
  sid,
  base: BASE,
  setup: { allFilesPresent: allExist, exists: Object.fromEntries(exists), lsOut: lsOut.slice(-300) },
  binRun: { ok, tail: rOut.slice(-500) },
};
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ...FILES.map((file) => [`${file} is a file on the VFS`, exists.get(file) === true]),
  ['bin run produces SIBLING-OK:INNER-PRESENT', ok],
];
let pass = 0;
for (const [name, ok] of checks) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); if (ok) pass++; }
const verdict = pass === checks.length ? 'passing' : 'failing';
console.log(`[G3] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'passing' ? 0 : 1);
