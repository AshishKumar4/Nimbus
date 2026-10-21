// The @source paths that ran an isolate out of memory or stack (Kinu ask
// 68), each through sourceReach and through the plan of a sheet holding
// them. Run by data-plan-source-reach.mjs in a child bounded in time, so a
// return to expansion fails as a timeout or a kill, not a hung test. Prints
// what it found as JSON.
import { planStylesheetSources, sourceReach } from '../../../packages/worker/src/facets/data-plan.ts';

const nested = '{'.repeat(4999) + '}'.repeat(4999);
const commas = '{a,'.repeat(1999) + '}'.repeat(1999);
const range = 'src/{1..100000000}/x.html';
const reach = {
  nested: sourceReach(nested),
  commas: sourceReach(commas),
  range: sourceReach(range),
  deep: sourceReach('{'.repeat(200_000) + '.'.repeat(4)),
};

const files = {
  'home/user/app/src/index.css': [
    '@import "tailwindcss";',
    `@source "${nested}";`,
    '@source "../../huge/{1..100000000}/x.html";',
    '@source "../../kit/**/*.{ts,tsx}";',
  ].join('\n'),
  'home/user/kit/Button.tsx': 'b',
  'home/user/huge/1/x.html': 'h',
};
const source = {
  readText: async (path) => files[path] ?? null,
  stat: async (path) => {
    if (Object.hasOwn(files, path)) return { kind: 'file', size: files[path].length };
    return Object.keys(files).some((name) => name.startsWith(`${path}/`)) ? { kind: 'directory', size: 0 } : null;
  },
  linkTarget: async () => null,
  readdir: async (dir) => {
    const below = new Map();
    for (const name of Object.keys(files)) {
      if (!name.startsWith(`${dir}/`)) continue;
      const rest = name.slice(dir.length + 1);
      const slash = rest.indexOf('/');
      below.set(rest.slice(0, slash < 0 ? undefined : slash), slash < 0 ? 'file' : 'directory');
    }
    return [...below].map(([name, kind]) => ({ path: `${dir}/${name}`, kind, size: kind === 'file' ? files[`${dir}/${name}`].length : 0 }));
  },
};
const planned = await planStylesheetSources(source, { cwd: '/home/user/app', home: '/home/user', sheets: ['home/user/app/src/index.css'] });
console.log(JSON.stringify({ reach, held: planned.files.map((file) => file.path).sort() }));
