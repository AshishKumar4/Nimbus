#!/usr/bin/env bun
// Scratch (red proof): main's three-arm grader, with the candidate's one
// Preview 1.5x behind on the baseline's own code, as ruby-gem-require's
// receipts had it. Expected not slower; main grades it slower.
import assert from 'node:assert/strict';
import { gradePaired } from '../behavioral/_paired.mjs';
let state = 22;
const uniform = () => { state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return (((t ^ (t >>> 14)) >>> 0) + 1) / 4294967297; };
const normal = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
const rounds = Array.from({ length: 20 }, () => {
  const moment = normal();
  const draw = () => 600 * Math.exp(0.1 * (Math.SQRT1_2 * moment + Math.SQRT1_2 * normal()));
  return { a1: draw(), a2: draw(), b: draw() * 1.5 };
});
const grade = gradePaired(rounds);
assert.equal(grade.slower, false, `one slow candidate Preview, same code: graded slower (${JSON.stringify(grade)})`);
