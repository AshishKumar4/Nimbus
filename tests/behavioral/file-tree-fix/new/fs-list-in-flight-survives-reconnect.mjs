#!/usr/bin/env bun
// file-tree-fix/new/fs-list-in-flight-survives-reconnect — a listing the
// tree has sent when its socket drops, unanswered, is sent again on the
// replacement socket: the tree loads, and never says the listing failed.
// A write in flight is not sent again (it may have been done); that is
// fs-request-queues-while-ws-pending's save, sent only once the new socket opens.
import { BASE, mintSession, deleteSession, makeAsserter, requestHeaders } from '../../_driver.mjs';
import { launchBrowser, openPage } from '../../_runtime-behavioral-template.mjs';
import { Nimbus } from '../../../../packages/sdk/src/index.ts';
import { holdShellSocket } from '../_hold-shell-socket.mjs';

const a = makeAsserter('file-tree-fix/new/fs-list-in-flight-survives-reconnect');
const sid = await mintSession();
const box = Nimbus.connect({ endpoint: BASE, headers: () => requestHeaders({}, sid) }).sandbox(sid);
const path = '/home/user/listed-across-reconnect.txt';
const browser = await launchBrowser();
try {
  await box.files.write(path, 'listed\n');
  const { page, pageErrors } = await openPage(browser, sid);
  await page.evaluateOnNewDocument(holdShellSocket);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.evaluate(() => window.__probeReleaseWs());
  await page.waitForSelector(`.tree-node[data-path="${path}"]`, { visible: true, timeout: 30_000 });

  // A refresh's listing goes out, and its answer is lost with the socket.
  await page.evaluate(() => window.__probeDropReplies(true));
  const before = await page.evaluate(() => window.__probeHeld.sent);
  await page.click('#btnTreeRefresh');
  await page.waitForFunction((before) => window.__probeHeld.sent > before, { timeout: 15_000 }, before);
  await page.evaluate(() => { window.__probeHoldNextWs(); ws.close(4000, 'drop with a listing in flight'); });
  await page.waitForFunction(() => window.__probeHeld.sockets === 2 && ws.readyState === WebSocket.CONNECTING, { timeout: 15_000 });
  await page.evaluate(() => { window.__probeDropReplies(false); window.__probeReleaseWs(); });

  const loaded = await page.waitForSelector(`.tree-node[data-path="${path}"]`, { visible: true, timeout: 30_000 }).then(() => true, () => false);
  a.check('the tree lists the folder on the replacement socket', loaded);
  const failed = await page.evaluate(() => window.__probeHeld.treeTexts.filter((text) => /failed|not connected/i.test(text)));
  a.check('the tree never says the listing failed', failed.length === 0, JSON.stringify(failed));
  a.check('no page error', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  await browser.close();
  await deleteSession(sid);
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
