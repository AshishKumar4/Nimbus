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
let browser, ctx, page;

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
  browser = await launchBrowser({ timeout: 60_000, webSecurity: true });
  ctx = await openPage(browser, sid);
  page = ctx.page;
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

  await page.click('#btnPhoneFiles');
  await pane('#treePanel');
  await page.click('#btnTreeRefresh');
  await page.waitForSelector('.tree-node[data-path="/home/user/phone-layout.js"]', { visible: true, timeout: 30_000 });
  await screenshot('phone-files-390x844');
  await page.click('.tree-node[data-path="/home/user/phone-layout.js"]');
  await page.waitForFunction((content) => window.__nimbusMonacoEditor?.getValue() === content
    && document.querySelector('.monaco-editor .view-lines')?.getBoundingClientRect().width > 0, { timeout: 60_000 }, FILE_CONTENT);
  await pane('#editorPanel');
  a.check('choosing a file opens its real content in the full-width editor',
    await page.evaluate((content) => document.getElementById('editorTab').textContent.includes('phone-layout.js')
      && window.__nimbusMonacoEditor.getValue() === content, FILE_CONTENT));
  await screenshot('phone-editor-390x844');

  await page.click('#btnAgent');
  await page.waitForFunction(() => document.getElementById('agentStatus')?.textContent
    && document.getElementById('agentStatus').textContent !== 'Checking...', { timeout: 30_000 });
  await pane('#agentPanel');
  const agentControls = await page.evaluate(() => [...document.querySelectorAll('.agent-top button, .agent-top select, #agentStatus')].every((control) => {
    const rect = control.getBoundingClientRect();
    return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && control.scrollWidth <= control.clientWidth + 1;
  }));
  a.check('Agent actions and status stay fully on screen', agentControls);
  await screenshot('phone-agent-390x844');
  await page.click('#btnEditor');
  await pane('#editorPanel');
  a.check('switching through Agent preserves the open file',
    await page.evaluate((content) => window.__nimbusMonacoEditor.getValue() === content, FILE_CONTENT));

  const app = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phone preview</title><style>body{margin:24px;font:18px system-ui}button{padding:12px;font:inherit}</style><h1>Nimbus preview</h1><button id="counter">Clicks 0</button><script>let n=0;counter.onclick=()=>counter.textContent='Clicks '+(++n)</script>`;
  const server = `require('http').createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(${JSON.stringify(app)});}).listen(3000,()=>console.log('phone-preview-ready'));`;
  await page.click('#btnPhoneTerminal');
  await pane('#terminal-container');
  await command(`printf '%s' '${Buffer.from(server).toString('base64')}' | base64 -d > phone-server.js; node --watch phone-server.js`, /phone-preview-ready/);
  await page.waitForFunction(() => [...document.querySelectorAll('#previewTabs .preview-tab')].some((tab) => tab.textContent.includes(':3000')), { timeout: 60_000 });
  await page.click('#btnPhonePreview');
  await pane('#previewPanel');
  await page.waitForFunction(() => document.getElementById('preview-frame').src.includes('/port/3000/'), { timeout: 30_000 });
  const frame = await (await page.$('#preview-frame')).contentFrame();
  if (!frame) throw new Error('the preview frame never reached the port app');
  await frame.waitForSelector('#counter', { visible: true, timeout: 30_000 });
  await frame.click('#counter');
  a.check('the live port preview is usable and interactive on the phone',
    await frame.$eval('#counter', (button) => button.textContent) === 'Clicks 1');
  await screenshot('phone-preview-390x844');
  await page.click('#btnPhoneTerminal');
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
    return { tree: rect('#treePanel'), editor: rect('#editorPanel'), terminal: rect('#terminal-container'), preview: rect('#previewPanel'), phoneButton: rect('#btnPhoneTerminal') };
  });
  a.check('desktop keeps the explorer, editor/terminal stack and preview side by side',
    desktop.tree.width >= 160 && desktop.editor.width >= 250 && desktop.terminal.width >= 250 && desktop.preview.width >= 250
      && desktop.editor.x >= desktop.tree.x + desktop.tree.width && desktop.preview.x >= desktop.editor.x + desktop.editor.width
      && desktop.terminal.y > desktop.editor.y && desktop.phoneButton.width === 0, JSON.stringify(desktop));
  await screenshot('desktop-workspace-1440x900');

  await page.setViewport({ width: 390, height: 844 });
  await page.click('#btnPhoneTerminal');
  const tui = `process.stdout.write('\\x1b[2J\\x1b[HPHONE_TUI_READY\\r\\n');
