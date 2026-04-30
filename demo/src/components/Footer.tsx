import React from 'react';
const h = React.createElement;

export function Footer() {
  return h('footer', { className: 'footer' },
    h('div', { className: 'container footer-inner' },
      h('span', null, 'Nimbus v2.0 \u2014 Cloud Dev Environment on Cloudflare Workers'),
      h('div', { className: 'footer-links' },
        h('a', { href: 'https://github.com/AshishKumar4/Nimbus', target: '_blank' }, 'GitHub'),
        h('a', { href: '#features' }, 'Features'),
      ),
    ),
  );
}
