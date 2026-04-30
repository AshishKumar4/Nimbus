import React from 'react';
const h = React.createElement;

export function Hero() {
  return h('section', { className: 'hero' },
    h('div', { className: 'container' },
      h('div', { className: 'badge' },
        h('span', { className: 'pulse-dot' }),
        'Built on Cloudflare Workers',
      ),
      h('h1', null,
        'Your dev environment, ',
        h('span', { className: 'gradient-text' }, 'at the edge'),
      ),
      h('p', { className: 'hero-desc' },
        'A complete cloud-native development environment running on Cloudflare Durable Objects. ',
        '10 GB persistent filesystem, npm, node, git, esbuild, Vite \u2014 all in your browser.',
      ),
      h('div', { className: 'hero-actions' },
        h('a', { href: '/', className: 'btn btn-primary' }, 'Open Terminal'),
        h('a', { href: 'https://github.com/AshishKumar4/Nimbus', className: 'btn btn-ghost', target: '_blank' }, 'View on GitHub'),
      ),
    ),
  );
}
