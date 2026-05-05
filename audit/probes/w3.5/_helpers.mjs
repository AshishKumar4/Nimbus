// W3.5 probe helpers — thin shim over W3's _helpers so that artifacts
// land under audit/probes/w3.5/_results instead of audit/probes/w3/_results.
//
// The driving primitive is `runFacetSnippet` from W3 (see ../w3/_helpers.mjs);
// we wrap it so the outdir is local. Everything else (extractStdout,
// assertProbe, execProbe) is re-exported unchanged.

import { runProbe, nodeEvalBase64 } from '../_driver.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const W35_OUT_DIR = path.join(HERE, '_results');
fs.mkdirSync(W35_OUT_DIR, { recursive: true });

let _ctr = 0;
function makeRunCmd(jsSource, runInDir) {
  const id = ++_ctr + '_' + Date.now().toString(36);
  if (!runInDir) return nodeEvalBase64(jsSource);
  const b64 = Buffer.from(jsSource, 'utf8').toString('base64');
  const target = runInDir.replace(/\/+$/, '') + '/.w35-probe-' + id + '.js';
  return `node -e "require('fs').writeFileSync('${target}', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}' && cd ${runInDir} && node ${target}`;
}

/**
 * Run a JS snippet inside a fresh facet and capture stdout.
 *
 * @param {string} name probe label.
 * @param {string} jsSource JavaScript to execute inside the facet.
 * @param {object} [opts]
 * @param {string[]} [opts.preCmds] commands to run before the snippet (e.g. npm install).
 * @param {string[]} [opts.preFileWrites] [path, contents] pairs to write into VFS before snippet.
 * @param {string} [opts.runInDir] directory to cd into before running snippet.
 * @param {number} [opts.snippetTimeoutMs=20000]
 * @param {number} [opts.installTimeoutMs=180000]
 */
export async function runFacetSnippet(name, jsSource, opts = {}) {
  const artifactPath = path.join(W35_OUT_DIR, name + '.out.txt');
  fs.writeFileSync(artifactPath, '');
  fs.writeFileSync(path.join(W35_OUT_DIR, name + '.probe.js'), jsSource);

  const steps = [];
  if (opts.preFileWrites) {
    // Each entry: [absPath, contents]. We write via base64-decode to avoid
    // shell-quoting hell for content with quotes / newlines / backticks.
    for (const [absPath, contents] of opts.preFileWrites) {
      const b64 = Buffer.from(contents, 'utf8').toString('base64');
      const dir = absPath.replace(/\/[^/]*$/, '');
      const cmd =
        `mkdir -p ${dir} && node -e "require('fs').writeFileSync('${absPath}', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
      steps.push({ kind: 'cmd', cmd, timeoutMs: 15_000 });
    }
  }
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

export function extractStdout(output) {
  const lines = output.split(/\r?\n/);
  const out = [];
  let inSnippet = false;
  // Recognise both node-eval probes (/tmp/p_*.js) and runInDir probes
  // (/.w35-probe-*.js anywhere) — both come from runFacetSnippet.
  const startRe = /\bnode\s+(\/tmp\/p_\S+\.js|\/[^\s]*\.w35-probe-\S+\.js)\b/;
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

export function assertProbe(name, cond, message, output) {
  if (cond) return { name, pass: true, message: 'OK' };
  return { name, pass: false, message, output };
}

export async function execProbe(probeFn) {
  try {
    return await probeFn({ runFacetSnippet, extractStdout, assertProbe });
  } catch (e) {
    return { name: probeFn.name || 'unknown', pass: false, message: 'EXCEPTION: ' + (e?.message || e), output: '' };
  }
}
