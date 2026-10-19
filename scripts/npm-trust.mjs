#!/usr/bin/env bun
// Links every package Nimbus publishes to the publish workflow, by npm
// trusted publishing: npm then accepts a publish from
// .github/workflows/publish.yml in AshishKumar4/Nimbus, in its `npm`
// environment, and from nowhere else that holds no token. First it makes
// that GitHub environment one only npm/* tags may deploy from (gh, as a
// repository admin), so no other ref can publish even with the workflow
// edited. Run it once, by hand, in a terminal: `npm trust` asks for the
// account's 2FA (npm's page offers five minutes without it, which lets the
// rest through). It needs npm 11.15.0 or later. What is already set up is
// left as it is, so it is safe to run again.
//
//   bun scripts/npm-trust.mjs
//
// The packages are the ones the release publishes (publish-packages.mjs and
// runtime-specs.mjs), never a list kept here. A package npm does not have
// yet cannot be linked; its first publish is by hand, then run this again.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { npmRuntimeSpecs } from '../packages/worker/scripts/runtime-specs.mjs';
import { publishPackages } from './ci/lib/publish-packages.mjs';

const REPO = 'AshishKumar4/Nimbus';
const WORKFLOW = 'publish.yml';
const ENVIRONMENT = 'npm';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('npm-trust: run this in a terminal; npm asks for the account\'s 2FA');
  process.exit(2);
}
const npmVersion = spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim();
const [major, minor] = npmVersion.split('.').map(Number);
if (!(major > 11 || (major === 11 && minor >= 15))) {
  console.error(`npm-trust: npm ${npmVersion || '(none)'} has no \`npm trust\`; install 11.15.0 or later: npm install -g npm@^11.15.0`);
  process.exit(2);
}

// The environment, and the one tag pattern that may deploy from it.
const gh = (args) => spawnSync('gh', ['api', ...args], { encoding: 'utf8' });
const made = gh(['-X', 'PUT', `repos/${REPO}/environments/${ENVIRONMENT}`, '-F', 'deployment_branch_policy[protected_branches]=false', '-F', 'deployment_branch_policy[custom_branch_policies]=true']);
if (made.status !== 0) {
  console.error(`npm-trust: the GitHub environment ${ENVIRONMENT} was not set up (${(made.stderr || made.error?.message || '').trim()}); run this with gh signed in as a repository admin`);
  process.exit(2);
}
const policies = gh([`repos/${REPO}/environments/${ENVIRONMENT}/deployment-branch-policies`]);
if (policies.status !== 0 || !JSON.parse(policies.stdout).branch_policies.some((policy) => policy.name === 'npm/*' && policy.type === 'tag')) {
  const added = gh(['-X', 'POST', `repos/${REPO}/environments/${ENVIRONMENT}/deployment-branch-policies`, '-f', 'name=npm/*', '-f', 'type=tag']);
  if (added.status !== 0) {
    console.error(`npm-trust: npm/* tags were not allowed to deploy from ${ENVIRONMENT} (${added.stderr.trim()})`);
    process.exit(2);
  }
}
console.log(`environment ${ENVIRONMENT}: only npm/* tags deploy from it`);

const root = fileURLToPath(new URL('../', import.meta.url));
const names = [...npmRuntimeSpecs().map(({ name }) => name), ...publishPackages(root).map(({ name }) => name)];
const missing = [];
let failed = 0;
for (const name of names) {
  const held = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, { method: 'HEAD' });
  if (held.status === 404) {
    missing.push(name);
    continue;
  }
  const listed = spawnSync('npm', ['trust', 'list', name, '--json'], { encoding: 'utf8' });
  if (listed.status === 0 && listed.stdout.includes(REPO) && listed.stdout.includes(WORKFLOW)) {
    console.log(`linked   ${name}`);
    continue;
  }
  console.log(`linking  ${name}`);
  const linked = spawnSync('npm', ['trust', 'github', name, '--file', WORKFLOW, '--repo', REPO, '--env', ENVIRONMENT, '--allow-publish', '--yes'], { stdio: 'inherit' });
  if (linked.status !== 0) failed++;
}
for (const name of missing) console.log(`MISSING  ${name}: npm has no such package yet. Publish its first version by hand (npm publish --access public), then run this again.`);
if (failed > 0) console.error(`npm-trust: ${failed} package(s) not linked; run it again once npm says why`);
process.exit(failed > 0 || missing.length > 0 ? 1 : 0);
