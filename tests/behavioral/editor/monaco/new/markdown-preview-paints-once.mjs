// editor/monaco/new/markdown-preview-paints-once — showing a Markdown file
// in the preview renders it once: opening one from the Explorer, and the
// preview's Reload, each run the shared Markdown renderer (the chat island's
// renderMarkdown: marked, highlight.js, DOMPurify) one time.
//
// Counted in a real Chrome at the island module the shell loads: its request
// is answered with a module that re-exports the real one and counts each
// renderMarkdown call, the rest as shipped.
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
export function renderMarkdown(markdown) { window.__probeRenders++; return real.renderMarkdown(markdown); }
`,
      });
    }
    return request.continue();
  });
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  // The welcome file's preview first, then quiet.
  await page.waitForFunction(() => /Welcome to Nimbus/.test(document.getElementById('markdown-preview-body')?.innerText || ''), { timeout: 90_000 });
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const settledCount = async (heading) => {
    await page.waitForFunction((text) => document.querySelector('#markdown-preview-body h1')?.textContent === text, { timeout: 60_000 }, heading);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return page.evaluate(() => window.__probeRenders);
  };

  await page.evaluate(() => { window.__probeRenders = 0; });
  await page.locator(`.tree-node[data-path="${FILE}"]`).click();
  const opened = await settledCount(MARK);
  a.check('opening a Markdown file renders it once', opened === 1, `renders=${opened}`);

  await page.evaluate(() => { window.__probeRenders = 0; });
  await page.click('#btnReloadPreview');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const reloaded = await settledCount(MARK);
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
