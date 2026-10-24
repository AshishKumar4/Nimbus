#!/usr/bin/env bun
// tests/behavioral/_deploy-target.mjs deployAndVerify, as staging and promote
// deploy a Worker: it reads the active version back until the platform
// serves the upload's own version (readBack, the one settle rule it shares
// with the throwaway's Previews), for the longer of the upload's own time and
// the slowest landing measured, and only then refuses. The platform can
// answer with the version before for a moment after the upload (2026-10-24,
// release 1023's staging: "Cloudflare serves b9a978ab-… but the deploy
// reported 70509b5f-…"). Here `wrangler` is a stand-in in a checkout of its
// own: its deploy takes UPLOAD_S and reports a new version, and its
// `deployments status` serves the version before until SWITCH_MS after the
// upload, then the new one, or never.
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');
const BEFORE = '11111111-1111-4111-8111-111111111111';
const UPLOADED = '22222222-2222-4222-8222-222222222222';
/** The stand-in upload's own time: longer than the slowest landing measured (1.488 s), so it is the window. */
const UPLOAD_S = 2;
/** When the platform switches, after the upload: inside its window, past the first read. */
const SWITCH_MS = 1_700;

const root = mkdtempSync(join(tmpdir(), 'deploy-read-back-'));
const checkout = join(root, 'checkout');
/** `dir` in the checkout as a directory of links to the repository's own entries, except `except`. */
const linkEntries = (dir, except = []) => {
  mkdirSync(join(checkout, dir), { recursive: true });
  for (const entry of readdirSync(join(REPO, dir))) if (!except.includes(entry)) symlinkSync(join(REPO, dir, entry), join(checkout, dir, entry));
};

try {
  linkEntries('tests/behavioral', ['_deploy-target.mjs']);
  copyFileSync(join(REPO, 'tests/behavioral/_deploy-target.mjs'), join(checkout, 'tests/behavioral/_deploy-target.mjs'));
  linkEntries('apps');
  symlinkSync(join(REPO, 'scripts'), join(checkout, 'scripts'));
  symlinkSync(join(REPO, 'packages'), join(checkout, 'packages'));
  linkEntries('node_modules', ['.bin']);
  linkEntries('node_modules/.bin', ['wrangler']);
  const at = (file) => join(checkout, file);
  writeFileSync(at('node_modules/.bin/wrangler'), `#!/bin/sh
case "$1" in
  deploy)
    sleep ${UPLOAD_S}
    date +%s%3N > '${at('deployed-at')}'
    echo 'Uploaded nimbus-read-back'
    echo 'https://nimbus-read-back.proof.workers.dev'
    echo 'Current Version ID: ${UPLOADED}'
    ;;
  deployments)
    served=${BEFORE}
    if [ -f '${at('deployed-at')}' ] && [ ! -f '${at('never')}' ] && [ $(( $(date +%s%3N) - $(cat '${at('deployed-at')}') )) -ge ${SWITCH_MS} ]; then served=${UPLOADED}; fi
    echo "Version(s): (100%) $served"
    ;;
  *) exit 1 ;;
esac
`);
  chmodSync(at('node_modules/.bin/wrangler'), 0o755);
  const { deployAndVerify } = await import(at('tests/behavioral/_deploy-target.mjs'));
  const deploy = () => deployAndVerify({ cwd: checkout, account: 'proof-account', name: 'nimbus-read-back' });

  // The platform switches SWITCH_MS after the upload: the read-back waits for it.
  {
    const started = Date.now();
    const { versionId, base } = await deploy();
    assert.deepEqual([versionId, base], [UPLOADED, 'https://nimbus-read-back.proof.workers.dev'], 'the upload is read back once it is served');
    assert.ok(Date.now() - started >= UPLOAD_S * 1000 + SWITCH_MS, 'after the platform switched to it');
    console.log('  ok  a version served a moment after the upload is read back, not refused');
  }

  // Never served: refused after the window, saying what was served.
  {
    rmSync(at('deployed-at'), { force: true });
    writeFileSync(at('never'), '');
    await assert.rejects(deploy(), new RegExp(`did not land: Cloudflare serves ${BEFORE} but the deploy reported ${UPLOADED}, read back for [\\d.]+ s`));
    console.log('  ok  a version never served is refused after the window');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('deploy-read-back: ok');
