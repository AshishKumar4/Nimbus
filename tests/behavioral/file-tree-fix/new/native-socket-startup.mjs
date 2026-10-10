import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { BASE, WS_BASE, mintSession, deleteSession, makeAsserter, requestHeaders, wsHeaders } from '../../_driver.mjs';
import { launchBrowser, openPage } from '../../_runtime-behavioral-template.mjs';
import { Nimbus } from '../../../../packages/sdk/src/index.ts';

const a = makeAsserter('file-tree-fix/new/native-socket-startup');
const sid = await mintSession();
const box = Nimbus.connect({ endpoint: BASE, headers: () => requestHeaders({}, sid) }).sandbox(sid);
const path = '/home/user/native-startup.txt';
const content = 'saved after a real native WebSocket handshake\n';
const proxyErrors = [];
let receivedUpgrade;
const upgraded = new Promise((resolve) => { receivedUpgrade = resolve; });
let browser;
const bridge = spawn('node', [new URL('../_native-socket-bridge.mjs', import.meta.url).pathname], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
bridge.on('message', (message) => {
  if (message.type === 'pending') receivedUpgrade();
  if (message.type === 'error') proxyErrors.push(message.message);
});
bridge.stderr.on('data', (message) => proxyErrors.push(String(message)));
const listening = once(bridge, 'message');
try {
  bridge.send({ type: 'start', url: `${WS_BASE}/s/${sid}/ws`, options: wsHeaders(sid) });
  const [ready] = await Promise.race([listening, new Promise((_, reject) => setTimeout(() => reject(new Error('native WebSocket bridge did not start')), 10_000))]);
  const proxyUrl = `ws://127.0.0.1:${ready.port}/`;
  await box.files.write(path, 'initial native file');
  browser = await launchBrowser({ args: ['--allow-running-insecure-content'] });
  const { page, pageErrors } = await openPage(browser, sid);
  await page.evaluateOnNewDocument((proxyUrl) => {
    const Native = window.WebSocket;
    window.__probeNativeWebSocket = Native;
    function Routed(url, protocols) {
      const parsed = new URL(url, location.href);
      const socket = new Native(/\/s\/[^/]+\/ws$/.test(parsed.pathname) && !parsed.search ? proxyUrl : url, protocols);
      if (socket.url === proxyUrl) window.__probeNativeSocket = socket;
      return socket;
    }
    Routed.prototype = Native.prototype;
    Object.assign(Routed, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Routed;
  }, proxyUrl);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => document.getElementById('treeBody').textContent.includes('Waiting for connection'), { timeout: 20_000 });
  await Promise.race([upgraded, new Promise((_, reject) => setTimeout(() => reject(new Error('bridge never received the native HTTP Upgrade')), 10_000))]);
  a.check('the browser owns a native CONNECTING WebSocket, not a facade', await page.evaluate(() =>
    ws === window.__probeNativeSocket && ws instanceof window.__probeNativeWebSocket && ws.readyState === 0));
  a.check('the bridge received the real HTTP Upgrade before releasing it', true);
  a.check('the tree waits without a request failure', await page.$eval('#treeBody', (element) => !/failed/i.test(element.textContent)));
  bridge.send({ type: 'accept' });
  await page.waitForSelector(`.tree-node[data-path="${path}"]`, { visible: true, timeout: 30_000 });
  a.check('the queued tree listing arrives after the native handshake', true);
  await page.locator(`.tree-node[data-path="${path}"]`).click();
  await page.waitForFunction(() => window.__nimbusMonacoEditor?.getValue() === 'initial native file', { timeout: 30_000 });
  await page.evaluate(() => window.__nimbusMonacoEditor.focus());
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.type(content);
  await page.waitForFunction(() => document.getElementById('editorTab').classList.contains('dirty'), { timeout: 10_000 });
  await page.keyboard.down('Control');
  await page.keyboard.press('s');
  await page.keyboard.up('Control');
  await page.waitForFunction(() => !document.getElementById('editorTab').classList.contains('dirty'), { timeout: 30_000 });
  a.check('a real browser save after early page startup reaches the session VFS', await box.files.read(path) === content);
  if (process.env.NIMBUS_PROBE_SCREENSHOTS) await page.screenshot({ path: join(process.env.NIMBUS_PROBE_SCREENSHOTS, 'native-socket-startup-save.png') });
  a.check('no browser or upstream errors', pageErrors.length === 0 && proxyErrors.length === 0, JSON.stringify({ pageErrors, proxyErrors }));
} finally {
  if (browser) await browser.close();
  if (bridge.exitCode === null) {
    const stopped = once(bridge, 'close');
    bridge.kill('SIGTERM');
    await stopped;
  }
  await deleteSession(sid);
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
