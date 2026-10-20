#!/usr/bin/env bun
/**
 * barrier-schedules-eager — the resident filesystem over a store enumerated
 * at boot (Node's, once it runs on it) answers as the session holds its
 * files however the session's replies are timed against a peer's changes
 * and the process's own: each schedule a review found an engine wrong on
 * (lib/barrier-found.mjs), judged by lib/barrier-schedule.mjs.
 */

import { runScenarios } from './lib/resident-body.mjs';
import { foundScenarios } from './lib/barrier-found.mjs';

const { scenarios, gaps } = foundScenarios('eager');
await runScenarios(import.meta.path, scenarios, { gaps });
