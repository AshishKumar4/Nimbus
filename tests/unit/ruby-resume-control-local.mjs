import assert from 'node:assert/strict';
import { RUBY_RUNNER_PREAMBLE_TAIL } from '../../packages/core/src/runtime/ruby-runner.ts';
const begin = RUBY_RUNNER_PREAMBLE_TAIL.indexOf('globalThis.__nimbusRubyResumeMain =');
const end = RUBY_RUNNER_PREAMBLE_TAIL.indexOf('// One resume at a time', begin);
const source = RUBY_RUNNER_PREAMBLE_TAIL.slice(begin, end);
assert.ok(!source.includes('await __nimbusRubyOutput.drain()'), 'a private resume report must not postpone guest deadlines behind ordinary output RPCs');
assert.ok(RUBY_RUNNER_PREAMBLE_TAIL.includes('__nimbusRubyWriteOutput'), 'control frames are parsed at the producer boundary before enqueueing ordinary bytes');
console.log('ruby-resume-control-local: private scheduling metadata does not await network log delivery');
