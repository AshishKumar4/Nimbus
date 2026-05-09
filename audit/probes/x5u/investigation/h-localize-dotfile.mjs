#!/usr/bin/env bun
// X.5-U investigation probe — localize the `.ts-jest-digest` drop point.
//
// Strategy: install ts-jest, then introspect VFS state via /api/_diag.
// Three independent observations:
//   H_INSTALL: is `.ts-jest-digest` written to VFS by the install pipeline?
//              (probe: stat the file via shell `ls` + `cat`)
//   H_BUNDLE:  is `.ts-jest-digest` reachable in the runtime facet bundle?
//              (probe: node -e existsSync, readFileSync, fs.readdirSync)
//   H_MANIFEST: does fs.readdirSync see `.ts-jest-digest` (i.e. is manifest
//              picking it up)?
//
// PRE-X5U expectation:
//   - INSTALL  : present (writeBatch should NOT drop dotfiles).
//   - BUNDLE   : ABSENT (bundle population paths don't pick up dotfile asset).
//   - MANIFEST : present (manifest pass walks vfs.readdir which doesn't filter).
//
// If INSTALL is ABSENT → root-cause is install pipeline (H1/H2/H3 from
// dispatch). If INSTALL is present + BUNDLE absent → H4 (NEW path):
// prefetch-bundle population doesn't reach dotfiles + odd extensions.
//
// Usage:
//   BASE=http://127.0.0.1:8791 bun audit/probes/x5u/investigation/h-localize-dotfile.mjs

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'h-localize-dotfile.out.txt');

if (!process.env.BASE) {
  console.error('FATAL: must set BASE=http://127.0.0.1:8791');
  process.exit(2);
}

fs.writeFileSync(ARTIFACT, '');

// Probe 1: VFS-disk state via shell.
//   - ls -la node_modules/ts-jest         → does dotfile show up?
//   - cat node_modules/ts-jest/.ts-jest-digest → does content match (40-byte sha1)?
const PROBE_VFS = `
ls -la /home/user/app/node_modules/ts-jest 2>&1 | head -20
echo '====AFTER_LS===='
cat /home/user/app/node_modules/ts-jest/.ts-jest-digest 2>&1 | head -3
echo '====AFTER_CAT===='
`.trim();

// Probe 2: facet runtime view via node script.
//   - existsSync of dotfile
//   - readFileSync of dotfile
//   - readdirSync of node_modules/ts-jest sees `.ts-jest-digest`
const PROBE_NODE = `
const fs = require('fs');
const p = '/home/user/app/node_modules/ts-jest/.ts-jest-digest';
const dir = '/home/user/app/node_modules/ts-jest';
let exists, readDir, readContent;
try { exists = fs.existsSync(p); } catch (e) { exists = 'ERR:' + e.message; }
try { readDir = fs.readdirSync(dir).filter(n => n.startsWith('.') || n === 'package.json').sort(); } catch (e) { readDir = 'ERR:' + e.message; }
try { readContent = fs.readFileSync(p, 'utf8').trim(); } catch (e) { readContent = 'ERR:' + e.message; }
console.log('FACET_EXISTS:', JSON.stringify(exists));
console.log('FACET_READDIR:', JSON.stringify(readDir));
console.log('FACET_READ:', JSON.stringify(readContent));
`.trim();
const b64 = Buffer.from(PROBE_NODE, 'utf8').toString('base64');

const r = await runProbe('x5u h-localize-dotfile', [
  { kind: 'cmd', cmd: 'cd app && npm install ts-jest', timeoutMs: 180_000 },
  { kind: 'cmd', cmd: PROBE_VFS, timeoutMs: 15_000 },
  {
    kind: 'cmd',
    cmd: `node -e "require('fs').writeFileSync('/home/user/app/.x5u_inv.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}' && cd /home/user/app && node .x5u_inv.js`,
    timeoutMs: 30_000,
  },
], { artifactPath: ARTIFACT, settleMs: 3000 });

const txt = fs.readFileSync(ARTIFACT, 'utf8');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.log(`  NOT OK  ${label}` + (detail ? ` — ${detail}` : '')); }
}

ok('probe ran (POST /new succeeded)', r.ok);
ok('npm install completed', /added \d+ packages/.test(txt));

// VFS-disk view
const vfsListsDigest = /\.ts-jest-digest/.test(txt.split('====AFTER_LS====')[0] || '');
const vfsCatHasSha1 = /^[0-9a-f]{40}$/m.test(
  (txt.split('====AFTER_LS====')[1] || '').split('====AFTER_CAT====')[0] || '',
);
ok('VFS-disk: ls shows .ts-jest-digest in node_modules/ts-jest',
  vfsListsDigest, 'install pipeline writeBatch should preserve dotfiles');
ok('VFS-disk: cat .ts-jest-digest returns 40-byte sha1',
  vfsCatHasSha1, 'tarball extraction should preserve content');

// Facet runtime view (post-bundle).
const facetExists = /FACET_EXISTS:\s*"?true"?/.test(txt) || /FACET_EXISTS:\s*true/.test(txt);
const facetReaddirSeesDigest = /FACET_READDIR:.*\.ts-jest-digest/.test(txt);
const facetReadOk = /FACET_READ:\s*"[0-9a-f]{40}"/.test(txt);
const facetReadEnoent = /FACET_READ:\s*"ERR:.*ENOENT/.test(txt);

console.log('');
console.log('# X.5-U localization summary');
console.log(`  VFS-disk     : ls→${vfsListsDigest ? 'YES' : 'NO'}  cat→${vfsCatHasSha1 ? 'YES' : 'NO'}`);
console.log(`  Facet runtime: existsSync→${facetExists ? 'YES' : 'NO'}  readdirSync→${facetReaddirSeesDigest ? 'YES' : 'NO'}  readFile→${facetReadOk ? 'YES' : (facetReadEnoent ? 'ENOENT' : 'OTHER')}`);
console.log('');

// Diagnostic: which hypothesis is alive?
if (!vfsListsDigest || !vfsCatHasSha1) {
  console.log('# CONCLUSION: install-pipeline drop (H1/H2/H3 territory).');
} else if (!facetReadOk) {
  console.log('# CONCLUSION: install OK, runtime bundle gap (H4 — prefetch path).');
} else {
  console.log('# CONCLUSION: ts-jest-digest reachable end-to-end. Probe needs revision.');
}

console.log('');
console.log(`# x5u h-localize-dotfile: ${passed} passed, ${failed} failed`);
process.exit(0); // investigation probe — never fail; produce report
