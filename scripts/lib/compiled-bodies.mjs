import { build } from 'esbuild';
import { builtinModules, createRequire } from 'node:module';

const { parse } = createRequire(new URL('../../packages/core/package.json', import.meta.url))('acorn');

const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));

// CommonJS packages can require a builtin at module initialization. Reify those
// edges as real ESM imports before bundling, rather than esbuild's __require.
function builtinImports() {
  return {
    name: 'compiled-body-node-imports',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path, namespace }) => {
        const name = path.replace(/^node:/, '');
        if (!builtins.has(name)) return;
        if (namespace === 'compiled-node-builtin') return { path: `node:${name}`, external: true };
        return { path: name, namespace: 'compiled-node-builtin' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'compiled-node-builtin' }, ({ path }) => ({
        contents: `import * as builtin from ${JSON.stringify(`node:${path}`)}; module.exports = builtin.default ?? builtin;`,
        loader: 'js',
      }));
    },
  };
}

/**
 * @param {{ entry?: string; exports?: string[]; contents?: string; resolveDir?: string; external?: string[]; alias?: Record<string,string>; target?: string }} input
 * @returns {Promise<{ module: string; expression: string; imports: string[] }>}
 */
export async function compiledBodies({ entry, exports, contents, resolveDir = process.cwd(), external = [], alias = {}, target = 'esnext' }) {
  const result = await build({
    stdin: { contents: contents ?? `export { ${exports.join(', ')} } from ${JSON.stringify(entry)};`, resolveDir, sourcefile: 'compiled-bodies-entry.mjs', loader: 'js' },
    bundle: true, write: false, platform: 'neutral', format: 'esm', target, minify: true,
    conditions: ['workspace', 'workerd', 'worker', 'import'], mainFields: ['module', 'main'], external: ['cloudflare:*', ...external], alias, plugins: [builtinImports()],
    legalComments: 'none', logLevel: 'warning',
  });
  const module = result.outputFiles[0].text;
  const ast = parse(module, { ecmaVersion: 'latest', sourceType: 'module' });
  const imports = [];
  const edits = [];
  const returned = [];
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      imports.push(module.slice(node.start, node.end));
      edits.push({ start: node.start, end: node.end });
    } else if (node.type === 'ExportNamedDeclaration' && !node.source && !node.declaration) {
      for (const specifier of node.specifiers) {
        returned.push(`${JSON.stringify(specifier.exported.name ?? specifier.exported.value)}:${specifier.local.name}`);
      }
      edits.push({ start: node.start, end: node.end });
    } else if (node.type.startsWith('Export')) {
      throw new Error('compiledBodies: unexpected export form from esbuild');
    }
  }
  let body = module;
  for (const edit of edits.reverse()) body = body.slice(0, edit.start) + body.slice(edit.end);
  return { module, expression: `(()=>{${body}\nreturn {${returned.join(',')}};})()`, imports };
}
