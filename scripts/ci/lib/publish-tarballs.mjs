// Prepare archives once. The immutable-version check and signing use these
// same files; only package.json formatting is ignored in content comparison.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filesUnder, sha256Hex } from '../../lib/fs-walk.mjs';

export function prepareTarball(dir, into) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', into],
    { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (packed.status !== 0) throw new Error(`npm pack ${pkg.name}: ${packed.stderr || packed.stdout}`);
  const receipts = JSON.parse(packed.stdout);
  if (receipts.length !== 1 || !/^[A-Za-z0-9._-]+\.tgz$/.test(receipts[0].filename)) throw new Error(`npm pack ${pkg.name} returned an invalid archive receipt`);
  const file = receipts[0].filename;
  const path = join(into, file);
  const bytes = readFileSync(path);
  const hash = (algorithm, encoding) => createHash(algorithm).update(bytes).digest(encoding);
  return { name: pkg.name, version: pkg.version, file, path, bytes: bytes.length,
    sha256: hash('sha256', 'hex'), shasum: hash('sha1', 'hex'), integrity: 'sha512-' + hash('sha512', 'base64'),
    base64: bytes.toString('base64') };
}

function unpack(tarball, into) {
  mkdirSync(into);
  execFileSync('tar', ['-xzf', tarball, '-C', into], { stdio: ['ignore', 'pipe', 'inherit'], timeout: 300_000 });
  const dir = join(into, 'package');
  const digests = new Map(filesUnder(dir).map(path => [path, sha256Hex(readFileSync(join(dir, path)))]));
  digests.set('package.json', JSON.stringify(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))));
  return digests;
}

export async function verifyPublishedTarballs(prepared, { registry = 'https://registry.npmjs.org', fetch: request = globalThis.fetch, log = console.log } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'nimbus-check-published-'));
  const stale = [];
  try {
    for (const [index, pkg] of prepared.entries()) {
      if (sha256Hex(readFileSync(pkg.path)) !== pkg.sha256) throw new Error(`${pkg.name}: prepared tarball changed after packing`);
      const answer = await request(`${registry}/${pkg.name.replace('/', '%2f')}/${pkg.version}`);
      if (answer.status === 404) { log(`new       ${pkg.name}@${pkg.version}`); continue; }
      if (!answer.ok) throw new Error(`${pkg.name}@${pkg.version}: the registry answered ${answer.status}`);
      const { dist } = await answer.json();
      const archive = await request(dist.tarball);
      if (!archive.ok) throw new Error(`${pkg.name}@${pkg.version}: the registry tarball answered ${archive.status}`);
      const publicPath = join(work, `${index}.tgz`);
      writeFileSync(publicPath, new Uint8Array(await archive.arrayBuffer()));
      const published = unpack(publicPath, join(work, `${index}-published`));
      const packed = unpack(pkg.path, join(work, `${index}-prepared`));
      const changed = [...new Set([...published.keys(), ...packed.keys()])]
        .filter(path => published.get(path) !== packed.get(path)).sort();
      if (!changed.length) { log(`published ${pkg.name}@${pkg.version} (unchanged)`); continue; }
      stale.push(pkg.name);
      log(`CHANGED   ${pkg.name}@${pkg.version} differs from what npm holds for that version; bump its version:`);
      for (const path of changed.slice(0, 20)) log(`            ${!published.has(path) ? '+' : !packed.has(path) ? '-' : '~'} ${path}`);
      if (changed.length > 20) log(`            ... and ${changed.length - 20} more`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (stale.length) throw new Error(`refusing: ${stale.join(', ')} changed since their version was published. Bump each, move the ranges that need the change, then publish.`);
  log('every package npm already holds packs to what it holds');
}
