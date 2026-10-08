// R — Desktop Editor/Agent buttons replace only the center surface at
// /s/<sid>/. The explorer, terminal, preview and file palette remain usable.
import { BASE, deleteSession, makeAsserter, mintSession } from '../../../_driver.mjs';
import { launchBrowser, openPage } from '../../../_runtime-behavioral-template.mjs';
import { waitForWorkspace, workspaceState } from '../_workspace-browser.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'editor/monaco/new/workspace-surface-toggle';
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
  const editor = await workspaceState(page);
  a.check('Editor selects a rendered Monaco surface in the single workspace',
    editor.classes.join(' ') === 'main editor' && editor.editorReady && editor.editor.visible && !editor.agent.visible,
    JSON.stringify(editor));

  await page.click('#btnAgent');
  await waitForWorkspace(page, 'agent');
  const agent = await workspaceState(page);
  a.check('Agent button selects the loaded chat surface in the center stack',
    agent.agentButton.active && agent.agentSurface && agent.agentReady && agent.agent.visible && !agent.editor.visible,
    JSON.stringify(agent));
  a.check('Agent replaces the editor only, keeping the workspace and surrounding panes',
    agent.classes.join(' ') === 'main editor' && agent.tree.visible && agent.terminal.visible && agent.preview.visible,
    JSON.stringify(agent));
  a.check('Agent occupies the editor slot without moving the outer panes',
    Math.abs(agent.agent.x - editor.editor.x) <= 1 && Math.abs(agent.agent.width - editor.editor.width) <= 1
      && Math.abs(agent.tree.width - editor.tree.width) <= 1 && Math.abs(agent.preview.x - editor.preview.x) <= 1,
    JSON.stringify({ editor, agent }));

  await page.click('#btnEditor');
  await waitForWorkspace(page, 'editor');
  const restored = await workspaceState(page);
  a.check('Editor button restores Monaco and hides Agent without changing the open file',
    restored.editorButton.active && restored.editor.visible && !restored.agent.visible && restored.tab === editor.tab,
    JSON.stringify(restored));

  await page.keyboard.down('Control');
  await page.keyboard.press('p');
  await page.keyboard.up('Control');
  await page.waitForSelector('#paletteOverlay.active #paletteInput', { visible: true, timeout: 15_000 });
  await page.type('#paletteInput', 'hello.js');
  await page.waitForFunction(() => [...document.querySelectorAll('.palette-item')].some((item) => item.textContent.includes('hello.js')), { timeout: 15_000 });
  a.check('the workspace file palette opens and renders matching results', true);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('editorTab').textContent.includes('hello.js')
    && !document.getElementById('paletteOverlay').classList.contains('active'), { timeout: 30_000 });
  a.check('choosing a palette result opens its file in Monaco',
    await page.evaluate(() => window.__nimbusMonacoEditor.getValue().length > 0));
  a.check('surface switching and file selection cause no browser errors', ctx.pageErrors.length === 0, JSON.stringify(ctx.pageErrors));
} finally {
  try { await browser?.close(); }
  finally { await deleteSession(sid); }
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
