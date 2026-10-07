#!/usr/bin/env bun
// editor/monaco/regression/single-workspace-no-legacy-modes — the shell has
// one workspace. Terminal/Preview/Split are not top-level modes, and neither
// is the old Edit+Preview pair (editor-split, editor-split-with-term), which
// the user asked to have removed ("I don't need 'edit + preview' at all").

import { mintSession, BASE, makeAsserter, requestHeaders } from '../../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('editor/monaco/regression/single-workspace-no-legacy-modes');
console.log(`editor/monaco/regression/single-workspace-no-legacy-modes — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow', headers: requestHeaders() });
const html = await r.text();

for (const id of ['btnTerminal', 'btnPreview', 'btnSplit', 'btnEditorTerm']) {
  a.check(`#${id} button removed`,
    !new RegExp(`id=["']${id}["']`).test(html),
    `#${id} still present`);
}

for (const mode of ['terminal-only', 'preview-only', 'split', 'editor-split', 'editor-split-with-term']) {
  a.check(`setLayout('${mode}') removed`,
    !new RegExp("setLayout\\(['\"]" + mode + "['\"]\\)").test(html),
    `setLayout('${mode}') still present`);
}

for (const cssClass of ['terminal-only', 'preview-only', 'agent', 'editor-split', 'editor-split-with-term']) {
  a.check(`.main.${cssClass} rule removed`,
    !new RegExp("\\.main\\." + cssClass + "\\b").test(html),
    `.main.${cssClass} still present`);
}

// A comment may name the old label (commit history); a button may not.
a.check('no Edit+Preview button',
  !/<button[^>]*>[^<]*Edit\+Preview[^<]*<\/button>/.test(html.replace(/<!--[\s\S]*?-->/g, '')),
  'an Edit+Preview button is still served');

a.check('Editor and Agent workspace buttons present',
  /id=["']btnEditor["'][^>]*>\s*Editor\s*</.test(html)
  && /id=["']btnAgent["'][^>]*>\s*Agent\s*</.test(html),
  'workspace buttons missing');

a.check('Agent surface is selected through the center stack',
  /agent-surface/.test(html)
  && /id=["']leftStack["']/.test(html)
  && /id=["']agentPanel["']/.test(html),
  'agent center-stack wiring missing');

a.check('Terminal and preview remain regular workspace panels',
  /class=["']panel-terminal["']/.test(html)
  && /class=["']panel-preview["']/.test(html)
  && /id=["']resizeHandle["']/.test(html),
  'workspace panels missing');

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
