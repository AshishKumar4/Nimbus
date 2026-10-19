// editor/monaco/new/shell-terminal-look — the shell's terminal has the look
// Nimbus's browser terminals share (core's _shared/terminal-policy.ts, which
// the docs' sandbox terminal takes too): its font, its bar cursor and its
// sixteen colours, on the shell's own background, at the shell's size.
import { mintSession, makeAsserter, deleteSession } from '../../../_driver.mjs';
import { launchBrowser, openPage, BASE } from '../../../_runtime-behavioral-template.mjs';
import { TERMINAL_CURSOR, TERMINAL_FONT_FAMILY, TERMINAL_THEME } from '../../../../../packages/core/src/_shared/terminal-policy.ts';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'editor/monaco/new/shell-terminal-look';
const a = makeAsserter(label);
console.log(`${label} — ${BASE}`);

const sid = await mintSession();
const browser = await launchBrowser({ timeout: 60_000 });
try {
  const { page, pageErrors } = await openPage(browser, sid, { navTimeoutMs: 90_000 });
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => typeof term === 'object' && term?.options, { timeout: 60_000 });
  const look = await page.evaluate(() => ({
    fontFamily: term.options.fontFamily, fontSize: term.options.fontSize,
    cursorBlink: term.options.cursorBlink, cursorStyle: term.options.cursorStyle,
    theme: { ...term.options.theme },
  }));
  a.check("the shell terminal has the shared font, at the shell's size", look.fontFamily === TERMINAL_FONT_FAMILY && look.fontSize === 13, JSON.stringify(look));
  a.check('and the shared cursor', look.cursorBlink === TERMINAL_CURSOR.cursorBlink && look.cursorStyle === TERMINAL_CURSOR.cursorStyle, JSON.stringify(look));
  a.check("and the shared colours, on the shell's background",
    Object.entries({ ...TERMINAL_THEME, background: '#0d1117' }).every(([k, v]) => look.theme[k] === v), JSON.stringify(look.theme));
  a.check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));
} finally {
  await browser.close();
  await deleteSession(sid);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
