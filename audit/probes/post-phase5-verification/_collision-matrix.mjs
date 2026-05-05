#!/usr/bin/env bun
// Build cross-wave file-collision matrix from merge commits.
import { execSync } from 'node:child_process';

const merges = {
  w3:  '8cfbd16',
  w4:  'a177138',
  w5:  '98d3ab1',
  w6:  'e7e9d20',
  w7:  '8b9ac44',
  w8:  'bcb32df',
  w9:  'c303948',
  w10: '7c55d2a',
  w11: 'c521135',
  w12: 'de1ebce',
};

const fileToWaves = new Map();
for (const [w, sha] of Object.entries(merges)) {
  const out = execSync(`git diff --name-only ${sha}^1 ${sha} -- src/`, { encoding: 'utf8' });
  for (const f of out.split('\n').filter(Boolean)) {
    if (!fileToWaves.has(f)) fileToWaves.set(f, []);
    fileToWaves.get(f).push(w);
  }
}

const collisions = [...fileToWaves.entries()].filter(([_, ws]) => ws.length >= 2);
collisions.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

console.log('## Collision matrix (files touched by ≥2 waves)');
console.log('');
console.log('| Wave count | File | Waves |');
console.log('|---|---|---|');
for (const [f, ws] of collisions) {
  console.log(`| ${ws.length} | \`${f}\` | ${ws.join(', ')} |`);
}
console.log('');

const singles = [...fileToWaves.entries()].filter(([_, ws]) => ws.length === 1).sort();
console.log('## Single-wave files (no collision)');
console.log('');
for (const [f, ws] of singles) {
  console.log(`- \`${f}\`: ${ws[0]}`);
}
console.log('');
console.log(`Total touched: ${fileToWaves.size}, collisions: ${collisions.length}, singles: ${singles.length}`);
