#!/usr/bin/env bun
// Live drive for the G4 fix: create-vite react template `npm run build`
// must emit dist/index.html + hashed assets; `npm run dev` must still
// serve; a SvelteKit scaffold must print the honest plugin diagnostic.
// Run: BASE=... NIMBUS_PROBE_TOKEN=... bun tests/behavioral/_vite-build-assets-drive.mjs
import { mintSession, deleteSession, Terminal, stripAnsi, fetchPort, sleep } from './_driver.mjs';

const BASE = process.env.BASE;
if (!BASE) { console.error('FATAL: BASE required'); process.exit(2); }

async function exec(t, cmd, timeoutMs) {
  if (!t.ws || t.closed) {
    const nt = new Terminal(t.sid);
    await nt.connect();
    await nt.waitForPrompt(60_000);
    t.ws = nt.ws; t.closed = false; t.buf = '';
  }
  t.reset();
  t.cmd(`${cmd}; echo __EXIT__$?`);
  try {
    await t.waitFor(b => /__EXIT__\d+/.test(b), timeoutMs, `${cmd.slice(0, 60)} exit`);
    await sleep(200);
  } catch {
    t.send('');
    return { exit: null, timedOut: true, output: stripAnsi(t.buf) };
  }
  const output = stripAnsi(t.buf);
  const m = output.match(/__EXIT__(\d+)/);
  return { exit: m ? Number(m[1]) : null, timedOut: false, output };
}

const fail = (msg, extra = '') => { console.error(`FAIL: ${msg}\n${String(extra).slice(-1500)}`); process.exitCode = 1; };
async function main() {
  let sid;
  try {
    sid = await mintSession();
    console.log(`sid=${sid} BASE=${BASE}`);
    const t = new Terminal(sid);
    await t.connect();
    await t.waitForPrompt(60_000);

    // 1. scaffold + install (real registry — slow on cold cache)
    let r = await exec(t, 'cd /home/user && npm create vite@latest vt -- --template react', 300_000);
    console.log('[scaffold] exit=' + r.exit);
    if (r.exit !== 0) return fail('npm create vite failed', r.output);

    r = await exec(t, 'cd /home/user/vt && npm install', 600_000);
    console.log('[install] exit=' + r.exit);
    if (r.exit !== 0) return fail('npm install failed', r.output);

    // 2. THE BUG: npm run build
    r = await exec(t, 'cd /home/user/vt && npm run build', 300_000);
    console.log('[build] exit=' + r.exit);
    console.log(r.output.split('\n').filter(l => l.trim()).slice(-20).join('\n'));
    if (r.exit !== 0) return fail('npm run build failed', r.output);
    if (/Build error|Unexpected|JSX syntax/.test(r.output)) return fail('build emitted the G4 errors', r.output);

    // 3. dist contents
    r = await exec(t, 'cd /home/user/vt && ls -la dist dist/assets && cat dist/index.html', 30_000);
    const listing = r.output;
    console.log('[dist]\n' + listing);
    if (!/index-\w+\.js|main-\w+\.js/.test(listing)) return fail('no hashed js in dist/assets', listing);
    if (!/-\w+\.(svg|png)/.test(listing)) return fail('no hashed assets in dist/assets', listing);
    if (!/(favicon|vite)\.svg/.test(listing)) return fail('public/ files not copied to dist root', listing);
    if (!/\/assets\/\w+-\w+\.js/.test(listing)) return fail('index.html does not reference hashed asset js', listing);

    // 4. npm run dev still serves (dev-server path unchanged). Vite's dev
    // server is exposed through /port/<n>/, not a loopback listener.
    t.reset();
    t.cmd('cd /home/user/vt && npm run dev');
    try {
      await t.waitFor(b => /Preview:|pid=\d+|Local:/.test(stripAnsi(b)), 60_000, 'dev server ready');
    } catch (e) {
      t.send('');
      return fail('npm run dev never printed its banner', stripAnsi(t.buf));
    }
    const devOut = stripAnsi(t.buf);
    console.log('[dev]\n' + devOut.split('\n').filter(l => l.trim()).slice(-12).join('\n'));
    const portM = devOut.match(/port=(\d+)/) || devOut.match(/Port:\s*(\d+)/);
    const devPort = portM ? Number(portM[1]) : 5173;
    let served = false;
    for (let i = 0; i < 15 && !served; i++) {
      const pr = await fetchPort(sid, devPort).catch(() => null);
      if (pr && pr.status < 500 && /<div id="root"|<title>/i.test(pr.body || '')) served = true;
      else await sleep(1_000);
    }
    if (!served) return fail(`dev server not serving on /port/${devPort}/`);
    await exec(t, 'cd /home/user/vt && vite stop', 30_000).catch(() => {});
    await t.waitForNewPrompt(15_000).catch(() => t.send(''));

    // 5. SvelteKit scaffold → honest diagnostic on build
    r = await exec(t, 'cd /home/user && npx --yes sv@latest create skx --template minimal --types ts --no-add-ons --no-install', 300_000);
    console.log('[sv create] exit=' + r.exit);
    if (r.exit !== 0) return fail('sv create failed', r.output);
    // The node_modules guard precedes the plugin diagnostic, so deps must
    // actually be installed before `vite build` is reached.
    r = await exec(t, 'cd /home/user/skx && npm install', 600_000);
    console.log('[sk install] exit=' + r.exit);
    if (r.exit !== 0) return fail('skx npm install failed', r.output);
    r = await exec(t, 'cd /home/user/skx && npm run build 2>&1', 120_000);
    console.log('[sk build] exit=' + r.exit + '\n' + r.output.split('\n').filter(l => l.trim()).slice(-12).join('\n'));
    if (r.exit === 0) return fail('sveltekit build unexpectedly succeeded', r.output);
    if (!/needs Vite plugins the built-in (build )?server cannot run/.test(r.output)) {
      return fail('sveltekit build did not print the honest diagnostic', r.output);
    }
    if (/cannot be marked as external|JSX syntax/.test(r.output)) {
      return fail('sveltekit build still shows the misleading esbuild error', r.output);
    }

    if (!process.exitCode) console.log('ALL CHECKS PASSED');
  } finally {
    if (sid) await deleteSession(sid).catch(() => {});
  }
}

await main();
process.exit(process.exitCode || 0);
