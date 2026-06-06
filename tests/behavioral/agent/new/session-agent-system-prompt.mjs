#!/usr/bin/env bun
// agent/new/session-agent-system-prompt - the session agent prompt should
// frame Nimbus as a builder/operator, not as a menu of raw tools.

import { readFileSync } from 'node:fs';
import { makeAsserter } from '../../_driver.mjs';

const a = makeAsserter('agent/new/session-agent-system-prompt');

const source = readFileSync(new URL('../../../../packages/worker/src/session/agent.ts', import.meta.url), 'utf8');
const promptMatch = source.match(/const SYSTEM_PROMPT = \[([\s\S]*?)\]\.join\('\\n'\);/);
const prompt = promptMatch?.[1] || '';

a.check('system prompt exists as explicit builder instructions',
  prompt.includes('autonomous software builder')
  && prompt.includes('build, change, debug, run, and preview software')
  && prompt.includes('end-to-end in this workspace'),
  prompt);

a.check('system prompt treats tools as agent-operated instruments',
  prompt.includes('instruments you operate on the user\\\'s behalf')
  && prompt.includes('Do not present them as chores for the user')
  && prompt.includes('Do not dump a bullet list of raw tools'),
  prompt);

a.check('system prompt preserves verified-action discipline',
  prompt.includes('Do not claim a command ran')
  && prompt.includes('unless a tool result proves it'),
  prompt);

a.check('system prompt no longer leads with a tool-menu capability list',
  !prompt.includes('You can inspect and edit the session filesystem'),
  prompt);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
