#!/usr/bin/env bun
// editor/monaco/new/workspace-surface-toggle — HTML structural assertion for
// the single workspace with editor/agent switching in the center pane.

import { mintSession, BASE, makeAsserter, requestHeaders } from '../../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('editor/monaco/new/workspace-surface-toggle');
console.log(`editor/monaco/new/workspace-surface-toggle — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow', headers: requestHeaders() });
const html = await r.text();

a.check("setLayout('editor') wiring present",
  /setLayout\(['"]editor['"]\)/.test(html),
  `setLayout('editor') missing`);
a.check("setLayout('agent') wiring present",
  /setLayout\(['"]agent['"]\)/.test(html),
  `setLayout('agent') missing`);
a.check('setLayout keeps main panel on .main.editor',
  /mainPanel\.className\s*=\s*['"]main editor['"]/.test(html),
  `main editor assignment missing`);
a.check('Agent selection toggles leftStack.agent-surface',
  /leftStack\.classList\.toggle\(['"]agent-surface['"][\s\S]{0,120}workSurface\s*===\s*['"]agent['"]/.test(html),
  `agent-surface toggle missing`);

a.check('.main.editor rule present',
  /\.main\.editor\b/.test(html),
  `.main.editor CSS missing`);
a.check('Agent surface CSS hides the editor pane only',
  /\.panel-left-stack\.agent-surface\s+\.panel-editor\s*\{\s*display:\s*none/.test(html)
  && /\.panel-left-stack\.agent-surface\s+\.panel-agent[\s\S]{0,120}display:\s*flex/.test(html),
  `agent-surface CSS missing`);

a.check('Workspace DOM contains tree, editor, agent, terminal, and preview',
  /id=["']treePanel["']/.test(html)
  && /id=["']editorPanel["']/.test(html)
  && /id=["']agentPanel["']/.test(html)
  && /class=["']panel-terminal["']/.test(html)
  && /id=["']previewPanel["']/.test(html),
  `workspace DOM incomplete`);

a.check('Palette overlay DOM present',
  /id=["']paletteOverlay["']/.test(html) && /id=["']paletteInput["']/.test(html),
  `palette overlay missing`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
