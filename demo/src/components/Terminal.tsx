import React from 'react';
const h = React.createElement;

const lines = [
  { type: 'prompt', text: '$ npm install left-pad' },
  { type: 'output', text: '[npm] Resolving dependencies...' },
  { type: 'output', text: '[npm] fetching left-pad@1.3.0...' },
  { type: 'success', text: '[npm] Done! 1 packages, 7 files in 0.3s' },
  { type: 'prompt', text: '$ node -e "console.log(require(\'left-pad\')(42,5,\'0\'))"' },
  { type: 'highlight', text: '00042' },
  { type: 'prompt', text: '$ git init && git add . && git commit -m "init"' },
  { type: 'output', text: 'Initialized empty Git repository' },
  { type: 'output', text: '[a1b2c3d] init' },
  { type: 'prompt', text: '$ vite' },
  { type: 'success', text: '  Nimbus Vite Dev Server' },
  { type: 'output', text: '  \u27A1 Preview: /preview/ | Mode: facet' },
];

export function Terminal() {
  return h('section', { className: 'terminal-section', id: 'terminal' },
    h('div', { className: 'container' },
      h('h2', { className: 'section-title' }, 'Try it live'),
      h('p', { className: 'section-subtitle' }, 'A real shell running on Cloudflare Durable Objects.'),
      h('div', { className: 'terminal-window' },
        h('div', { className: 'terminal-chrome' },
          h('span', { className: 'dot red' }),
          h('span', { className: 'dot yellow' }),
          h('span', { className: 'dot green' }),
          h('span', { className: 'terminal-title' }, 'user@nimbus ~/project'),
        ),
        h('div', { className: 'terminal-content' },
          ...lines.map((line, i) =>
            h('div', { className: 'term-line ' + line.type, key: i, style: { animationDelay: (i * 0.3) + 's' } },
              line.type === 'prompt' ? h('span', { className: 'term-prompt' }, '$ ') : null,
              line.type === 'prompt' ? line.text.substring(2) : line.text,
            ),
          ),
          h('div', { className: 'term-line prompt', style: { animationDelay: (lines.length * 0.3) + 's' } },
            h('span', { className: 'term-prompt' }, '$ '),
            h('span', { className: 'cursor' }),
          ),
        ),
      ),
    ),
  );
}
