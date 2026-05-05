#!/usr/bin/env bun
// Classify each packages-local/<pkg>.out.txt artifact.
// Adapted from audit/probes/classify-packages.mjs for the post-phase5 local sweep.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'packages-local');

function classify(text) {
  const smokeIdx = text.lastIndexOf('---- STEP cmd: node ');
  const installIdx = text.indexOf('---- STEP cmd: cd app && npm install');
  const smoke = smokeIdx >= 0 ? text.slice(smokeIdx) : '';
  const install = installIdx >= 0 ? text.slice(installIdx, smokeIdx >= 0 ? smokeIdx : undefined) : '';

  let installStatus = 'unknown', installNote = '';
  const m = install.match(/added (\d+) packages?(?: \((\d+) files\))?/);
  if (m) {
    installStatus = 'installed';
    installNote = `added ${m[1]} pkgs${m[2] ? ', ' + m[2] + ' files' : ''}`;
  } else if (/added 0 packages/.test(install)) {
    installStatus = 'noop-skip';
    installNote = 'added 0 packages (likely SKIP_PACKAGES)';
  } else if (/Done!/.test(install)) {
    installStatus = 'installed-no-count';
    installNote = 'Done! line present';
  } else if (/REJECT_INSTALL|npm install rejected|not supported on Nimbus/.test(install)) {
    installStatus = 'rejected-loud';
    // Capture the package name + reason
    const e = install.match(/❌\s+\S+\s+—\s+[^\n]+/);
    if (e) {
      installNote = e[0].slice(0, 200);
    } else {
      const e2 = install.match(/npm install rejected[^\n]*/);
      installNote = e2 ? e2[0].slice(0, 200) : 'rejected (loud)';
    }
  } else if (/error/i.test(install)) {
    installStatus = 'install-failed';
    const e = install.match(/[Ee]rror[^\n]+/);
    installNote = e ? e[0].slice(0, 200) : 'unknown error';
  }

  let runtimeStatus = 'unknown', runtimeNote = '';
  if (/Process \d+ \([^)]*\) exited with code 0/.test(smoke)) {
    runtimeStatus = 'ok';
    const lines = smoke.split('\n');
    for (const l of lines) {
      const t = l.trim();
      if (t.match(/^(keys|typeof|hash|parse|app keys|title|app title):/)) {
        runtimeNote = t.slice(0, 200);
        break;
      }
    }
  } else if (/Error:/.test(smoke) || /exited with code [1-9]/.test(smoke)) {
    runtimeStatus = 'runtime-failed';
    const e = smoke.match(/Error:[^\n]+/);
    runtimeNote = e ? e[0].slice(0, 240) : 'non-zero exit';
  }

  let overall;
  if (installStatus === 'installed' && runtimeStatus === 'ok') overall = '✅';
  else if ((installStatus === 'installed' || installStatus === 'installed-no-count') && runtimeStatus === 'runtime-failed') overall = '⚠️';
  else if (installStatus === 'rejected-loud') overall = '⛔'; // honest reject
  else if (installStatus === 'noop-skip') overall = '❌'; // silent skip
  else if (installStatus === 'install-failed') overall = '❌';
  else overall = '❓';

  return { overall, installStatus, installNote, runtimeStatus, runtimeNote };
}

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.out.txt')).sort();
const results = [];
for (const f of files) {
  const text = fs.readFileSync(path.join(DIR, f), 'utf8');
  const c = classify(text);
  results.push({ name: f.replace(/\.out\.txt$/, ''), ...c });
}

console.log('Total:', results.length);
console.log('✅:', results.filter(r => r.overall === '✅').length);
console.log('⚠️:', results.filter(r => r.overall === '⚠️').length);
console.log('⛔:', results.filter(r => r.overall === '⛔').length);
console.log('❌:', results.filter(r => r.overall === '❌').length);
console.log('❓:', results.filter(r => r.overall === '❓').length);

console.log('\n| Package | Status | Install | Runtime |');
console.log('|---|---|---|---|');
for (const r of results) {
  console.log(`| \`${r.name}\` | ${r.overall} | ${(r.installNote || r.installStatus).replace(/\|/g, '\\|')} | ${(r.runtimeNote || r.runtimeStatus).replace(/\|/g, '\\|')} |`);
}

fs.writeFileSync(path.join(DIR, '_TABLE.md'), [
  `# Post-Phase-5 local package compat — generated ${new Date().toISOString()}`,
  '',
  `Total: ${results.length}`,
  `- ✅ ${results.filter(r => r.overall === '✅').length}`,
  `- ⚠️ ${results.filter(r => r.overall === '⚠️').length}`,
  `- ⛔ ${results.filter(r => r.overall === '⛔').length} (loud reject — counts as healthy outcome)`,
  `- ❌ ${results.filter(r => r.overall === '❌').length}`,
  `- ❓ ${results.filter(r => r.overall === '❓').length}`,
  '',
  '| Package | Status | Install | Runtime |',
  '|---|---|---|---|',
  ...results.map(r => `| \`${r.name}\` | ${r.overall} | ${(r.installNote || r.installStatus).replace(/\|/g, '\\|')} | ${(r.runtimeNote || r.runtimeStatus).replace(/\|/g, '\\|')} |`),
  '',
].join('\n'));
fs.writeFileSync(path.join(DIR, '_SUMMARY-CLASSIFIED.json'), JSON.stringify(results, null, 2));
