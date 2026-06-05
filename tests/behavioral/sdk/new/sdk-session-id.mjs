#!/usr/bin/env bun
// sdk/new/sdk-session-id — programmatic sandbox IDs and generated
// browser session IDs are both valid route IDs.

import { makeAsserter } from '../../_driver.mjs';

const a = makeAsserter('sdk/new/sdk-session-id');
const { isValidSessionId } = await import('../../../../packages/worker/src/_shared/session-id.ts');

a.check('generated friendly ID remains valid',
  isValidSessionId('pretty-otter-1234'));
a.check('SDK job ID is valid',
  isValidSessionId('job-123'));
a.check('SDK dotted/underscored ID is valid',
  isValidSessionId('tenant_1.job_7'));
a.check('empty ID is invalid',
  !isValidSessionId(''));
a.check('slash-bearing ID is invalid',
  !isValidSessionId('job/123'));
a.check('tenant separator is invalid in session ID',
  !isValidSessionId('tenant:subject:job-123'));

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
