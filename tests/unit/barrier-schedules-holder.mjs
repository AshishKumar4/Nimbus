#!/usr/bin/env bun
/**
 * barrier-schedules-holder — a WASI guest's (the resident filesystem and its delegation holder) filesystem answers as the session holds
 * its files however the session's replies are timed against a peer's
 * changes and the process's own: each schedule a review found an engine
 * wrong on (lib/barrier-found.mjs), judged by lib/barrier-schedule.mjs.
 */

import { runScenarios } from './lib/resident-body.mjs';
import { foundScenarios } from './lib/barrier-found.mjs';

const { scenarios, gaps } = foundScenarios('holder');
await runScenarios(import.meta.path, scenarios, { gaps });
