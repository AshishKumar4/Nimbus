import React from 'react';
const h = React.createElement;

const features = [
  { icon: '\uD83D\uDDC4\uFE0F', title: '10 GB Persistent VFS', desc: 'SQLite-backed virtual filesystem with demand-paged 32 MB LRU cache. Files persist across sessions.' },
  { icon: '\u26A1', title: 'Isolated Node.js', desc: 'Each script runs in its own V8 isolate via DO Facets. Full require() with real module resolution.' },
  { icon: '\uD83D\uDCE6', title: 'npm Install', desc: 'Parallel package fetching in dedicated facets. Dependencies resolve, download, and extract via live RPC.' },
  { icon: '\uD83D\uDD25', title: 'Vite Dev Server', desc: 'On-the-fly TypeScript/JSX transforms via esbuild. HMR client injection. Runs as a non-blocking facet.' },
  { icon: '\uD83D\uDD00', title: 'Git Integration', desc: 'Full git CLI \u2014 clone, commit, push, branch, merge. Powered by isomorphic-git (CF-compatible fork).' },
  { icon: '\uD83D\uDEE1\uFE0F', title: 'Supervisor RPC', desc: 'Facets call back to the supervisor for filesystem I/O, stdout streaming, and esbuild transforms.' },
];

export function Features() {
  return h('section', { className: 'features', id: 'features' },
    h('div', { className: 'container' },
      h('h2', { className: 'section-title' }, 'Everything you need to build'),
      h('p', { className: 'section-subtitle' }, 'A complete dev environment on Cloudflare\u2019s edge network. No local install required.'),
      h('div', { className: 'feature-grid' },
        ...features.map(f =>
          h('div', { className: 'feature-card', key: f.title },
            h('div', { className: 'feature-icon' }, f.icon),
            h('h3', null, f.title),
            h('p', null, f.desc),
          ),
        ),
      ),
    ),
  );
}
