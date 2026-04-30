import React from 'react';
const h = React.createElement;

export function Navbar() {
  return h('header', { className: 'navbar' },
    h('div', { className: 'container nav-inner' },
      h('a', { href: '/', className: 'logo' }, '\u2601\uFE0F Nimbus'),
      h('nav', { className: 'nav-links' },
        h('a', { href: '#features' }, 'Features'),
        h('a', { href: '#terminal' }, 'Demo'),
        h('a', { href: '#stats' }, 'Stats'),
        h('a', { href: 'https://github.com/AshishKumar4/Nimbus', target: '_blank', rel: 'noopener' }, 'GitHub'),
      ),
    ),
  );
}
