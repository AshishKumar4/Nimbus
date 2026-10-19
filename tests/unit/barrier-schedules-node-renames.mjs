#!/usr/bin/env bun
/**
 * barrier-schedules-node-renames — what Node's process renamed itself is
 * where it put it, however the session's answers to its renames are timed
 * against the barriers that report them: each schedule a review found an
 * engine wrong on (lib/barrier-found.mjs), judged by lib/barrier-schedule.mjs.
 */

import { runScenarios } from './lib/resident-body.mjs';
import { foundScenarios } from './lib/barrier-found.mjs';

const { scenarios, gaps } = foundScenarios('node', { renames: true });
await runScenarios(import.meta.path, scenarios, { gaps });
