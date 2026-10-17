// Where OpenCode's embedded models.dev catalog sits in a built chunk, read
// from the syntax tree: the one function the ModelsDev module syncs, whose
// body is the catalog object literal (over 1 MiB). Upstream writes the value
// as `typeof OPENCODE_MODELS_DEV === "undefined" ? undefined : …`, and a
// bundler may fold that guard away once the define substitutes the literal,
// so the body is either the object or a conditional whose alternate is.
// Identifier renaming does not matter.
//
// The attach entry's build strips it (build-opencode-attach-entry.mjs) and
// the source rebuild extracts it as its catalog snapshot (scripts/ci/
// rebuild-opencode.mjs); what each does when it is not found is its own.
import { createRequire } from 'node:module';

const { parse } = createRequire(import.meta.url)('acorn');

/** The anchor every chunk that carries the catalog also carries. */
const ANCHOR = 'ModelsDev.fetchAndWrite';
const CATALOG_BYTES = 1024 * 1024;

/**
 * Each catalog in the chunk `source`: the syncing arrow function's range
 * ({ start, end }) and the catalog object's syntax node. A chunk that does
 * not carry the catalog has none; a built OpenCode has exactly one.
 */
export function modelsCatalogs(source) {
  if (!source.includes(ANCHOR)) return [];
  const found = [];
  // Every node of the tree, without recursion: a minified chunk nests deep.
  const pending = [parse(source, { sourceType: 'module', ecmaVersion: 'latest' })];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node.type === 'ArrowFunctionExpression') {
      const catalog = node.body.type === 'ConditionalExpression' ? node.body.alternate : node.body;
      if (catalog.type === 'ObjectExpression' && catalog.end - catalog.start > CATALOG_BYTES) found.push({ start: node.start, end: node.end, catalog });
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child !== null && typeof child === 'object' && typeof child.type === 'string') pending.push(child);
      }
    }
  }
  return found.sort((a, b) => a.start - b.start);
}
