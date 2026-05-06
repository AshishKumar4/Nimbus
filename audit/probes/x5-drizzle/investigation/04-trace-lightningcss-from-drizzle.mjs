#!/usr/bin/env bun
// X.5-drizzle investigation 04 — Phase D pivot evidence:
//
// The Phase D fix (frameworkAware=false for generic-vite) was applied
// and verified to take effect (the "[npm] Framework detected" banner
// no longer appears in `npm install drizzle-orm`), BUT the
// resolver-facet still loud-rejects with `npm install rejected:
// lightningcss`. This means the lightningcss reject is NOT cascading
// through the framework-detected vite pull-in (as VERIFY-9D4B61D §3
// hypothesized) — it's cascading through a DIFFERENT path.
//
// This probe statically traces drizzle-orm's optional peers (X.5-J
// enqueues them at top-level) and finds which peer's transitive
// `dependencies` walk hits the parent `lightningcss` JS package.
//
// Output: name → first-hop chain to lightningcss.

import fs from 'node:fs';

const TARGET = 'lightningcss';
const ROOT = 'drizzle-orm';
const VERSION_RANGES = {}; // resolve all to "latest" for tracing

const fetched = new Map();
async function getMeta(name, range = 'latest') {
  const key = name + '@' + range;
  if (fetched.has(key)) return fetched.get(key);
  // Use exact-version fallback to "latest" for tracing — sufficient
  // because lightningcss is a structural dep, not a version-pinned one.
  const url = range === 'latest' || /^\^|^~|^>/.test(range)
    ? `https://registry.npmjs.org/${name}/latest`
    : `https://registry.npmjs.org/${name}/${range.replace(/^[\^~>=<]+/, '')}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    fetched.set(key, null);
    return null;
  }
  if (!res.ok) {
    // Fall back to /latest
    try {
      res = await fetch(`https://registry.npmjs.org/${name}/latest`);
      if (!res.ok) { fetched.set(key, null); return null; }
    } catch { fetched.set(key, null); return null; }
  }
  let meta;
  try { meta = await res.json(); } catch { fetched.set(key, null); return null; }
  fetched.set(key, meta);
  return meta;
}

console.log(`==== Tracing transitive paths from ${ROOT} to ${TARGET} ====`);

// 1. Get drizzle-orm meta
const drizzle = await getMeta(ROOT);
if (!drizzle) { console.error('failed to fetch drizzle-orm meta'); process.exit(2); }

console.log(`drizzle-orm@${drizzle.version}`);
console.log(`  optional peers (X.5-J top-level enqueue candidates): ${Object.keys(drizzle.peerDependencies || {}).length}`);

const peers = Object.keys(drizzle.peerDependencies || {});

// 2. For each peer, BFS-walk its dependencies (depth ≤ 4) looking for lightningcss
async function walkForTarget(rootName, maxDepth = 5) {
  // X.5-J's optional-peer top-level enqueue means the enqueued peer's
  // OWN peers (and their transitives) walk via both `dependencies` AND
  // `peerDependencies` fields. Mirror that here.
  const visited = new Set();
  const queue = [{ name: rootName, path: [rootName], depth: 0 }];
  while (queue.length > 0) {
    const { name, path, depth } = queue.shift();
    if (visited.has(name) || depth > maxDepth) continue;
    visited.add(name);
    if (name === TARGET) return path;
    const meta = await getMeta(name);
    if (!meta) continue;
    for (const dep of Object.keys(meta.dependencies || {})) {
      if (!visited.has(dep)) queue.push({ name: dep, path: [...path, dep + ' (dep)'], depth: depth + 1 });
    }
    for (const peer of Object.keys(meta.peerDependencies || {})) {
      const optional = meta.peerDependenciesMeta && meta.peerDependenciesMeta[peer] && meta.peerDependenciesMeta[peer].optional === true;
      if (!visited.has(peer)) queue.push({ name: peer, path: [...path, peer + (optional ? ' (optpeer)' : ' (peer)')], depth: depth + 1 });
    }
  }
  return null;
}

const hits = [];
for (const peer of peers) {
  process.stdout.write(`  trace ${peer} ... `);
  const chain = await walkForTarget(peer, 5);
  if (chain) {
    console.log('HIT  ' + chain.join(' → '));
    hits.push({ peer, chain });
  } else {
    console.log('no');
  }
}

console.log();
console.log('==== Summary ====');
if (hits.length === 0) {
  console.log('No optional peer of drizzle-orm transitively pulls lightningcss within depth 4.');
  console.log('lightningcss must come from a different mechanism — likely a peer\\u2019s peer.');
} else {
  console.log(`${hits.length} optional peer(s) of drizzle-orm transitively pull lightningcss:`);
  for (const h of hits) console.log(`  ${h.peer}: ${h.chain.join(' → ')}`);
}

process.exit(0);
