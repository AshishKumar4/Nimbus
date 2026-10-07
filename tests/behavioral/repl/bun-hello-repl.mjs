#!/usr/bin/env bun
// repl/bun-hello-repl — `bun` with no script drops into its REPL, which
// evaluates each line with the Bun shim loaded (_js-repl.mjs).

import { STRING, probeJsRepl } from './_js-repl.mjs';

await probeJsRepl('bun', [['typeof Bun.file', STRING('function')]]);
