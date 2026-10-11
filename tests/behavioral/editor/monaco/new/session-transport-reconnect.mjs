import { join } from 'node:path';
import { BASE, AUTH_TOKEN, makeAsserter } from '../../../_driver.mjs';
import { launchBrowser, openPage } from '../../../_runtime-behavioral-template.mjs';
import { Nimbus } from '../../../../../packages/sdk/src/index.ts';
import { sessionAttachUrl } from '../../../../../packages/sdk/src/session.ts';

const label = 'editor/monaco/new/session-transport-reconnect';
const a = makeAsserter(label);
const sid = `job_${Date.now()}.transport`;
const box = Nimbus.connect({ endpoint: BASE, token: AUTH_TOKEN }).sandbox(sid);
const path = '/home/user/transport.js';
let browser;
try {
  await box.files.write(path, 'const answer = 1;\n');
  browser = await launchBrowser({ webSecurity: true });
  const { page, pageErrors } = await openPage(browser, sid);
  await page.goto(sessionAttachUrl(BASE, sid, AUTH_TOKEN), { waitUntil: 'domcontentloaded', timeout: 90_000 });

  for (const [layout, width, height, answer] of [['desktop', 1440, 900, 2], ['phone', 390, 844, 3]]) {
    await page.setViewport({ width, height });
    if (layout === 'phone') await page.click('#btnPhoneFiles');
    await page.waitForSelector(`.tree-node[data-path="${path}"]`, { visible: true, timeout: 60_000 });
    const previousModel = await page.evaluate(() => window.__nimbusMonacoEditor?.getModel()?.id);
    await page.locator(`.tree-node[data-path="${path}"]`).click();
    await page.waitForFunction((previous) => window.__nimbusMonacoEditor?.getModel()?.id !== previous
      && document.getElementById('editorTab').textContent === 'transport.js', { timeout: 60_000 }, previousModel);
    const content = `const answer = ${answer};\n`;
    await page.waitForFunction(() => ws.readyState === WebSocket.OPEN, { timeout: 60_000 });
    await page.evaluate((content) => {
      ws.close(4000, 'reconnect probe');
      window.__nimbusMonacoEditor.setValue(content);
      window.queuedSave = Editor.save();
      document.getElementById('btnTreeRefresh').click();
    }, content);
    await page.evaluate(() => window.queuedSave);
    a.check(`${layout}: a save queued during reconnect reaches the real VFS`, await box.files.read(path) === content);

    const watched = `/home/user/reconnected-${layout}.txt`;
    await box.files.write(watched, `watch-${layout}\n`);
    if (layout === 'phone') await page.click('#btnPhoneFiles');
    await page.waitForSelector(`.tree-node[data-path="${watched}"]`, { visible: true, timeout: 30_000 });
    a.check(`${layout}: file-watch subscription resumes after reconnect`, true);
    if (process.env.NIMBUS_PROBE_SCREENSHOTS) await page.screenshot({ path: join(process.env.NIMBUS_PROBE_SCREENSHOTS, `transport-${layout}-files.png`) });
    await page.locator(`.tree-node[data-path="${path}"]`).click();
    await page.waitForFunction((content) => window.__nimbusMonacoEditor?.getValue() === content
      && window.__nimbusMonacoEditor.getLayoutInfo().contentWidth >= 200
      && document.querySelector('.monaco-editor .view-lines')?.textContent.replace(/\u00a0/g, ' ').includes(content.trim()), { timeout: 30_000 }, content);
    a.check(`${layout}: file tree opens the saved content after reconnect`, true);
    if (process.env.NIMBUS_PROBE_SCREENSHOTS) await page.screenshot({ path: join(process.env.NIMBUS_PROBE_SCREENSHOTS, `transport-${layout}-editor.png`) });
  }
  a.check('general SDK session IDs work in the browser shell without runtime errors', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  if (browser) await browser.close();
  const destroyed = await box.destroy({ reason: 'session-transport-probe-complete' });
  a.check('the SDK-owned sandbox is destroyed', destroyed.ok === true && typeof destroyed.destroyedAt === 'number');
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
