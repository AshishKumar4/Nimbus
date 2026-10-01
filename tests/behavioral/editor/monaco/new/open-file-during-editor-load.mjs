// editor/monaco/new/open-file-during-editor-load — a file the user opens
// while the editor is still loading stays open, and what they type goes
// into it.
//
// The shell opens welcome.md by default once Monaco has loaded. A click on a
// file in the tree before that moment used to lose to the default: both
// opens waited for Monaco, the default was asked for after the click and
// landed last, and the user's typing went into welcome.md (or was dropped
// when the default replaced the buffer). Monaco's loader is held back two
// seconds here so the click always lands inside that window.
//
// The file is then typed into, saved with Ctrl+S, and read back from the
// session's filesystem; welcome.md must be untouched.

import { AUTH_TOKEN, BASE, Terminal, deleteSession, heredocCommand, makeAsserter, mintSession } from '../../../_driver.mjs';
import { applyProbeCookies, exchangeAttachCookie, launchBrowser } from '../../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'editor/monaco/new/open-file-during-editor-load';
const a = makeAsserter(label);
console.log(`${label} — BASE=${BASE}`);

const MARK = `typed-into-pick-${Date.now()}`;
const sid = await mintSession();
const t = new Terminal(sid);
const browser = await launchBrowser({ timeout: 60_000 });
try {
  await t.connect();
  await t.waitForPrompt(30_000);
  await t.run(heredocCommand('/home/user/pick.js', '// pick'), 15_000);
  const welcomeBefore = (await t.run('md5sum /home/user/welcome.md', 15_000)).output.match(/[0-9a-f]{32}/)?.[0];
  await t.close();

  const page = await browser.newPage();
  if (AUTH_TOKEN) await exchangeAttachCookie(page, sid);
  else await applyProbeCookies(page);
  // Hold Monaco's loader back so the click lands before the editor is ready.
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.isInterceptResolutionHandled()) return;
    if (request.url().endsWith('/vs/loader.min.js')) setTimeout(() => request.continue(), 2_000);
    else request.continue();
  });
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  await page.waitForFunction(() => [...document.querySelectorAll('.tree-node .tree-label')].some((label) => label.textContent === 'pick.js'), { timeout: 30_000 });
  const clickedBeforeEditor = await page.evaluate(() => {
    const ready = typeof window.monaco !== 'undefined';
    [...document.querySelectorAll('.tree-node')].find((node) => node.querySelector('.tree-label')?.textContent === 'pick.js').click();
    return !ready;
  });
  a.check('the file is clicked before the editor has loaded', clickedBeforeEditor);

  // Once Monaco is up the editor shows a file: the one clicked, or, when the
  // default open wins, welcome.md (its read lands right after the click's).
  await page.waitForFunction(() => {
    const tab = document.getElementById('editorTab')?.textContent ?? '';
    return window.__nimbusMonacoEditor && (tab.includes('pick.js') || tab.includes('welcome.md'));
  }, { timeout: 30_000 });
  await page.click('.monaco-editor .view-lines');
  await page.keyboard.press('End');
  await page.keyboard.type(` ${MARK}`);
  await page.keyboard.down('Control');
  await page.keyboard.press('s');
  await page.keyboard.up('Control');
  await page.waitForFunction(() => !document.getElementById('editorTab')?.classList.contains('dirty'), { timeout: 10_000 });
  // The tab's text flashes "saved"; its title keeps the open file's path.
  const shown = await page.evaluate(() => document.getElementById('editorTab')?.title);
  a.check('the editor still shows the file the user opened', shown === '/home/user/pick.js', `editor tab=${shown}`);
  await page.close();

  const after = new Terminal(sid);
  await after.connect();
  await after.waitForPrompt(30_000);
  const picked = await after.run('cat /home/user/pick.js; echo', 15_000);
  a.check('what the user typed was saved into that file', picked.output.includes(MARK), picked.output.slice(-200));
  const welcomeAfter = (await after.run('md5sum /home/user/welcome.md', 15_000)).output.match(/[0-9a-f]{32}/)?.[0];
  a.check('welcome.md is untouched', welcomeBefore !== undefined && welcomeAfter === welcomeBefore, `${welcomeBefore} → ${welcomeAfter}`);
  await after.close();
} catch (error) {
  a.check('probe completed', false, error instanceof Error ? error.stack : String(error));
} finally {
  await browser.close().catch(() => {});
  await deleteSession(sid);
}

const summary = a.summary();
process.exit(summary.fail > 0 ? 1 : 0);
