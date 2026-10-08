// R — Desktop exposes one workspace. Its Editor/Agent controls replace the
// center surface; removed Terminal/Preview/Split/Edit+Preview modes stay absent.
import { BASE, deleteSession, makeAsserter, mintSession } from '../../../_driver.mjs';
import { launchBrowser, openPage } from '../../../_runtime-behavioral-template.mjs';
import { waitForWorkspace, workspaceState } from '../_workspace-browser.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'editor/monaco/regression/single-workspace-no-legacy-modes';
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
  for (const id of ['btnTerminal', 'btnPreview', 'btnSplit', 'btnEditorTerm']) {
    a.check(`#${id} legacy control is absent from the served workspace`, await page.$('#' + id) === null);
  }
  const navigation = await page.evaluate(() => [...document.querySelectorAll('#toolbar button')]
    .filter((button) => button.getBoundingClientRect().width > 0 && button.getBoundingClientRect().height > 0)
    .map((button) => button.textContent.trim()));
  a.check('desktop has no Terminal, Preview, Split or Edit+Preview mode control',
    !navigation.some((label) => ['Terminal', 'Preview', 'Split', 'Edit+Preview', 'Edit + Preview'].includes(label)), JSON.stringify(navigation));
  a.check('desktop exposes its Editor and Agent workspace controls',
    navigation.includes('Editor') && navigation.includes('Agent'), JSON.stringify(navigation));

  for (const [button, surface] of [['#btnAgent', 'agent'], ['#btnEditor', 'editor']]) {
    await page.click(button);
    await waitForWorkspace(page, surface);
    const state = await workspaceState(page);
    for (const mode of ['terminal-only', 'preview-only', 'split', 'agent', 'editor-split', 'editor-split-with-term']) {
      a.check(`${surface}: the main workspace never enters ${mode}`, !state.classes.includes(mode), JSON.stringify(state.classes));
    }
    a.check(`${surface}: only the center surface changes, with regular terminal and preview panels`,
      state.classes.join(' ') === 'main editor' && state.tree.visible && state.terminal.visible && state.preview.visible
        && state.agentSurface === (surface === 'agent'), JSON.stringify(state));
    for (const handle of ['#treeResizeHandle', '#resizeHandle', '#editorTerminalResizeHandle']) {
      a.check(`${surface}: ${handle} remains a visible workspace resize handle`,
        await page.$eval(handle, (element) => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0));
    }
  }
  a.check('single-workspace controls cause no browser errors', ctx.pageErrors.length === 0, JSON.stringify(ctx.pageErrors));
} finally {
  try { await browser?.close(); }
  finally { await deleteSession(sid); }
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
