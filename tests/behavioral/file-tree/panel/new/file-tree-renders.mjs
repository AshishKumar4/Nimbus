import { mintSession, deleteSession, BASE, makeAsserter } from '../../../_driver.mjs';
import { launchBrowser, openPage } from '../../../_runtime-behavioral-template.mjs';

const a = makeAsserter('file-tree/panel/new/file-tree-renders');
const sid = await mintSession();
const browser = await launchBrowser();
try {
  const { page, pageErrors } = await openPage(browser, sid);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#treeBody .tree-node', { visible: true, timeout: 30_000 });
  for (const selector of ['#treePanel', '#treeBody', '#treeSearch', '#treeResizeHandle', '#btnTreeNewFile', '#btnTreeNewDir', '#btnTreeRefresh']) {
    a.check(`${selector} is rendered and visible`, await page.$eval(selector, (element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    }));
  }
  await page.type('#treeSearch', 'welcome.md');
  await page.waitForFunction(() => [...document.querySelectorAll('#treeBody .tree-node')].every((row) => row.dataset.path.endsWith('/welcome.md')), { timeout: 10_000 });
  a.check('search filters actual file rows', await page.$$eval('#treeBody .tree-node', (rows) => rows.length === 1));
  await page.click('#treeSearch', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => document.querySelectorAll('#treeBody .tree-node').length > 1, { timeout: 10_000 });
  page.once('dialog', (dialog) => dialog.accept('rendered-new.txt'));
  await page.click('#btnTreeNewFile');
  await page.waitForSelector('.tree-node[data-path="/home/user/rendered-new.txt"]', { visible: true, timeout: 30_000 });
  await page.waitForFunction(() => document.getElementById('editorTab').textContent === 'rendered-new.txt', { timeout: 30_000 });
  a.check('New File renders and opens its completed filesystem write', true);
  page.once('dialog', (dialog) => dialog.accept('rendered-folder'));
  await page.click('#btnTreeNewDir');
  await page.waitForSelector('.tree-node[data-path="/home/user/rendered-folder"]', { visible: true, timeout: 30_000 });
  a.check('New Folder renders its completed filesystem write', true);
  await page.click('#btnTreeRefresh');
  await page.waitForSelector('.tree-node[data-path="/home/user/rendered-new.txt"]', { visible: true, timeout: 30_000 });
  a.check('Refresh completes and preserves filesystem entries', true);
  await page.setViewport({ width: 390, height: 844 });
  await page.click('#btnPhoneTerminal');
  a.check('the tree is hidden when the phone shows Terminal', await page.$eval('#treePanel', (element) => element.getBoundingClientRect().width === 0));
  await page.click('#btnPhoneFiles');
  await page.waitForSelector('.tree-node[data-path="/home/user/rendered-new.txt"]', { visible: true, timeout: 10_000 });
  a.check('opening Files restores the rendered tree', true);
  a.check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  await browser.close();
  await deleteSession(sid);
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
