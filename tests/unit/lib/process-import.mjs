// The process side of a rewritten dynamic import. rewriteDynamicImports
// turns `import(specifier, options)` into a call to
// globalThis.__nimbusDynamicImport(parent, specifier, options); a test
// stands in for the process there, records each call, and must remove
// itself afterwards whatever the cell did.

/**
 * Run `cell` with `answer(specifier, from)` as the process's import.
 * Each call is recorded as [from, specifier], or [from, specifier,
 * options] when the import carried options.
 *
 * @template T
 * @param {(specifier: string, from: string) => unknown} answer
 * @param {() => T | Promise<T>} cell
 * @returns {Promise<{ result: Awaited<T>, calls: unknown[][] }>}
 */
export async function withProcessImport(answer, cell) {
  const calls = [];
  globalThis.__nimbusDynamicImport = async (from, specifier, options) => {
    calls.push(options === undefined ? [from, specifier] : [from, specifier, options]);
    return answer(specifier, from);
  };
  try {
    return { result: await cell(), calls };
  } finally {
    delete globalThis.__nimbusDynamicImport;
  }
}

/**
 * A rewritten CommonJS-shaped cell, run as the process's module wrapper runs it.
 * @param {string} code
 * @param {{ exports?: object, require?: (id: string) => unknown, module?: object }} [wrapper]
 */
export function runCell(code, { exports = {}, require, module = {} } = {}) {
  return new Function('exports', 'require', 'module', code)(exports, require, module);
}
