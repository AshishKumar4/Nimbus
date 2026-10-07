#!/usr/bin/env bun
// repl/node-hello-repl — `node` with no script drops into its REPL, which
// evaluates each line (_js-repl.mjs).

import { STRING, probeJsRepl } from './_js-repl.mjs';

await probeJsRepl('node', [['typeof process.versions.node', STRING('string')]]);
