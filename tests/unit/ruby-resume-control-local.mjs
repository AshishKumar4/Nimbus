// Execute the production Ruby relay/resume seam with VM output at its WASI
// boundary. A private scheduling report must finish while log delivery waits.
import assert from 'node:assert/strict';
import { RUBY_RUNNER_PREAMBLE_TAIL } from '../../packages/core/src/runtime/ruby-runner.ts';
import { wasiOutputRelay } from '../../packages/core/src/runtime/wasi/stdio.ts';
import { outputControlReader } from '../../packages/core/src/runtime/wasi/output-control.ts';

const release = Promise.withResolvers();
const delivered = [];
const scope = {
  __wasiSupervisorOutput: wasiOutputRelay, __wasiOutputControl: outputControlReader,
  __nimbusRubySupervisor: {
    async stdout(bytes) { await release.promise; delivered.push(['stdout', new TextDecoder().decode(bytes)]); },
    async stderr(bytes) { await release.promise; delivered.push(['stderr', new TextDecoder().decode(bytes)]); },
  },
  __rubyBootstrap: Promise.resolve({ ok: true }),
};
const bind = new Function('globalThis', RUBY_RUNNER_PREAMBLE_TAIL + `
  async function __nimbusRubyEval() {
    __nimbusRubyWriteOutput('stdout', new TextEncoder().encode('ordinary output\\n'));
    __nimbusRubyWriteOutput('stderr', new TextEncoder().encode('diagnostic\\n__NIMBUS_RESUMED_true_1_0_0.125\\n'));
  }
  return __nimbusRubyBindOutput;
`)(scope);
scope.__rubyBootstrap = Promise.resolve({ ok: true });
bind({});
let timer;
try {
  const result = await Promise.race([
    scope.__nimbusRubyResumeMain(),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('resume waited for ordinary output delivery')), 1000); }),
  ]);
  assert.deepEqual(result, { resumed: true, alive: true, hostDriven: false, wakeAfter: 0.125 });
  assert.deepEqual(delivered, [], 'ordinary delivery is genuinely blocked');
} finally {
  clearTimeout(timer);
  release.resolve();
}
await scope.__nimbusRubyDrainOutput();
assert.deepEqual(delivered, [['stdout', 'ordinary output\n'], ['stderr', 'diagnostic\n']], 'control was parsed locally and never relayed as ordinary output');
console.log('ruby-resume-control-local: scheduling report independent of blocked log delivery');
