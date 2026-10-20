#!/usr/bin/env bun
import { runScenarios } from './lib/resident-body.mjs';
import { runSchedule, KNOWN_GAPS } from './lib/barrier-schedule.mjs';

const schedule = [["own","readFile","z/g"],["own","opendir","d/e/g"],["input"],["own","readdir","z/k"],["own","rename","d","z"],["own","opendir","d/e/g"],["input"],["peer","mkdir","d"],["own","chmod","x/h",420],["own","pread","mid",8400000],["release","wave"],["peer","unlink","top"],["own","stat","new"],["sync","readdir","z/k"],["own","stat","z/g"],["hold","acquire"],["settle"],["sync","stat","d/e/g"],["own","readFile","mid"],["poison"],["release"],["own","write","top","c3378.3"],["root","chmod","x",493],["sync","readFile","x/e"],["own","opendir","x/e"]];
await runScenarios(import.meta.path, {
  'seed 3378 shrunk [node]': () => runSchedule('node', schedule, { parkSeed: 3378, knownGaps: KNOWN_GAPS.node ?? {} }),
});
