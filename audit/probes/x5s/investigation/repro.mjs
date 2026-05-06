// X.5-S investigation: standalone reproducer for the __dirname re-declaration
// failure surfaced by VERIFY-23417C5 §4 #1 / X5M3-retro §"Next bucket".
//
// Mirrors the exact wrap done by facet-manager.ts:215 (and :400) and
// node-shims.ts:2312:
//
//     new Function("exports","require","module","__filename","__dirname", code)
//
// where `code` is the esbuild ESM→CJS output that itself emits
//
//     const __dirname = import_path.default.dirname(...);
//
// Run: node audit/probes/x5s/investigation/repro.mjs

Error.stackTraceLimit = Infinity;

const ESBUILD_LIKE_OUTPUT = `
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var test_exports = {};
module.exports = test_exports;
var import_url = require("url");
var import_path = require("path");
const import_meta = {};
const __dirname = import_path.dirname((0, import_url.fileURLToPath)(import_meta.url));
const dir = __dirname;
test_exports.dir = dir;
`;

let res = { repro: null, fix_drop_param: null };

// 1. Reproduce the failure — current behaviour.
try {
  const fn = new Function(
    'exports', 'require', 'module', '__filename', '__dirname',
    ESBUILD_LIKE_OUTPUT,
  );
  res.repro = { ok: true, msg: 'unexpected — body parsed' };
} catch (e) {
  res.repro = { ok: false, msg: e.message };
}

// 2. Validate the conditional-drop fix shape — drop __dirname param when body declares it.
const HAS_DIRNAME_DECL = /(?:^|\n|;)\s*(?:const|let|var)\s+__dirname\s*=/m.test(ESBUILD_LIKE_OUTPUT);
const HAS_FILENAME_DECL = /(?:^|\n|;)\s*(?:const|let|var)\s+__filename\s*=/m.test(ESBUILD_LIKE_OUTPUT);
const params = ['exports', 'require', 'module'];
if (!HAS_FILENAME_DECL) params.push('__filename');
if (!HAS_DIRNAME_DECL) params.push('__dirname');
try {
  const fn = new Function(...params, ESBUILD_LIKE_OUTPUT);
  // Caller still passes 5 positional args; JS ignores extras.
  res.fix_drop_param = {
    ok: true,
    body_declares_dirname: HAS_DIRNAME_DECL,
    body_declares_filename: HAS_FILENAME_DECL,
    final_params: params,
  };
} catch (e) {
  res.fix_drop_param = { ok: false, msg: e.message };
}

console.log(JSON.stringify(res, null, 2));

// Exit 0 only if repro confirms failure AND fix shape parses cleanly.
const ok = res.repro && !res.repro.ok && res.fix_drop_param && res.fix_drop_param.ok;
process.exit(ok ? 0 : 1);
