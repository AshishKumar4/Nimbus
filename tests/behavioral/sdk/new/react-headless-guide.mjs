// sdk/new/react-headless-guide — the published headless-hook guide works as
// written. Each copy of it (packages/react/README.md, and the example in
// useNimbusSession's own documentation) is run as an embedder would paste
// it, with only its example endpoint replaced by this target and a real
// token handed in: its iframe mounts at once, the shell in it boots, and its
// ready event ends the guide's loading state.
// Red before: both copies rendered "Loading…" until ready was true, and only
// the iframe they had not mounted could make it true.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { build } from 'esbuild';
import { BASE, AUTH_TOKEN, makeAsserter } from '../../_driver.mjs';
import { launchBrowser, openPage } from '../../_runtime-behavioral-template.mjs';
import { Nimbus } from '../../../../packages/sdk/src/index.ts';

const a = makeAsserter('sdk/new/react-headless-guide');
const EXAMPLE_ENDPOINT = 'https://my-nimbus.workers.dev';
const readme = readFileSync(new URL('../../../../packages/react/README.md', import.meta.url), 'utf8');
const hookSource = readFileSync(new URL('../../../../packages/react/src/useNimbusSession.ts', import.meta.url), 'utf8');
/** The guide's TSX block: the fenced one that calls the hook. */
const guideBlock = (text) => [...text.matchAll(/```tsx\n([\s\S]*?)```/g)].map((m) => m[1]).find((block) => block.includes('useNimbusSession('));
const guides = {
  readme: guideBlock(readme),
  jsdoc: guideBlock(hookSource.slice(0, hookSource.indexOf('*/')).replace(/^ \* ?/gm, '')),
};

const client = Nimbus.connect({ endpoint: BASE, token: AUTH_TOKEN });
const box = client.sandbox(`react_guide_${Date.now()}.host`);
const sessions = new Set([box.id]);
let browser;
try {
  await box.ready();
  const require = createRequire(new URL('../../../../packages/worker/package.json', import.meta.url));
  const reactIndex = new URL('../../../../packages/react/src/index.ts', import.meta.url).pathname;
  browser = await launchBrowser({ webSecurity: true });
  const { page, pageErrors } = await openPage(browser, box.id);
  page.on('framenavigated', (frame) => {
    const match = /^\/s\/([^/]+)\//.exec(new URL(frame.url()).pathname);
    if (new URL(frame.url()).origin === new URL(BASE).origin && match) sessions.add(match[1]);
  });
  const bundles = new Map();
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    const guide = /^\/__react-guide-probe\/(\w+)(\.js)?$/.exec(url.pathname);
    if (url.origin === new URL(BASE).origin && guide && bundles.has(guide[1])) {
      return guide[2]
        ? request.respond({ contentType: 'text/javascript', body: bundles.get(guide[1]) })
        : request.respond({ contentType: 'text/html', body: `<!doctype html><div id="root"></div><script>
window.__guideEvents = [];
addEventListener('message', (event) => { if (typeof event.data?.type === 'string' && event.data.type.startsWith('nimbus:')) window.__guideEvents.push(event.data.type); });
// What the page showed as the guide's iframe first appeared, taken at that mutation.
window.__guideMount = null;
new MutationObserver(() => {
  if (window.__guideMount !== null || !document.querySelector('#root iframe[src]')) return;
  window.__guideMount = { loading: document.querySelector('#root').textContent.includes('Loading'), events: window.__guideEvents.slice() };
}).observe(document.documentElement, { childList: true, subtree: true });
</script><script src="/__react-guide-probe/${guide[1]}.js"></script>` });
    }
    return request.continue();
  });

  for (const [name, block] of Object.entries(guides)) {
    a.check(`the ${name} guide names the example endpoint it is run against`, typeof block === 'string' && block.includes(EXAMPLE_ENDPOINT), String(block));
    if (typeof block !== 'string') continue;
    const bundled = await build({
      stdin: { contents: `
import { createRoot } from 'react-dom/client';
${block.replace(EXAMPLE_ENDPOINT, BASE)}
createRoot(document.getElementById('root')).render(<MyTerm token={${JSON.stringify(AUTH_TOKEN)}} />);
`, resolveDir: process.cwd(), loader: 'tsx' },
      write: false, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic',
      alias: { react: dirname(require.resolve('react')), 'react-dom': dirname(require.resolve('react-dom')), '@nimbus-sh/react': reactIndex },
      conditions: ['workspace'],
    });
    bundles.set(name, bundled.outputFiles[0].text);
    await page.goto(`${BASE}/__react-guide-probe/${name}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    const mounted = await page.waitForFunction(() => window.__guideMount, { timeout: 20_000 }).then((handle) => handle.jsonValue(), () => null);
    a.check(`the ${name} guide mounts its iframe under its loading state, before the session is ready`,
      mounted !== null && mounted.loading && !mounted.events.includes('nimbus:ready'), JSON.stringify(mounted) + ' ' + await page.$eval('#root', (el) => el.innerHTML.slice(0, 300)));
    const ready = mounted !== null && await page.waitForFunction(() => window.__guideEvents.includes('nimbus:ready')
      && !document.querySelector('#root').textContent.includes('Loading') && !!document.querySelector('#root iframe[src]'), { timeout: 90_000 }).then(() => true, () => false);
    const after = await page.evaluate(() => ({ events: window.__guideEvents.slice(), root: document.querySelector('#root').innerHTML.slice(0, 300) }));
    a.check(`the ${name} guide's shell reports ready, and the guide drops its loading state with its iframe still there`,
      ready && !after.events.includes('nimbus:error'), JSON.stringify(after));
  }
  a.check('the guides cause no browser errors', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  if (browser) await browser.close();
  for (const sid of sessions) {
    const destroyed = await client.sandbox(sid).destroy({ reason: 'react-headless-guide-probe-complete' });
    a.check('the SDK-owned sandbox is destroyed', destroyed.ok === true && typeof destroyed.destroyedAt === 'number');
  }
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
