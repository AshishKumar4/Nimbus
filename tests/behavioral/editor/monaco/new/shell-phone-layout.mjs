// R — A phone uses one full-width shell pane at a time. At /s/<sid>/,
// switch Terminal/Files/Editor/Agent/Preview, type a command, open a file,
// and click a live port app. The old fixed columns leave ~80 px per pane.
// Screenshots use the existing NIMBUS_PROBE_SCREENSHOTS capture hook.
import { join } from 'node:path';
import { BASE, deleteSession, makeAsserter, mintSession } from '../../../_driver.mjs';
import { launchBrowser, openPage, waitForSessionTerminalText } from '../../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'editor/monaco/new/shell-phone-layout';
const FILE_CONTENT = '// Phone workspace\nconst answer = 42;\n';
const a = makeAsserter(label);
console.log(`${label} — ${BASE}`);
const sid = await mintSession();
const browser = await launchBrowser({ timeout: 60_000, webSecurity: true });
const ctx = await openPage(browser, sid);
const page = ctx.page;

async function screenshot(name) {
  if (process.env.NIMBUS_PROBE_SCREENSHOTS) await page.screenshot({ path: join(process.env.NIMBUS_PROBE_SCREENSHOTS, 'shell-' + name + '.png') });
}

async function pane(selector) {
  await page.waitForSelector(selector, { visible: true, timeout: 30_000 });
  const measured = await page.evaluate((selector) => {
    const rect = document.querySelector(selector).getBoundingClientRect();
    const panes = ['#terminal-container', '#editorPanel', '#agentPanel', '#treePanel', '#previewPanel'];
    return {
      width: rect.width, height: rect.height, left: rect.left, right: rect.right, viewport: innerWidth,
      visible: panes.filter((name) => {
        const box = document.querySelector(name).getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      }),
      overflow: document.body.scrollWidth > innerWidth + 1,
    };
  }, selector);
  a.check(`${selector}: the phone pane fills at least 90% of the viewport`,
    measured.width >= measured.viewport * 0.9 && measured.left >= 0 && measured.right <= measured.viewport + 1 && !measured.overflow,
    JSON.stringify(measured));
  a.check(`${selector}: switching shows only the chosen pane`,
    measured.visible.length === 1 && measured.visible[0] === selector, JSON.stringify(measured));
  console.log(`[shell-phone] ${selector} ${JSON.stringify(measured)}`);
  return measured;
}

async function command(text, output) {
  await page.click('#terminal-container .xterm-helper-textarea');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await waitForSessionTerminalText(page, output, 60_000);
}

