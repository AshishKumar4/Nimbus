#!/usr/bin/env bun
// editor/monaco/new/welcome-markdown-preview-default — fresh editor
// sessions open the Markdown welcome preview.
//
// User-visible contract: a fresh Nimbus session opens `/home/user/welcome.md`
// by default, and the right preview pane renders it as Markdown. Broken
// symptoms: the editor tab remains empty, the old welcome.txt opens, or the
// preview pane shows the app iframe/raw markdown instead of rendered content.

import { mintSession, makeAsserter } from '../../../_driver.mjs';
import { launchBrowser, openPage, BASE } from '../../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'editor/monaco/new/welcome-markdown-preview-default';
const a = makeAsserter(label);
console.log(`${label} — ${BASE}`);

const sid = await mintSession();
const browser = await launchBrowser({ timeout: 60_000 });
const ctx = await openPage(browser, sid, { navTimeoutMs: 90_000 });

try {
  await ctx.page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await ctx.page.waitForFunction(() => {
    const tab = document.getElementById('editorTab')?.textContent || '';
    const md = document.getElementById('markdown-preview');
    const body = document.getElementById('markdown-preview-body');
    const url = document.getElementById('urlBar')?.value || '';
    return tab.includes('welcome.md')
      && md?.classList.contains('active')
      && /Welcome to Nimbus/.test(body?.innerText || '')
      && /Start Here/.test(body?.innerText || '')
      && /Markdown Preview/.test(url);
  }, { timeout: 90_000 });

  const state = await ctx.page.evaluate(() => ({
    tab: document.getElementById('editorTab')?.textContent || '',
    url: document.getElementById('urlBar')?.value || '',
    markdownActive: document.getElementById('markdown-preview')?.classList.contains('active') || false,
    iframeHidden: getComputedStyle(document.getElementById('preview-frame')).display === 'none',
    previewTabs: Array.from(document.querySelectorAll('#previewTabs .preview-tab')).map((tab) => ({
      text: tab.textContent || '',
      active: tab.classList.contains('active'),
      markdown: tab.classList.contains('markdown'),
    })),
    h1: document.querySelector('#markdown-preview-body h1')?.textContent || '',
    h2s: Array.from(document.querySelectorAll('#markdown-preview-body h2')).map((h) => h.textContent || ''),
    codeCount: document.querySelectorAll('#markdown-preview-body code').length,
    rawPrefix: (document.getElementById('markdown-preview-body')?.innerText || '').trim().slice(0, 40),
  }));

  a.check('default tab is welcome.md',
    state.tab.includes('welcome.md') && !state.tab.includes('welcome.txt'),
    JSON.stringify(state));
  a.check('markdown preview surface is active and iframe hidden',
    state.markdownActive && state.iframeHidden && /Markdown Preview/.test(state.url),
    JSON.stringify(state));
  a.check('preview pane keeps Markdown and app previews as tabs',
    state.previewTabs.some((tab) => tab.text.includes('Preview'))
    && state.previewTabs.some((tab) => tab.text.includes('welcome.md') && tab.active && tab.markdown),
    JSON.stringify(state));
  a.check('markdown rendered headings, not raw markdown',
    /^Welcome to Nimbus/.test(state.h1) && state.h2s.includes('Start Here') && !state.rawPrefix.startsWith('# '),
    JSON.stringify(state));
  a.check('markdown code spans rendered',
    state.codeCount >= 3,
    JSON.stringify(state));

  await ctx.page.click('#previewTabs .preview-tab:not(.markdown)');
  await ctx.page.waitForFunction(() => {
    const frame = document.getElementById('preview-frame');
    const url = document.getElementById('urlBar')?.value || '';
    return frame && getComputedStyle(frame).display !== 'none' && /\/preview\/$/.test(url);
  }, { timeout: 15_000 });
  const appTabState = await ctx.page.evaluate(() => ({
    iframeHidden: getComputedStyle(document.getElementById('preview-frame')).display === 'none',
    url: document.getElementById('urlBar')?.value || '',
    activeTab: document.querySelector('#previewTabs .preview-tab.active')?.textContent || '',
  }));
  a.check('app preview tab restores the iframe',
    !appTabState.iframeHidden && appTabState.activeTab.includes('Preview') && /\/preview\/$/.test(appTabState.url),
    JSON.stringify(appTabState));

  const serious = [
    ...ctx.pageErrors.map((e) => e.message),
    ...ctx.consoleMessages
      .filter((m) => ['error', 'request-failed'].includes(m.type))
      .map((m) => m.location?.url ? `${m.text} (${m.location.url})` : m.text),
  ].filter((msg) => !/favicon/i.test(msg));
  a.check('no browser/runtime errors while opening markdown preview',
    serious.length === 0,
    serious.join('\n'));
} finally {
  try { await ctx.close?.(); } catch {}
  try { await browser.close(); } catch {}
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
