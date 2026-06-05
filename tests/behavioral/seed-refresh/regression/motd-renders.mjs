#!/usr/bin/env bun
// seed-refresh/regression/motd-renders — the motd box-drawing banner
// MUST still render with correct alignment after we change the inner
// content lines. The banner alignment rule from nimbus-session.ts:160
// is "all characters are 1-cell-wide in the Unicode East Asian Width
// table" — box drawing (U+2500-U+257F), em-dash (U+2014), middle dot
// (U+00B7) all qualify. A new banner line that exceeds INNER_WIDTH=48
// columns OR adds non-Na/A/N chars would corrupt the right boundary.
//
// Category: R (runtime-behavioral) — the user sees the rendered banner
// on every shell boot.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('seed-refresh/motd-renders');
console.log(`seed-refresh/motd-renders — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

const { output } = await t.run('cat /etc/motd', 10_000);
const out = stripAnsi(output);

// 1. Top border line `╔════════...════╗` present.
const topBorder = out.match(/(╔═+╗)/);
a.check('motd has top box-border ╔═...═╗', topBorder !== null,
  out.slice(-500));

// 2. Bottom border ╚════════...════╝ present.
const botBorder = out.match(/(╚═+╝)/);
a.check('motd has bottom box-border ╚═...═╝', botBorder !== null,
  out.slice(-500));

// 3. The widths of the top + bottom borders MUST match (alignment intact).
if (topBorder && botBorder) {
  a.check('top + bottom border widths agree',
    topBorder[1].length === botBorder[1].length,
    `top=${topBorder[1].length} bot=${botBorder[1].length}`);
}

// 4. The version line ("Nimbus v X.Y.Z — Cloud Dev Environment") fits
//    INSIDE the borders without breaking the right `║`. Take the
//    border width and count cells in every inner-content line.
if (topBorder) {
  const borderWidth = [...topBorder[1]].length;  // ╔ + ═*N + ╗
  // Find each `║...║` content line and verify they're border-width long.
  const contentLines = [...out.matchAll(/║([^║\r\n]*)║/g)];
  a.check('motd has 3 inner content lines',
    contentLines.length === 3, `got ${contentLines.length}`);
  for (const m of contentLines) {
    const line = m[0];
    const lineCells = [...line].length;
    a.check(`inner line cells (${lineCells}) === border cells (${borderWidth})`,
      lineCells === borderWidth, `line=${JSON.stringify(line)}`);
  }
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
