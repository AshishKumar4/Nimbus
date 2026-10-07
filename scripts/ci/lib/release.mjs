// A commit's deploy bundles: built on CI (scripts/ci/bundle.mjs), kept on
// this machine as a release, and uploaded from here as built. Every deploy
// that leaves this machine goes through here: a throwaway
// (remote-probes.mjs --deploy), staging (release.mjs staging) and
// production (promote.mjs), so each uploads exactly the bytes CI built, and
// production the bytes staging verified.
//
// A release is a directory under ~/.local/state/nimbus/releases/, named by
// commit and job, holding each target's module, the docs build of an app
// that has assets, and release.json: { commit, job, bundles: { "<app>[:<env>]":
// { main, sha256, file } }, assets: { "<app>": { manifest, docs: { sha256,
// file } } } }. release.mjs adds staged.json when staging verified it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { loadConfig } from '../../deploy-isolation.mjs';
import { filesUnder } from '../../lib/fs-walk.mjs';
import { mapOnArmada } from './armada.mjs';

export const RELEASES = join(homedir(), '.local', 'state', 'nimbus', 'releases');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const slug = (name) => name.replace(/[/:]/g, '-');
const git = (cwd, args) => {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || '').trim()}`);
  return done.stdout.trim();
};

/**
 * Build `targets` ("<app>[:<env>]") of `sha` on armada and keep them as a
 * release. Resolves to { dir, release }; throws, with the red rows, when
 * nothing usable was built.
 *
 * @param {{ repo: string, sha: string, targets: string[], log?: (line: string) => void }} options
 */
export async function fetchRelease({ repo, sha, targets, log = (line) => console.error(line) }) {
  const mapped = await mapOnArmada({
    repo, sha, files: ['scripts/ci/bundle.mjs'], items: [1], label: `bundle ${sha.slice(0, 12)} ${targets.join(' ')}`, log,
    command: ['bun', 'scripts/ci/bundle.mjs', '--out', '{out}', ...targets.flatMap((target) => ['--target', target])],
  });
  const [outcome] = mapped.outcomes;
  if (outcome?.kind !== 'exited' || mapped.outputs[0] === null) throw new Error(`armada could not bundle ${sha.slice(0, 12)} (job ${mapped.jobId}):\n${outcome?.tail ?? 'no outcome'}`);
  const verdict = JSON.parse(mapped.outputs[0]);
  if (verdict.head !== mapped.commit) throw new Error(`the bundles are of ${verdict.head}, not ${mapped.commit} (job ${mapped.jobId})`);
  const red = verdict.rows.filter((row) => row.exitCode !== 0);
  if (red.length > 0 || targets.some((target) => !verdict.bundles[target])) {
    throw new Error(`no release (job ${mapped.jobId}):\n${red.map((row) => `${row.name} exit ${row.exitCode}\n${row.output.trimEnd().split('\n').slice(-40).join('\n')}`).join('\n')}`);
  }
  const dir = join(RELEASES, `${sha.slice(0, 12)}-${mapped.jobId}`);
  mkdirSync(dir, { recursive: true });
  const release = { commit: sha, job: mapped.jobId, bundles: {}, assets: {} };
  for (const [target, bundle] of Object.entries(verdict.bundles)) {
    const bytes = Buffer.from(bundle.base64, 'base64');
    if (sha256(bytes) !== bundle.sha256) throw new Error(`${target}'s module did not arrive intact (job ${mapped.jobId})`);
    const file = join(slug(target), bundle.main);
    mkdirSync(join(dir, slug(target)), { recursive: true });
    writeFileSync(join(dir, file), bytes);
    release.bundles[target] = { main: bundle.main, sha256: bundle.sha256, file };
  }
  for (const [app, { manifest, docs }] of Object.entries(verdict.assets)) {
    const bytes = Buffer.from(docs.base64, 'base64');
    if (sha256(bytes) !== docs.sha256) throw new Error(`${app}'s docs build did not arrive intact (job ${mapped.jobId})`);
    const file = `${slug(app)}-docs.tar`;
    writeFileSync(join(dir, file), bytes);
    release.assets[app] = { manifest, docs: { sha256: docs.sha256, file } };
  }
  writeFileSync(join(dir, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  log(`release: ${Object.entries(release.bundles).map(([target, bundle]) => `${target} ${bundle.sha256.slice(0, 16)}…`).join(', ')} (job ${mapped.jobId}) in ${dir}`);
  return { dir, release };
}

/** The release in `dir`. */
export function readRelease(dir) {
  return JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8'));
}

/**
 * A wrangler config that uploads `target`'s module from the release in
 * `dir` as built, with the app's own settings (its env blocks included)
 * otherwise; returns its path. Refused unless the release is of `root`'s
 * HEAD, what the upload reads from the checkout (the app and the worker's
 * public assets) is as HEAD has it, the module is the bytes CI built, and,
 * for an app whose assets CI built, the assembled assets are the files CI
 * built, byte for byte. `preview`: for `wrangler preview`, which must not
 * define differently from the `wrangler deploy` that built the module.
 *
 * @param {string} dir
 * @param {string} target
 * @param {{ root: string, preview?: boolean, log?: (line: string) => void }} options
 */
export function uploadConfig(dir, target, { root, preview = false, log = (line) => console.error(line) }) {
  const release = readRelease(dir);
  const [app] = target.split(':');
  const head = git(root, ['rev-parse', 'HEAD']);
  if (release.commit !== head) throw new Error(`the release in ${dir} is of ${release.commit}, and this checkout is at ${head}`);
  const bundle = release.bundles[target];
  if (!bundle) throw new Error(`the release in ${dir} has no ${target}`);
  const local = git(root, ['status', '--porcelain', '--untracked-files=all', '--', app, 'packages/worker/public']);
  if (local) throw new Error(`the upload reads these from the checkout, and they differ from ${head}:\n${local}`);
  const main = join(dir, bundle.file);
  const actual = sha256(readFileSync(main));
  if (actual !== bundle.sha256) throw new Error(`${main} is not the module CI built (sha256 ${actual}, not ${bundle.sha256})`);
  const config = loadConfig(`${app}/wrangler.jsonc`, root);
  if (preview && JSON.stringify(config.previews?.define) !== JSON.stringify(config.define)) {
    throw new Error(`${app} defines differently for a Preview than for the deploy that built the module; it cannot be uploaded as built`);
  }
  const assets = release.assets[app] ? assemble(dir, app, release.assets[app], root) : resolve(root, app, config.assets.directory);
  const { $schema, alias, ...settings } = config;
  const path = join(dir, `${slug(target)}.wrangler.json`);
  writeFileSync(path, JSON.stringify({ ...settings, main, no_bundle: true, assets: { ...settings.assets, directory: assets } }, null, 2));
  log(`uploading ${target}'s ${bundle.main} as CI built it for ${head.slice(0, 12)} (sha256 ${bundle.sha256.slice(0, 16)}…), without bundling`);
  return path;
}

/**
 * Assemble `app`'s assets with CI's docs build (build-assets.mjs --docs,
 * which copies and builds nothing), and require every file to be the one CI
 * built. Returns the directory.
 */
function assemble(dir, app, { manifest, docs }, root) {
  const tar = join(dir, docs.file);
  if (sha256(readFileSync(tar)) !== docs.sha256) throw new Error(`${tar} is not the docs build CI made`);
  const unpacked = join(dir, `${slug(app)}-docs`);
  rmSync(unpacked, { recursive: true, force: true });
  mkdirSync(unpacked, { recursive: true });
  const untar = spawnSync('tar', ['-xf', tar, '-C', unpacked], { encoding: 'utf8' });
  if (untar.status !== 0) throw new Error(`could not unpack ${tar}: ${untar.stderr}`);
  const built = spawnSync('bun', ['run', '--cwd', app, 'build:assets', '--docs', unpacked], { cwd: root, encoding: 'utf8' });
  if (built.status !== 0) throw new Error(`could not assemble ${app}'s assets: ${built.stderr || built.stdout}`);
  const directory = join(root, app, 'dist', 'assets');
  const here = Object.fromEntries(filesUnder(directory).map((path) => [path, sha256(readFileSync(join(directory, path)))]));
  const differ = [...new Set([...Object.keys(here), ...Object.keys(manifest)])].filter((path) => here[path] !== manifest[path]).sort();
  if (differ.length > 0) throw new Error(`${app}'s assets here are not the ones CI built: ${differ.slice(0, 10).join(', ')}${differ.length > 10 ? `, and ${differ.length - 10} more` : ''}`);
  return isAbsolute(directory) ? directory : resolve(directory);
}
