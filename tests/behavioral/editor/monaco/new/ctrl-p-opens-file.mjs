import { mintSession, deleteSession, BASE, AUTH_TOKEN, makeAsserter } from '../../../_driver.mjs';
import { launchBrowser, openPage } from '../../../_runtime-behavioral-template.mjs';
import { Nimbus } from '../../../../../packages/sdk/src/index.ts';

const a = makeAsserter('editor/monaco/new/ctrl-p-opens-file');
const sid = await mintSession();
const box = Nimbus.connect({ endpoint: BASE, token: AUTH_TOKEN }).sandbox(sid);
const content = 'const paletteSelected = 42;\n';
let browser;
try {
  await box.files.write('/home/user/palette-target.js', content);
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
  a.check('the keyboard workflow causes no browser errors', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  if (browser) await browser.close();
  await deleteSession(sid);
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
