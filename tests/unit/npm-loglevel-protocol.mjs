#!/usr/bin/env bun
// `npm install --loglevel=verbose` has to produce npm's log protocol, because
// that is what drives other people's tooling.
//
// Pi's public installer (https://pi.dev/install.sh) runs
//   npm install -g --ignore-scripts --loglevel=verbose --progress=false <pkg>
// with stdout and stderr teed to a file, and a spinner that re-reads the file
// every ~0.4 s and advances its label off npm's own lines. Nimbus parsed
// --loglevel only so it would not be mistaken for a package name, then
// discarded it and printed its own prose, so none of pi's patterns ever
// matched and the label sat at "starting npm install" for the whole install.
//
// The cases below are transcribed from `npm_install_progress_label` in that
// installer; they are the consumer contract, so they are asserted literally.

import assert from 'node:assert/strict';
import { parseNpmInstallInvocation } from '../../packages/worker/src/npm/install-args.ts';
import {
  npmAddedLine,
  npmHttpCacheLine,
  npmHttpFetchLine,
  npmLogEnabled,
  npmTitleLine,
  parseNpmLogLevel,
} from '../../packages/worker/src/npm/npm-log.ts';
import { packumentUrl } from '../../packages/worker/src/npm/r2-cache.ts';

// pi's `case` arms, in the order it tests them; the first match wins.
const PI_LABELS = [
  [/^npm verbose title npm install/, 'resolving packages'],
  [/^npm http fetch GET .*https:\/\/registry\.npmjs\.org\/.*\.tgz/, 'fetching tarballs'],
  [/^npm http cache .*@https:\/\/registry\.npmjs\.org\/.*\.tgz/, 'checking tarballs'],
  [/^npm http fetch GET .*https:\/\/registry\.npmjs\.org\//, 'fetching package metadata'],
  [/^npm http cache https:\/\/registry\.npmjs\.org\//, 'checking cached metadata'],
  [/^added /, 'added'],
];

function piLabel(line) {
  for (const [pattern, label] of PI_LABELS) if (pattern.test(line)) return label;
  return null;
}

// --loglevel reaches the installer instead of being dropped on the floor.
{
  const parsed = parseNpmInstallInvocation([
    '-g', '--ignore-scripts', '--no-fund', '--no-audit',
    '--loglevel=verbose', '--progress=false', '@earendil-works/pi-coding-agent',
  ]);
  assert.deepEqual(parsed.packages, ['@earendil-works/pi-coding-agent']);
  assert.equal(parsed.global, true);
  assert.equal(parsed.loglevel, 'verbose');
  assert.equal(parseNpmInstallInvocation(['react']).loglevel, null);
  // An unknown level names no level rather than inventing one.
  assert.equal(parseNpmInstallInvocation(['--loglevel=chatty', 'react']).loglevel, null);
  assert.equal(parseNpmLogLevel('silly'), 'silly');
  assert.equal(parseNpmLogLevel(undefined), null);
}

// npm's level ladder: a level enables itself and everything quieter.
{
  assert.equal(npmLogEnabled('verbose', 'http'), true);
  assert.equal(npmLogEnabled('verbose', 'verbose'), true);
  assert.equal(npmLogEnabled('silly', 'verbose'), true);
  assert.equal(npmLogEnabled('http', 'verbose'), false);
  assert.equal(npmLogEnabled('warn', 'http'), false);
  assert.equal(npmLogEnabled('silent', 'http'), false);
  assert.equal(npmLogEnabled(null, 'http'), false);
}

// Every line the installer emits moves pi's label off "starting npm install".
{
  const title = npmTitleLine(['@earendil-works/pi-coding-agent']);
  assert.equal(piLabel(title), 'resolving packages');
  assert.equal(npmTitleLine([]), 'npm verbose title npm install');

  const metadata = packumentUrl('@earendil-works/pi-coding-agent');
  assert.equal(metadata, 'https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent');
  assert.equal(piLabel(npmHttpFetchLine(metadata, 132)), 'fetching package metadata');
  assert.equal(piLabel(npmHttpCacheLine(metadata)), 'checking cached metadata');
  assert.equal(piLabel(npmHttpFetchLine(packumentUrl('chalk'), 7)), 'fetching package metadata');

  const tarball = 'https://registry.npmjs.org/chalk/-/chalk-5.3.0.tgz';
  assert.equal(piLabel(npmHttpFetchLine(tarball, 214)), 'fetching tarballs');
  assert.equal(piLabel(npmHttpCacheLine(tarball, 'sha512-abc123')), 'checking tarballs');

  // The summary must reach the log unstyled: pi anchors on `added ` at the
  // start of the line, so an ANSI colour prefix hides it.
  const added = npmAddedLine(123, 87_000);
  assert.equal(added, 'added 123 packages in 87.0s');
  assert.equal(piLabel(added), 'added');
  assert.equal(piLabel(`[32m${added}[0m`), null);
  assert.equal(npmAddedLine(1, 1_000), 'added 1 package in 1.0s');
}

// A tarball line must never be counted as metadata, and an elapsed time is a
// measurement rather than a decoration.
{
  const tarball = 'https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz';
  assert.equal(piLabel(npmHttpFetchLine(tarball, 0)), 'fetching tarballs');
  assert.equal(npmHttpFetchLine(tarball, 0), `npm http fetch GET 200 ${tarball} 0ms (cache miss)`);
  assert.equal(npmHttpFetchLine(tarball, 12.7).includes('13ms'), true);
  assert.equal(npmHttpFetchLine(tarball, -5).includes('0ms'), true);
  // Without an integrity key a cache line is still a well-formed npm line.
  assert.equal(npmHttpCacheLine(tarball), `npm http cache ${tarball}`);
}

console.log('npm-loglevel-protocol: ok');
