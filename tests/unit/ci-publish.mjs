#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishPackages } from '../../scripts/ci/lib/publish-packages.mjs';

const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const root = mkdtempSync(join(tmpdir(), 'nimbus-publish-test-'));
const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex');
const receipt = (name, version) => {
  const bytes = Buffer.from(name + '@' + version);
  return { name, version, file: name.replace(/^@/, '').replaceAll('/', '-') + '-' + version + '.tgz', sha256: hash('sha256', bytes), shasum: hash('sha1', bytes), integrity: 'sha512-' + hash('sha512', bytes), bytes: bytes.length, data: [...bytes] };
};
const runtime = receipt('@nimbus-sh/runtime-cpython', '3.13.14-1');
const packages = publishPackages(repo).map((pkg) => receipt(pkg.name, pkg.version));

try {
  const published = publishPackages(repo);
  assert.equal(published.length, 10);
  assert.ok(published.some((pkg) => pkg.name === 'create-nimbus-app'), 'the version guard includes the published create helper');
  const index = new Map(published.map((pkg, index) => [pkg.name, index]));
  for (const pkg of published) for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })) {
    if (index.has(dep)) assert.ok(index.get(dep) < index.get(pkg.name), `${pkg.name} follows its published dependency ${dep}`);
  }

  const bin = join(root, 'bin');
  mkdirSync(bin);
  const stateFile = join(root, 'state.json');
  const logFile = join(root, 'calls.jsonl');
  const fixture = join(root, 'fixture.json');
  writeFileSync(fixture, JSON.stringify({ runtime, packages }));
  const program = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args=process.argv.slice(2), cmd=path.basename(process.argv[1]);
