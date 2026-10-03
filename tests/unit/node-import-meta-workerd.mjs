// @serial
// ES module entry metadata must name the VFS file, just as Node names its
// file. sv 1.0 searches for its package.json from import.meta.dirname; a
// launch with no package.json in its cwd must still find the CLI's package.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const W = '/home/user/import-meta-proof';
const PACKAGE = 'node_modules/fixture-cli';
const SOURCE = [
  'import fs from "node:fs";',
  'import path from "node:path";',
  'import { fileURLToPath } from "node:url";',
  'const root = process.argv[2];',
  'const normalize = (v) => typeof v === "string" ? v.replace(root, "<root>") : null;',
  'const meta = import.meta;',
  'const { dirname: extractedDirname, filename: extractedFilename } = import.meta;',
  'console.log("RAW dirname=" + String(import.meta.dirname) + " type=" + typeof import.meta.dirname);',
  'console.log("META " + JSON.stringify({',
  '  dirname: normalize(import.meta.dirname), filename: normalize(import.meta.filename),',
  '  url: normalize(import.meta.url), objectDirname: normalize(meta.dirname),',
  '  extractedDirname: normalize(extractedDirname), extractedFilename: normalize(extractedFilename),',
  '  bracketDirname: normalize(import.meta["dirname"]),',
  '}));',
  // This is empathic's upwards package search (bundled into sv), reduced to
  // the relevant dependency: an absent cwd defaults to process.cwd().
  'const start = process.argv[3] === "derived" ? path.dirname(fileURLToPath(import.meta.url)) : import.meta.dirname;',
  'let dir = path.resolve(start || ".");',
  'let found;',
  'for (;;) {',
  '  const candidate = path.join(dir, "package.json");',
  '  if (fs.existsSync(candidate)) { found = candidate; break; }',
  '  const parent = path.dirname(dir);',
  '  if (parent === dir) break;',
  '  dir = parent;',
  '}',
  'console.log("PACKAGE " + JSON.stringify(normalize(found)));',
  'if (!found) throw new Error("Could not locate the `package.json` of `sv`");',
].join('\n');
const FILES = {
  [`${PACKAGE}/package.json`]: '{"name":"fixture-cli","type":"module","version":"1.0.0"}',
  [`${PACKAGE}/dist/bin.mjs`]: SOURCE,
  'load.cjs': 'import("./node_modules/fixture-cli/dist/bin.mjs");',
};
const hostRoot = mkdtempSync(join(tmpdir(), 'node-import-meta-host-'));
for (const [name, source] of Object.entries(FILES)) {
  mkdirSync(dirname(join(hostRoot, name)), { recursive: true });
  writeFileSync(join(hostRoot, name), source);
}
const line = (stdout, prefix) => stdout.split(/\r?\n/).find((value) => value.startsWith(`${prefix} `));
const hostRun = (file, mode = 'native') => {
  const run = spawnSync('node', [join(hostRoot, file), hostRoot, mode], { cwd: hostRoot, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run;
};
const probe = await startLocalProbe({ runtimes: [] });
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const payload = Buffer.from(JSON.stringify(FILES)).toString('base64');
    const setup = await terminal.run(
      `mkdir -p ${W}/${PACKAGE}/dist && node -e "const f=JSON.parse(Buffer.from('${payload}','base64').toString());for(const [n,t] of Object.entries(f))require('fs').writeFileSync('${W}/'+n,t);console.log('SETUP')"`,
    );
    assert.equal(setup.status, 0, setup.stdout);
    assert.match(setup.stdout, /^SETUP$/m);
    const entry = `${PACKAGE}/dist/bin.mjs`;
    const nativeHost = hostRun(entry);
    const nativeGuest = await terminal.run(`cd ${W} && node ${entry} ${W}`);
    console.log('NODE ENTRY ' + line(nativeHost.stdout, 'RAW'));
    console.log('NIMBUS ENTRY ' + line(nativeGuest.stdout, 'RAW'));
    console.log('NODE ENTRY ' + line(nativeHost.stdout, 'META'));
    console.log('NIMBUS ENTRY ' + line(nativeGuest.stdout, 'META'));
    console.log('NODE ENTRY ' + line(nativeHost.stdout, 'PACKAGE'));
    console.log('NIMBUS ENTRY ' + line(nativeGuest.stdout, 'PACKAGE'));
    console.log('NIMBUS ENTRY STATUS ' + nativeGuest.status);
    const error = nativeGuest.stdout.split(/\r?\n/).find((value) => value.includes('Could not locate'));
    if (error) console.log('NIMBUS ENTRY ' + error);

    // A cause-removal control: deriving the same dirname from the URL makes
    // the identical package walk green before changing any product code.
    const derivedHost = hostRun(entry, 'derived');
    const derivedGuest = await terminal.run(`cd ${W} && node ${entry} ${W} derived`);
    assert.equal(derivedGuest.status, 0, derivedGuest.stdout);
    assert.equal(line(derivedGuest.stdout, 'PACKAGE'), line(derivedHost.stdout, 'PACKAGE'));
    console.log('DERIVED DIRNAME CONTROL PASS ' + line(derivedGuest.stdout, 'PACKAGE'));

    // A reusable module already has correct evaluation metadata. Pin that
    // boundary too: the entry and a dependency must answer alike.
    const dependencyHost = hostRun('load.cjs');
    const dependencyGuest = await terminal.run(`cd ${W} && node load.cjs ${W}`);
    assert.equal(dependencyGuest.status, 0, dependencyGuest.stdout);
    assert.equal(line(dependencyGuest.stdout, 'META'), line(dependencyHost.stdout, 'META'));
    assert.equal(line(dependencyGuest.stdout, 'PACKAGE'), line(dependencyHost.stdout, 'PACKAGE'));
    console.log('DEPENDENCY METADATA CONTROL PASS ' + line(dependencyGuest.stdout, 'META'));

    assert.equal(line(nativeGuest.stdout, 'META'), line(nativeHost.stdout, 'META'), 'ES module entry import.meta matches real Node');
    assert.equal(line(nativeGuest.stdout, 'PACKAGE'), line(nativeHost.stdout, 'PACKAGE'), 'entry dirname locates its own package from a package-free cwd');
    assert.equal(nativeGuest.status, nativeHost.status, nativeGuest.stdout);
  } finally {
    await terminal.close();
  }
} finally {
  await probe.stop();
  rmSync(hostRoot, { recursive: true, force: true });
}
console.log('node-import-meta-workerd: entry and dependency metadata match real Node');
