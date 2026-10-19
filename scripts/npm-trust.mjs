#!/usr/bin/env bun
// Links every package Nimbus publishes to the publish workflow, by npm
// trusted publishing: npm then accepts a publish from
// .github/workflows/publish.yml in AshishKumar4/Nimbus, in its `npm`
// environment, and from nowhere else that holds no token. First it makes
// that GitHub environment one only npm/* tags may deploy from (gh, as a
// repository admin), so no other ref can publish even with the workflow
// edited. Run it once, by hand, in a terminal: `npm trust` asks for the
// account's 2FA (npm's page offers five minutes without it, which lets the
// rest through). It needs npm 11.15.0 or later. What is already set up as
// described is left as it is, so it is safe to run again; anything set up
// otherwise (another deploy rule, another trust) is named, with its fix.
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

const refuse = (why) => {
  console.error(`npm-trust: ${why}`);
  process.exit(2);
};

if (!process.stdin.isTTY || !process.stdout.isTTY) refuse('run this in a terminal; npm asks for the account\'s 2FA');
const npmVersion = spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim();
const [major, minor] = npmVersion.split('.').map(Number);
if (!(major > 11 || (major === 11 && minor >= 15))) refuse(`npm ${npmVersion || '(none)'} has no \`npm trust\`; install 11.15.0 or later: npm install -g npm@^11.15.0`);

// The environment, and exactly one rule for what may deploy from it: npm/*
// tags. Any other rule would let that ref publish; it is named, not removed.
const gh = (args) => spawnSync('gh', ['api', ...args], { encoding: 'utf8' });
const environment = `repos/${REPO}/environments/${ENVIRONMENT}`;
const made = gh(['-X', 'PUT', environment, '-F', 'deployment_branch_policy[protected_branches]=false', '-F', 'deployment_branch_policy[custom_branch_policies]=true']);
if (made.status !== 0) refuse(`the GitHub environment ${ENVIRONMENT} was not set up (${(made.stderr || made.error?.message || '').trim()}); run this with gh signed in as a repository admin`);
const read = gh(['--paginate', '--slurp', `${environment}/deployment-branch-policies`]);
if (read.status !== 0) refuse(`the rules of the GitHub environment ${ENVIRONMENT} could not be read (${(read.stderr || read.error?.message || '').trim()})`);
const rules = JSON.parse(read.stdout).flatMap((page) => page.branch_policies);
const others = rules.filter((rule) => rule.name !== 'npm/*' || rule.type !== 'tag');
if (others.length > 0) {
  refuse(`the GitHub environment ${ENVIRONMENT} also lets ${others.map((rule) => `${rule.type} ${rule.name}`).join(', ')} deploy, and so publish. `
    + `Remove each, then run this again: ${others.map((rule) => `gh api -X DELETE ${environment}/deployment-branch-policies/${rule.id}`).join('; ')}`);
}
if (rules.length === 0) {
  const added = gh(['-X', 'POST', `${environment}/deployment-branch-policies`, '-f', 'name=npm/*', '-f', 'type=tag']);
  if (added.status !== 0) refuse(`npm/* tags were not allowed to deploy from ${ENVIRONMENT} (${added.stderr.trim()})`);
}
console.log(`environment ${ENVIRONMENT}: only npm/* tags deploy from it`);

/**
 * npm's trust configuration of `name` (one per package), as `npm trust list
 * --json` prints it: null for none. npm asks for 2FA only with a terminal on
 * both ends, so a read it refuses for 2FA is asked once more at the terminal;
 * the 5 minutes without 2FA npm's page offers then let the captured read
 * through. Throws when it cannot be read.
 */
function trustOf(name) {
  const list = () => spawnSync('npm', ['trust', 'list', name, '--json'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
  let listed = list();
  if (listed.status !== 0 && /EOTP|one-time pass/.test(listed.stderr)) {
    spawnSync('npm', ['trust', 'list', name], { stdio: 'inherit' });
    listed = list();
  }
  if (listed.status !== 0) throw new Error(`npm trust list ${name} exited ${listed.status}: ${listed.stderr.trim().split('\n').at(-1)}`);
  const text = listed.stdout.trim();
  return text === '' ? null : JSON.parse(text);
}

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
  let trust;
  try {
    trust = trustOf(name);
  } catch (error) {
    console.error(`FAILED   ${name}: its trust configuration could not be read (${error.message})`);
    failed++;
    continue;
  }
  if (trust !== null) {
    const ours = trust.type === 'github' && trust.repository === REPO && trust.file === WORKFLOW && trust.environment === ENVIRONMENT
      && Array.isArray(trust.permissions) && trust.permissions.includes('createPackage');
    if (ours) {
      console.log(`linked   ${name}`);
    } else {
      console.error(`OTHER    ${name}: npm trusts ${JSON.stringify(trust)}, not ${REPO}'s ${WORKFLOW} in ${ENVIRONMENT} with publish. `
        + `npm keeps one per package: npm trust revoke ${name} --id=${trust.id}, then run this again`);
      failed++;
    }
    continue;
  }
  console.log(`linking  ${name}`);
  const linked = spawnSync('npm', ['trust', 'github', name, '--file', WORKFLOW, '--repo', REPO, '--env', ENVIRONMENT, '--allow-publish', '--yes'], { stdio: 'inherit' });
  if (linked.status !== 0) failed++;
}
for (const name of missing) console.log(`MISSING  ${name}: npm has no such package yet. Publish its first version by hand (npm publish --access public), then run this again.`);
if (failed > 0) console.error(`npm-trust: ${failed} package(s) not linked to the workflow; run it again once each is fixed`);
process.exit(failed > 0 || missing.length > 0 ? 1 : 0);
