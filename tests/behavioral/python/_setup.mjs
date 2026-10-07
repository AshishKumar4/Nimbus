// The setup the Python probes share: the runtime from the catalog, then a
// pip install that must complete without reaching an extension's wasm at
// request time (MarkupSafe's speedups, a dynamic library, code generation:
// workerd refuses wasm compiled after startup).

import { stripAnsi } from '../_driver.mjs';

export const WASM_LOAD_FAILURE = /Failed to load MarkupSafe|Failed to load dynamic library|Wasm code generation disallowed/i;

/**
 * `nimbus install python` (`reinstall`: from the catalog, not an installed
 * copy), checked to have installed.
 */
export async function installPython(t, a, { reinstall = false, timeoutMs = 240_000 } = {}) {
  const out = stripAnsi((await t.run(`nimbus install python${reinstall ? ' --reinstall' : ''}`, timeoutMs)).output);
  a.check('python runtime installs from runtime catalog',
    /installed at|already installed/.test(out) && !/catalog cannot be fetched|command not found/i.test(out),
    JSON.stringify(out.slice(-1000)));
  return out;
}

/**
 * `pip install <packages>`: checked to complete (`installed`, by default
 * "Successfully installed <the last package>") and, separately, to load no
 * extension wasm. `refuse` adds failures a probe has seen pip print.
 */
export async function pipInstall(t, a, packages, { timeoutMs = 300_000, installed, refuse } = {}) {
  const out = stripAnsi((await t.run(`pip install ${packages}`, timeoutMs)).output);
  const expect = installed ?? new RegExp(`Successfully installed ${packages.split(' ').at(-1)}`, 'i');
  a.check(`pip install ${packages} completes`, expect.test(out) && !(refuse?.test(out)), JSON.stringify(out.slice(-1500)));
  a.check(`pip install ${packages} loads no extension wasm`, !WASM_LOAD_FAILURE.test(out), JSON.stringify(out.slice(-1500)));
  return out;
}
