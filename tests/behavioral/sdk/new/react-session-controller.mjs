import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { build } from 'esbuild';
import { BASE, AUTH_TOKEN, makeAsserter } from '../../_driver.mjs';
import { launchBrowser, openPage } from '../../_runtime-behavioral-template.mjs';
import { Nimbus } from '../../../../packages/sdk/src/index.ts';

const a = makeAsserter('sdk/new/react-session-controller');
const client = Nimbus.connect({ endpoint: BASE, token: AUTH_TOKEN });
const box = client.sandbox(`react_${Date.now()}.component`);
const sessions = new Set([box.id]);
let browser;
try {
  await box.ready();
  const require = createRequire(new URL('../../../../packages/worker/package.json', import.meta.url));
  const component = new URL('../../../../packages/react/src/NimbusTerminal.tsx', import.meta.url).pathname;
  const hook = new URL('../../../../packages/react/src/useNimbusSession.ts', import.meta.url).pathname;
  const bundled = await build({
    stdin: { contents: `
import { createRoot } from 'react-dom/client';
import { useRef, useState } from 'react';
import { NimbusTerminal } from ${JSON.stringify(component)};
import { useNimbusSession } from ${JSON.stringify(hook)};
const endpoint = ${JSON.stringify(BASE)}, token = ${JSON.stringify(AUTH_TOKEN)};
function Headless() {
  const iframeRef = useRef(null);
  const state = useNimbusSession({ endpoint, token, tenant: 'probe', iframeRef });
  return <section id="headless" data-ready={String(state.ready)} data-session-id={state.sessionId} data-error={state.error?.code ?? ''}>
    <iframe ref={iframeRef} src={state.attachUrl} />
  </section>;
}
function App() {
  const ref = useRef(null);
  const [readyCount, setReadyCount] = useState(0);
  const [error, setError] = useState(null);
  window.reloadTerminal = () => ref.current.reload();
  window.terminalUrl = () => ref.current.getUrl();
  return <><output id="ready-count">{readyCount}</output><output id="error">{error?.code ?? ''}</output>
    <NimbusTerminal ref={ref} className="component" endpoint={endpoint} token={token} tenant="probe" sessionId=${JSON.stringify(box.id)}
      onReady={() => setReadyCount((count) => count + 1)} onError={setError} style={{ height: 400 }} />
    <Headless />
  </>;
}
createRoot(document.getElementById('root')).render(<App />);
`, resolveDir: process.cwd(), loader: 'tsx' },
    write: false, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic',
    alias: { react: dirname(require.resolve('react')), 'react-dom': dirname(require.resolve('react-dom')) },
    conditions: ['workspace'],
  });
  browser = await launchBrowser({ webSecurity: true });
  const { page, pageErrors } = await openPage(browser, box.id);
  page.on('framenavigated', (frame) => {
    const url = new URL(frame.url());
    const match = /^\/s\/([^/]+)\//.exec(url.pathname);
    if (url.origin === new URL(BASE).origin && match) sessions.add(match[1]);
  });
  const host = `${BASE}/__react-controller-probe`;
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.url() === host) return request.respond({ contentType: 'text/html', body: '<!doctype html><div id="root"></div><script src="/__react-controller.js"></script>' });
    if (request.url() === `${BASE}/__react-controller.js`) return request.respond({ contentType: 'text/javascript', body: bundled.outputFiles[0].text });
    return request.continue();
  });
  await page.goto(host, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => document.getElementById('ready-count')?.textContent === '1'
    && document.getElementById('headless')?.dataset.ready === 'true'
    && document.getElementById('headless').dataset.sessionId, { timeout: 90_000 });
  a.check('component and headless hook independently consume real shell ready events', true);
  const allocated = await page.$eval('#headless', (element) => element.dataset.sessionId);
  a.check('the headless controller discovers the session allocated by /new', allocated !== box.id && sessions.has(allocated));
  const url = new URL(await page.evaluate(() => window.terminalUrl()));
  a.check('the component consumes the canonical SDK attach URL', url.pathname === `/s/${box.id}/` && url.searchParams.get('nimbus_token') === AUTH_TOKEN);
  await page.evaluate(() => new Promise((resolve) => {
    const barrier = (event) => { if (event.data?.type === 'probe:barrier') { window.removeEventListener('message', barrier); requestAnimationFrame(resolve); } };
    window.addEventListener('message', barrier);
    window.postMessage({ type: 'nimbus:error', code: 'E_WS_CLOSED', message: 'wrong source' }, location.origin);
    window.postMessage({ type: 'probe:barrier' }, location.origin);
  }));
  a.check('same-origin events from outside each iframe are ignored', await page.$eval('#error', (element) => element.textContent) === '');
  await page.evaluate(() => window.reloadTerminal());
  await page.waitForFunction(() => document.getElementById('ready-count').textContent === '2', { timeout: 90_000 });
  a.check('imperative reload goes through the shared controller and reconnects', true);
  const frame = await (await page.$('iframe.component')).contentFrame();
  await frame.evaluate(() => parent.postMessage({ type: 'nimbus:error', code: 'E_WS_CLOSED', message: 'transport failure' }, location.origin));
  await page.waitForFunction(() => document.getElementById('error').textContent === 'E_WS_CLOSED', { timeout: 10_000 });
  a.check('an iframe error reaches its component without contaminating the headless session', await page.$eval('#headless', (element) => element.dataset.error === '' && element.dataset.ready === 'true'));
  a.check('the React integrations cause no browser errors', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  if (browser) await browser.close();
  for (const sid of sessions) {
    const destroyed = await client.sandbox(sid).destroy({ reason: 'react-controller-probe-complete' });
    a.check('the SDK-owned sandbox is destroyed', destroyed.ok === true && typeof destroyed.destroyedAt === 'number');
  }
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
