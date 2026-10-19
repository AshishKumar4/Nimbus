#!/usr/bin/env bun
/**
 * barrier-schedules-node — Node's (node-shims) filesystem answers as the session holds
 * its files however the session's replies are timed against a peer's
 * changes and the process's own: each schedule a review found an engine
 * wrong on (lib/barrier-found.mjs), judged by lib/barrier-schedule.mjs.
 */

import { runScenarios } from './lib/resident-body.mjs';
import { foundScenarios } from './lib/barrier-found.mjs';

const { scenarios, gaps } = foundScenarios('node', { renames: false });
await runScenarios(import.meta.path, scenarios, { gaps });
