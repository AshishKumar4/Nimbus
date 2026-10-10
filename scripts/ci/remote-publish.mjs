#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapOnArmada } from './lib/armada.mjs';
import { PUBLISH_ARTIFACTS } from './lib/state-dir.mjs';
import { verifiedPublishArtifacts } from './lib/publish-artifacts.mjs';

const argv = process.argv.slice(2);
if (argv.length > 1 || argv.some((arg) => arg.startsWith('--'))) {
  console.error('usage: bun scripts/ci/remote-publish.mjs [<commit>]');
  process.exit(2);
}
const git = (args) => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return result.stdout.trim();
};
try {
  const repo = git(['rev-parse', '--show-toplevel']);
  const sha = git(['rev-parse', '--verify', `${argv[0] ?? 'HEAD'}^{commit}`]);
  const mapped = await mapOnArmada({ repo, sha, files: ['scripts/ci/publish-pack.mjs', 'scripts/ci/lib/publish-packages.mjs', 'scripts/ci/lib/publish-tarballs.mjs', 'scripts/ci/lib/step.mjs', 'scripts/check-published.mjs'], items: [1], command: ['bun', 'scripts/ci/publish-pack.mjs', '--out', '{out}'], label: `publish-pack ${sha.slice(0, 12)}` });
  const outcome = mapped.outcomes[0];
  if (outcome?.kind !== 'exited' || mapped.outputs[0] === null) throw new Error(`armada publish packing was not graded (${mapped.jobId}): ${outcome?.tail ?? 'no outcome'}`);
  const result = JSON.parse(mapped.outputs[0]);
  if (result.head !== mapped.commit) throw new Error('publish artifact provenance does not match the requested commit');
  const dir = join(PUBLISH_ARTIFACTS, sha);
  mkdirSync(dir, { recursive: true });
  const manifest = { commit: sha, job: mapped.jobId, rows: result.rows, tarballs: [] };
  for (const row of result.rows) console.error(`${row.exitCode === 0 ? 'ok' : 'FAIL'} ${row.name}: ${row.exitCode}${row.exitCode ? '\n' + row.output : ''}`);
  if (outcome.exitCode !== 0 || result.rows.some((row) => row.exitCode !== 0)) {
    writeFileSync(join(dir, 'publish-verdict.json'), JSON.stringify(manifest, null, 2) + '\n');
    process.exit(1);
  }
  for (const artifact of result.tarballs) {
    if (!/^[A-Za-z0-9._-]+\.tgz$/.test(artifact.file)) throw new Error('publish artifact has an unsafe filename');
    const bytes = Buffer.from(artifact.base64, 'base64');
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256 || bytes.length !== artifact.bytes) throw new Error(`${artifact.file} did not arrive intact`);
    writeFileSync(join(dir, artifact.file), bytes);
    const { base64, ...receipt } = artifact;
    manifest.tarballs.push(receipt);
  }
  verifiedPublishArtifacts(repo, dir, sha, manifest);
  writeFileSync(join(dir, 'publish.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ dir, manifest: join(dir, 'publish.json'), tarballs: manifest.tarballs }));
} catch (error) {
  console.error(`remote-publish: NOT GRADED — ${error.message}`);
  process.exit(2);
}
