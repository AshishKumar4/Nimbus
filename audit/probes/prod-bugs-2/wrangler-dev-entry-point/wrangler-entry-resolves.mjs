// Bug 2 probe: `wrangler dev` resolves its entry point regardless
// of `main:` field shape in wrangler.jsonc.
//
// Reported symptom (prod 4f2afd9e):
//   $ cd /home/user/app/Nimbus
//   $ npm run dev
//   Entry point not found: home/user/app/Nimbus/src/index.ts
//
// Root cause (found post-recon):
//   src/wrangler/nimbus-wrangler.ts:349 builds the entry path with
//   a naive string concatenation:
//     const entryPoint = this.root + '/' + this.config.main;
//
//   The result is NOT canonicalized through normalizeVfsPath, so any
//   `main:` value with embedded `./`, leading `/`, or `//` produces
//   a malformed VFS key that vfs.exists() can't match against the
//   actual stored inode.
//
// Reproduction matrix (each is a separate sub-test below):
//   main: "src/index.ts"     → 'home/user/app/X/src/index.ts'    OK
//   main: "./src/index.ts"   → 'home/user/app/X/./src/index.ts'  FAIL
//   main: "/src/index.ts"    → 'home/user/app/X//src/index.ts'   FAIL
//   main: "src//index.ts"    → 'home/user/app/X/src//index.ts'   FAIL
//
// The user's reported path 'home/user/app/Nimbus/src/index.ts' has
// no `./` or `//` so it's the control case — that one passes. But
// the failure path is the same code: any `main` shape variation
// triggers the malformed-key bug. The probe locks all 4 cases.
//
// Fix at source (P2): join `this.root` and `this.config.main`
// through normalizeVfsPath, the canonical VFS-key normalizer, so
// every shape produces a valid lookup key.

import {
  BASE, mintSession, WsSession, sleep, strip,
} from '../../interactive-liveness/_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'wrangler-entry-resolves.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };

let exitCode = 0;
const fail = (m) => { exitCode = 1; log('FAIL: ' + m); };
const pass = (m) => { log('PASS: ' + m); };

async function tryWithMain(s, mainValue, label) {
  // Each test gets a fresh project dir so there's no state leak
  // between runs.
  const projDir = `~/app/T_${label}`;
  s.reset();
  s.send(`mkdir -p ${projDir}/src && cd ${projDir}\r`);
  await s.waitForNewPrompt(5000);

  s.reset();
  s.send(
    `cat > wrangler.jsonc << 'EOF'\n` +
    `{\n` +
    `  "name": "t",\n` +
    `  "main": ${JSON.stringify(mainValue)},\n` +
    `  "compatibility_date": "2026-04-01",\n` +
    `  "compatibility_flags": ["nodejs_compat"]\n` +
    `}\n` +
    `EOF\r`
  );
  await s.waitForNewPrompt(5000);

  s.reset();
  s.send(
    `cat > src/index.ts << 'EOF'\n` +
    `export default { async fetch(req) { return new Response("hi"); } };\n` +
    `EOF\r`
  );
  await s.waitForNewPrompt(5000);

  // Drop the prior wrangler invocation if it lingered.
  s.send('wrangler stop || true\r');
  await sleep(300);

  s.reset();
  s.send('wrangler dev --force\r');
  // Give the wrangler emulator a few seconds to do entry resolution.
  await sleep(4000);

  const out = strip(s.buf);
  const hasError = /Entry point not found/i.test(out);
  const hasBuilt = /Worker built|Building Worker/i.test(out);
  const reportedPath = (() => {
    const m = out.match(/Entry point not found:\s*(\S+)/);
    return m ? m[1] : null;
  })();
  return { mainValue, label, hasError, hasBuilt, reportedPath };
}

async function main() {
  log('==== Bug 2 probe: wrangler dev entry-point resolution ====');
  log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');
  log('BASE: ' + BASE);

  const sid = await mintSession();
  log('SID: ' + sid);

  const s = new WsSession(sid);
  await s.connect();
  await s.waitForPrompt(8000);

  // The four `main:` shapes covering the bug surface. The control
  // case ("src/index.ts") is what the canonical Nimbus repo ships
  // and works. The other three are common user mistakes (or
  // template artifacts) that trigger the bug.
  const cases = [
    { mainValue: 'src/index.ts',     label: 'control',      shouldBuild: true },
    { mainValue: './src/index.ts',   label: 'leadingdot',   shouldBuild: true },
    { mainValue: '/src/index.ts',    label: 'leadingslash', shouldBuild: true },
    { mainValue: 'src//index.ts',    label: 'doubleslash',  shouldBuild: true },
  ];

  const results = [];
  for (const c of cases) {
    const r = await tryWithMain(s, c.mainValue, c.label);
    results.push({ ...r, shouldBuild: c.shouldBuild });
    log(`[main=${JSON.stringify(c.mainValue)}] hasError=${r.hasError} hasBuilt=${r.hasBuilt} reportedPath=${JSON.stringify(r.reportedPath)}`);
  }

  log('---- assertions ----');
  for (const r of results) {
    if (r.shouldBuild) {
      if (r.hasBuilt && !r.hasError) {
        pass(`main=${JSON.stringify(r.mainValue)} built without "Entry point not found"`);
      } else {
        fail(`main=${JSON.stringify(r.mainValue)} expected to build; hasError=${r.hasError}, reportedPath=${JSON.stringify(r.reportedPath)}`);
      }
    }
  }

  await s.close();
  log('==== EXIT ' + exitCode + ' ====');
  process.exit(exitCode);
}

main().catch((e) => {
  log('UNCAUGHT: ' + (e?.stack || e));
  process.exit(2);
});
