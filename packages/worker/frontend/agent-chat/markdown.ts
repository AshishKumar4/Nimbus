/**
 * markdown.ts - The single Nimbus markdown pipeline: marked (GFM) ->
 * highlight.js -> DOMPurify. Used by the chat island and by the shell's
 * #markdown-preview pane, replacing the old runtime CDN imports.
 */

import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { Marked } from 'marked';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('go', go);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = (lang || '').trim().split(/\s+/)[0].toLowerCase();
      const highlighted = language && hljs.getLanguage(language)
        ? hljs.highlight(text, { language, ignoreIllegals: true }).value
        : escapeHtml(text);
      return (
        `<div class="code-block">`
        + `<div class="code-block-head"><span class="code-block-lang">${escapeHtml(language || 'text')}</span>`
        + `<button type="button" class="code-copy">Copy</button></div>`
        + `<pre><code class="hljs">${highlighted}</code></pre>`
        + `</div>`
      );
    },
  },
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/** Render markdown to sanitized, syntax-highlighted HTML. */
export function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false });
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, ADD_ATTR: ['target'] });
}

// One delegated listener serves every copy button this pipeline renders,
// in the chat island and in the markdown preview pane alike.
document.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest('.code-copy') : null;
  if (!button) return;
  const code = button.closest('.code-block')?.querySelector('pre code');
  if (!code) return;
  navigator.clipboard.writeText(code.textContent ?? '').then(() => {
    button.textContent = 'Copied!';
    button.classList.add('copied');
    setTimeout(() => {
      button.textContent = 'Copy';
      button.classList.remove('copied');
    }, 1400);
  }).catch(() => {});
});
