// @serial
// @tier slow — repeatedly fills local-host pipe budgets and drives staged bash and BusyBox
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { assertMatchesNativeBash } from './lib/native-bash.mjs';

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../../packages/core/src/runtime/bash/preamble.ts', import.meta.url))],
  bundle: true, write: false, format: 'iife', platform: 'neutral', target: 'esnext', treeShaking: false,
});
const preambleSource = bundled.outputFiles[0].text;
const writer = `{ while :; do printf '%65536s' x || exit $?; done; }`;
const reader = '{ read -r -n 1 byte; }';
const cases = [
  `trap '' PIPE; set -o pipefail; ${writer} | ${reader}`,
  `trap '' PIPE; ${writer} | ${reader}; ` + 'echo "${PIPESTATUS[*]}"',
  `set -o pipefail; ${writer} | ${reader}`,
  `trap '' PIPE; trap - PIPE; set -o pipefail; ${writer} | ${reader}`,
  // BusyBox and GNU yes phrase their diagnostics differently; bash's own
  // printf above compares the full stderr, while these compare exec status.
  `trap '' PIPE; set -o pipefail; yes 2>/dev/null | ${reader}`,
  `set -o pipefail; yes 2>/dev/null | ${reader}`,
  `trap 'exit 7' PIPE; set -o pipefail; yes 2>/dev/null | ${reader}`,
];
for (const remote of [false, true]) {
  await assertMatchesNativeBash(cases, { compareStderr: true, remote, preambleSource });
}
console.log('bash-pipe-sigpipe: ignored and default SIGPIPE match native bash on both transports');
