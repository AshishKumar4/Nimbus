/**
 * minimatch 10.2.4 as Node v22.22.3 vendors it: deps/minimatch/index.js, the
 * one file holding minimatch with brace-expansion and balanced-match bundled
 * in. Node's fs.glob matches with exactly this code (lib/internal/fs/glob.js),
 * so the shims' fs.glob evaluates it too (node-shims.ts, "fs.glob"), once,
 * the first time a program globs. v22.22.3 is the release Nimbus's node
 * reports and the tests' oracle (core/constants.ts NODE_RELEASE).
 *
 * The text is upstream's byte for byte:
 *   https://raw.githubusercontent.com/nodejs/node/v22.22.3/deps/minimatch/index.js
 *   sha256 bbb2e2de15fd760c8ae208fff3160681820f175a3fc02df66464ca0c04852884 (NODE_MINIMATCH_SHA256;
 *   tests/unit/node-glob-matches-node.mjs checks it)
 *
 * minimatch: Blue Oak Model License 1.0.0, Copyright Isaac Z. Schlueter and
 * Contributors; the license: https://blueoakcouncil.org/license/1.0.0
 * (Node ships its text as deps/minimatch/LICENSE.md).
 * brace-expansion and balanced-match: MIT, Copyright (c) 2013 Julian Gruber.
 */
export declare const NODE_MINIMATCH_SHA256 = "bbb2e2de15fd760c8ae208fff3160681820f175a3fc02df66464ca0c04852884";
export declare const NODE_MINIMATCH_SOURCE: string;
//# sourceMappingURL=node-minimatch-source.d.ts.map