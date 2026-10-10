import { BASE, mintSession, deleteSession, makeAsserter, requestHeaders } from '../../_driver.mjs';
import { launchBrowser, openPage } from '../../_runtime-behavioral-template.mjs';
import { Nimbus } from '../../../../packages/sdk/src/index.ts';
import { holdShellSocket } from '../_hold-shell-socket.mjs';

const a = makeAsserter('file-tree-fix/new/fs-request-queues-while-ws-pending');
const sid = await mintSession();
const box = Nimbus.connect({ endpoint: BASE, headers: () => requestHeaders({}, sid) }).sandbox(sid);
const path = '/home/user/queued-browser.txt';
const content = 'saved while the reconnect was pending\n';
const browser = await launchBrowser();
try {
  const { page, pageErrors } = await openPage(browser, sid);
  await page.evaluateOnNewDocument(holdShellSocket);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => document.getElementById('treeBody').textContent.includes('Waiting for connection'), { timeout: 20_000 });
  await page.waitForFunction(() => window.__nimbusMonacoEditor, { timeout: 30_000 });
  page.once('dialog', (dialog) => dialog.accept('queued-browser.txt'));
  await page.click('#btnTreeNewFile');
  a.check('the toolbar write waits alongside initial editor-read and tree-list requests', await box.files.exists(path) === false);
  a.check('requests do not send while CONNECTING', await page.evaluate(() => window.__probeHeld.sendsWhileHeld === 0));
  await page.evaluate(() => window.__probeReleaseWs());
  await page.waitForSelector(`.tree-node[data-path="${path}"]`, { visible: true, timeout: 30_000 });
  await page.waitForFunction(() => document.getElementById('editorTab').textContent === 'queued-browser.txt'
    && window.__nimbusMonacoEditor.getValue() === '', { timeout: 30_000 });
  a.check('queued write, read and list complete in the correct views after opening', await box.files.read(path) === '');

  await page.evaluate(() => { window.__probeHoldNextWs(); ws.close(4000, 'hold reconnect'); });
  await page.waitForFunction(() => window.__probeHeld.sockets === 2 && ws.readyState === WebSocket.CONNECTING, { timeout: 15_000 });
  await page.evaluate((content) => { window.__nimbusMonacoEditor.setValue(content); window.__nimbusMonacoEditor.focus(); }, content);
  await page.keyboard.down('Control');
  await page.keyboard.press('s');
  await page.keyboard.up('Control');
  await page.click('#btnTreeRefresh');
  a.check('a save stays pending until the replacement socket opens', await box.files.read(path) === '');
  a.check('neither view sends a request on the connecting replacement', await page.evaluate(() => window.__probeHeld.sendsWhileHeld === 0));
  await page.evaluate(() => window.__probeReleaseWs());
  await page.waitForFunction(() => !document.getElementById('editorTab').classList.contains('dirty')
    && document.querySelector('.tree-node[data-path="/home/user/queued-browser.txt"]'), { timeout: 30_000 });
  a.check('queued save and refresh complete after reconnect', await box.files.read(path) === content);
  a.check('no request failure or page error', pageErrors.length === 0
    && await page.evaluate(() => !window.__probeHeld.treeTexts.some((text) => /failed|not connected/i.test(text))), JSON.stringify(pageErrors));
} finally {
  await browser.close();
  await deleteSession(sid);
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
