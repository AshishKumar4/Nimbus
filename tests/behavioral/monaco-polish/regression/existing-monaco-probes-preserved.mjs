import { BASE, mintSession, deleteSession, makeAsserter, requestHeaders } from '../../_driver.mjs';
import { launchBrowser, openPage } from '../../_runtime-behavioral-template.mjs';
import { Nimbus } from '../../../../packages/sdk/src/index.ts';

const a = makeAsserter('monaco-polish/regression/existing-monaco-probes-preserved');
const sid = await mintSession();
const box = Nimbus.connect({ endpoint: BASE, headers: () => requestHeaders({}, sid) }).sandbox(sid);
const path = '/home/user/preserved-editor.txt';
const content = 'persisted through the editor transport\n';
const browser = await launchBrowser();
try {
  await box.files.write(path, 'original');
  const { page, pageErrors } = await openPage(browser, sid);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__nimbusMonacoEditor && document.getElementById('editorTab').textContent.includes('welcome.md'), { timeout: 60_000 });
  await page.waitForSelector(`.tree-node[data-path="${path}"]`, { visible: true, timeout: 30_000 });
  a.check('the editor and tree load real session data', true);
  await page.locator(`.tree-node[data-path="${path}"]`).click();
  await page.waitForFunction(() => window.__nimbusMonacoEditor.getValue() === 'original', { timeout: 30_000 });
  a.check('selecting a file opens it and updates the selected tree row', await page.$eval(`.tree-node[data-path="${path}"]`, (element) => element.classList.contains('selected')));
  await page.evaluate((content) => { window.__nimbusMonacoEditor.setValue(content); window.__nimbusMonacoEditor.focus(); }, content);
  await page.waitForFunction(() => document.getElementById('editorTab').classList.contains('dirty')
    && document.querySelector('.tree-node[data-path="/home/user/preserved-editor.txt"]').classList.contains('dirty'), { timeout: 10_000 });
  a.check('editing marks both the tab and tree row dirty', true);
  await page.keyboard.down('Control');
  await page.keyboard.press('s');
  await page.keyboard.up('Control');
  await page.click('#btnTreeRefresh');
  await page.waitForFunction(() => !document.getElementById('editorTab').classList.contains('dirty')
    && document.querySelector('.tree-node[data-path="/home/user/preserved-editor.txt"]'), { timeout: 30_000 });
  a.check('save and concurrent tree refresh resolve through the shared connection', await box.files.read(path) === content);
  await page.click('#btnEditor');
  await page.click('#editorPanel .monaco-editor');
  a.check('the command palette starts closed', await page.$eval('#paletteOverlay', (element) => !element.classList.contains('active')));
  await page.keyboard.down('Control');
  await page.keyboard.press('p');
  await page.keyboard.up('Control');
  await page.waitForSelector('#paletteOverlay.active #paletteInput', { visible: true, timeout: 15_000 });
  await page.type('#paletteInput', 'welcome.md');
  await page.waitForSelector('.palette-item', { visible: true, timeout: 15_000 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('editorTab').textContent.includes('welcome.md')
    && window.__nimbusMonacoEditor.getValue().includes('Welcome to Nimbus'), { timeout: 30_000 });
  a.check('Ctrl+P lists files and opening a result reads its content', true);
  await page.locator(`.tree-node[data-path="${path}"]`).click();
  await page.waitForFunction((content) => window.__nimbusMonacoEditor.getValue() === content, { timeout: 30_000 }, content);
  a.check('reopening the edited file reads the saved buffer', true);
  a.check('no page errors during editor, tree and palette workflows', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  await browser.close();
  await deleteSession(sid);
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
