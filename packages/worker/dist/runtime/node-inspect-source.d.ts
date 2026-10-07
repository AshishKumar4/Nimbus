/**
 * Node v22.22.3's util.inspect as Node runs it: lib/internal/util/inspect.js,
 * over the primordials lib/internal/per_context/primordials.js builds. Both
 * are upstream's text byte for byte, each checked by its digest
 * (tests/unit/node-inspect-matches-node.mjs):
 *   https://raw.githubusercontent.com/nodejs/node/v22.22.3/lib/internal/util/inspect.js
 *   sha256 2f2f01d7077800f8565d1be2bd1e6800f8ac02759482dc080eb6bc6005d67dd1 (NODE_INSPECT_SHA256)
 *   https://raw.githubusercontent.com/nodejs/node/v22.22.3/lib/internal/per_context/primordials.js
 *   sha256 9e3fe2fe051667172d6ed9d997eee99b3454a7e4ec779dd63c1f19d44b25b1ca (NODE_PRIMORDIALS_SHA256)
 * The shims evaluate them once, the first time a program formats a value
 * (node-shims.ts, "util.inspect"), over what node-inspect-host.ts gives them
 * for Node's internal modules and bindings. v22.22.3 is the release Nimbus's
 * node reports and the tests' oracle (core/constants.ts NODE_RELEASE).
 *
 * The East Asian Wide and Fullwidth code points, for the column width
 * Node's ICU build counts (src/node_i18n.cc GetColumnWidth), are the W and F
 * ranges of the Unicode Character Database of Node's ICU (78.2, Unicode 17.0):
 *   https://www.unicode.org/Public/17.0.0/ucd/EastAsianWidth.txt
 *   sha256 ea7ce50f3444a050333448dffef1cadd9325af55cbb764b4a2280faf52170a33
 *
 * Node.js: MIT, Copyright Node.js contributors (NOTICE.md). Unicode data:
 * Unicode License v3, Copyright © 1991-2025 Unicode, Inc.
 */
export declare const NODE_INSPECT_SHA256 = "2f2f01d7077800f8565d1be2bd1e6800f8ac02759482dc080eb6bc6005d67dd1";
export declare const NODE_INSPECT_SOURCE: string;
export declare const NODE_PRIMORDIALS_SHA256 = "9e3fe2fe051667172d6ed9d997eee99b3454a7e4ec779dd63c1f19d44b25b1ca";
export declare const NODE_PRIMORDIALS_SOURCE: string;
/** The W and F ranges of EastAsianWidth.txt 17.0.0, merged: `first[-last]` in hex, comma-separated, ascending. */
export declare const EAST_ASIAN_WIDE_RANGES = "1100-115f,231a-231b,2329-232a,23e9-23ec,23f0,23f3,25fd-25fe,2614-2615,2630-2637,2648-2653,267f,268a-268f,2693,26a1,26aa-26ab,26bd-26be,26c4-26c5,26ce,26d4,26ea,26f2-26f3,26f5,26fa,26fd,2705,270a-270b,2728,274c,274e,2753-2755,2757,2795-2797,27b0,27bf,2b1b-2b1c,2b50,2b55,2e80-2e99,2e9b-2ef3,2f00-2fd5,2ff0-303e,3041-3096,3099-30ff,3105-312f,3131-318e,3190-31e5,31ef-321e,3220-3247,3250-a48c,a490-a4c6,a960-a97c,ac00-d7a3,f900-faff,fe10-fe19,fe30-fe52,fe54-fe66,fe68-fe6b,ff01-ff60,ffe0-ffe6,16fe0-16fe4,16ff0-16ff6,17000-18cd5,18cff-18d1e,18d80-18df2,1aff0-1aff3,1aff5-1affb,1affd-1affe,1b000-1b122,1b132,1b150-1b152,1b155,1b164-1b167,1b170-1b2fb,1d300-1d356,1d360-1d376,1f004,1f0cf,1f18e,1f191-1f19a,1f200-1f202,1f210-1f23b,1f240-1f248,1f250-1f251,1f260-1f265,1f300-1f320,1f32d-1f335,1f337-1f37c,1f37e-1f393,1f3a0-1f3ca,1f3cf-1f3d3,1f3e0-1f3f0,1f3f4,1f3f8-1f43e,1f440,1f442-1f4fc,1f4ff-1f53d,1f54b-1f54e,1f550-1f567,1f57a,1f595-1f596,1f5a4,1f5fb-1f64f,1f680-1f6c5,1f6cc,1f6d0-1f6d2,1f6d5-1f6d8,1f6dc-1f6df,1f6eb-1f6ec,1f6f4-1f6fc,1f7e0-1f7eb,1f7f0,1f90c-1f93a,1f93c-1f945,1f947-1f9ff,1fa70-1fa7c,1fa80-1fa8a,1fa8e-1fac6,1fac8,1facd-1fadc,1fadf-1faea,1faef-1faf8,20000-2fffd,30000-3fffd";
//# sourceMappingURL=node-inspect-source.d.ts.map