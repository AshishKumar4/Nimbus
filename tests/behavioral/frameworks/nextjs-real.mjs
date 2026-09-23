#!/usr/bin/env bun
// frameworks/nextjs-real — honest-boundary probe for `create-next-app`.
//
// Category: R (runtime-behavioral)
//
// User scenario:
//   npx create-next-app@latest mvp --ts --no-eslint --tailwind --app
//     --src-dir --import-alias '@/*' --use-npm --yes
//   cd mvp && npm run dev
//
// What this probe PROVES: create-next-app runs to "Success!" and exits 0,
// writing the full app-tw template including package.json, and its
// in-scaffold `npm install` installs the pinned `next`, `react` and
// `react-dom` into mvp/node_modules.
//
// Boundary (documented, not faked): Next.js itself does not run. `npm run
// dev` refuses with Nimbus' Next.js diagnostic and starts nothing on :3000,
// and the `next` bin (even `--version`) is refused before start because its
// require closure (webpack bundle5.js) exceeds the facet snapshot bound.
// Both are asserted, so a silent hang or a fake success would fail here.

import { Terminal, mintSession, sleep, stripAnsi, makeAsserter, deleteSession, fetchPort, BASE } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('nextjs-real');
const PORT = 3000;

const sid = await mintSession();
console.log(`[nextjs-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
try {
  await t.connect();
  await sleep(2_000);
  await t.waitForPrompt(60_000);

  await t.run('mkdir -p /home/user/nextjs-probe && cd /home/user/nextjs-probe', 10_000);
  console.log('[nextjs-real] npx create-next-app@latest...');

  const createR = await t.run(
    "npx --yes create-next-app@latest mvp --ts --no-eslint --tailwind --app --src-dir --import-alias '@/*' --use-npm --yes 2>&1; echo \"CNA_EXIT=$?\"",
    240_000,
  );
  const createOut = stripAnsi(createR.output);
  const createTail = JSON.stringify(createOut.split(/\r?\n/).filter((l) => l.trim()).slice(-8).join(' | '));

  a.check('create-next-app launches and initializes the local template (npm resolver + facet spawn)',
    /Initializing project with template/.test(createOut), createTail);
  a.check('create-next-app completes: "Success! Created mvp" and exit 0',
    /Success! Created mvp/.test(createOut) && /CNA_EXIT=0\b/.test(createOut), createTail);

  const tpl = await t.run(
    `node -e "const fs=require('fs');const need=['mvp/next.config.ts','mvp/tsconfig.json','mvp/src'];console.log('TPL='+need.every(p=>fs.existsSync(p)));console.log('PKG='+fs.existsSync('mvp/package.json'));"`,
    20_000,
  );
  const tplOut = stripAnsi(tpl.output);
  a.check('create-next-app writes the local template files to the VFS (next.config.ts, tsconfig.json, src/)',
    /TPL=true/.test(tplOut), JSON.stringify(tplOut.slice(-200)));
  a.check('create-next-app writes package.json (regression guard: the pre-S2a {"remote":true} abort landed BEFORE package.json)',
    /PKG=true/.test(tplOut), JSON.stringify(tplOut.slice(-200)));

  // The in-scaffold install is real: every runtime dependency package.json
  // pins is installed at exactly the pinned version.
  const deps = await t.run(
    `cd /home/user/nextjs-probe/mvp && node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('package.json','utf8')).dependencies;for(const n of ['next','react','react-dom']){const p='node_modules/'+n+'/package.json';console.log('DEP '+n+' want='+d[n]+' have='+(fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')).version:'missing'));}"`,
    30_000,
  );
  const depLines = stripAnsi(deps.output).split(/\r?\n/).filter((l) => l.startsWith('DEP '));
  a.check('in-scaffold npm install installs the pinned next, react and react-dom',
    depLines.length === 3 && depLines.every((l) => /want=(\S+) have=\1$/.test(l.trim())),
    JSON.stringify(depLines));

  // Boundary 1: `npm run dev` refuses loudly and starts nothing.
  const dev = await t.run('npm run dev', 60_000);
  const devOut = stripAnsi(dev.output);
  a.check('honest boundary: `npm run dev` refuses with the Next.js diagnostic',
    /Next\.js is not supported in Nimbus/.test(devOut), JSON.stringify(devOut.slice(-400)));
  const port = await fetchPort(sid, PORT).catch((e) => ({ status: `fetch error: ${e.message}`, body: '' }));
  a.check(`honest boundary: nothing listens on :${PORT} after the refusal`,
    port.status === 502 && /No process listening/.test(port.body),
    `status=${port.status} body=${JSON.stringify(String(port.body).slice(0, 200))}`);

  // Boundary 2: the next bin itself is refused before start, by name.
  const bin = await t.run('npx next --version; echo "NEXT_EXIT=$?"', 120_000);
  const binOut = stripAnsi(bin.output);
  a.check('honest boundary: the next bin is refused (require closure exceeds the facet snapshot bound), exit non-zero',
    /require closure for \S*next\/dist\/bin\/next exceeds the snapshot bound/.test(binOut)
      && /NEXT_EXIT=[1-9]\d*/.test(binOut),
    JSON.stringify(binOut.slice(-400)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
