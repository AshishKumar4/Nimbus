#!/usr/bin/env bun
// X.5-U investigation probe — confirm VFS-disk has .ts-jest-digest.
//
// The first investigation probe used `ls -la 2>&1 | head -20` which the
// in-Nimbus shell parser rejected ("Expected Word but got Amp"). Use a
// node-script-only path so we observe VFS via the runtime fs shim AND
// via the supervisor /api/_diag fallback.

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'h-vfs-disk-confirm.out.txt');

if (!process.env.BASE) {
  console.error('FATAL: must set BASE=http://127.0.0.1:8791');
  process.exit(2);
}
fs.writeFileSync(ARTIFACT, '');

// node script that asks fs.readdirSync (uses manifest fallback) AND
// fs.statSync to compare what the manifest exposes vs what readFileSync
// can serve. Manifest is built from vfs.readdir which is the SOURCE OF
// TRUTH for VFS-disk state. If readdirSync sees `.ts-jest-digest`, the
// install pipeline wrote it to VFS. If readFileSync ENOENTs, the
// bundle population is the gap.
const PROBE = `
const fs = require('fs');
const dir = '/home/user/app/node_modules/ts-jest';
const dot = dir + '/.ts-jest-digest';
const reg = dir + '/package.json';
const out = {};
out.readdirAll = fs.readdirSync(dir).sort();
out.readdirDotfiles = out.readdirAll.filter(n => n.startsWith('.'));
out.statDot = (() => { try { const s = fs.statSync(dot); return { isFile: s.isFile(), size: s.size }; } catch (e) { return 'ERR:' + e.code + ':' + e.message; } })();
out.statReg = (() => { try { const s = fs.statSync(reg); return { isFile: s.isFile(), size: s.size }; } catch (e) { return 'ERR:' + e.code + ':' + e.message; } })();
out.readDot = (() => { try { return fs.readFileSync(dot, 'utf8').trim(); } catch (e) { return 'ERR:' + e.code; } })();
out.readReg = (() => { try { const j = fs.readFileSync(reg, 'utf8'); return 'OK:bytes=' + j.length; } catch (e) { return 'ERR:' + e.code; } })();
console.log('X5U_REPORT:' + JSON.stringify(out));
`.trim();
const b64 = Buffer.from(PROBE, 'utf8').toString('base64');

const r = await runProbe('x5u h-vfs-disk-confirm', [
  { kind: 'cmd', cmd: 'cd app && npm install ts-jest', timeoutMs: 180_000 },
  {
    kind: 'cmd',
    cmd: `node -e "require('fs').writeFileSync('/home/user/app/.x5u_disk.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}' && cd /home/user/app && node .x5u_disk.js`,
    timeoutMs: 30_000,
  },
], { artifactPath: ARTIFACT, settleMs: 3000 });

const txt = fs.readFileSync(ARTIFACT, 'utf8');
const m = txt.match(/X5U_REPORT:(\{.*\})/);
const report = m ? JSON.parse(m[1]) : null;

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.log(`  NOT OK  ${label}` + (detail ? ` — ${detail}` : '')); }
}

ok('probe ran', r.ok);
ok('npm install completed', /added \d+ packages/.test(txt));
ok('X5U_REPORT parsed', !!report);

if (report) {
  console.log('  report.readdirDotfiles =', JSON.stringify(report.readdirDotfiles));
  console.log('  report.statDot         =', JSON.stringify(report.statDot));
  console.log('  report.readDot         =', JSON.stringify(report.readDot));
  console.log('  report.readReg         =', JSON.stringify(report.readReg));

  const inReaddir = (report.readdirDotfiles || []).includes('.ts-jest-digest');
  const statOk = report.statDot && typeof report.statDot === 'object' && report.statDot.isFile === true;
  const readDotOk = /^[0-9a-f]{40}$/.test(String(report.readDot || ''));
  const readRegOk = String(report.readReg || '').startsWith('OK:bytes=');

  ok('readdirSync includes .ts-jest-digest (VFS-disk has dotfile)', inReaddir,
    'install pipeline preserves dotfile in VFS');
  ok('statSync(.ts-jest-digest) reports a file', statOk);
  ok('readFileSync(package.json) succeeds (control: regular file in bundle)', readRegOk,
    'sanity check that regular files are reachable');
  ok('readFileSync(.ts-jest-digest) returns 40-byte sha1 (NOT YET — will fail PRE-FIX)', readDotOk,
    'POST-FIX expectation: dotfile content reachable via runtime fs shim');

  console.log('');
  if (inReaddir && !readDotOk) {
    console.log('# CONCLUSION: install OK; bundle population is the gap (H4 NEW path).');
    console.log('#   readdir/stat see the file (manifest pass works);');
    console.log('#   readFile ENOENTs because __vfsBundle has no entry.');
    console.log('#   Fix locus: facet-manager.ts buildPrefetchBundle population.');
  } else if (!inReaddir) {
    console.log('# CONCLUSION: install pipeline drops dotfile (H1/H2/H3 territory).');
  } else {
    console.log('# CONCLUSION: dotfile reachable end-to-end already? Re-check probe.');
  }
}

console.log('');
console.log(`# x5u h-vfs-disk-confirm: ${passed} passed, ${failed} failed`);
process.exit(0); // investigation probe — never fail; report findings
