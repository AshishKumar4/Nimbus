import { mintSession, deleteSession, BASE, AUTH_TOKEN, makeAsserter } from '../../../_driver.mjs';
import { launchBrowser, openPage } from '../../../_runtime-behavioral-template.mjs';
import { Nimbus } from '../../../../../packages/sdk/src/index.ts';

const a = makeAsserter('editor/monaco/new/ctrl-s-saves-file');
const sid = await mintSession();
const box = Nimbus.connect({ endpoint: BASE, token: AUTH_TOKEN }).sandbox(sid);
const path = '/home/user/ctrl-s-target.txt';
const content = 'saved by the keyboard\nsecond line\n  indented';
let browser;
try {
  await box.files.write(path, 'original content');
  browser = await launchBrowser({ webSecurity: true });
  const { page, pageErrors } = await openPage(browser, sid);
  async function openFile() {
    await page.waitForFunction(() => window.__nimbusMonacoEditor && document.getElementById('editorTab').textContent.includes('welcome.md'), { timeout: 60_000 });
    await page.click('#editorPanel .monaco-editor');
    await page.keyboard.down('Control');
    await page.keyboard.press('p');
    await page.keyboard.up('Control');
    await page.waitForSelector('#paletteOverlay.active #paletteInput', { visible: true, timeout: 15_000 });
    await page.type('#paletteInput', 'ctrl-s-target');
    await page.waitForSelector('.palette-item', { visible: true, timeout: 15_000 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('editorTab').textContent === 'ctrl-s-target.txt', { timeout: 30_000 });
  }
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await openFile();
  await page.evaluate(() => window.__nimbusMonacoEditor.focus());
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.type(content);
  await page.waitForFunction(() => document.getElementById('editorTab').classList.contains('dirty'), { timeout: 10_000 });
  await page.keyboard.down('Control');
  await page.keyboard.press('s');
  await page.keyboard.up('Control');
  await page.waitForFunction(() => !document.getElementById('editorTab').classList.contains('dirty'), { timeout: 20_000 });
  a.check('Ctrl+S saves the typed Monaco buffer to the real VFS', await box.files.read(path) === content);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await openFile();
  a.check('the saved file survives a fresh shell connection', await page.evaluate(() => window.__nimbusMonacoEditor.getValue()) === content);
  a.check('the keyboard workflow causes no browser errors', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  if (browser) await browser.close();
  await deleteSession(sid);
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
