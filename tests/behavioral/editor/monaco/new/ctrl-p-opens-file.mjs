import { mintSession, deleteSession, BASE, requestHeaders, makeAsserter } from '../../../_driver.mjs';
import { launchBrowser, openPage } from '../../../_runtime-behavioral-template.mjs';
import { Nimbus } from '../../../../../packages/sdk/src/index.ts';

const a = makeAsserter('editor/monaco/new/ctrl-p-opens-file');
const sid = await mintSession();
const box = Nimbus.connect({ endpoint: BASE, headers: () => requestHeaders({}, sid) }).sandbox(sid);
const content = 'const paletteSelected = 42;\n';
// A file name is untrusted text: a cloned repository chooses its own names.
const markupName = '<img src=x onerror=window.__paletteMarkupRan=1>.js';
const markupContent = 'const markupNamed = true;\n';
let browser;
try {
  await box.files.write('/home/user/palette-target.js', content);
  await box.files.write(`/home/user/${markupName}`, markupContent);
  browser = await launchBrowser({ webSecurity: true });
  const { page, pageErrors } = await openPage(browser, sid);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__nimbusMonacoEditor && document.getElementById('editorTab').textContent.includes('welcome.md'), { timeout: 60_000 });
  await page.click('#editorPanel .monaco-editor');
  await page.keyboard.down('Control');
  await page.keyboard.press('p');
  await page.keyboard.up('Control');
  await page.waitForSelector('#paletteOverlay.active #paletteInput', { visible: true, timeout: 15_000 });
  await page.type('#paletteInput', 'palette-target');
  await page.waitForFunction(() => [...document.querySelectorAll('.palette-item')].some((item) => item.textContent.includes('palette-target.js')), { timeout: 15_000 });
  a.check('Ctrl+P lists the real file from the session filesystem', true);
  await page.keyboard.press('Enter');
  await page.waitForFunction((content) => window.__nimbusMonacoEditor.getValue() === content
    && !document.getElementById('paletteOverlay').classList.contains('active'), { timeout: 30_000 }, content);
  a.check('choosing a palette result opens its real content in Monaco',
    await page.$eval('#editorTab', (element) => element.textContent === 'palette-target.js'));

  await page.click('#editorPanel .monaco-editor');
  await page.keyboard.down('Control');
  await page.keyboard.press('p');
  await page.keyboard.up('Control');
  await page.waitForSelector('#paletteOverlay.active #paletteInput', { visible: true, timeout: 15_000 });
  await page.type('#paletteInput', 'onerror');
  await page.waitForFunction((name) => [...document.querySelectorAll('.palette-item')].some((item) => item.textContent.endsWith(name)),
    { timeout: 15_000 }, markupName);
  a.check('Ctrl+P shows a markup-like file name as its literal text',
    await page.$$eval('#paletteList img', (images) => images.length === 0));
  a.check('a markup-like file name runs no script in the shell',
    await page.evaluate(() => window.__paletteMarkupRan === undefined));
  await page.keyboard.press('Enter');
  await page.waitForFunction((markupContent) => window.__nimbusMonacoEditor.getValue() === markupContent,
    { timeout: 30_000 }, markupContent);
  a.check('choosing the markup-like name opens that file', true);
  a.check('the keyboard workflow causes no browser errors', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  if (browser) await browser.close();
  await deleteSession(sid);
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
