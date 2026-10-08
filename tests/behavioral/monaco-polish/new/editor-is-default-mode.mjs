// R — A desktop session boots into Editor, preserves saved pane dimensions,
// and selects Agent on boot only when /s/<sid>/?agent=1 asks for it.
import { BASE, deleteSession, makeAsserter, mintSession } from '../../_driver.mjs';
import { launchBrowser, openPage } from '../../_runtime-behavioral-template.mjs';
import { waitForWorkspace, workspaceState } from '../../editor/monaco/_workspace-browser.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'monaco-polish/new/editor-is-default-mode';
const a = makeAsserter(label);
console.log(`${label} — ${BASE}`);
const sid = await mintSession();
let browser;
try {
  browser = await launchBrowser({ webSecurity: true });
  const ctx = await openPage(browser, sid);
  const page = ctx.page;
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForWorkspace(page, 'editor');
  await page.waitForFunction(() => document.getElementById('editorTab').textContent.includes('welcome.md'), { timeout: 60_000 });
  const initial = await workspaceState(page);
  a.check('desktop page-load selects the rendered editor, not Agent or a legacy mode',
    initial.editorButton.active && initial.editor.visible && initial.editorReady && !initial.agentButton.active
      && !initial.agent.visible && initial.classes.join(' ') === 'main editor', JSON.stringify(initial));
  a.check('the default editor opens welcome.md with its actual content',
    await page.evaluate(() => document.getElementById('editorTab').textContent.includes('welcome.md')
      && window.__nimbusMonacoEditor.getValue().includes('# Welcome to Nimbus')));
  a.check('default desktop mode retains explorer, terminal and preview',
    initial.tree.visible && initial.terminal.visible && initial.preview.visible, JSON.stringify(initial));

  const key = 'nimbus.pane.dims./s/' + sid;
  await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ treeWidth: 360, middlePct: 70, editorPct: 45 })), key);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForWorkspace(page, 'editor');
  await page.waitForFunction(() => {
    const tree = document.getElementById('treePanel').getBoundingClientRect();
    const editor = document.getElementById('editorPanel').getBoundingClientRect();
    const stack = document.getElementById('leftStack').getBoundingClientRect();
    const preview = document.getElementById('previewPanel').getBoundingClientRect();
    return Math.abs(tree.width - 360) <= 2 && Math.abs(stack.width / (stack.width + preview.width) - 0.7) <= 0.01
      && Math.abs(editor.height / (stack.height - 4) - 0.45) <= 0.01;
  }, { timeout: 15_000 });
  a.check('boot restores saved tree width and both workspace splits while retaining Editor', true);

  await page.evaluate(() => releaseTerminal(10_000));
  await page.goto(`${BASE}/s/${sid}/?agent=1`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForWorkspace(page, 'agent');
  const requested = await workspaceState(page);
  a.check('agent=1 explicitly selects Agent at desktop page-load',
    requested.agentButton.active && requested.agentReady && requested.agent.visible && !requested.editor.visible,
    JSON.stringify(requested));
  a.check('explicit Agent still uses the single desktop workspace',
    requested.classes.join(' ') === 'main editor' && requested.tree.visible && requested.terminal.visible && requested.preview.visible,
    JSON.stringify(requested));
  a.check('default-mode and explicit Agent boot cause no browser errors', ctx.pageErrors.length === 0, JSON.stringify(ctx.pageErrors));
} finally {
  try { await browser?.close(); }
  finally { await deleteSession(sid); }
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
