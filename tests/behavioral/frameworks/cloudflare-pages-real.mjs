#!/usr/bin/env bun
// frameworks/cloudflare-pages-real — scaffold-milestone probe of a
// `create-cloudflare` (c3) hello-world Worker.
//
// Category: R (runtime-behavioral)
//
// User scenario:
//   npm create cloudflare@latest mvp -- --template hello-world --lang js \
//     --deploy=false --git=false --open=false -y
//
// Achievable milestone (asserted here): c3 copies a VALID project — a
// wrangler.jsonc, a src worker entry, and a package.json wired with the
// wrangler dev/deploy scripts and a wrangler dependency.
//
// Boundaries (documented, not faked):
//   1. c3 always runs `npm install` after copying files. The current
//      hello-world template carries @cloudflare/vitest-pool-workers,
//      whose tree pulls native `sharp` (libvips) — a genuine native ABI
//      boundary Nimbus rejects with a precise diagnostic (same class as
//      cf-vite-plugin-real). So the post-scaffold install does not
//      complete; that is expected and not a scaffold failure.
//   2. `wrangler dev` needs workerd-in-DO (a separate, large capability
//      that does not exist yet), so a running dev server is out of reach.
//
// The scaffold itself — c3 resolving flags non-interactively and writing
// a coherent Worker project — is the real, provable capability and is
// what this probe asserts.

import { Terminal, mintSession, sleep, stripAnsi, makeAsserter, deleteSession, BASE } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('cloudflare-pages-real');

const sid = await mintSession();
console.log(`[cloudflare-pages-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
try {
  await t.connect();
  await sleep(2_000);
  await t.waitForPrompt(60_000);

  await t.run('mkdir -p /home/user/c3-probe && cd /home/user/c3-probe', 10_000);
  console.log('[cloudflare-pages-real] npm create cloudflare@latest...');

  // Current c3 non-interactive flag surface: --template <id> --lang js,
  // boolean opt-outs as --flag=false, -y to accept remaining defaults.
  const createR = await t.run(
    'npm create cloudflare@latest mvp -- --template hello-world --lang js --deploy=false --git=false --open=false -y 2>&1; echo C3_RC=$?',
    400_000,
  );
  const createOut = stripAnsi(createR.output);
  console.log('[cloudflare-pages-real] create tail:', createOut.split(/\r?\n/).slice(-8).join('\n').slice(-600));

  // c3 reached the language/template selection non-interactively (no
  // hang on an unanswered prompt) and copied template files.
  a.check('c3 resolved template + language non-interactively (no prompt hang)',
    /Copying template files|files copied to project directory|Updating name in/.test(createOut),
    JSON.stringify(createOut.slice(-800)));

  // The scaffolded project is structurally valid. Use a script that
  // reads package.json fields and the on-disk layout, emitting one
  // KEY=yes|no line per assertion (robust against shell-quoting of
  // regex literals through the WS terminal).
  const scriptBody = [
    'const fs = require("fs");',
    'let pkg = {};',
    'try { pkg = JSON.parse(fs.readFileSync("mvp/package.json", "utf8")); } catch {}',
    'const dep = Object.assign({}, pkg.dependencies, pkg.devDependencies);',
    'const dev = (pkg.scripts && pkg.scripts.dev) || "";',
    'console.log("WRANGLER_DEP=" + (dep.wrangler ? "yes" : "no"));',
    'console.log("DEV_SCRIPT=" + (dev.indexOf("wrangler dev") >= 0 ? "yes" : "no"));',
    'console.log("WCONFIG=" + ((fs.existsSync("mvp/wrangler.jsonc") || fs.existsSync("mvp/wrangler.toml")) ? "yes" : "no"));',
    'let src = [];',
    'try { src = fs.readdirSync("mvp/src"); } catch {}',
    'console.log("SRC_ENTRY=" + (src.some(f => f === "index.js" || f === "index.ts") ? "yes" : "no"));',
  ].join('\n');
  const b64 = Buffer.from(scriptBody, 'utf8').toString('base64');
  await t.run(`echo ${b64} | base64 -d > /home/user/c3-probe/__check.js`, 15_000);
  const probe = await t.run('node /home/user/c3-probe/__check.js', 25_000);
  const out = stripAnsi(probe.output);
  const yes = (k) => new RegExp(k + '=yes').test(out);
  console.log('[cloudflare-pages-real] scaffold probe:', out.split(/\r?\n/).filter((l) => /=(yes|no)/.test(l)).join(' '));

  a.check('package.json declares the wrangler dependency', yes('WRANGLER_DEP'), JSON.stringify(out.slice(-300)));
  a.check('package.json dev script runs `wrangler dev`', yes('DEV_SCRIPT'), JSON.stringify(out.slice(-300)));
  a.check('project has a wrangler.jsonc/wrangler.toml config', yes('WCONFIG'), JSON.stringify(out.slice(-300)));
  a.check('project has a src worker entry (index.js/ts)', yes('SRC_ENTRY'), JSON.stringify(out.slice(-300)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
