// editor/monaco/new/markdown-preview-paints-once — showing a Markdown file
// in the preview renders it once: opening one from the Explorer, and the
// preview's Reload, each run the shared Markdown renderer (the chat island's
// renderMarkdown: marked, highlight.js, DOMPurify) one time.
//
// Counted in a real Chrome at the island module the shell loads: its request
// is answered with a module that re-exports the real one, counts each
// renderMarkdown call, tracks the calls still running, and marks each result
// with its call's number, the rest as shipped. An operation is done when the
// preview shows the newest call's result and no call is running.
// Red before: activating the Markdown tab painted it, and the caller that
// activated it painted it again, so every open and reload rendered twice.

import { mintSession, makeAsserter, deleteSession, requestHeaders } from '../../../_driver.mjs';
import { launchBrowser, openPage, BASE } from '../../../_runtime-behavioral-template.mjs';
import { Nimbus } from '../../../../../packages/sdk/src/index.ts';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'editor/monaco/new/markdown-preview-paints-once';
const a = makeAsserter(label);
console.log(`${label} — ${BASE}`);

const sid = await mintSession();
const MARK = `paint-once-${Date.now().toString(36)}`;
const FILE = `/home/user/${MARK}.md`;
const box = Nimbus.connect({ endpoint: BASE, headers: () => requestHeaders({}, sid) }).sandbox(sid);
await box.files.write(FILE, `# ${MARK}\n\nSome \`code\` and a list:\n\n- one\n- two\n`);

const browser = await launchBrowser({ timeout: 60_000 });
try {
  const { page, pageErrors } = await openPage(browser, sid, { navTimeoutMs: 90_000 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/_assets/agent-chat/agent-chat.js' && !url.searchParams.has('probe-real')) {
      return request.respond({
        contentType: 'text/javascript',
        body: `import * as real from '/_assets/agent-chat/agent-chat.js?probe-real';
export * from '/_assets/agent-chat/agent-chat.js?probe-real';
window.__probeRenders = 0;
window.__probeRunning = 0;
export async function renderMarkdown(markdown) {
  const call = ++window.__probeRenders;
  window.__probeRunning++;
  try { return (await real.renderMarkdown(markdown)) + '<i hidden data-probe-render="' + call + '"></i>'; }
  finally { window.__probeRunning--; }
}
`,
      });
    }
    return request.continue();
  });
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  /** Once the preview shows heading `heading` from a call after `after`, and no call runs: the calls since `after`. */
  const callsUntilShown = async (heading, after) => {
    await page.waitForFunction((text, since) => {
      const body = document.getElementById('markdown-preview-body');
      const shown = Number(body?.querySelector('[data-probe-render]')?.dataset.probeRender ?? 0);
      return body?.querySelector('h1')?.textContent === text && shown > since && shown === window.__probeRenders && window.__probeRunning === 0;
    }, { timeout: 60_000, polling: 50 }, heading, after);
    return (await page.evaluate(() => window.__probeRenders)) - after;
  };
  // The welcome file's preview first.
  await page.waitForFunction(() => /Welcome to Nimbus/.test(document.getElementById('markdown-preview-body')?.innerText || '')
    && window.__probeRunning === 0, { timeout: 90_000, polling: 50 });

  const beforeOpen = await page.evaluate(() => window.__probeRenders);
  await page.locator(`.tree-node[data-path="${FILE}"]`).click();
  const opened = await callsUntilShown(MARK, beforeOpen);
  a.check('opening a Markdown file renders it once', opened === 1, `renders=${opened}`);

  const beforeReload = await page.evaluate(() => window.__probeRenders);
  await page.click('#btnReloadPreview');
  const reloaded = await callsUntilShown(MARK, beforeReload);
  a.check("the preview's Reload renders it once", reloaded === 1, `renders=${reloaded}`);
  const rendered = await page.evaluate(() => ({
    code: document.querySelectorAll('#markdown-preview-body code').length,
    items: document.querySelectorAll('#markdown-preview-body li').length,
  }));
  a.check('and it is rendered Markdown', rendered.code >= 1 && rendered.items === 2, JSON.stringify(rendered));
  a.check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));
} finally {
  await browser.close();
  await deleteSession(sid);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