const s=JSON.parse(fs.readFileSync(process.env.PUBLISH_STATE,'utf8'));
const f=JSON.parse(fs.readFileSync(process.env.PUBLISH_FIXTURE,'utf8'));
fs.appendFileSync(process.env.PUBLISH_LOG,JSON.stringify({cmd,args,callerStdin:fs.fstatSync(0).isFIFO()})+'\\n');
const save=()=>fs.writeFileSync(process.env.PUBLISH_STATE,JSON.stringify(s));
if(cmd==='bun') {
  if(s.failGate) {console.error('FAIL runtime-packages');process.exit(1);}
  const dir=path.join(process.env.NIMBUS_PUBLISH_ARTIFACTS,args[1]);fs.mkdirSync(dir,{recursive:true});
  const rows=[f.runtime,...f.packages];
  for(const p of rows) fs.writeFileSync(path.join(dir,p.file),Buffer.from(p.data));
  if(s.corrupt) fs.appendFileSync(path.join(dir,rows[0].file),'changed');
  fs.writeFileSync(path.join(dir,'publish.json'),JSON.stringify({commit:args[1],job:'fixture-job',rows:[{exitCode:0}],tarballs:rows}));process.exit(0);
}
if(args[0]==='view') {
  if(args.includes('dist-tags.latest')) {console.log(s.latest||'3.13.14');process.exit(0);}
  const p=[f.runtime,...f.packages].find(p=>args.includes(p.name+'@'+p.version));
  if(!p||!s.done.includes(p.name)) {console.log(JSON.stringify({error:{code:'E404'}}));process.exit(1);}
  console.log(JSON.stringify({shasum:s.wrong?'0'.repeat(40):p.shasum,integrity:p.integrity}));process.exit(0);
}
if(args[0]==='publish') {
  const p=[f.runtime,...f.packages].find(p=>args.includes(path.join(process.env.NIMBUS_PUBLISH_ARTIFACTS,'${sha}',p.file)));
  if(!p) throw new Error('unexpected publish');s.done.push(p.name);if(p===f.runtime)s.latest=p.version;save();process.exit(0);
}
if(args[0]==='dist-tag') {s.latest=f.runtime.version;save();process.exit(0);}
throw new Error('unexpected npm command '+args.join(' '));
`;
  for (const command of ['bun', 'npm']) { writeFileSync(join(bin, command), program); chmodSync(join(bin, command), 0o700); }
  const run = (override = true) => {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NIMBUS_PUBLISH_ARTIFACTS: join(root, 'artifacts'), PUBLISH_STATE: stateFile, PUBLISH_FIXTURE: fixture, PUBLISH_LOG: logFile };
    if (override) env.NIMBUS_PUBLISH_REPO = repo;
    else delete env.NIMBUS_PUBLISH_REPO;
    return spawnSync('bash', [join(repo, 'scripts/publish-web.sh'), sha], { cwd: root, encoding: 'utf8', timeout: 20_000, env });
  };
  const calls = () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const set = (value) => { writeFileSync(stateFile, JSON.stringify({ done: [], ...value })); writeFileSync(logFile, ''); rmSync(join(root, 'artifacts'), { recursive: true, force: true }); };
  const prepared = () => {
    const dir = join(root, 'artifacts', sha);
    mkdirSync(dir, { recursive: true });
    for (const artifact of [runtime, ...packages]) writeFileSync(join(dir, artifact.file), Buffer.from(artifact.data));
    writeFileSync(join(dir, 'publish.json'), JSON.stringify({ commit: sha, job: 'fixture-job', rows: [{ exitCode: 0 }], tarballs: [runtime, ...packages] }));
  };

  set({});
  let result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const first = calls();
  const signing = first.filter((call) => call.cmd === 'npm' && call.args[0] === 'publish');
  assert.deepEqual(signing.map((call) => pathName(call.args[1])), [runtime.file, ...packages.map((pkg) => pkg.file)]);
  assert.ok(signing.every((call) => call.args.includes('--ignore-scripts') && call.args.includes('--auth-type=web') && call.args.includes('--access')));
  assert.ok(first.filter((call) => call.cmd === 'npm').every((call) => call.callerStdin), 'every npm call keeps the caller stdin; a TSV cannot replace its terminal');
  const runtimeSigned = first.indexOf(signing[0]);
  const nextSigned = first.indexOf(signing[1]);
  assert.ok(first.slice(runtimeSigned, nextSigned).some((call) => call.args.includes('dist-tags.latest')), 'public latest confirmation precedes signing anything after runtime');
  assert.equal(first.filter((call) => call.cmd === 'bun').length, 1, 'one remote pack produces the entire signing set');
  result = run(false);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already on npm, identical:/, 'script-relative checkout selection works from an unrelated cwd without a repo override');
  assert.equal(calls().filter((call) => call.cmd === 'npm' && call.args[0] === 'publish').length, 11, 'rerun skips all identical immutable versions');
  assert.equal(calls().filter((call) => call.cmd === 'bun').length, 1, 'rerun reuses the verified cache without contacting armada');

  set({}); prepared(); result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls().filter((call) => call.cmd === 'bun').length, 0, 'a prepacked commit is signing only');
  assert.ok(calls().filter((call) => call.cmd === 'npm').every((call) => call.callerStdin), 'all metadata, tag and publish calls keep caller stdin');

  set({ failGate: true });
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /STOP: armada publish gates failed/);
  assert.equal(calls().filter((call) => call.args[0] === 'publish').length, 0, 'every gate runs before the first signing');
  const state = JSON.parse(readFileSync(stateFile)); state.failGate = false; writeFileSync(stateFile, JSON.stringify(state));
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls().filter((call) => call.args[0] === 'publish' && pathName(call.args[1]) === runtime.file).length, 1, 'resume does not republish runtime');

  set({ done: [runtime.name, ...packages.map((pkg) => pkg.name)], latest: runtime.version }); prepared();
  const cachedFile = join(root, 'artifacts', sha, runtime.file);
  writeFileSync(cachedFile, 'corrupt cached tarball');
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls().filter((call) => call.cmd === 'bun').length, 1, 'a failed cache checksum requests one fresh pack');
  assert.equal(calls().filter((call) => call.args[0] === 'publish').length, 0, 'identical registry versions remain skipped after cache repair');

  for (const problem of [{ corrupt: true }, { wrong: true, done: [runtime.name], latest: runtime.version }]) {
    set(problem); result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /STOP:/);
    assert.equal(calls().filter((call) => call.args[0] === 'publish').length, 0, 'bad local sha or differing registry bytes cannot be signed');
  }
  console.log('ci-publish: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}

function pathName(file) { return file.slice(file.lastIndexOf('/') + 1); }
