// W3.5 regression probe — npm install + require still works for the W3
// happy-path packages (axios, ts-node, puppeteer-core).
//
// Catches accidental breakage in the install + bundle path. If the ESM
// transform OR the directory-as-index fix accidentally drops content,
// this probe will go red where W3 was green.
//
// Note: doesn't re-run the full W3 acceptance suite; that's the job of
// audit/probes/w3/run-all.mjs in Phase D.

import { execProbe } from '../_helpers.mjs';

export default function install_pipeline_coverage() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('install-pipeline-coverage', `
      const axios = require('axios');
      console.log('AXIOS_GET=' + (typeof axios.get));
      console.log('AXIOS_POST=' + (typeof axios.post));

      const tsNode = require('ts-node');
      console.log('TSNODE_REGISTER=' + (typeof tsNode.register));

      const pup = require('puppeteer-core');
      console.log('PUP_LAUNCH=' + (typeof pup.launch));
    `, {
      preCmds: ['cd app && npm install axios ts-node puppeteer-core'],
      runInDir: '/home/user/app',
      installTimeoutMs: 240_000,
      snippetTimeoutMs: 30_000,
    });
    if (!r.ok) return assertProbe('install-pipeline-coverage', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('AXIOS_GET=function')
      && so.includes('AXIOS_POST=function')
      && so.includes('TSNODE_REGISTER=function')
      && so.includes('PUP_LAUNCH=function');
    return assertProbe('install-pipeline-coverage', ok, 'expected three packages to load, got:\n' + so, r.output);
  });
}