process.stdin.setRawMode?.(true);
process.stdin.resume();
let input = '';
process.stdin.on('data', (chunk) => {
  const text = String(chunk);
  if (text.includes('q')) process.exit(0);
  input += text;
  process.stdout.write('INPUT ' + input.replace(/\\r/g, '<CR>').replace(/\\n/g, '<LF>') + '\\r\\n');
  if (text.includes('\\r') || text.includes('\\n')) input = '';
});
setInterval(() => {}, 1000);`;
  const files = {
    'phone-tui/package.json': JSON.stringify({ name: 'phone-tui', version: '1.0.0', bin: { 'phone-tui': 'cli.js' }, nimbus: { terminal: 'attached' } }),
    'phone-tui/cli.js': tui,
    '.bin/phone-tui': "#!/usr/bin/env node\nrequire('../phone-tui/cli.js');\n",
  };
  const setup = ['mkdir -p node_modules/phone-tui node_modules/.bin', ...Object.entries(files).map(([path, content]) =>
    `printf '%s' '${Buffer.from(content).toString('base64')}' | base64 -d > node_modules/${path}`),
    `printf 'tui-files-%s\\n' "$((6*7))"`].join('; ');
  await command(setup, /tui-files-42/);
  await page.keyboard.type('phone-tui');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.logs-view.active.terminal-view .xterm-rows')?.innerText.includes('PHONE_TUI_READY'), { timeout: 60_000 });

  for (const [away, viewport, text] of [
    ['#btnPhoneFiles', { width: 390, height: 844 }, 'files-return'],
    ['#btnEditor', { width: 640, height: 390 }, 'resize-return'],
    ['#btnEditor', { width: 390, height: 844 }, 'portrait-return'],
  ]) {
    await page.click(away);
    await page.setViewport(viewport);
    await page.click('#btnPhoneTerminal');
    await page.waitForFunction(() => {
      const view = document.querySelector('.logs-view.active.terminal-view');
      const screen = view?.querySelector('.xterm-screen')?.getBoundingClientRect();
      const panel = document.getElementById('logsPanelBody').getBoundingClientRect();
      return view?.contains(document.activeElement) && document.activeElement?.classList.contains('xterm-helper-textarea')
        && screen.width >= innerWidth * 0.9 && screen.width <= panel.width && screen.height <= panel.height;
    }, { timeout: 15_000 });
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    await page.waitForFunction((text) => document.querySelector('.logs-view.active.terminal-view .xterm-rows')?.innerText.includes(text + '<CR>'), { timeout: 15_000 }, text);
    a.check(`${text}: returning to Terminal refits and focuses the TUI; typed input arrives there`, true);
  }
  await screenshot('phone-attached-tui-390x844');
  await page.keyboard.type('q');
  await page.waitForFunction(() => [...document.querySelectorAll('.proc-item.exited')].some((item) => item.textContent.includes('phone-tui')), { timeout: 30_000 });
  a.check('switching and resizing cause no browser runtime errors', ctx.pageErrors.length === 0, JSON.stringify(ctx.pageErrors));
} catch (error) {
  if (page) {
    await screenshot('failure');
    console.error('[shell-phone] failure state', await page.evaluate(() => ({
      pane: document.getElementById('mainPanel').dataset.pane,
      tab: document.getElementById('editorTab').textContent,
      status: document.getElementById('editorStatus').textContent,
      content: window.__nimbusMonacoEditor?.getValue(),
      tui: (() => {
        const view = document.querySelector('.logs-view.active.terminal-view');
        const rect = (element) => {
          const box = element?.getBoundingClientRect();
          return box && { width: box.width, height: box.height, top: box.top, bottom: box.bottom };
        };
        return {
          focused: view?.contains(document.activeElement),
          view: rect(view), screen: rect(view?.querySelector('.xterm-screen')),
          panel: rect(document.getElementById('logsPanelBody')),
          scroll: (() => {
            const viewport = view?.querySelector('.xterm-viewport');
            return viewport && { top: viewport.scrollTop, height: viewport.scrollHeight, client: viewport.clientHeight };
          })(),
        };
      })(),
    })));

  }
  throw error;
} finally {
  try { await ctx?.close(); }
  finally {
    try { await browser?.close(); }
    finally { await deleteSession(sid); }
  }
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
