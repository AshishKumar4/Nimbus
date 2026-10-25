#!/usr/bin/env bun
// Publishes what scripts/ci/publish-pack.mjs packed, in its order (the
// runtimes, then the packages in dependency order): each version npm does
// not have yet, tagged latest. It runs in the publish workflow
// (.github/workflows/publish.yml), where npm signs in with the workflow's
// OIDC token (npm trusted publishing) and adds provenance; nothing here holds
// a token.
//
//   bun scripts/ci/npm-publish.mjs --pack <publish-pack's out file> --tarballs <dir> [--dry-run]
//
// Every archive is checked against its receipt before anything is
// published. The first publish that fails stops the rest: a package after
// it may need it.
// Exit: 0, each version npm lacked was published (or, with --dry-run, would
// be); 1, a publish failed; 2, usage, or a pack that is not a green one.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const USAGE = 'usage: bun scripts/ci/npm-publish.mjs --pack <file> --tarballs <dir> [--dry-run]';
const REGISTRY = 'https://registry.npmjs.org';

/**
 * Publishes each of `tarballs` (publish-pack's receipts, archives in `dir`)
 * that `registry` does not hold, through `npm`. Answers what it did, in
 * order: each `{ name, version, published }`.
 */
export async function publishPacked({ tarballs, dir, dryRun = false, registry = REGISTRY, fetch: request = globalThis.fetch, npm = 'npm', log = console.log }) {
  for (const receipt of tarballs) {
    const bytes = readFileSync(join(dir, receipt.file));
    const hash = (algorithm, encoding) => createHash(algorithm).update(bytes).digest(encoding);
    if (bytes.length !== receipt.bytes || hash('sha256', 'hex') !== receipt.sha256 || `sha512-${hash('sha512', 'base64')}` !== receipt.integrity) {
      throw new Error(`${receipt.file} is not the archive publish-pack packed; nothing was published`);
    }
  }
  const done = [];
  for (const { name, version, file } of tarballs) {
    const path = join(dir, file);
    const held = await request(`${registry}/${name.replace('/', '%2f')}/${version}`);
    if (held.status !== 404 && !held.ok) throw new Error(`${name}@${version}: the registry answered ${held.status}`);
    if (held.ok) {
      log(`skip      ${name}@${version} (npm has it)`);
      done.push({ name, version, published: false });
      continue;
    }
    log(`${dryRun ? 'dry-run' : 'publish'}   ${name}@${version}`);
    const logs = mkdtempSync(join(tmpdir(), 'npm-publish-'));
    try {
      const run = spawnSync(npm, ['publish', path, '--tag', 'latest', '--access', 'public', ...(dryRun ? ['--dry-run'] : [])], { stdio: 'inherit', env: { ...process.env, npm_config_logs_dir: logs } });
      if (run.status !== 0) {
        const failed = `npm publish ${name}@${version} exited ${run.status ?? run.signal}; nothing after it was published`;
        throw new Error(dryRun ? failed : `${failed}. npm's OIDC sign-in: ${oidcLog(logs).join('; ') || 'not logged'}. `
          + 'If npm refused it, bun scripts/npm-trust.mjs checks the package\'s trust and remakes one that expired');
      }
    } finally {
      rmSync(logs, { recursive: true, force: true });
    }
    done.push({ name, version, published: !dryRun });
  }
  return done;
}

// npm answers a refused trusted-publisher sign-in only with the publish's
// E404; why it was refused is in its debug log alone, at level verbose.
function oidcLog(dir) {
  return readdirSync(dir).flatMap((file) => readFileSync(join(dir, file), 'utf8').split('\n'))
    .flatMap((line) => /^\d+ \w+ oidc (.+)$/.exec(line)?.[1] ?? []);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flags = { 'dry-run': false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') flags['dry-run'] = true;
    else if (['--pack', '--tarballs'].includes(args[i]) && args[i + 1] !== undefined) flags[args[i].slice(2)] = args[++i];
    else flags.wrong = args[i];
  }
  if (flags.wrong !== undefined || !flags.pack || !flags.tarballs) {
    console.error(USAGE);
    process.exit(2);
  }
  const pack = JSON.parse(readFileSync(flags.pack, 'utf8'));
  if (pack.rows.some((row) => row.exitCode !== 0) || pack.tarballs.length === 0) {
    console.error(`npm-publish: ${flags.pack} is not a green pack; nothing published`);
    process.exit(2);
  }
  try {
    await publishPacked({ tarballs: pack.tarballs, dir: flags.tarballs, dryRun: flags['dry-run'] });
  } catch (error) {
    console.error(`npm-publish: ${error.message}`);
    process.exit(1);
  }
}