try {
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => document.getElementById('editorTab').textContent.includes('welcome.md')
    && document.querySelector('#markdown-preview-body h1')?.textContent.includes('Welcome to Nimbus'), { timeout: 90_000 });
  await waitForSessionTerminalText(page, /\$\s*$/m, 60_000);
  await screenshot('desktop-initial-1440x900');

  await page.setViewport({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForSessionTerminalText(page, /\$\s*$/m, 60_000);
  await screenshot('phone-initial-390x844');
  const initial = await pane('#terminal-container');
  if (initial.width < initial.viewport * 0.9) throw new Error('phone terminal is squeezed by the desktop columns');
  await command(`printf 'phone-layout-%s\\n' "$((6*7))"`, /phone-layout-42/);
  a.check('real terminal keystrokes execute the computed command', true);
  await command(`printf '// Phone workspace\\nconst answer = 42;\\n' > phone-layout.js; printf 'file-ready-%s\\n' "$((6*7))"`, /file-ready-42/);
  await screenshot('phone-terminal-390x844');

  await page.click('#btnFiles');
  await pane('#treePanel');
  await page.click('#btnTreeRefresh');
  await page.waitForSelector('.tree-node[data-path="/home/user/phone-layout.js"]', { visible: true, timeout: 30_000 });
  await screenshot('phone-files-390x844');
  await page.click('.tree-node[data-path="/home/user/phone-layout.js"]');
  await page.waitForFunction((content) => window.__nimbusMonacoEditor?.getValue() === content
    && document.querySelector('.monaco-editor .view-lines')?.getBoundingClientRect().width > 0, { timeout: 60_000 }, FILE_CONTENT);
  await pane('#editorPanel');
  a.check('choosing a file opens its real content in the full-width editor',
    await page.evaluate(() => document.getElementById('editorTab').textContent.includes('phone-layout.js')
      && window.__nimbusMonacoEditor.getValue() === '// Phone workspace\nconst answer = 42;\n'));
  await screenshot('phone-editor-390x844');

  await page.click('#btnAgent');
  await page.waitForFunction(() => document.getElementById('agentStatus')?.textContent
    && document.getElementById('agentStatus').textContent !== 'Checking...', { timeout: 30_000 });
  await pane('#agentPanel');
  await screenshot('phone-agent-390x844');
  await page.click('#btnEditor');
  await pane('#editorPanel');
  a.check('switching through Agent preserves the open file',
    await page.evaluate((content) => window.__nimbusMonacoEditor.getValue() === content, FILE_CONTENT));

  const app = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phone preview</title><style>body{margin:24px;font:18px system-ui}button{padding:12px;font:inherit}</style><h1>Nimbus preview</h1><button id="counter">Clicks 0</button><script>let n=0;counter.onclick=()=>counter.textContent='Clicks '+(++n)</script>`;
  const server = `require('http').createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(${JSON.stringify(app)});}).listen(3000,()=>console.log('phone-preview-ready'));`;
  await page.click('#btnTerminal');
  await pane('#terminal-container');
  await command(`printf '%s' '${Buffer.from(server).toString('base64')}' | base64 -d > phone-server.js; node --watch phone-server.js`, /phone-preview-ready/);
  await page.waitForFunction(() => [...document.querySelectorAll('#previewTabs .preview-tab')].some((tab) => tab.textContent.includes(':3000')), { timeout: 60_000 });
  await page.click('#btnPreview');
  await pane('#previewPanel');
  await page.waitForFunction(() => document.getElementById('preview-frame').src.includes('/port/3000/'), { timeout: 30_000 });
  const frame = await (await page.$('#preview-frame')).contentFrame();
  if (!frame) throw new Error('the preview frame never reached the port app');
  await frame.waitForSelector('#counter', { visible: true, timeout: 30_000 });
  await frame.click('#counter');
  a.check('the live port preview is usable and interactive on the phone',
    await frame.$eval('#counter', (button) => button.textContent) === 'Clicks 1');
  await screenshot('phone-preview-390x844');
  await page.click('#btnTerminal');
  await pane('#terminal-container');
  await command(`printf 'switch-back-%s\\n' "$((6*7))"`, /switch-back-42/);
  await screenshot('phone-terminal-process-390x844');

  await page.setViewport({ width: 1440, height: 900 });
  await page.click('#btnEditor');
  const desktop = await page.evaluate(() => {
    const rect = (selector) => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    return { tree: rect('#treePanel'), editor: rect('#editorPanel'), terminal: rect('#terminal-container'), preview: rect('#previewPanel'), phoneButton: rect('#btnTerminal') };
  });
  a.check('desktop keeps the explorer, editor/terminal stack and preview side by side',
    desktop.tree.width >= 160 && desktop.editor.width >= 250 && desktop.terminal.width >= 250 && desktop.preview.width >= 250
      && desktop.editor.x >= desktop.tree.x + desktop.tree.width && desktop.preview.x >= desktop.editor.x + desktop.editor.width
      && desktop.terminal.y > desktop.editor.y && desktop.phoneButton.width === 0, JSON.stringify(desktop));
  await screenshot('desktop-workspace-1440x900');
  a.check('switching and resizing cause no browser runtime errors', ctx.pageErrors.length === 0, JSON.stringify(ctx.pageErrors));
} catch (error) {
  await screenshot('failure');
  console.error('[shell-phone] failure state', await page.evaluate(() => ({
    pane: document.getElementById('mainPanel').dataset.pane,
    tab: document.getElementById('editorTab').textContent,
    status: document.getElementById('editorStatus').textContent,
    content: window.__nimbusMonacoEditor?.getValue(),
  })));
  throw error;
} finally {
  await ctx.close();
  await browser.close();
  await deleteSession(sid);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
