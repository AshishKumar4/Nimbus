// Node's built-in modules as wrangler resolves them for a worker with
// nodejs_compat: a bare `util`, as a dependency's CommonJS requires it, is
// `node:util`, which workerd provides. An esbuild plugin, for a test that
// bundles the worker as wrangler does.

import { builtinModules } from 'node:module';

const BARE = new RegExp(`^(?:${builtinModules.filter((name) => !name.startsWith('_')).map((name) => name.replace(/[/.]/g, '\\$&')).join('|')})$`);

export const wranglerNodeBuiltins = {
  name: 'wrangler-node-builtins',
  setup(on) {
    on.onResolve({ filter: BARE }, (args) => ({ path: `node:${args.path}`, external: true }));
  },
};
