#!/usr/bin/env node
// The upstream source a runtime built in this repository is built from, as
// its spec pins it (runtime-specs.mjs `source`): "<url> <sha256>", for its
// build script to fetch and check.
//
//   node runtime-source.mjs jq/1.7.1
import { SPECS } from './runtime-specs.mjs';

const [key] = process.argv.slice(2);
const source = key === undefined ? undefined : SPECS[key]?.source;
if (source === undefined) {
  console.error(`runtime-source: ${key ?? '(no runtime named)'} pins no source in runtime-specs.mjs`);
  process.exit(2);
}
console.log(`${source.url} ${source.sha256}`);
