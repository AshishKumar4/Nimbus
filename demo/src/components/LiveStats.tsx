import React, { useState, useEffect } from 'react';
const h = React.createElement;

export function LiveStats() {
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    const load = () => fetch('/api/stats').then(r => r.json()).then(setStats).catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const items = [
    { value: '10 GB', label: 'Persistent Storage' },
    { value: stats ? String(stats.files || 0) : '\u2014', label: 'Files in VFS' },
    { value: '32 MB', label: 'LRU Hot Cache' },
    { value: stats?.cache ? stats.cache.hitRate + '%' : '\u2014', label: 'Cache Hit Rate' },
  ];

  return h('section', { className: 'stats-section', id: 'stats' },
    h('div', { className: 'container' },
      h('div', { className: 'stats-grid' },
        ...items.map(item =>
          h('div', { className: 'stat-card', key: item.label },
            h('div', { className: 'stat-number' }, item.value),
            h('div', { className: 'stat-label' }, item.label),
          ),
        ),
      ),
    ),
  );
}
