// W3 probe helpers — minimal harness that:
//   1. Targets BASE env (defaults to prod) — same as _driver.mjs convention.
//   2. Runs an in-facet `node -e <inline>` probe via the existing
//      runProbe pipeline.
//   3. Reads back the artifact text and lets the caller's assertion
//      decide PASS/FAIL.
//
// Each probe's .mjs file is self-contained: imports this helper, calls
// runFacetSnippet(name, jsSource), then asserts against the captured
// stdout. Returns { ok, name, snippet, output, error }.

import { runProbe, nodeEvalBase64 } from '../_driver.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const W3_OUT_DIR = path.join(HERE, '_results');
fs.mkdirSync(W3_OUT_DIR, { recursive: true });

/**
 * Build a "node -e write file then node /that/file" command.  Used by
 * runFacetSnippet — analogous to nodeEvalBase64 from _driver.mjs but
 * writes to a user-specified directory so require() resolution starts
 * from there (e.g. /home/user/app for installed packages).
 */
let _ctr = 0;
function makeRunCmd(jsSource, runInDir) {
  const id = ++_ctr + '_' + Date.now().toString(36);
  if (!runInDir) return nodeEvalBase64(jsSource);
  const b64 = Buffer.from(jsSource, 'utf8').toString('base64');
  const target = runInDir.replace(/\/+$/, '') + '/.w3-probe-' + id + '.js';
  return `node -e "require('fs').writeFileSync('${target}', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}' && cd ${runInDir} && node ${target}`;
}

/**
 * Run a JS snippet inside a fresh facet, capture stdout, return result.
 *
 * @param {string} name — probe label (used for artifact file name).
 * @param {string} jsSource — JavaScript source to run inside facet.
 *                            Must `console.log` whatever you want to
 *                            assert against.
 * @param {object} [opts]
 * @param {string[]} [opts.preCmds] — additional shell commands before the
 *                                    `node -e` snippet (e.g. `npm install X`).
 * @param {number} [opts.snippetTimeoutMs=20000] — timeout for the snippet step.
 * @param {number} [opts.installTimeoutMs=180000] — timeout for npm install steps.
 * @returns {{ok: boolean, name: string, output: string, artifactPath: string, error?: string}}
 */
export async function runFacetSnippet(name, jsSource, opts = {}) {
  const artifactPath = path.join(W3_OUT_DIR, name + '.out.txt');
  fs.writeFileSync(artifactPath, '');
  fs.writeFileSync(path.join(W3_OUT_DIR, name + '.probe.js'), jsSource);

  const steps = [];
  if (opts.preCmds) {
    for (const c of opts.preCmds) {
      steps.push({ kind: 'cmd', cmd: c, timeoutMs: opts.installTimeoutMs ?? 180_000 });
    }
  }
  steps.push({
    kind: 'cmd',
    cmd: makeRunCmd(jsSource, opts.runInDir),
    timeoutMs: opts.snippetTimeoutMs ?? 20_000,
  });

  let r;
  try {
    r = await runProbe(name, steps, { artifactPath, settleMs: 3000 });
  } catch (e) {
    return { ok: false, name, output: '', artifactPath, error: e?.message || String(e) };
  }

  const output = fs.readFileSync(artifactPath, 'utf8');
  return { ok: !!r?.ok, name, output, artifactPath };
}

/**
 * Extract just the lines emitted by the user's `console.log` calls,
 * stripped of shell prompts / banners / probe-driver framing.
 *
 * Looks for the section between the snippet command and the next prompt.
 */
export function extractStdout(output) {
  // The pattern from runProbe artifacts: lines after "node /path/to.js"
  // (where the path is either /tmp/p_<id>.js or /home/user/app/.w3-probe-*)
  // appear as the actual stdout.  Strip the trailing "[facet started]" /
  // "Process N exited" lines and shell prompt.
  const lines = output.split(/\r?\n/);
  const out = [];
  let inSnippet = false;
  // Recognise both node-eval probes (/tmp/p_*.js) and runInDir probes
  // (/.w3-probe-*.js anywhere) — both come from runFacetSnippet.
  const startRe = /\bnode\s+(\/tmp\/p_\S+\.js|\/[^\s]*\.w3-probe-\S+\.js)\b/;
  for (const line of lines) {
    if (startRe.test(line) && !line.includes('writeFileSync')) {
      inSnippet = true;
      continue;
    }
    if (!inSnippet) continue;
    if (/\[facet started/.test(line)) continue;
    if (/^─{5,}/.test(line)) { inSnippet = false; continue; }
    if (/^Process \d+ \(.*\) exited with code/.test(line)) { inSnippet = false; continue; }
    if (/^---- step done/.test(line)) { inSnippet = false; continue; }
    if (/^==== END PROBE/.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * Assertion helper.  Throws if cond falsy; otherwise no-op.
 * Returns the result tuple expected by run-all.mjs.
 */
export function assertProbe(name, cond, message, output) {
  if (cond) return { name, pass: true, message: 'OK' };
  return { name, pass: false, message, output };
}

/**
 * Standard probe wrapper. Signature:
 *   defaultExport({ runFacetSnippet, extractStdout, assertProbe }) → result
 * Each probe .mjs exports default async function returning the result.
 */
export async function execProbe(probeFn) {
  try {
    return await probeFn({ runFacetSnippet, extractStdout, assertProbe });
  } catch (e) {
    return { name: probeFn.name || 'unknown', pass: false, message: 'EXCEPTION: ' + (e?.message || e), output: '' };
  }
}
