var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name50 in all)
    __defProp(target, name50, { get: all[name50], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// scripts/rolldown-facet/shims.mjs
var shims_exports = {};
__export(shims_exports, {
  EOL: () => EOL,
  MessageChannel: () => MessageChannel,
  Module: () => Module,
  Worker: () => Worker,
  WriteStream: () => WriteStream,
  argv: () => argv,
  cpus: () => cpus,
  createInterface: () => createInterface,
  createRequire: () => createRequire,
  cwd: () => cwd,
  default: () => shims_default,
  env: () => env,
  execSync: () => execSync,
  existsSync: () => existsSync,
  exit: () => exit,
  fileURLToPath: () => fileURLToPath,
  formatWithOptions: () => formatWithOptions,
  homedir: () => homedir,
  inspect: () => inspect,
  isMainThread: () => isMainThread,
  isatty: () => isatty,
  on: () => on,
  pathToFileURL: () => pathToFileURL,
  platform: () => platform,
  readFile: () => readFile,
  readFileSync: () => readFileSync,
  spawn: () => spawn,
  stat: () => stat,
  stderr: () => stderr,
  stdin: () => stdin,
  stdout: () => stdout,
  styleText: () => styleText,
  tmpdir: () => tmpdir,
  versions: () => versions,
  writeFile: () => writeFile
});
var unsupported2, isMainThread, Worker, MessageChannel, isatty, WriteStream, EOL, platform, homedir, tmpdir, cpus, styleText, formatWithOptions, inspect, Module, createRequire, readFileSync, existsSync, readFile, writeFile, stat, env, cwd, argv, versions, stdin, stdout, stderr, exit, on, createInterface, spawn, execSync, fileURLToPath, pathToFileURL, self, shims_default;
var init_shims = __esm({
  "scripts/rolldown-facet/shims.mjs"() {
    unsupported2 = (what) => () => {
      throw new Error(`Nimbus's build facet does not support ${what}`);
    };
    isMainThread = false;
    Worker = class {
      constructor() {
        unsupported2("worker_threads.Worker")();
      }
    };
    MessageChannel = class {
      constructor() {
        unsupported2("worker_threads.MessageChannel")();
      }
    };
    isatty = () => false;
    WriteStream = class {
      constructor() {
        unsupported2("tty.WriteStream")();
      }
    };
    EOL = "\n";
    platform = () => "linux";
    homedir = () => "/";
    tmpdir = () => "/tmp";
    cpus = () => [];
    styleText = (_format, text) => text;
    formatWithOptions = (_options, ...args2) => args2.map((a2) => typeof a2 === "string" ? a2 : JSON.stringify(a2)).join(" ");
    inspect = (value) => typeof value === "string" ? value : JSON.stringify(value);
    Module = class {
    };
    createRequire = () => unsupported2("require");
    readFileSync = unsupported2("fs.readFileSync");
    existsSync = () => false;
    readFile = unsupported2("fs.readFile");
    writeFile = unsupported2("fs.writeFile");
    stat = unsupported2("fs.stat");
    env = {};
    cwd = () => "/";
    argv = [];
    versions = {};
    stdin = { isTTY: false, on() {
    } };
    stdout = { isTTY: false, write() {
    } };
    stderr = { isTTY: false, write() {
    } };
    exit = unsupported2("process.exit");
    on = () => {
    };
    createInterface = unsupported2("readline.createInterface");
    spawn = unsupported2("child_process.spawn");
    execSync = unsupported2("child_process.execSync");
    fileURLToPath = (url) => decodeURIComponent(new URL(String(url)).pathname);
    pathToFileURL = (path3) => new URL(`file://${encodeURI(path3)}`);
    self = {
      isMainThread,
      Worker,
      MessageChannel,
      isatty,
      WriteStream,
      EOL,
      platform,
      homedir,
      tmpdir,
      cpus,
      styleText,
      formatWithOptions,
      inspect,
      Module,
      createRequire,
      readFileSync,
      existsSync,
      readFile,
      writeFile,
      stat,
      env,
      cwd,
      argv,
      stdin,
      versions,
      stdout,
      stderr,
      exit,
      on,
      fileURLToPath,
      pathToFileURL,
      createInterface,
      spawn,
      execSync,
      promises: { readFile, writeFile, stat }
    };
    shims_default = self;
  }
});

// ../../node_modules/.bun/rolldown@1.2.11/node_modules/rolldown/dist/shared/prompt-CH6TK0bC.mjs
var prompt_CH6TK0bC_exports = {};
__export(prompt_CH6TK0bC_exports, {
  prompt: () => prompt
});
function getDefaultExportFromCjs(x2) {
  return x2 && x2.__esModule && Object.prototype.hasOwnProperty.call(x2, "default") ? x2["default"] : x2;
}
function requireSrc() {
  if (hasRequiredSrc) return src;
  hasRequiredSrc = 1;
  const ESC = "\x1B";
  const CSI = `${ESC}[`;
  const beep = "\x07";
  const cursor = {
    to(x2, y3) {
      if (!y3) return `${CSI}${x2 + 1}G`;
      return `${CSI}${y3 + 1};${x2 + 1}H`;
    },
    move(x2, y3) {
      let ret = "";
      if (x2 < 0) ret += `${CSI}${-x2}D`;
      else if (x2 > 0) ret += `${CSI}${x2}C`;
      if (y3 < 0) ret += `${CSI}${-y3}A`;
      else if (y3 > 0) ret += `${CSI}${y3}B`;
      return ret;
    },
    up: (count = 1) => `${CSI}${count}A`,
    down: (count = 1) => `${CSI}${count}B`,
    forward: (count = 1) => `${CSI}${count}C`,
    backward: (count = 1) => `${CSI}${count}D`,
    nextLine: (count = 1) => `${CSI}E`.repeat(count),
    prevLine: (count = 1) => `${CSI}F`.repeat(count),
    left: `${CSI}G`,
    hide: `${CSI}?25l`,
    show: `${CSI}?25h`,
    save: `${ESC}7`,
    restore: `${ESC}8`
  };
  src = {
    cursor,
    scroll: {
      up: (count = 1) => `${CSI}S`.repeat(count),
      down: (count = 1) => `${CSI}T`.repeat(count)
    },
    erase: {
      screen: `${CSI}2J`,
      up: (count = 1) => `${CSI}1J`.repeat(count),
      down: (count = 1) => `${CSI}J`.repeat(count),
      line: `${CSI}2K`,
      lineEnd: `${CSI}K`,
      lineStart: `${CSI}1K`,
      lines(count) {
        let clear = "";
        for (let i2 = 0; i2 < count; i2++) clear += this.line + (i2 < count - 1 ? cursor.up() : "");
        if (count) clear += cursor.left;
        return clear;
      }
    },
    beep
  };
  return src;
}
function requirePicocolors() {
  if (hasRequiredPicocolors) return picocolors.exports;
  hasRequiredPicocolors = 1;
  let p = process || {}, argv3 = p.argv || [], env3 = p.env || {};
  let isColorSupported2 = !(!!env3.NO_COLOR || argv3.includes("--no-color")) && (!!env3.FORCE_COLOR || argv3.includes("--color") || p.platform === "win32" || (p.stdout || {}).isTTY && env3.TERM !== "dumb" || !!env3.CI);
  let formatter = (open, close, replace = open) => (input) => {
    let string2 = "" + input, index = string2.indexOf(close, open.length);
    return ~index ? open + replaceClose2(string2, close, replace, index) + close : open + string2 + close;
  };
  let replaceClose2 = (string2, close, replace, index) => {
    let result = "", cursor = 0;
    do {
      result += string2.substring(cursor, index) + replace;
      cursor = index + close.length;
      index = string2.indexOf(close, cursor);
    } while (~index);
    return result + string2.substring(cursor);
  };
  let createColors2 = (enabled = isColorSupported2) => {
    let f2 = enabled ? formatter : () => String;
    return {
      isColorSupported: enabled,
      reset: f2("\x1B[0m", "\x1B[0m"),
      bold: f2("\x1B[1m", "\x1B[22m", "\x1B[22m\x1B[1m"),
      dim: f2("\x1B[2m", "\x1B[22m", "\x1B[22m\x1B[2m"),
      italic: f2("\x1B[3m", "\x1B[23m"),
      underline: f2("\x1B[4m", "\x1B[24m"),
      inverse: f2("\x1B[7m", "\x1B[27m"),
      hidden: f2("\x1B[8m", "\x1B[28m"),
      strikethrough: f2("\x1B[9m", "\x1B[29m"),
      black: f2("\x1B[30m", "\x1B[39m"),
      red: f2("\x1B[31m", "\x1B[39m"),
      green: f2("\x1B[32m", "\x1B[39m"),
      yellow: f2("\x1B[33m", "\x1B[39m"),
      blue: f2("\x1B[34m", "\x1B[39m"),
      magenta: f2("\x1B[35m", "\x1B[39m"),
      cyan: f2("\x1B[36m", "\x1B[39m"),
      white: f2("\x1B[37m", "\x1B[39m"),
      gray: f2("\x1B[90m", "\x1B[39m"),
      bgBlack: f2("\x1B[40m", "\x1B[49m"),
      bgRed: f2("\x1B[41m", "\x1B[49m"),
      bgGreen: f2("\x1B[42m", "\x1B[49m"),
      bgYellow: f2("\x1B[43m", "\x1B[49m"),
      bgBlue: f2("\x1B[44m", "\x1B[49m"),
      bgMagenta: f2("\x1B[45m", "\x1B[49m"),
      bgCyan: f2("\x1B[46m", "\x1B[49m"),
      bgWhite: f2("\x1B[47m", "\x1B[49m"),
      blackBright: f2("\x1B[90m", "\x1B[39m"),
      redBright: f2("\x1B[91m", "\x1B[39m"),
      greenBright: f2("\x1B[92m", "\x1B[39m"),
      yellowBright: f2("\x1B[93m", "\x1B[39m"),
      blueBright: f2("\x1B[94m", "\x1B[39m"),
      magentaBright: f2("\x1B[95m", "\x1B[39m"),
      cyanBright: f2("\x1B[96m", "\x1B[39m"),
      whiteBright: f2("\x1B[97m", "\x1B[39m"),
      bgBlackBright: f2("\x1B[100m", "\x1B[49m"),
      bgRedBright: f2("\x1B[101m", "\x1B[49m"),
      bgGreenBright: f2("\x1B[102m", "\x1B[49m"),
      bgYellowBright: f2("\x1B[103m", "\x1B[49m"),
      bgBlueBright: f2("\x1B[104m", "\x1B[49m"),
      bgMagentaBright: f2("\x1B[105m", "\x1B[49m"),
      bgCyanBright: f2("\x1B[106m", "\x1B[49m"),
      bgWhiteBright: f2("\x1B[107m", "\x1B[49m")
    };
  };
  picocolors.exports = createColors2();
  picocolors.exports.createColors = createColors2;
  return picocolors.exports;
}
function J({ onlyFirst: t5 = false } = {}) {
  const F4 = ["[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?(?:\\u0007|\\u001B\\u005C|\\u009C))", "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))"].join("|");
  return new RegExp(F4, t5 ? void 0 : "g");
}
function T$1(t5) {
  if (typeof t5 != "string") throw new TypeError(`Expected a \`string\`, got \`${typeof t5}\``);
  return t5.replace(Q, "");
}
function O(t5) {
  return t5 && t5.__esModule && Object.prototype.hasOwnProperty.call(t5, "default") ? t5.default : t5;
}
function A$1(t5, u3 = {}) {
  if (typeof t5 != "string" || t5.length === 0 || (u3 = {
    ambiguousIsNarrow: true,
    ...u3
  }, t5 = T$1(t5), t5.length === 0)) return 0;
  t5 = t5.replace(FD(), "  ");
  const F4 = u3.ambiguousIsNarrow ? 1 : 2;
  let e3 = 0;
  for (const s2 of t5) {
    const i2 = s2.codePointAt(0);
    if (i2 <= 31 || i2 >= 127 && i2 <= 159 || i2 >= 768 && i2 <= 879) continue;
    switch (DD.eastAsianWidth(s2)) {
      case "F":
      case "W":
        e3 += 2;
        break;
      case "A":
        e3 += F4;
        break;
      default:
        e3 += 1;
    }
  }
  return e3;
}
function sD() {
  const t5 = /* @__PURE__ */ new Map();
  for (const [u3, F4] of Object.entries(r)) {
    for (const [e3, s2] of Object.entries(F4)) r[e3] = {
      open: `\x1B[${s2[0]}m`,
      close: `\x1B[${s2[1]}m`
    }, F4[e3] = r[e3], t5.set(s2[0], s2[1]);
    Object.defineProperty(r, u3, {
      value: F4,
      enumerable: false
    });
  }
  return Object.defineProperty(r, "codes", {
    value: t5,
    enumerable: false
  }), r.color.close = "\x1B[39m", r.bgColor.close = "\x1B[49m", r.color.ansi = L$1(), r.color.ansi256 = N(), r.color.ansi16m = I(), r.bgColor.ansi = L$1(m), r.bgColor.ansi256 = N(m), r.bgColor.ansi16m = I(m), Object.defineProperties(r, {
    rgbToAnsi256: {
      value: (u3, F4, e3) => u3 === F4 && F4 === e3 ? u3 < 8 ? 16 : u3 > 248 ? 231 : Math.round((u3 - 8) / 247 * 24) + 232 : 16 + 36 * Math.round(u3 / 255 * 5) + 6 * Math.round(F4 / 255 * 5) + Math.round(e3 / 255 * 5),
      enumerable: false
    },
    hexToRgb: {
      value: (u3) => {
        const F4 = /[a-f\d]{6}|[a-f\d]{3}/i.exec(u3.toString(16));
        if (!F4) return [
          0,
          0,
          0
        ];
        let [e3] = F4;
        e3.length === 3 && (e3 = [...e3].map((i2) => i2 + i2).join(""));
        const s2 = Number.parseInt(e3, 16);
        return [
          s2 >> 16 & 255,
          s2 >> 8 & 255,
          s2 & 255
        ];
      },
      enumerable: false
    },
    hexToAnsi256: {
      value: (u3) => r.rgbToAnsi256(...r.hexToRgb(u3)),
      enumerable: false
    },
    ansi256ToAnsi: {
      value: (u3) => {
        if (u3 < 8) return 30 + u3;
        if (u3 < 16) return 90 + (u3 - 8);
        let F4, e3, s2;
        if (u3 >= 232) F4 = ((u3 - 232) * 10 + 8) / 255, e3 = F4, s2 = F4;
        else {
          u3 -= 16;
          const C3 = u3 % 36;
          F4 = Math.floor(u3 / 36) / 5, e3 = Math.floor(C3 / 6) / 5, s2 = C3 % 6 / 5;
        }
        const i2 = Math.max(F4, e3, s2) * 2;
        if (i2 === 0) return 30;
        let D2 = 30 + (Math.round(s2) << 2 | Math.round(e3) << 1 | Math.round(F4));
        return i2 === 2 && (D2 += 60), D2;
      },
      enumerable: false
    },
    rgbToAnsi: {
      value: (u3, F4, e3) => r.ansi256ToAnsi(r.rgbToAnsi256(u3, F4, e3)),
      enumerable: false
    },
    hexToAnsi: {
      value: (u3) => r.ansi256ToAnsi(r.hexToAnsi256(u3)),
      enumerable: false
    }
  }), r;
}
function G(t5, u3, F4) {
  return String(t5).normalize().replace(/\r\n/g, `
`).split(`
`).map((e3) => oD(e3, u3, F4)).join(`
`);
}
function k$1(t5, u3) {
  if (typeof t5 == "string") return c.aliases.get(t5) === u3;
  for (const F4 of t5) if (F4 !== void 0 && k$1(F4, u3)) return true;
  return false;
}
function lD(t5, u3) {
  if (t5 === u3) return;
  const F4 = t5.split(`
`), e3 = u3.split(`
`), s2 = [];
  for (let i2 = 0; i2 < Math.max(F4.length, e3.length); i2++) F4[i2] !== e3[i2] && s2.push(i2);
  return s2;
}
function d$1(t5, u3) {
  const F4 = t5;
  F4.isTTY && F4.setRawMode(u3);
}
function ce() {
  return shims_default.platform !== "win32" ? shims_default.env.TERM !== "linux" : !!shims_default.env.CI || !!shims_default.env.WT_SESSION || !!shims_default.env.TERMINUS_SUBLIME || shims_default.env.ConEmuTask === "{cmd::Cmder}" || shims_default.env.TERM_PROGRAM === "Terminus-Sublime" || shims_default.env.TERM_PROGRAM === "vscode" || shims_default.env.TERM === "xterm-256color" || shims_default.env.TERM === "alacritty" || shims_default.env.TERMINAL_EMULATOR === "JetBrains-JediTerm";
}
async function prompt(message2, opts = {}) {
  const handleCancel = (value) => {
    if (typeof value !== "symbol" || value.toString() !== "Symbol(clack:cancel)") return value;
    switch (opts.cancel) {
      case "reject": {
        const error2 = /* @__PURE__ */ new Error("Prompt cancelled.");
        error2.name = "ConsolaPromptCancelledError";
        if (Error.captureStackTrace) Error.captureStackTrace(error2, prompt);
        throw error2;
      }
      case "undefined":
        return;
      case "null":
        return null;
      case "symbol":
        return kCancel;
      default:
      case "default":
        return opts.default ?? opts.initial;
    }
  };
  if (!opts.type || opts.type === "text") return await he({
    message: message2,
    defaultValue: opts.default,
    placeholder: opts.placeholder,
    initialValue: opts.initial
  }).then(handleCancel);
  if (opts.type === "confirm") return await ye({
    message: message2,
    initialValue: opts.initial
  }).then(handleCancel);
  if (opts.type === "select") return await ve({
    message: message2,
    options: opts.options.map((o3) => typeof o3 === "string" ? {
      value: o3,
      label: o3
    } : o3),
    initialValue: opts.initial
  }).then(handleCancel);
  if (opts.type === "multiselect") return await fe({
    message: message2,
    options: opts.options.map((o3) => typeof o3 === "string" ? {
      value: o3,
      label: o3
    } : o3),
    required: opts.required,
    initialValues: opts.initial
  }).then(handleCancel);
  throw new Error(`Unknown prompt type: ${opts.type}`);
}
var src, hasRequiredSrc, srcExports, picocolors, hasRequiredPicocolors, e2, Q, P$1, X, DD, uD, FD, m, L$1, N, I, r, tD, eD, iD, v, CD, w$1, W$1, rD, R, y, V$1, z, ED, _, nD, oD, c, S, AD, pD, h, x, fD, bD, mD, Y, wD, SD, $D, q, jD, PD, V, u, le, L, W, C, o, d, k, P, A, T, F, w, B, he, ye, ve, fe, kCancel;
var init_prompt_CH6TK0bC = __esm({
  "../../node_modules/.bun/rolldown@1.2.11/node_modules/rolldown/dist/shared/prompt-CH6TK0bC.mjs"() {
    init_shims();
    init_shims();
    init_shims();
    srcExports = requireSrc();
    picocolors = { exports: {} };
    e2 = /* @__PURE__ */ getDefaultExportFromCjs(/* @__PURE__ */ requirePicocolors());
    Q = J();
    P$1 = { exports: {} };
    (function(t5) {
      var u3 = {};
      t5.exports = u3, u3.eastAsianWidth = function(e3) {
        var s2 = e3.charCodeAt(0), i2 = e3.length == 2 ? e3.charCodeAt(1) : 0, D2 = s2;
        return 55296 <= s2 && s2 <= 56319 && 56320 <= i2 && i2 <= 57343 && (s2 &= 1023, i2 &= 1023, D2 = s2 << 10 | i2, D2 += 65536), D2 == 12288 || 65281 <= D2 && D2 <= 65376 || 65504 <= D2 && D2 <= 65510 ? "F" : D2 == 8361 || 65377 <= D2 && D2 <= 65470 || 65474 <= D2 && D2 <= 65479 || 65482 <= D2 && D2 <= 65487 || 65490 <= D2 && D2 <= 65495 || 65498 <= D2 && D2 <= 65500 || 65512 <= D2 && D2 <= 65518 ? "H" : 4352 <= D2 && D2 <= 4447 || 4515 <= D2 && D2 <= 4519 || 4602 <= D2 && D2 <= 4607 || 9001 <= D2 && D2 <= 9002 || 11904 <= D2 && D2 <= 11929 || 11931 <= D2 && D2 <= 12019 || 12032 <= D2 && D2 <= 12245 || 12272 <= D2 && D2 <= 12283 || 12289 <= D2 && D2 <= 12350 || 12353 <= D2 && D2 <= 12438 || 12441 <= D2 && D2 <= 12543 || 12549 <= D2 && D2 <= 12589 || 12593 <= D2 && D2 <= 12686 || 12688 <= D2 && D2 <= 12730 || 12736 <= D2 && D2 <= 12771 || 12784 <= D2 && D2 <= 12830 || 12832 <= D2 && D2 <= 12871 || 12880 <= D2 && D2 <= 13054 || 13056 <= D2 && D2 <= 19903 || 19968 <= D2 && D2 <= 42124 || 42128 <= D2 && D2 <= 42182 || 43360 <= D2 && D2 <= 43388 || 44032 <= D2 && D2 <= 55203 || 55216 <= D2 && D2 <= 55238 || 55243 <= D2 && D2 <= 55291 || 63744 <= D2 && D2 <= 64255 || 65040 <= D2 && D2 <= 65049 || 65072 <= D2 && D2 <= 65106 || 65108 <= D2 && D2 <= 65126 || 65128 <= D2 && D2 <= 65131 || 110592 <= D2 && D2 <= 110593 || 127488 <= D2 && D2 <= 127490 || 127504 <= D2 && D2 <= 127546 || 127552 <= D2 && D2 <= 127560 || 127568 <= D2 && D2 <= 127569 || 131072 <= D2 && D2 <= 194367 || 177984 <= D2 && D2 <= 196605 || 196608 <= D2 && D2 <= 262141 ? "W" : 32 <= D2 && D2 <= 126 || 162 <= D2 && D2 <= 163 || 165 <= D2 && D2 <= 166 || D2 == 172 || D2 == 175 || 10214 <= D2 && D2 <= 10221 || 10629 <= D2 && D2 <= 10630 ? "Na" : D2 == 161 || D2 == 164 || 167 <= D2 && D2 <= 168 || D2 == 170 || 173 <= D2 && D2 <= 174 || 176 <= D2 && D2 <= 180 || 182 <= D2 && D2 <= 186 || 188 <= D2 && D2 <= 191 || D2 == 198 || D2 == 208 || 215 <= D2 && D2 <= 216 || 222 <= D2 && D2 <= 225 || D2 == 230 || 232 <= D2 && D2 <= 234 || 236 <= D2 && D2 <= 237 || D2 == 240 || 242 <= D2 && D2 <= 243 || 247 <= D2 && D2 <= 250 || D2 == 252 || D2 == 254 || D2 == 257 || D2 == 273 || D2 == 275 || D2 == 283 || 294 <= D2 && D2 <= 295 || D2 == 299 || 305 <= D2 && D2 <= 307 || D2 == 312 || 319 <= D2 && D2 <= 322 || D2 == 324 || 328 <= D2 && D2 <= 331 || D2 == 333 || 338 <= D2 && D2 <= 339 || 358 <= D2 && D2 <= 359 || D2 == 363 || D2 == 462 || D2 == 464 || D2 == 466 || D2 == 468 || D2 == 470 || D2 == 472 || D2 == 474 || D2 == 476 || D2 == 593 || D2 == 609 || D2 == 708 || D2 == 711 || 713 <= D2 && D2 <= 715 || D2 == 717 || D2 == 720 || 728 <= D2 && D2 <= 731 || D2 == 733 || D2 == 735 || 768 <= D2 && D2 <= 879 || 913 <= D2 && D2 <= 929 || 931 <= D2 && D2 <= 937 || 945 <= D2 && D2 <= 961 || 963 <= D2 && D2 <= 969 || D2 == 1025 || 1040 <= D2 && D2 <= 1103 || D2 == 1105 || D2 == 8208 || 8211 <= D2 && D2 <= 8214 || 8216 <= D2 && D2 <= 8217 || 8220 <= D2 && D2 <= 8221 || 8224 <= D2 && D2 <= 8226 || 8228 <= D2 && D2 <= 8231 || D2 == 8240 || 8242 <= D2 && D2 <= 8243 || D2 == 8245 || D2 == 8251 || D2 == 8254 || D2 == 8308 || D2 == 8319 || 8321 <= D2 && D2 <= 8324 || D2 == 8364 || D2 == 8451 || D2 == 8453 || D2 == 8457 || D2 == 8467 || D2 == 8470 || 8481 <= D2 && D2 <= 8482 || D2 == 8486 || D2 == 8491 || 8531 <= D2 && D2 <= 8532 || 8539 <= D2 && D2 <= 8542 || 8544 <= D2 && D2 <= 8555 || 8560 <= D2 && D2 <= 8569 || D2 == 8585 || 8592 <= D2 && D2 <= 8601 || 8632 <= D2 && D2 <= 8633 || D2 == 8658 || D2 == 8660 || D2 == 8679 || D2 == 8704 || 8706 <= D2 && D2 <= 8707 || 8711 <= D2 && D2 <= 8712 || D2 == 8715 || D2 == 8719 || D2 == 8721 || D2 == 8725 || D2 == 8730 || 8733 <= D2 && D2 <= 8736 || D2 == 8739 || D2 == 8741 || 8743 <= D2 && D2 <= 8748 || D2 == 8750 || 8756 <= D2 && D2 <= 8759 || 8764 <= D2 && D2 <= 8765 || D2 == 8776 || D2 == 8780 || D2 == 8786 || 8800 <= D2 && D2 <= 8801 || 8804 <= D2 && D2 <= 8807 || 8810 <= D2 && D2 <= 8811 || 8814 <= D2 && D2 <= 8815 || 8834 <= D2 && D2 <= 8835 || 8838 <= D2 && D2 <= 8839 || D2 == 8853 || D2 == 8857 || D2 == 8869 || D2 == 8895 || D2 == 8978 || 9312 <= D2 && D2 <= 9449 || 9451 <= D2 && D2 <= 9547 || 9552 <= D2 && D2 <= 9587 || 9600 <= D2 && D2 <= 9615 || 9618 <= D2 && D2 <= 9621 || 9632 <= D2 && D2 <= 9633 || 9635 <= D2 && D2 <= 9641 || 9650 <= D2 && D2 <= 9651 || 9654 <= D2 && D2 <= 9655 || 9660 <= D2 && D2 <= 9661 || 9664 <= D2 && D2 <= 9665 || 9670 <= D2 && D2 <= 9672 || D2 == 9675 || 9678 <= D2 && D2 <= 9681 || 9698 <= D2 && D2 <= 9701 || D2 == 9711 || 9733 <= D2 && D2 <= 9734 || D2 == 9737 || 9742 <= D2 && D2 <= 9743 || 9748 <= D2 && D2 <= 9749 || D2 == 9756 || D2 == 9758 || D2 == 9792 || D2 == 9794 || 9824 <= D2 && D2 <= 9825 || 9827 <= D2 && D2 <= 9829 || 9831 <= D2 && D2 <= 9834 || 9836 <= D2 && D2 <= 9837 || D2 == 9839 || 9886 <= D2 && D2 <= 9887 || 9918 <= D2 && D2 <= 9919 || 9924 <= D2 && D2 <= 9933 || 9935 <= D2 && D2 <= 9953 || D2 == 9955 || 9960 <= D2 && D2 <= 9983 || D2 == 10045 || D2 == 10071 || 10102 <= D2 && D2 <= 10111 || 11093 <= D2 && D2 <= 11097 || 12872 <= D2 && D2 <= 12879 || 57344 <= D2 && D2 <= 63743 || 65024 <= D2 && D2 <= 65039 || D2 == 65533 || 127232 <= D2 && D2 <= 127242 || 127248 <= D2 && D2 <= 127277 || 127280 <= D2 && D2 <= 127337 || 127344 <= D2 && D2 <= 127386 || 917760 <= D2 && D2 <= 917999 || 983040 <= D2 && D2 <= 1048573 || 1048576 <= D2 && D2 <= 1114109 ? "A" : "N";
      }, u3.characterLength = function(e3) {
        var s2 = this.eastAsianWidth(e3);
        return s2 == "F" || s2 == "W" || s2 == "A" ? 2 : 1;
      };
      function F4(e3) {
        return e3.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[^\uD800-\uDFFF]/g) || [];
      }
      u3.length = function(e3) {
        for (var s2 = F4(e3), i2 = 0, D2 = 0; D2 < s2.length; D2++) i2 = i2 + this.characterLength(s2[D2]);
        return i2;
      }, u3.slice = function(e3, s2, i2) {
        textLen = u3.length(e3), s2 = s2 || 0, i2 = i2 || 1, s2 < 0 && (s2 = textLen + s2), i2 < 0 && (i2 = textLen + i2);
        for (var D2 = "", C3 = 0, o3 = F4(e3), E = 0; E < o3.length; E++) {
          var a2 = o3[E], n5 = u3.length(a2);
          if (C3 >= s2 - (n5 == 2 ? 1 : 0)) if (C3 + n5 <= i2) D2 += a2;
          else break;
          C3 += n5;
        }
        return D2;
      };
    })(P$1);
    X = P$1.exports;
    DD = O(X);
    uD = function() {
      return /\uD83C\uDFF4\uDB40\uDC67\uDB40\uDC62(?:\uDB40\uDC77\uDB40\uDC6C\uDB40\uDC73|\uDB40\uDC73\uDB40\uDC63\uDB40\uDC74|\uDB40\uDC65\uDB40\uDC6E\uDB40\uDC67)\uDB40\uDC7F|(?:\uD83E\uDDD1\uD83C\uDFFF\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFF\u200D\uD83E\uDD1D\u200D(?:\uD83D[\uDC68\uDC69]))(?:\uD83C[\uDFFB-\uDFFE])|(?:\uD83E\uDDD1\uD83C\uDFFE\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFE\u200D\uD83E\uDD1D\u200D(?:\uD83D[\uDC68\uDC69]))(?:\uD83C[\uDFFB-\uDFFD\uDFFF])|(?:\uD83E\uDDD1\uD83C\uDFFD\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFD\u200D\uD83E\uDD1D\u200D(?:\uD83D[\uDC68\uDC69]))(?:\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])|(?:\uD83E\uDDD1\uD83C\uDFFC\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFC\u200D\uD83E\uDD1D\u200D(?:\uD83D[\uDC68\uDC69]))(?:\uD83C[\uDFFB\uDFFD-\uDFFF])|(?:\uD83E\uDDD1\uD83C\uDFFB\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFB\u200D\uD83E\uDD1D\u200D(?:\uD83D[\uDC68\uDC69]))(?:\uD83C[\uDFFC-\uDFFF])|\uD83D\uDC68(?:\uD83C\uDFFB(?:\u200D(?:\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFF])|\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFF]))|\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFC-\uDFFF])|[\u2695\u2696\u2708]\uFE0F|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD]))?|(?:\uD83C[\uDFFC-\uDFFF])\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFF])|\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFF]))|\u200D(?:\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83D\uDC68|(?:\uD83D[\uDC68\uDC69])\u200D(?:\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67]))|\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67])|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFF\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFE])|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFE\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFD\uDFFF])|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFD\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFC\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB\uDFFD-\uDFFF])|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|(?:\uD83C\uDFFF\u200D[\u2695\u2696\u2708]|\uD83C\uDFFE\u200D[\u2695\u2696\u2708]|\uD83C\uDFFD\u200D[\u2695\u2696\u2708]|\uD83C\uDFFC\u200D[\u2695\u2696\u2708]|\u200D[\u2695\u2696\u2708])\uFE0F|\u200D(?:(?:\uD83D[\uDC68\uDC69])\u200D(?:\uD83D[\uDC66\uDC67])|\uD83D[\uDC66\uDC67])|\uD83C\uDFFF|\uD83C\uDFFE|\uD83C\uDFFD|\uD83C\uDFFC)?|(?:\uD83D\uDC69(?:\uD83C\uDFFB\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D(?:\uD83D[\uDC68\uDC69])|\uD83D[\uDC68\uDC69])|(?:\uD83C[\uDFFC-\uDFFF])\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D(?:\uD83D[\uDC68\uDC69])|\uD83D[\uDC68\uDC69]))|\uD83E\uDDD1(?:\uD83C[\uDFFB-\uDFFF])\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1)(?:\uD83C[\uDFFB-\uDFFF])|\uD83D\uDC69\u200D\uD83D\uDC69\u200D(?:\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67]))|\uD83D\uDC69(?:\u200D(?:\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D(?:\uD83D[\uDC68\uDC69])|\uD83D[\uDC68\uDC69])|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFF\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFE\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFD\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFC\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFB\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD]))|\uD83E\uDDD1(?:\u200D(?:\uD83E\uDD1D\u200D\uD83E\uDDD1|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFF\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFE\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFD\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFC\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFB\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD]))|\uD83D\uDC69\u200D\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC69\u200D\uD83D\uDC69\u200D(?:\uD83D[\uDC66\uDC67])|\uD83D\uDC69\u200D\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67])|(?:\uD83D\uDC41\uFE0F\u200D\uD83D\uDDE8|\uD83E\uDDD1(?:\uD83C\uDFFF\u200D[\u2695\u2696\u2708]|\uD83C\uDFFE\u200D[\u2695\u2696\u2708]|\uD83C\uDFFD\u200D[\u2695\u2696\u2708]|\uD83C\uDFFC\u200D[\u2695\u2696\u2708]|\uD83C\uDFFB\u200D[\u2695\u2696\u2708]|\u200D[\u2695\u2696\u2708])|\uD83D\uDC69(?:\uD83C\uDFFF\u200D[\u2695\u2696\u2708]|\uD83C\uDFFE\u200D[\u2695\u2696\u2708]|\uD83C\uDFFD\u200D[\u2695\u2696\u2708]|\uD83C\uDFFC\u200D[\u2695\u2696\u2708]|\uD83C\uDFFB\u200D[\u2695\u2696\u2708]|\u200D[\u2695\u2696\u2708])|\uD83D\uDE36\u200D\uD83C\uDF2B|\uD83C\uDFF3\uFE0F\u200D\u26A7|\uD83D\uDC3B\u200D\u2744|(?:(?:\uD83C[\uDFC3\uDFC4\uDFCA]|\uD83D[\uDC6E\uDC70\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4-\uDEB6]|\uD83E[\uDD26\uDD35\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD-\uDDCF\uDDD4\uDDD6-\uDDDD])(?:\uD83C[\uDFFB-\uDFFF])|\uD83D\uDC6F|\uD83E[\uDD3C\uDDDE\uDDDF])\u200D[\u2640\u2642]|(?:\u26F9|\uD83C[\uDFCB\uDFCC]|\uD83D\uDD75)(?:\uFE0F|\uD83C[\uDFFB-\uDFFF])\u200D[\u2640\u2642]|\uD83C\uDFF4\u200D\u2620|(?:\uD83C[\uDFC3\uDFC4\uDFCA]|\uD83D[\uDC6E\uDC70\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4-\uDEB6]|\uD83E[\uDD26\uDD35\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD-\uDDCF\uDDD4\uDDD6-\uDDDD])\u200D[\u2640\u2642]|[\xA9\xAE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u2328\u23CF\u23ED-\u23EF\u23F1\u23F2\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB\u25FC\u2600-\u2604\u260E\u2611\u2618\u2620\u2622\u2623\u2626\u262A\u262E\u262F\u2638-\u263A\u2640\u2642\u265F\u2660\u2663\u2665\u2666\u2668\u267B\u267E\u2692\u2694-\u2697\u2699\u269B\u269C\u26A0\u26A7\u26B0\u26B1\u26C8\u26CF\u26D1\u26D3\u26E9\u26F0\u26F1\u26F4\u26F7\u26F8\u2702\u2708\u2709\u270F\u2712\u2714\u2716\u271D\u2721\u2733\u2734\u2744\u2747\u2763\u27A1\u2934\u2935\u2B05-\u2B07\u3030\u303D\u3297\u3299]|\uD83C[\uDD70\uDD71\uDD7E\uDD7F\uDE02\uDE37\uDF21\uDF24-\uDF2C\uDF36\uDF7D\uDF96\uDF97\uDF99-\uDF9B\uDF9E\uDF9F\uDFCD\uDFCE\uDFD4-\uDFDF\uDFF5\uDFF7]|\uD83D[\uDC3F\uDCFD\uDD49\uDD4A\uDD6F\uDD70\uDD73\uDD76-\uDD79\uDD87\uDD8A-\uDD8D\uDDA5\uDDA8\uDDB1\uDDB2\uDDBC\uDDC2-\uDDC4\uDDD1-\uDDD3\uDDDC-\uDDDE\uDDE1\uDDE3\uDDE8\uDDEF\uDDF3\uDDFA\uDECB\uDECD-\uDECF\uDEE0-\uDEE5\uDEE9\uDEF0\uDEF3])\uFE0F|\uD83C\uDFF3\uFE0F\u200D\uD83C\uDF08|\uD83D\uDC69\u200D\uD83D\uDC67|\uD83D\uDC69\u200D\uD83D\uDC66|\uD83D\uDE35\u200D\uD83D\uDCAB|\uD83D\uDE2E\u200D\uD83D\uDCA8|\uD83D\uDC15\u200D\uD83E\uDDBA|\uD83E\uDDD1(?:\uD83C\uDFFF|\uD83C\uDFFE|\uD83C\uDFFD|\uD83C\uDFFC|\uD83C\uDFFB)?|\uD83D\uDC69(?:\uD83C\uDFFF|\uD83C\uDFFE|\uD83C\uDFFD|\uD83C\uDFFC|\uD83C\uDFFB)?|\uD83C\uDDFD\uD83C\uDDF0|\uD83C\uDDF6\uD83C\uDDE6|\uD83C\uDDF4\uD83C\uDDF2|\uD83D\uDC08\u200D\u2B1B|\u2764\uFE0F\u200D(?:\uD83D\uDD25|\uD83E\uDE79)|\uD83D\uDC41\uFE0F|\uD83C\uDFF3\uFE0F|\uD83C\uDDFF(?:\uD83C[\uDDE6\uDDF2\uDDFC])|\uD83C\uDDFE(?:\uD83C[\uDDEA\uDDF9])|\uD83C\uDDFC(?:\uD83C[\uDDEB\uDDF8])|\uD83C\uDDFB(?:\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDEE\uDDF3\uDDFA])|\uD83C\uDDFA(?:\uD83C[\uDDE6\uDDEC\uDDF2\uDDF3\uDDF8\uDDFE\uDDFF])|\uD83C\uDDF9(?:\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDED\uDDEF-\uDDF4\uDDF7\uDDF9\uDDFB\uDDFC\uDDFF])|\uD83C\uDDF8(?:\uD83C[\uDDE6-\uDDEA\uDDEC-\uDDF4\uDDF7-\uDDF9\uDDFB\uDDFD-\uDDFF])|\uD83C\uDDF7(?:\uD83C[\uDDEA\uDDF4\uDDF8\uDDFA\uDDFC])|\uD83C\uDDF5(?:\uD83C[\uDDE6\uDDEA-\uDDED\uDDF0-\uDDF3\uDDF7-\uDDF9\uDDFC\uDDFE])|\uD83C\uDDF3(?:\uD83C[\uDDE6\uDDE8\uDDEA-\uDDEC\uDDEE\uDDF1\uDDF4\uDDF5\uDDF7\uDDFA\uDDFF])|\uD83C\uDDF2(?:\uD83C[\uDDE6\uDDE8-\uDDED\uDDF0-\uDDFF])|\uD83C\uDDF1(?:\uD83C[\uDDE6-\uDDE8\uDDEE\uDDF0\uDDF7-\uDDFB\uDDFE])|\uD83C\uDDF0(?:\uD83C[\uDDEA\uDDEC-\uDDEE\uDDF2\uDDF3\uDDF5\uDDF7\uDDFC\uDDFE\uDDFF])|\uD83C\uDDEF(?:\uD83C[\uDDEA\uDDF2\uDDF4\uDDF5])|\uD83C\uDDEE(?:\uD83C[\uDDE8-\uDDEA\uDDF1-\uDDF4\uDDF6-\uDDF9])|\uD83C\uDDED(?:\uD83C[\uDDF0\uDDF2\uDDF3\uDDF7\uDDF9\uDDFA])|\uD83C\uDDEC(?:\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEE\uDDF1-\uDDF3\uDDF5-\uDDFA\uDDFC\uDDFE])|\uD83C\uDDEB(?:\uD83C[\uDDEE-\uDDF0\uDDF2\uDDF4\uDDF7])|\uD83C\uDDEA(?:\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDED\uDDF7-\uDDFA])|\uD83C\uDDE9(?:\uD83C[\uDDEA\uDDEC\uDDEF\uDDF0\uDDF2\uDDF4\uDDFF])|\uD83C\uDDE8(?:\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDEE\uDDF0-\uDDF5\uDDF7\uDDFA-\uDDFF])|\uD83C\uDDE7(?:\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEF\uDDF1-\uDDF4\uDDF6-\uDDF9\uDDFB\uDDFC\uDDFE\uDDFF])|\uD83C\uDDE6(?:\uD83C[\uDDE8-\uDDEC\uDDEE\uDDF1\uDDF2\uDDF4\uDDF6-\uDDFA\uDDFC\uDDFD\uDDFF])|[#\*0-9]\uFE0F\u20E3|\u2764\uFE0F|(?:\uD83C[\uDFC3\uDFC4\uDFCA]|\uD83D[\uDC6E\uDC70\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4-\uDEB6]|\uD83E[\uDD26\uDD35\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD-\uDDCF\uDDD4\uDDD6-\uDDDD])(?:\uD83C[\uDFFB-\uDFFF])|(?:\u26F9|\uD83C[\uDFCB\uDFCC]|\uD83D\uDD75)(?:\uFE0F|\uD83C[\uDFFB-\uDFFF])|\uD83C\uDFF4|(?:[\u270A\u270B]|\uD83C[\uDF85\uDFC2\uDFC7]|\uD83D[\uDC42\uDC43\uDC46-\uDC50\uDC66\uDC67\uDC6B-\uDC6D\uDC72\uDC74-\uDC76\uDC78\uDC7C\uDC83\uDC85\uDC8F\uDC91\uDCAA\uDD7A\uDD95\uDD96\uDE4C\uDE4F\uDEC0\uDECC]|\uD83E[\uDD0C\uDD0F\uDD18-\uDD1C\uDD1E\uDD1F\uDD30-\uDD34\uDD36\uDD77\uDDB5\uDDB6\uDDBB\uDDD2\uDDD3\uDDD5])(?:\uD83C[\uDFFB-\uDFFF])|(?:[\u261D\u270C\u270D]|\uD83D[\uDD74\uDD90])(?:\uFE0F|\uD83C[\uDFFB-\uDFFF])|[\u270A\u270B]|\uD83C[\uDF85\uDFC2\uDFC7]|\uD83D[\uDC08\uDC15\uDC3B\uDC42\uDC43\uDC46-\uDC50\uDC66\uDC67\uDC6B-\uDC6D\uDC72\uDC74-\uDC76\uDC78\uDC7C\uDC83\uDC85\uDC8F\uDC91\uDCAA\uDD7A\uDD95\uDD96\uDE2E\uDE35\uDE36\uDE4C\uDE4F\uDEC0\uDECC]|\uD83E[\uDD0C\uDD0F\uDD18-\uDD1C\uDD1E\uDD1F\uDD30-\uDD34\uDD36\uDD77\uDDB5\uDDB6\uDDBB\uDDD2\uDDD3\uDDD5]|\uD83C[\uDFC3\uDFC4\uDFCA]|\uD83D[\uDC6E\uDC70\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4-\uDEB6]|\uD83E[\uDD26\uDD35\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD-\uDDCF\uDDD4\uDDD6-\uDDDD]|\uD83D\uDC6F|\uD83E[\uDD3C\uDDDE\uDDDF]|[\u231A\u231B\u23E9-\u23EC\u23F0\u23F3\u25FD\u25FE\u2614\u2615\u2648-\u2653\u267F\u2693\u26A1\u26AA\u26AB\u26BD\u26BE\u26C4\u26C5\u26CE\u26D4\u26EA\u26F2\u26F3\u26F5\u26FA\u26FD\u2705\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B\u2B1C\u2B50\u2B55]|\uD83C[\uDC04\uDCCF\uDD8E\uDD91-\uDD9A\uDE01\uDE1A\uDE2F\uDE32-\uDE36\uDE38-\uDE3A\uDE50\uDE51\uDF00-\uDF20\uDF2D-\uDF35\uDF37-\uDF7C\uDF7E-\uDF84\uDF86-\uDF93\uDFA0-\uDFC1\uDFC5\uDFC6\uDFC8\uDFC9\uDFCF-\uDFD3\uDFE0-\uDFF0\uDFF8-\uDFFF]|\uD83D[\uDC00-\uDC07\uDC09-\uDC14\uDC16-\uDC3A\uDC3C-\uDC3E\uDC40\uDC44\uDC45\uDC51-\uDC65\uDC6A\uDC79-\uDC7B\uDC7D-\uDC80\uDC84\uDC88-\uDC8E\uDC90\uDC92-\uDCA9\uDCAB-\uDCFC\uDCFF-\uDD3D\uDD4B-\uDD4E\uDD50-\uDD67\uDDA4\uDDFB-\uDE2D\uDE2F-\uDE34\uDE37-\uDE44\uDE48-\uDE4A\uDE80-\uDEA2\uDEA4-\uDEB3\uDEB7-\uDEBF\uDEC1-\uDEC5\uDED0-\uDED2\uDED5-\uDED7\uDEEB\uDEEC\uDEF4-\uDEFC\uDFE0-\uDFEB]|\uD83E[\uDD0D\uDD0E\uDD10-\uDD17\uDD1D\uDD20-\uDD25\uDD27-\uDD2F\uDD3A\uDD3F-\uDD45\uDD47-\uDD76\uDD78\uDD7A-\uDDB4\uDDB7\uDDBA\uDDBC-\uDDCB\uDDD0\uDDE0-\uDDFF\uDE70-\uDE74\uDE78-\uDE7A\uDE80-\uDE86\uDE90-\uDEA8\uDEB0-\uDEB6\uDEC0-\uDEC2\uDED0-\uDED6]|(?:[\u231A\u231B\u23E9-\u23EC\u23F0\u23F3\u25FD\u25FE\u2614\u2615\u2648-\u2653\u267F\u2693\u26A1\u26AA\u26AB\u26BD\u26BE\u26C4\u26C5\u26CE\u26D4\u26EA\u26F2\u26F3\u26F5\u26FA\u26FD\u2705\u270A\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B\u2B1C\u2B50\u2B55]|\uD83C[\uDC04\uDCCF\uDD8E\uDD91-\uDD9A\uDDE6-\uDDFF\uDE01\uDE1A\uDE2F\uDE32-\uDE36\uDE38-\uDE3A\uDE50\uDE51\uDF00-\uDF20\uDF2D-\uDF35\uDF37-\uDF7C\uDF7E-\uDF93\uDFA0-\uDFCA\uDFCF-\uDFD3\uDFE0-\uDFF0\uDFF4\uDFF8-\uDFFF]|\uD83D[\uDC00-\uDC3E\uDC40\uDC42-\uDCFC\uDCFF-\uDD3D\uDD4B-\uDD4E\uDD50-\uDD67\uDD7A\uDD95\uDD96\uDDA4\uDDFB-\uDE4F\uDE80-\uDEC5\uDECC\uDED0-\uDED2\uDED5-\uDED7\uDEEB\uDEEC\uDEF4-\uDEFC\uDFE0-\uDFEB]|\uD83E[\uDD0C-\uDD3A\uDD3C-\uDD45\uDD47-\uDD78\uDD7A-\uDDCB\uDDCD-\uDDFF\uDE70-\uDE74\uDE78-\uDE7A\uDE80-\uDE86\uDE90-\uDEA8\uDEB0-\uDEB6\uDEC0-\uDEC2\uDED0-\uDED6])|(?:[#\*0-9\xA9\xAE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u231A\u231B\u2328\u23CF\u23E9-\u23F3\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB-\u25FE\u2600-\u2604\u260E\u2611\u2614\u2615\u2618\u261D\u2620\u2622\u2623\u2626\u262A\u262E\u262F\u2638-\u263A\u2640\u2642\u2648-\u2653\u265F\u2660\u2663\u2665\u2666\u2668\u267B\u267E\u267F\u2692-\u2697\u2699\u269B\u269C\u26A0\u26A1\u26A7\u26AA\u26AB\u26B0\u26B1\u26BD\u26BE\u26C4\u26C5\u26C8\u26CE\u26CF\u26D1\u26D3\u26D4\u26E9\u26EA\u26F0-\u26F5\u26F7-\u26FA\u26FD\u2702\u2705\u2708-\u270D\u270F\u2712\u2714\u2716\u271D\u2721\u2728\u2733\u2734\u2744\u2747\u274C\u274E\u2753-\u2755\u2757\u2763\u2764\u2795-\u2797\u27A1\u27B0\u27BF\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B50\u2B55\u3030\u303D\u3297\u3299]|\uD83C[\uDC04\uDCCF\uDD70\uDD71\uDD7E\uDD7F\uDD8E\uDD91-\uDD9A\uDDE6-\uDDFF\uDE01\uDE02\uDE1A\uDE2F\uDE32-\uDE3A\uDE50\uDE51\uDF00-\uDF21\uDF24-\uDF93\uDF96\uDF97\uDF99-\uDF9B\uDF9E-\uDFF0\uDFF3-\uDFF5\uDFF7-\uDFFF]|\uD83D[\uDC00-\uDCFD\uDCFF-\uDD3D\uDD49-\uDD4E\uDD50-\uDD67\uDD6F\uDD70\uDD73-\uDD7A\uDD87\uDD8A-\uDD8D\uDD90\uDD95\uDD96\uDDA4\uDDA5\uDDA8\uDDB1\uDDB2\uDDBC\uDDC2-\uDDC4\uDDD1-\uDDD3\uDDDC-\uDDDE\uDDE1\uDDE3\uDDE8\uDDEF\uDDF3\uDDFA-\uDE4F\uDE80-\uDEC5\uDECB-\uDED2\uDED5-\uDED7\uDEE0-\uDEE5\uDEE9\uDEEB\uDEEC\uDEF0\uDEF3-\uDEFC\uDFE0-\uDFEB]|\uD83E[\uDD0C-\uDD3A\uDD3C-\uDD45\uDD47-\uDD78\uDD7A-\uDDCB\uDDCD-\uDDFF\uDE70-\uDE74\uDE78-\uDE7A\uDE80-\uDE86\uDE90-\uDEA8\uDEB0-\uDEB6\uDEC0-\uDEC2\uDED0-\uDED6])\uFE0F|(?:[\u261D\u26F9\u270A-\u270D]|\uD83C[\uDF85\uDFC2-\uDFC4\uDFC7\uDFCA-\uDFCC]|\uD83D[\uDC42\uDC43\uDC46-\uDC50\uDC66-\uDC78\uDC7C\uDC81-\uDC83\uDC85-\uDC87\uDC8F\uDC91\uDCAA\uDD74\uDD75\uDD7A\uDD90\uDD95\uDD96\uDE45-\uDE47\uDE4B-\uDE4F\uDEA3\uDEB4-\uDEB6\uDEC0\uDECC]|\uD83E[\uDD0C\uDD0F\uDD18-\uDD1F\uDD26\uDD30-\uDD39\uDD3C-\uDD3E\uDD77\uDDB5\uDDB6\uDDB8\uDDB9\uDDBB\uDDCD-\uDDCF\uDDD1-\uDDDD])/g;
    };
    FD = O(uD);
    m = 10;
    L$1 = (t5 = 0) => (u3) => `\x1B[${u3 + t5}m`;
    N = (t5 = 0) => (u3) => `\x1B[${38 + t5};5;${u3}m`;
    I = (t5 = 0) => (u3, F4, e3) => `\x1B[${38 + t5};2;${u3};${F4};${e3}m`;
    r = {
      modifier: {
        reset: [0, 0],
        bold: [1, 22],
        dim: [2, 22],
        italic: [3, 23],
        underline: [4, 24],
        overline: [53, 55],
        inverse: [7, 27],
        hidden: [8, 28],
        strikethrough: [9, 29]
      },
      color: {
        black: [30, 39],
        red: [31, 39],
        green: [32, 39],
        yellow: [33, 39],
        blue: [34, 39],
        magenta: [35, 39],
        cyan: [36, 39],
        white: [37, 39],
        blackBright: [90, 39],
        gray: [90, 39],
        grey: [90, 39],
        redBright: [91, 39],
        greenBright: [92, 39],
        yellowBright: [93, 39],
        blueBright: [94, 39],
        magentaBright: [95, 39],
        cyanBright: [96, 39],
        whiteBright: [97, 39]
      },
      bgColor: {
        bgBlack: [40, 49],
        bgRed: [41, 49],
        bgGreen: [42, 49],
        bgYellow: [43, 49],
        bgBlue: [44, 49],
        bgMagenta: [45, 49],
        bgCyan: [46, 49],
        bgWhite: [47, 49],
        bgBlackBright: [100, 49],
        bgGray: [100, 49],
        bgGrey: [100, 49],
        bgRedBright: [101, 49],
        bgGreenBright: [102, 49],
        bgYellowBright: [103, 49],
        bgBlueBright: [104, 49],
        bgMagentaBright: [105, 49],
        bgCyanBright: [106, 49],
        bgWhiteBright: [107, 49]
      }
    };
    Object.keys(r.modifier);
    tD = Object.keys(r.color);
    eD = Object.keys(r.bgColor);
    [...tD, ...eD];
    iD = sD();
    v = /* @__PURE__ */ new Set(["\x1B", "\x9B"]);
    CD = 39;
    w$1 = "\x07";
    W$1 = "[";
    rD = "]";
    R = "m";
    y = `${rD}8;;`;
    V$1 = (t5) => `${v.values().next().value}${W$1}${t5}${R}`;
    z = (t5) => `${v.values().next().value}${y}${t5}${w$1}`;
    ED = (t5) => t5.split(" ").map((u3) => A$1(u3));
    _ = (t5, u3, F4) => {
      const e3 = [...u3];
      let s2 = false, i2 = false, D2 = A$1(T$1(t5[t5.length - 1]));
      for (const [C3, o3] of e3.entries()) {
        const E = A$1(o3);
        if (D2 + E <= F4 ? t5[t5.length - 1] += o3 : (t5.push(o3), D2 = 0), v.has(o3) && (s2 = true, i2 = e3.slice(C3 + 1).join("").startsWith(y)), s2) {
          i2 ? o3 === w$1 && (s2 = false, i2 = false) : o3 === R && (s2 = false);
          continue;
        }
        D2 += E, D2 === F4 && C3 < e3.length - 1 && (t5.push(""), D2 = 0);
      }
      !D2 && t5[t5.length - 1].length > 0 && t5.length > 1 && (t5[t5.length - 2] += t5.pop());
    };
    nD = (t5) => {
      const u3 = t5.split(" ");
      let F4 = u3.length;
      for (; F4 > 0 && !(A$1(u3[F4 - 1]) > 0); ) F4--;
      return F4 === u3.length ? t5 : u3.slice(0, F4).join(" ") + u3.slice(F4).join("");
    };
    oD = (t5, u3, F4 = {}) => {
      if (F4.trim !== false && t5.trim() === "") return "";
      let e3 = "", s2, i2;
      const D2 = ED(t5);
      let C3 = [""];
      for (const [E, a2] of t5.split(" ").entries()) {
        F4.trim !== false && (C3[C3.length - 1] = C3[C3.length - 1].trimStart());
        let n5 = A$1(C3[C3.length - 1]);
        if (E !== 0 && (n5 >= u3 && (F4.wordWrap === false || F4.trim === false) && (C3.push(""), n5 = 0), (n5 > 0 || F4.trim === false) && (C3[C3.length - 1] += " ", n5++)), F4.hard && D2[E] > u3) {
          const B2 = u3 - n5, p = 1 + Math.floor((D2[E] - B2 - 1) / u3);
          Math.floor((D2[E] - 1) / u3) < p && C3.push(""), _(C3, a2, u3);
          continue;
        }
        if (n5 + D2[E] > u3 && n5 > 0 && D2[E] > 0) {
          if (F4.wordWrap === false && n5 < u3) {
            _(C3, a2, u3);
            continue;
          }
          C3.push("");
        }
        if (n5 + D2[E] > u3 && F4.wordWrap === false) {
          _(C3, a2, u3);
          continue;
        }
        C3[C3.length - 1] += a2;
      }
      F4.trim !== false && (C3 = C3.map((E) => nD(E)));
      const o3 = [...C3.join(`
`)];
      for (const [E, a2] of o3.entries()) {
        if (e3 += a2, v.has(a2)) {
          const { groups: B2 } = new RegExp(`(?:\\${W$1}(?<code>\\d+)m|\\${y}(?<uri>.*)${w$1})`).exec(o3.slice(E).join("")) || { groups: {} };
          if (B2.code !== void 0) {
            const p = Number.parseFloat(B2.code);
            s2 = p === CD ? void 0 : p;
          } else B2.uri !== void 0 && (i2 = B2.uri.length === 0 ? void 0 : B2.uri);
        }
        const n5 = iD.codes.get(Number(s2));
        o3[E + 1] === `
` ? (i2 && (e3 += z("")), s2 && n5 && (e3 += V$1(n5))) : a2 === `
` && (s2 && n5 && (e3 += V$1(s2)), i2 && (e3 += z(i2)));
      }
      return e3;
    };
    c = {
      actions: /* @__PURE__ */ new Set([
        "up",
        "down",
        "left",
        "right",
        "space",
        "enter",
        "cancel"
      ]),
      aliases: /* @__PURE__ */ new Map([
        ["k", "up"],
        ["j", "down"],
        ["h", "left"],
        ["l", "right"],
        ["", "cancel"],
        ["escape", "cancel"]
      ])
    };
    globalThis.process.platform.startsWith("win");
    S = /* @__PURE__ */ Symbol("clack:cancel");
    AD = Object.defineProperty;
    pD = (t5, u3, F4) => u3 in t5 ? AD(t5, u3, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: F4
    }) : t5[u3] = F4;
    h = (t5, u3, F4) => (pD(t5, typeof u3 != "symbol" ? u3 + "" : u3, F4), F4);
    x = class {
      constructor(u3, F4 = true) {
        h(this, "input"), h(this, "output"), h(this, "_abortSignal"), h(this, "rl"), h(this, "opts"), h(this, "_render"), h(this, "_track", false), h(this, "_prevFrame", ""), h(this, "_subscribers", /* @__PURE__ */ new Map()), h(this, "_cursor", 0), h(this, "state", "initial"), h(this, "error", ""), h(this, "value");
        const { input: e3 = stdin, output: s2 = stdout, render: i2, signal: D2, ...C3 } = u3;
        this.opts = C3, this.onKeypress = this.onKeypress.bind(this), this.close = this.close.bind(this), this.render = this.render.bind(this), this._render = i2.bind(this), this._track = F4, this._abortSignal = D2, this.input = e3, this.output = s2;
      }
      unsubscribe() {
        this._subscribers.clear();
      }
      setSubscriber(u3, F4) {
        const e3 = this._subscribers.get(u3) ?? [];
        e3.push(F4), this._subscribers.set(u3, e3);
      }
      on(u3, F4) {
        this.setSubscriber(u3, { cb: F4 });
      }
      once(u3, F4) {
        this.setSubscriber(u3, {
          cb: F4,
          once: true
        });
      }
      emit(u3, ...F4) {
        const e3 = this._subscribers.get(u3) ?? [], s2 = [];
        for (const i2 of e3) i2.cb(...F4), i2.once && s2.push(() => e3.splice(e3.indexOf(i2), 1));
        for (const i2 of s2) i2();
      }
      prompt() {
        return new Promise((u3, F4) => {
          if (this._abortSignal) {
            if (this._abortSignal.aborted) return this.state = "cancel", this.close(), u3(S);
            this._abortSignal.addEventListener("abort", () => {
              this.state = "cancel", this.close();
            }, { once: true });
          }
          const e3 = new WriteStream(0);
          e3._write = (s2, i2, D2) => {
            this._track && (this.value = this.rl?.line.replace(/\t/g, ""), this._cursor = this.rl?.cursor ?? 0, this.emit("value", this.value)), D2();
          }, this.input.pipe(e3), this.rl = shims_default.createInterface({
            input: this.input,
            output: e3,
            tabSize: 2,
            prompt: "",
            escapeCodeTimeout: 50
          }), shims_default.emitKeypressEvents(this.input, this.rl), this.rl.prompt(), this.opts.initialValue !== void 0 && this._track && this.rl.write(this.opts.initialValue), this.input.on("keypress", this.onKeypress), d$1(this.input, true), this.output.on("resize", this.render), this.render(), this.once("submit", () => {
            this.output.write(srcExports.cursor.show), this.output.off("resize", this.render), d$1(this.input, false), u3(this.value);
          }), this.once("cancel", () => {
            this.output.write(srcExports.cursor.show), this.output.off("resize", this.render), d$1(this.input, false), u3(S);
          });
        });
      }
      onKeypress(u3, F4) {
        if (this.state === "error" && (this.state = "active"), F4?.name && (!this._track && c.aliases.has(F4.name) && this.emit("cursor", c.aliases.get(F4.name)), c.actions.has(F4.name) && this.emit("cursor", F4.name)), u3 && (u3.toLowerCase() === "y" || u3.toLowerCase() === "n") && this.emit("confirm", u3.toLowerCase() === "y"), u3 === "	" && this.opts.placeholder && (this.value || (this.rl?.write(this.opts.placeholder), this.emit("value", this.opts.placeholder))), u3 && this.emit("key", u3.toLowerCase()), F4?.name === "return") {
          if (this.opts.validate) {
            const e3 = this.opts.validate(this.value);
            e3 && (this.error = e3 instanceof Error ? e3.message : e3, this.state = "error", this.rl?.write(this.value));
          }
          this.state !== "error" && (this.state = "submit");
        }
        k$1([
          u3,
          F4?.name,
          F4?.sequence
        ], "cancel") && (this.state = "cancel"), (this.state === "submit" || this.state === "cancel") && this.emit("finalize"), this.render(), (this.state === "submit" || this.state === "cancel") && this.close();
      }
      close() {
        this.input.unpipe(), this.input.removeListener("keypress", this.onKeypress), this.output.write(`
`), d$1(this.input, false), this.rl?.close(), this.rl = void 0, this.emit(`${this.state}`, this.value), this.unsubscribe();
      }
      restoreCursor() {
        const u3 = G(this._prevFrame, process.stdout.columns, { hard: true }).split(`
`).length - 1;
        this.output.write(srcExports.cursor.move(-999, u3 * -1));
      }
      render() {
        const u3 = G(this._render(this) ?? "", process.stdout.columns, { hard: true });
        if (u3 !== this._prevFrame) {
          if (this.state === "initial") this.output.write(srcExports.cursor.hide);
          else {
            const F4 = lD(this._prevFrame, u3);
            if (this.restoreCursor(), F4 && F4?.length === 1) {
              const e3 = F4[0];
              this.output.write(srcExports.cursor.move(0, e3)), this.output.write(srcExports.erase.lines(1));
              const s2 = u3.split(`
`);
              this.output.write(s2[e3]), this._prevFrame = u3, this.output.write(srcExports.cursor.move(0, s2.length - e3 - 1));
              return;
            }
            if (F4 && F4?.length > 1) {
              const e3 = F4[0];
              this.output.write(srcExports.cursor.move(0, e3)), this.output.write(srcExports.erase.down());
              const s2 = u3.split(`
`).slice(e3);
              this.output.write(s2.join(`
`)), this._prevFrame = u3;
              return;
            }
            this.output.write(srcExports.erase.down());
          }
          this.output.write(u3), this.state === "initial" && (this.state = "active"), this._prevFrame = u3;
        }
      }
    };
    fD = class extends x {
      get cursor() {
        return this.value ? 0 : 1;
      }
      get _value() {
        return this.cursor === 0;
      }
      constructor(u3) {
        super(u3, false), this.value = !!u3.initialValue, this.on("value", () => {
          this.value = this._value;
        }), this.on("confirm", (F4) => {
          this.output.write(srcExports.cursor.move(0, -1)), this.value = F4, this.state = "submit", this.close();
        }), this.on("cursor", () => {
          this.value = !this.value;
        });
      }
    };
    bD = Object.defineProperty;
    mD = (t5, u3, F4) => u3 in t5 ? bD(t5, u3, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: F4
    }) : t5[u3] = F4;
    Y = (t5, u3, F4) => (mD(t5, typeof u3 != "symbol" ? u3 + "" : u3, F4), F4);
    wD = class extends x {
      constructor(u3) {
        super(u3, false), Y(this, "options"), Y(this, "cursor", 0), this.options = u3.options, this.value = [...u3.initialValues ?? []], this.cursor = Math.max(this.options.findIndex(({ value: F4 }) => F4 === u3.cursorAt), 0), this.on("key", (F4) => {
          F4 === "a" && this.toggleAll();
        }), this.on("cursor", (F4) => {
          switch (F4) {
            case "left":
            case "up":
              this.cursor = this.cursor === 0 ? this.options.length - 1 : this.cursor - 1;
              break;
            case "down":
            case "right":
              this.cursor = this.cursor === this.options.length - 1 ? 0 : this.cursor + 1;
              break;
            case "space":
              this.toggleValue();
          }
        });
      }
      get _value() {
        return this.options[this.cursor].value;
      }
      toggleAll() {
        const u3 = this.value.length === this.options.length;
        this.value = u3 ? [] : this.options.map((F4) => F4.value);
      }
      toggleValue() {
        const u3 = this.value.includes(this._value);
        this.value = u3 ? this.value.filter((F4) => F4 !== this._value) : [...this.value, this._value];
      }
    };
    SD = Object.defineProperty;
    $D = (t5, u3, F4) => u3 in t5 ? SD(t5, u3, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: F4
    }) : t5[u3] = F4;
    q = (t5, u3, F4) => ($D(t5, typeof u3 != "symbol" ? u3 + "" : u3, F4), F4);
    jD = class extends x {
      constructor(u3) {
        super(u3, false), q(this, "options"), q(this, "cursor", 0), this.options = u3.options, this.cursor = this.options.findIndex(({ value: F4 }) => F4 === u3.initialValue), this.cursor === -1 && (this.cursor = 0), this.changeValue(), this.on("cursor", (F4) => {
          switch (F4) {
            case "left":
            case "up":
              this.cursor = this.cursor === 0 ? this.options.length - 1 : this.cursor - 1;
              break;
            case "down":
            case "right":
              this.cursor = this.cursor === this.options.length - 1 ? 0 : this.cursor + 1;
          }
          this.changeValue();
        });
      }
      get _value() {
        return this.options[this.cursor];
      }
      changeValue() {
        this.value = this._value.value;
      }
    };
    PD = class extends x {
      get valueWithCursor() {
        if (this.state === "submit") return this.value;
        if (this.cursor >= this.value.length) return `${this.value}\u2588`;
        const u3 = this.value.slice(0, this.cursor), [F4, ...e$1] = this.value.slice(this.cursor);
        return `${u3}${e2.inverse(F4)}${e$1.join("")}`;
      }
      get cursor() {
        return this._cursor;
      }
      constructor(u3) {
        super(u3), this.on("finalize", () => {
          this.value || (this.value = u3.defaultValue);
        });
      }
    };
    V = ce();
    u = (t5, n5) => V ? t5 : n5;
    le = u("\u276F", ">");
    L = u("\u25A0", "x");
    W = u("\u25B2", "x");
    C = u("\u2714", "\u221A");
    o = u("");
    d = u("");
    k = u("\u25CF", ">");
    P = u("\u25CB", " ");
    A = u("\u25FB", "[\u2022]");
    T = u("\u25FC", "[+]");
    F = u("\u25FB", "[ ]");
    w = (t5) => {
      switch (t5) {
        case "initial":
        case "active":
          return e2.cyan(le);
        case "cancel":
          return e2.red(L);
        case "error":
          return e2.yellow(W);
        case "submit":
          return e2.green(C);
      }
    };
    B = (t5) => {
      const { cursor: n5, options: s2, style: r3 } = t5, i2 = t5.maxItems ?? Number.POSITIVE_INFINITY, a2 = Math.max(process.stdout.rows - 4, 0), c3 = Math.min(a2, Math.max(i2, 5));
      let l2 = 0;
      n5 >= l2 + c3 - 3 ? l2 = Math.max(Math.min(n5 - c3 + 3, s2.length - c3), 0) : n5 < l2 + 2 && (l2 = Math.max(n5 - 2, 0));
      const $ = c3 < s2.length && l2 > 0, p = c3 < s2.length && l2 + c3 < s2.length;
      return s2.slice(l2, l2 + c3).map((M, v2, x2) => {
        const j = v2 === 0 && $, E = v2 === x2.length - 1 && p;
        return j || E ? e2.dim("...") : r3(M, v2 + l2 === n5);
      });
    };
    he = (t5) => new PD({
      validate: t5.validate,
      placeholder: t5.placeholder,
      defaultValue: t5.defaultValue,
      initialValue: t5.initialValue,
      render() {
        const n5 = `${e2.gray(o)}
${w(this.state)} ${t5.message}
`, s2 = t5.placeholder ? e2.inverse(t5.placeholder[0]) + e2.dim(t5.placeholder.slice(1)) : e2.inverse(e2.hidden("_")), r3 = this.value ? this.valueWithCursor : s2;
        switch (this.state) {
          case "error":
            return `${n5.trim()}
${e2.yellow(o)} ${r3}
${e2.yellow(d)} ${e2.yellow(this.error)}
`;
          case "submit":
            return `${n5}${e2.gray(o)} ${e2.dim(this.value || t5.placeholder)}`;
          case "cancel":
            return `${n5}${e2.gray(o)} ${e2.strikethrough(e2.dim(this.value ?? ""))}${this.value?.trim() ? `
${e2.gray(o)}` : ""}`;
          default:
            return `${n5}${e2.cyan(o)} ${r3}
${e2.cyan(d)}
`;
        }
      }
    }).prompt();
    ye = (t5) => {
      const n5 = t5.active ?? "Yes", s2 = t5.inactive ?? "No";
      return new fD({
        active: n5,
        inactive: s2,
        initialValue: t5.initialValue ?? true,
        render() {
          const r3 = `${e2.gray(o)}
${w(this.state)} ${t5.message}
`, i2 = this.value ? n5 : s2;
          switch (this.state) {
            case "submit":
              return `${r3}${e2.gray(o)} ${e2.dim(i2)}`;
            case "cancel":
              return `${r3}${e2.gray(o)} ${e2.strikethrough(e2.dim(i2))}
${e2.gray(o)}`;
            default:
              return `${r3}${e2.cyan(o)} ${this.value ? `${e2.green(k)} ${n5}` : `${e2.dim(P)} ${e2.dim(n5)}`} ${e2.dim("/")} ${this.value ? `${e2.dim(P)} ${e2.dim(s2)}` : `${e2.green(k)} ${s2}`}
${e2.cyan(d)}
`;
          }
        }
      }).prompt();
    };
    ve = (t5) => {
      const n5 = (s2, r3) => {
        const i2 = s2.label ?? String(s2.value);
        switch (r3) {
          case "selected":
            return `${e2.dim(i2)}`;
          case "active":
            return `${e2.green(k)} ${i2} ${s2.hint ? e2.dim(`(${s2.hint})`) : ""}`;
          case "cancelled":
            return `${e2.strikethrough(e2.dim(i2))}`;
          default:
            return `${e2.dim(P)} ${e2.dim(i2)}`;
        }
      };
      return new jD({
        options: t5.options,
        initialValue: t5.initialValue,
        render() {
          const s2 = `${e2.gray(o)}
${w(this.state)} ${t5.message}
`;
          switch (this.state) {
            case "submit":
              return `${s2}${e2.gray(o)} ${n5(this.options[this.cursor], "selected")}`;
            case "cancel":
              return `${s2}${e2.gray(o)} ${n5(this.options[this.cursor], "cancelled")}
${e2.gray(o)}`;
            default:
              return `${s2}${e2.cyan(o)} ${B({
                cursor: this.cursor,
                options: this.options,
                maxItems: t5.maxItems,
                style: (r3, i2) => n5(r3, i2 ? "active" : "inactive")
              }).join(`
${e2.cyan(o)}  `)}
${e2.cyan(d)}
`;
          }
        }
      }).prompt();
    };
    fe = (t5) => {
      const n5 = (s2, r3) => {
        const i2 = s2.label ?? String(s2.value);
        return r3 === "active" ? `${e2.cyan(A)} ${i2} ${s2.hint ? e2.dim(`(${s2.hint})`) : ""}` : r3 === "selected" ? `${e2.green(T)} ${e2.dim(i2)}` : r3 === "cancelled" ? `${e2.strikethrough(e2.dim(i2))}` : r3 === "active-selected" ? `${e2.green(T)} ${i2} ${s2.hint ? e2.dim(`(${s2.hint})`) : ""}` : r3 === "submitted" ? `${e2.dim(i2)}` : `${e2.dim(F)} ${e2.dim(i2)}`;
      };
      return new wD({
        options: t5.options,
        initialValues: t5.initialValues,
        required: t5.required ?? true,
        cursorAt: t5.cursorAt,
        validate(s2) {
          if (this.required && s2.length === 0) return `Please select at least one option.
${e2.reset(e2.dim(`Press ${e2.gray(e2.bgWhite(e2.inverse(" space ")))} to select, ${e2.gray(e2.bgWhite(e2.inverse(" enter ")))} to submit`))}`;
        },
        render() {
          const s2 = `${e2.gray(o)}
${w(this.state)} ${t5.message}
`, r3 = (i2, a2) => {
            const c3 = this.value.includes(i2.value);
            return a2 && c3 ? n5(i2, "active-selected") : c3 ? n5(i2, "selected") : n5(i2, a2 ? "active" : "inactive");
          };
          switch (this.state) {
            case "submit":
              return `${s2}${e2.gray(o)} ${this.options.filter(({ value: i2 }) => this.value.includes(i2)).map((i2) => n5(i2, "submitted")).join(e2.dim(", ")) || e2.dim("none")}`;
            case "cancel": {
              const i2 = this.options.filter(({ value: a2 }) => this.value.includes(a2)).map((a2) => n5(a2, "cancelled")).join(e2.dim(", "));
              return `${s2}${e2.gray(o)} ${i2.trim() ? `${i2}
${e2.gray(o)}` : ""}`;
            }
            case "error": {
              const i2 = this.error.split(`
`).map((a2, c3) => c3 === 0 ? `${e2.yellow(d)} ${e2.yellow(a2)}` : `   ${a2}`).join(`
`);
              return `${s2 + e2.yellow(o)} ${B({
                options: this.options,
                cursor: this.cursor,
                maxItems: t5.maxItems,
                style: r3
              }).join(`
${e2.yellow(o)}  `)}
${i2}
`;
            }
            default:
              return `${s2}${e2.cyan(o)} ${B({
                options: this.options,
                cursor: this.cursor,
                maxItems: t5.maxItems,
                style: r3
              }).join(`
${e2.cyan(o)}  `)}
${e2.cyan(d)}
`;
          }
        }
      }).prompt();
    };
    `${e2.gray(o)}`;
    kCancel = /* @__PURE__ */ Symbol.for("cancel");
  }
});

// ../../node_modules/.bun/source-map-js@1.2.1/node_modules/source-map-js/lib/base64.js
var require_base64 = __commonJS({
  "../../node_modules/.bun/source-map-js@1.2.1/node_modules/source-map-js/lib/base64.js"(exports) {
    var intToCharMap = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("");
    exports.encode = function(number2) {
      if (0 <= number2 && number2 < intToCharMap.length) {
        return intToCharMap[number2];
      }
      throw new TypeError("Must be between 0 and 63: " + number2);
    };
    exports.decode = function(charCode) {
      var bigA = 65;
      var bigZ = 90;
      var littleA = 97;
      var littleZ = 122;
      var zero = 48;
      var nine = 57;
      var plus = 43;
      var slash = 47;
      var littleOffset = 26;
      var numberOffset = 52;
      if (bigA <= charCode && charCode <= bigZ) {
        return charCode - bigA;
      }
      if (littleA <= charCode && charCode <= littleZ) {
        return charCode - littleA + littleOffset;
      }
      if (zero <= charCode && charCode <= nine) {
        return charCode - zero + numberOffset;
      }
      if (charCode == plus) {
        return 62;
      }
      if (charCode == slash) {
        return 63;
      }
      return -1;
    };
  }
});

// ../../node_modules/.bun/source-map-js@1.2.1/node_modules/source-map-js/lib/base64-vlq.js
var require_base64_vlq = __commonJS({
  "../../node_modules/.bun/source-map-js@1.2.1/node_modules/source-map-js/lib/base64-vlq.js"(exports) {
    var base64 = require_base64();
    var VLQ_BASE_SHIFT = 5;
    var VLQ_BASE = 1 << VLQ_BASE_SHIFT;
    var VLQ_BASE_MASK = VLQ_BASE - 1;
    var VLQ_CONTINUATION_BIT = VLQ_BASE;
    function toVLQSigned(aValue) {
      return aValue < 0 ? (-aValue << 1) + 1 : (aValue << 1) + 0;
    }
    function fromVLQSigned(aValue) {
      var isNegative = (aValue & 1) === 1;
      var shifted = aValue >> 1;
      return isNegative ? -shifted : shifted;
    }
    exports.encode = function base64VLQ_encode(aValue) {
      var encoded = "";
      var digit;
      var vlq = toVLQSigned(aValue);
      do {
        digit = vlq & VLQ_BASE_MASK;
        vlq >>>= VLQ_BASE_SHIFT;
        if (vlq > 0) {
          digit |= VLQ_CONTINUATION_BIT;
        }
        encoded += base64.encode(digit);
      } while (vlq > 0);
      return encoded;
    };
    exports.decode = function base64VLQ_decode(aStr, aIndex, aOutParam) {
      var strLen = aStr.length;
      var result = 0;
      var shift = 0;
      var continuation, digit;
      do {
        if (aIndex >= strLen) {
          throw new Error("Expected more digits in base 64 VLQ value.");
        }
        digit = base64.decode(aStr.charCodeAt(aIndex++));
        if (digit === -1) {
          throw new Error("Invalid base64 digit: " + aStr.charAt(aIndex - 1));
        }
        continuation = !!(digit & VLQ_CONTINUATION_BIT);
        digit &= VLQ_BASE_MASK;
        result = result + (digit << shift);
        shift += VLQ_BASE_SHIFT;
      } while (continuation);
      aOutParam.value = fromVLQSigned(result);
      aOutParam.rest = aIndex;
    };
  }
});

// ../../node_modules/.bun/source-map-js@1.2.1/node_modules/source-map-js/lib/util.js
var require_util = __commonJS({
  "../../node_modules/.bun/source-map-js@1.2.1/node_modules/source-map-js/lib/util.js"(exports) {
    function getArg(aArgs, aName, aDefaultValue) {
      if (aName in aArgs) {
        return aArgs[aName];
      } else if (arguments.length === 3) {
        return aDefaultValue;
      } else {
        throw new Error('"' + aName + '" is a required argument.');
      }
    }
    exports.getArg = getArg;
    var urlRegexp = /^(?:([\w+\-.]+):)?\/\/(?:(\w+:\w+)@)?([\w.-]*)(?::(\d+))?(.*)$/;
    var dataUrlRegexp = /^data:.+\,.+$/;
    function urlParse(aUrl) {
      var match = aUrl.match(urlRegexp);
      if (!match) {
        return null;
      }
      return {
        scheme: match[1],
        auth: match[2],
        host: match[3],
        port: match[4],
        path: match[5]
      };
    }
    exports.urlParse = urlParse;
    function urlGenerate(aParsedUrl) {
      var url = "";
      if (aParsedUrl.scheme) {
        url += aParsedUrl.scheme + ":";
      }
      url += "//";
      if (aParsedUrl.auth) {
        url += aParsedUrl.auth + "@";
      }
      if (aParsedUrl.host) {
        url += aParsedUrl.host;
      }
      if (aParsedUrl.port) {
        url += ":" + aParsedUrl.port;
      }
      if (aParsedUrl.path) {
        url += aParsedUrl.path;
      }
      return url;
    }
    exports.urlGenerate = urlGenerate;
    var MAX_CACHED_INPUTS = 32;
    function lruMemoize(f2) {
      var cache = [];
      return function(input) {
        for (var i2 = 0; i2 < cache.length; i2++) {
          if (cache[i2].input === input) {
            var temp = cache[0];
            cache[0] = cache[i2];
            cache[i2] = temp;
            return cache[0].result;
          }
        }
        var result = f2(input);
        cache.unshift({
          input,
          result
        });
        if (cache.length > MAX_CACHED_INPUTS) {
          cache.pop();
        }
        return result;
      };
    }
    var normalize = lruMemoize(function normalize2(aPath) {
      var path3 = aPath;
      var url = urlParse(aPath);
      if (url) {
        if (!url.path) {
          return aPath;
        }
        path3 = url.path;
      }
      var isAbsolute = exports.isAbsolute(path3);
      var parts = [];
      var start = 0;
      var i2 = 0;
      while (true) {
        start = i2;
        i2 = path3.indexOf("/", start);
        if (i2 === -1) {
          parts.push(path3.slice(start));
          break;
        } else {
          parts.push(path3.slice(start, i2));
          while (i2 < path3.length && path3[i2] === "/") {
            i2++;
          }
        }
      }
      for (var part, up = 0, i2 = parts.length - 1; i2 >= 0; i2--) {
        part = parts[i2];
        if (part === ".") {
          parts.splice(i2, 1);
        } else if (part === "..") {
          up++;
        } else if (up > 0) {
          if (part === "") {
            parts.splice(i2 + 1, up);
            up = 0;
          } else {
            parts.splice(i2, 2);
            up--;
          }
        }
      }
      path3 = parts.join("/");
      if (path3 === "") {
        path3 = isAbsolute ? "/" : ".";
      }
      if (url) {
        url.path = path3;
        return urlGenerate(url);
      }
      return path3;
    });
    exports.normalize = normalize;
    function join(aRoot, aPath) {
      if (aRoot === "") {
        aRoot = ".";
      }
      if (aPath === "") {
        aPath = ".";
      }
      var aPathUrl = urlParse(aPath);
      var aRootUrl = urlParse(aRoot);
      if (aRootUrl) {
        aRoot = aRootUrl.path || "/";
      }
      if (aPathUrl && !aPathUrl.scheme) {
        if (aRootUrl) {
          aPathUrl.scheme = aRootUrl.scheme;
        }
        return urlGenerate(aPathUrl);
      }
      if (aPathUrl || aPath.match(dataUrlRegexp)) {
        return aPath;
      }
      if (aRootUrl && !aRootUrl.host && !aRootUrl.path) {
        aRootUrl.host = aPath;
        return urlGenerate(aRootUrl);
      }
      var joined = aPath.charAt(0) === "/" ? aPath : normalize(aRoot.replace(/\/+$/, "") + "/" + aPath);
      if (aRootUrl) {
        aRootUrl.path = joined;
        return urlGenerate(aRootUrl);
      }
      return joined;
    }
    exports.join = join;
    exports.isAbsolute = function(aPath) {
      return aPath.charAt(0) === "/" || urlRegexp.test(aPath);
    };
    function relative(aRoot, aPath) {
      if (aRoot === "") {
        aRoot = ".";
      }
      aRoot = aRoot.replace(/\/$/, "");
      var level = 0;
      while (aPath.indexOf(aRoot + "/") !== 0) {
        var index = aRoot.lastIndexOf("/");
        if (index < 0) {
          return aPath;
        }
        aRoot = aRoot.slice(0, index);
        if (aRoot.match(/^([^\/]+:\/)?\/*$/)) {
          return aPath;
        }
        ++level;
      }
      return Array(level + 1).join("../") + aPath.substr(aRoot.length + 1);
    }
    exports.relative = relative;
    var supportsNullProto = (function() {
      var obj = /* @__PURE__ */ Object.create(null);
      return !("__proto__" in obj);
    })();
    function identity(s2) {
      return s2;
    }
    function toSetString(aStr) {
      if (isProtoString(aStr)) {
        return "$" + aStr;
      }
      return aStr;
    }
    exports.toSetString = supportsNullProto ? identity : toSetString;
    function fromSetString(aStr) {
      if (isProtoString(aStr)) {
        return aStr.slice(1);
      }
      return aStr;
    }
    exports.fromSetString = supportsNullProto ? identity : fromSetString;
    function isProtoString(s2) {
      if (!s2) {
        return false;
      }
      var length = s2.length;
      if (length < 9) {
        return false;
      }
      if (s2.charCodeAt(length - 1) !== 95 || s2.charCodeAt(length - 2) !== 95 || s2.charCodeAt(length - 3) !== 111 || s2.charCodeAt(length - 4) !== 116 || s2.charCodeAt(length - 5) !== 111 || s2.charCodeAt(length - 6) !== 114 || s2.charCodeAt(length - 7) !== 112 || s2.charCodeAt(length - 8) !== 95 || s2.charCodeAt(length - 9) !== 95) {
        return false;
      }
      for (var i2 = length - 10; i2 >= 0; i2--) {
        if (s2.charCodeAt(i2) !== 36) {
          return false;
        }
      }
      return true;
    }
    function compareByOriginalPositions(mappingA, mappingB, onlyCompareOriginal) {
      var cmp = strcmp(mappingA.source, mappingB.source);
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.originalLine - mappingB.originalLine;
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.originalColumn - mappingB.originalColumn;
      if (cmp !== 0 || onlyCompareOriginal) {
        return cmp;
      }
      cmp = mappingA.generatedColumn - mappingB.generatedColumn;
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.generatedLine - mappingB.generatedLine;
      if (cmp !== 0) {
        return cmp;
      }
      return strcmp(mappingA.name, mappingB.name);
    }
    exports.compareByOriginalPositions = compareByOriginalPositions;
    function compareByOriginalPositionsNoSource(mappingA, mappingB, onlyCompareOriginal) {
      var cmp;
      cmp = mappingA.originalLine - mappingB.originalLine;
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.originalColumn - mappingB.originalColumn;
      if (cmp !== 0 || onlyCompareOriginal) {
        return cmp;
      }
      cmp = mappingA.generatedColumn - mappingB.generatedColumn;
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.generatedLine - mappingB.generatedLine;
      if (cmp !== 0) {
        return cmp;
      }
      return strcmp(mappingA.name, mappingB.name);
    }
    exports.compareByOriginalPositionsNoSource = compareByOriginalPositionsNoSource;
    function compareByGeneratedPositionsDeflated(mappingA, mappingB, onlyCompareGenerated) {
      var cmp = mappingA.generatedLine - mappingB.generatedLine;
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.generatedColumn - mappingB.generatedColumn;
      if (cmp !== 0 || onlyCompareGenerated) {
        return cmp;
      }
      cmp = strcmp(mappingA.source, mappingB.source);
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.originalLine - mappingB.originalLine;
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.originalColumn - mappingB.originalColumn;
      if (cmp !== 0) {
        return cmp;
      }
      return strcmp(mappingA.name, mappingB.name);
    }
    exports.compareByGeneratedPositionsDeflated = compareByGeneratedPositionsDeflated;
    function compareByGeneratedPositionsDeflatedNoLine(mappingA, mappingB, onlyCompareGenerated) {
      var cmp = mappingA.generatedColumn - mappingB.generatedColumn;
      if (cmp !== 0 || onlyCompareGenerated) {
        return cmp;
      }
      cmp = strcmp(mappingA.source, mappingB.source);
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.originalLine - mappingB.originalLine;
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.originalColumn - mappingB.originalColumn;
      if (cmp !== 0) {
        return cmp;
      }
      return strcmp(mappingA.name, mappingB.name);
    }
    exports.compareByGeneratedPositionsDeflatedNoLine = compareByGeneratedPositionsDeflatedNoLine;
    function strcmp(aStr1, aStr2) {
      if (aStr1 === aStr2) {
        return 0;
      }
      if (aStr1 === null) {
        return 1;
      }
      if (aStr2 === null) {
        return -1;
      }
      if (aStr1 > aStr2) {
        return 1;
      }
      return -1;
    }
    function compareByGeneratedPositionsInflated(mappingA, mappingB) {
      var cmp = mappingA.generatedLine - mappingB.generatedLine;
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.generatedColumn - mappingB.generatedColumn;
      if (cmp !== 0) {
        return cmp;
      }
      cmp = strcmp(mappingA.source, mappingB.source);
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.originalLine - mappingB.originalLine;
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.originalColumn - mappingB.originalColumn;
      if (cmp !== 0) {
        return cmp;
      }
      return strcmp(mappingA.name, mappingB.name);
    }
    exports.compareByGeneratedPositionsInflated = compareByGeneratedPositionsInflated;
    function parseSourceMapInput(str) {
      return JSON.parse(str.replace(/^\)]}'[^\n]*\n/, ""));
    }
    exports.parseSourceMapInput = parseSourceMapInput;
    function computeSourceURL(sourceRoot, sourceURL, sourceMapURL) {
      sourceURL = sourceURL || "";
      if (sourceRoot) {
        if (sourceRoot[sourceRoot.length - 1] !== "/" && sourceURL[0] !== "/") {
          sourceRoot += "/";
        }
        sourceURL = sourceRoot + sourceURL;
      }
      if (sourceMapURL) {
        var parsed = urlParse(sourceMapURL);
        if (!parsed) {
          throw new Error("sourceMapURL could not be parsed");
        }
        if (parsed.path) {
          var index = parsed.path.lastIndexOf("/");
          if (index >= 0) {
            parsed.path = parsed.path.substring(0, index + 1);
          }
        }
        sourceURL = join(urlGenerate(parsed), sourceURL);
      }
      return normalize(sourceURL);
    }
    exports.computeSourceURL = computeSourceURL;
  }
});

// ../../node_modules/.bun/source-map-js@1.2.1/node_modules/source-map-js/lib/array-set.js
var require_array_set = __commonJS({
  "../../node_modules/.bun/source-map-js@1.2.1/node_modules/source-map-js/lib/array-set.js"(exports) {
    var util = require_util();
    var has = Object.prototype.hasOwnProperty;
    var hasNativeMap = typeof Map !== "undefined";
    function ArraySet() {
      this._array = [];
      this._set = hasNativeMap ? /* @__PURE__ */ new Map() : /* @__PURE__ */ Object.create(null);
    }
    ArraySet.fromArray = function ArraySet_fromArray(aArray, aAllowDuplicates) {
      var set = new ArraySet();
      for (var i2 = 0, len = aArray.length; i2 < len; i2++) {
        set.add(aArray[i2], aAllowDuplicates);
      }
      return set;
    };
    ArraySet.prototype.size = function ArraySet_size() {
      return hasNativeMap ? this._set.size : Object.getOwnPropertyNames(this._set).length;
    };
    ArraySet.prototype.add = function ArraySet_add(aStr, aAllowDuplicates) {
      var sStr = hasNativeMap ? aStr : util.toSetString(aStr);
      var isDuplicate = hasNativeMap ? this.has(aStr) : has.call(this._set, sStr);
      var idx = this._array.length;
      if (!isDuplicate || aAllowDuplicates) {
        this._array.push(aStr);
      }
      if (!isDuplicate) {
        if (hasNativeMap) {
          this._set.set(aStr, idx);
        } else {
          this._set[sStr] = idx;
        }
      }
    };
    ArraySet.prototype.has = function ArraySet_has(aStr) {
      if (hasNativeMap) {
        return this._set.has(aStr);
      } else {
        var sStr = util.toSetString(aStr);
        return has.call(this._set, sStr);
      }
    };
    ArraySet.prototype.indexOf = function ArraySet_indexOf(aStr) {
      if (hasNativeMap) {
        var idx = this._set.get(aStr);
        if (idx >= 0) {
          return idx;
        }
      } else {
        var sStr = util.toSetString(aStr);
        if (has.call(this._set, sStr)) {
          return this._set[sStr];
        }
      }
      throw new Error('"' + aStr + '" is not in the set.');
    };
    ArraySet.prototype.at = function ArraySet_at(aIdx) {
      if (aIdx >= 0 && aIdx < this._array.length) {
        return this._array[aIdx];
      }
      throw new Error("No element indexed by " + aIdx);
    };
    ArraySet.prototype.toArray = function ArraySet_toArray() {
      return this._array.slice();
    };
    exports.ArraySet = ArraySet;
  }
});

// ../../node_modules/.bun/source-map-js@1.2.1/node_modules/source-map-js/lib/mapping-list.js
var require_mapping_list = __commonJS({
  "../../node_modules/.bun/source-map-js@1.2.1/node_modules/source-map-js/lib/mapping-list.js"(exports) {
    var util = require_util();
    function generatedPositionAfter(mappingA, mappingB) {
      var lineA = mappingA.generatedLine;
      var lineB = mappingB.generatedLine;
      var columnA = mappingA.generatedColumn;
      var columnB = mappingB.generatedColumn;
      return lineB > lineA || lineB == lineA && columnB >= columnA || util.compareByGeneratedPositionsInflated(mappingA, mappingB) <= 0;
    }
    function MappingList() {
      this._array = [];
      this._sorted = true;
      this._last = { generatedLine: -1, generatedColumn: 0 };
    }
    MappingList.prototype.unsortedForEach = function MappingList_forEach(aCallback, aThisArg) {
      this._array.forEach(aCallback, aThisArg);
    };
    MappingList.prototype.add = function MappingList_add(aMapping) {
      if (generatedPositionAfter(this._last, aMapping)) {
        this._last = aMapping;
        this._array.push(aMapping);
      } else {
        this._sorted = false;
        this._array.push(aMapping);
      }
    };
    MappingList.prototype.toArray = function MappingList_toArray() {
      if (!this._sorted) {
        this._array.sort(util.compareByGeneratedPositionsInflated);
        this._sorted = true;
      }
      return this._array;
    };
    exports.MappingList = MappingList;
  }
});

// ../../node_modules/.bun/source-map-js@1.2.1/node_modules/source-map-js/lib/source-map-generator.js
var require_source_map_generator = __commonJS({
  "../../node_modules/.bun/source-map-js@1.2.1/node_modules/source-map-js/lib/source-map-generator.js"(exports) {
    var base64VLQ = require_base64_vlq();
    var util = require_util();
    var ArraySet = require_array_set().ArraySet;
    var MappingList = require_mapping_list().MappingList;
    function SourceMapGenerator2(aArgs) {
      if (!aArgs) {
        aArgs = {};
      }
      this._file = util.getArg(aArgs, "file", null);
      this._sourceRoot = util.getArg(aArgs, "sourceRoot", null);
      this._skipValidation = util.getArg(aArgs, "skipValidation", false);
      this._ignoreInvalidMapping = util.getArg(aArgs, "ignoreInvalidMapping", false);
      this._sources = new ArraySet();
      this._names = new ArraySet();
      this._mappings = new MappingList();
      this._sourcesContents = null;
    }
    SourceMapGenerator2.prototype._version = 3;
    SourceMapGenerator2.fromSourceMap = function SourceMapGenerator_fromSourceMap(aSourceMapConsumer, generatorOps) {
      var sourceRoot = aSourceMapConsumer.sourceRoot;
      var generator = new SourceMapGenerator2(Object.assign(generatorOps || {}, {
        file: aSourceMapConsumer.file,
        sourceRoot
      }));
      aSourceMapConsumer.eachMapping(function(mapping) {
        var newMapping = {
          generated: {
            line: mapping.generatedLine,
            column: mapping.generatedColumn
          }
        };
        if (mapping.source != null) {
          newMapping.source = mapping.source;
          if (sourceRoot != null) {
            newMapping.source = util.relative(sourceRoot, newMapping.source);
          }
          newMapping.original = {
            line: mapping.originalLine,
            column: mapping.originalColumn
          };
          if (mapping.name != null) {
            newMapping.name = mapping.name;
          }
        }
        generator.addMapping(newMapping);
      });
      aSourceMapConsumer.sources.forEach(function(sourceFile) {
        var sourceRelative = sourceFile;
        if (sourceRoot !== null) {
          sourceRelative = util.relative(sourceRoot, sourceFile);
        }
        if (!generator._sources.has(sourceRelative)) {
          generator._sources.add(sourceRelative);
        }
        var content = aSourceMapConsumer.sourceContentFor(sourceFile);
        if (content != null) {
          generator.setSourceContent(sourceFile, content);
        }
      });
      return generator;
    };
    SourceMapGenerator2.prototype.addMapping = function SourceMapGenerator_addMapping(aArgs) {
      var generated = util.getArg(aArgs, "generated");
      var original = util.getArg(aArgs, "original", null);
      var source = util.getArg(aArgs, "source", null);
      var name50 = util.getArg(aArgs, "name", null);
      if (!this._skipValidation) {
        if (this._validateMapping(generated, original, source, name50) === false) {
          return;
        }
      }
      if (source != null) {
        source = String(source);
        if (!this._sources.has(source)) {
          this._sources.add(source);
        }
      }
      if (name50 != null) {
        name50 = String(name50);
        if (!this._names.has(name50)) {
          this._names.add(name50);
        }
      }
      this._mappings.add({
        generatedLine: generated.line,
        generatedColumn: generated.column,
        originalLine: original != null && original.line,
        originalColumn: original != null && original.column,
        source,
        name: name50
      });
    };
    SourceMapGenerator2.prototype.setSourceContent = function SourceMapGenerator_setSourceContent(aSourceFile, aSourceContent) {
      var source = aSourceFile;
      if (this._sourceRoot != null) {
        source = util.relative(this._sourceRoot, source);
      }
      if (aSourceContent != null) {
        if (!this._sourcesContents) {
          this._sourcesContents = /* @__PURE__ */ Object.create(null);
        }
        this._sourcesContents[util.toSetString(source)] = aSourceContent;
      } else if (this._sourcesContents) {
        delete this._sourcesContents[util.toSetString(source)];
        if (Object.keys(this._sourcesContents).length === 0) {
          this._sourcesContents = null;
        }
      }
    };
    SourceMapGenerator2.prototype.applySourceMap = function SourceMapGenerator_applySourceMap(aSourceMapConsumer, aSourceFile, aSourceMapPath) {
      var sourceFile = aSourceFile;
      if (aSourceFile == null) {
        if (aSourceMapConsumer.file == null) {
          throw new Error(
            `SourceMapGenerator.prototype.applySourceMap requires either an explicit source file, or the source map's "file" property. Both were omitted.`
          );
        }
        sourceFile = aSourceMapConsumer.file;
      }
      var sourceRoot = this._sourceRoot;
      if (sourceRoot != null) {
        sourceFile = util.relative(sourceRoot, sourceFile);
      }
      var newSources = new ArraySet();
      var newNames = new ArraySet();
      this._mappings.unsortedForEach(function(mapping) {
        if (mapping.source === sourceFile && mapping.originalLine != null) {
          var original = aSourceMapConsumer.originalPositionFor({
            line: mapping.originalLine,
            column: mapping.originalColumn
          });
          if (original.source != null) {
            mapping.source = original.source;
            if (aSourceMapPath != null) {
              mapping.source = util.join(aSourceMapPath, mapping.source);
            }
            if (sourceRoot != null) {
              mapping.source = util.relative(sourceRoot, mapping.source);
            }
            mapping.originalLine = original.line;
            mapping.originalColumn = original.column;
            if (original.name != null) {
              mapping.name = original.name;
            }
          }
        }
        var source = mapping.source;
        if (source != null && !newSources.has(source)) {
          newSources.add(source);
        }
        var name50 = mapping.name;
        if (name50 != null && !newNames.has(name50)) {
          newNames.add(name50);
        }
      }, this);
      this._sources = newSources;
      this._names = newNames;
      aSourceMapConsumer.sources.forEach(function(sourceFile2) {
        var content = aSourceMapConsumer.sourceContentFor(sourceFile2);
        if (content != null) {
          if (aSourceMapPath != null) {
            sourceFile2 = util.join(aSourceMapPath, sourceFile2);
          }
          if (sourceRoot != null) {
            sourceFile2 = util.relative(sourceRoot, sourceFile2);
          }
          this.setSourceContent(sourceFile2, content);
        }
      }, this);
    };
    SourceMapGenerator2.prototype._validateMapping = function SourceMapGenerator_validateMapping(aGenerated, aOriginal, aSource, aName) {
      if (aOriginal && typeof aOriginal.line !== "number" && typeof aOriginal.column !== "number") {
        var message2 = "original.line and original.column are not numbers -- you probably meant to omit the original mapping entirely and only map the generated position. If so, pass null for the original mapping instead of an object with empty or null values.";
        if (this._ignoreInvalidMapping) {
          if (typeof console !== "undefined" && console.warn) {
            console.warn(message2);
          }
          return false;
        } else {
          throw new Error(message2);
        }
      }
      if (aGenerated && "line" in aGenerated && "column" in aGenerated && aGenerated.line > 0 && aGenerated.column >= 0 && !aOriginal && !aSource && !aName) {
        return;
      } else if (aGenerated && "line" in aGenerated && "column" in aGenerated && aOriginal && "line" in aOriginal && "column" in aOriginal && aGenerated.line > 0 && aGenerated.column >= 0 && aOriginal.line > 0 && aOriginal.column >= 0 && aSource) {
        return;
      } else {
        var message2 = "Invalid mapping: " + JSON.stringify({
          generated: aGenerated,
          source: aSource,
          original: aOriginal,
          name: aName
        });
        if (this._ignoreInvalidMapping) {
          if (typeof console !== "undefined" && console.warn) {
            console.warn(message2);
          }
          return false;
        } else {
          throw new Error(message2);
        }
      }
    };
    SourceMapGenerator2.prototype._serializeMappings = function SourceMapGenerator_serializeMappings() {
      var previousGeneratedColumn = 0;
      var previousGeneratedLine = 1;
      var previousOriginalColumn = 0;
      var previousOriginalLine = 0;
      var previousName = 0;
      var previousSource = 0;
      var result = "";
      var next;
      var mapping;
      var nameIdx;
      var sourceIdx;
      var mappings = this._mappings.toArray();
      for (var i2 = 0, len = mappings.length; i2 < len; i2++) {
        mapping = mappings[i2];
        next = "";
        if (mapping.generatedLine !== previousGeneratedLine) {
          previousGeneratedColumn = 0;
          while (mapping.generatedLine !== previousGeneratedLine) {
            next += ";";
            previousGeneratedLine++;
          }
        } else {
          if (i2 > 0) {
            if (!util.compareByGeneratedPositionsInflated(mapping, mappings[i2 - 1])) {
              continue;
            }
            next += ",";
          }
        }
        next += base64VLQ.encode(mapping.generatedColumn - previousGeneratedColumn);
        previousGeneratedColumn = mapping.generatedColumn;
        if (mapping.source != null) {
          sourceIdx = this._sources.indexOf(mapping.source);
          next += base64VLQ.encode(sourceIdx - previousSource);
          previousSource = sourceIdx;
          next += base64VLQ.encode(mapping.originalLine - 1 - previousOriginalLine);
          previousOriginalLine = mapping.originalLine - 1;
          next += base64VLQ.encode(mapping.originalColumn - previousOriginalColumn);
          previousOriginalColumn = mapping.originalColumn;
          if (mapping.name != null) {
            nameIdx = this._names.indexOf(mapping.name);
            next += base64VLQ.encode(nameIdx - previousName);
            previousName = nameIdx;
          }
        }
        result += next;
      }
      return result;
    };
    SourceMapGenerator2.prototype._generateSourcesContent = function SourceMapGenerator_generateSourcesContent(aSources, aSourceRoot) {
      return aSources.map(function(source) {
        if (!this._sourcesContents) {
          return null;
        }
        if (aSourceRoot != null) {
          source = util.relative(aSourceRoot, source);
        }
        var key = util.toSetString(source);
        return Object.prototype.hasOwnProperty.call(this._sourcesContents, key) ? this._sourcesContents[key] : null;
      }, this);
    };
    SourceMapGenerator2.prototype.toJSON = function SourceMapGenerator_toJSON() {
      var map = {
        version: this._version,
        sources: this._sources.toArray(),
        names: this._names.toArray(),
        mappings: this._serializeMappings()
      };
      if (this._file != null) {
        map.file = this._file;
      }
      if (this._sourceRoot != null) {
        map.sourceRoot = this._sourceRoot;
      }
      if (this._sourcesContents) {
        map.sourcesContent = this._generateSourcesContent(map.sources, map.sourceRoot);
      }
      return map;
    };
    SourceMapGenerator2.prototype.toString = function SourceMapGenerator_toString() {
      return JSON.stringify(this.toJSON());
    };
    exports.SourceMapGenerator = SourceMapGenerator2;
  }
});

// rolldown-binding:./shared/binding-BY0qR5iS.mjs
var t = () => {
  const binding = globalThis.__nimbusRolldownBinding;
  if (!binding) throw new Error("Nimbus: the build facet imported rolldown before installing its binding");
  return binding;
};
var n = (mod) => mod;

// rolldown-binding:./binding-BY0qR5iS.mjs
var t2 = () => {
  const binding = globalThis.__nimbusRolldownBinding;
  if (!binding) throw new Error("Nimbus: the build facet imported rolldown before installing its binding");
  return binding;
};
var n2 = (mod) => mod;

// ../../node_modules/.bun/rolldown@1.2.11/node_modules/rolldown/dist/shared/logs-D6uA606S.mjs
function spaces(index) {
  let result = "";
  while (index--) result += " ";
  return result;
}
function tabsToSpaces(value) {
  return value.replace(/^\t+/, (match) => match.split("	").join("  "));
}
var LINE_TRUNCATE_LENGTH = 120;
var MIN_CHARACTERS_SHOWN_AFTER_LOCATION = 10;
var ELLIPSIS = "...";
function getCodeFrame(source, line, column) {
  let lines = source.split("\n");
  if (line > lines.length) return "";
  const maxLineLength = Math.max(tabsToSpaces(lines[line - 1].slice(0, column)).length + MIN_CHARACTERS_SHOWN_AFTER_LOCATION + 3, LINE_TRUNCATE_LENGTH);
  const frameStart = Math.max(0, line - 3);
  let frameEnd = Math.min(line + 2, lines.length);
  lines = lines.slice(frameStart, frameEnd);
  while (!/\S/.test(lines[lines.length - 1])) {
    lines.pop();
    frameEnd -= 1;
  }
  const digits = String(frameEnd).length;
  return lines.map((sourceLine, index) => {
    const isErrorLine = frameStart + index + 1 === line;
    let lineNumber = String(index + frameStart + 1);
    while (lineNumber.length < digits) lineNumber = ` ${lineNumber}`;
    let displayedLine = tabsToSpaces(sourceLine);
    if (displayedLine.length > maxLineLength) displayedLine = `${displayedLine.slice(0, maxLineLength - 3)}${ELLIPSIS}`;
    if (isErrorLine) {
      const indicator = spaces(digits + 2 + tabsToSpaces(sourceLine.slice(0, column)).length) + "^";
      return `${lineNumber}: ${displayedLine}
${indicator}`;
    }
    return `${lineNumber}: ${displayedLine}`;
  }).join("\n");
}
function rangeContains(range, index) {
  return range.start <= index && index < range.end;
}
function getLocator(source, options = {}) {
  const { offsetLine = 0, offsetColumn = 0 } = options;
  let start = 0;
  const ranges = source.split("\n").map((line, i3) => {
    const end = start + line.length + 1;
    const range = {
      start,
      end,
      line: i3
    };
    start = end;
    return range;
  });
  let i2 = 0;
  function locator(search, index) {
    if (typeof search === "string") search = source.indexOf(search, index ?? 0);
    if (search === -1) return void 0;
    let range = ranges[i2];
    const d2 = search >= range.end ? 1 : -1;
    while (range) {
      if (rangeContains(range, search)) return {
        line: offsetLine + range.line,
        column: offsetColumn + search - range.start,
        character: search
      };
      i2 += d2;
      range = ranges[i2];
    }
  }
  return locator;
}
function locate(source, search, options) {
  return getLocator(source, options)(search, options && options.startIndex);
}
var INVALID_LOG_POSITION = "INVALID_LOG_POSITION";
var PLUGIN_ERROR = "PLUGIN_ERROR";
var INPUT_HOOK_IN_OUTPUT_PLUGIN = "INPUT_HOOK_IN_OUTPUT_PLUGIN";
var CYCLE_LOADING = "CYCLE_LOADING";
var MISSING_CODE_SPLITTING_GROUP_DEBUG_NAME = "MISSING_CODE_SPLITTING_GROUP_DEBUG_NAME";
var PARSE_ERROR = "PARSE_ERROR";
var VALIDATION_ERROR = "VALIDATION_ERROR";
function logParseError(message2, id2, pos) {
  return {
    code: PARSE_ERROR,
    id: id2,
    message: message2,
    pos
  };
}
function logFailedValidation(message2) {
  return {
    code: VALIDATION_ERROR,
    message: message2
  };
}
function logInvalidLogPosition(pluginName) {
  return {
    code: INVALID_LOG_POSITION,
    message: `Plugin "${pluginName}" tried to add a file position to a log or warning. This is only supported in the "transform" hook at the moment and will be ignored.`
  };
}
function logInputHookInOutputPlugin(pluginName, hookName) {
  return {
    code: INPUT_HOOK_IN_OUTPUT_PLUGIN,
    message: `The "${hookName}" hook used by the output plugin ${pluginName} is a build time hook and will not be run for that plugin. Either this plugin cannot be used as an output plugin, or it should have an option to configure it as an output plugin.`
  };
}
function logCycleLoading(pluginName, moduleId) {
  return {
    code: CYCLE_LOADING,
    message: `Found the module "${moduleId}" cycle loading at ${pluginName} plugin, it maybe blocking fetching modules.`
  };
}
function logMissingCodeSplittingGroupDebugName(groupPath) {
  return {
    code: MISSING_CODE_SPLITTING_GROUP_DEBUG_NAME,
    message: `\`${groupPath}.name\` is a function. Set \`${groupPath}.debugName\` so the bundler timing report can identify this group.`
  };
}
function logPluginError(error2, plugin, { hook, id: id2 } = {}) {
  try {
    const code3 = error2.code;
    if (!error2.pluginCode && code3 != null && (typeof code3 !== "string" || !code3.startsWith("PLUGIN_"))) error2.pluginCode = code3;
    error2.code = PLUGIN_ERROR;
    error2.plugin = plugin;
    if (hook) error2.hook = hook;
    if (id2) error2.id = id2;
  } catch (_3) {
  } finally {
    return error2;
  }
}
function error(base) {
  if (!(base instanceof Error)) {
    base = Object.assign(new Error(base.message), base);
    Object.defineProperty(base, "name", {
      value: "RolldownError",
      writable: true
    });
  }
  throw base;
}
function augmentCodeLocation(properties, pos, source, id2) {
  if (typeof pos === "object") {
    const { line, column } = pos;
    properties.loc = {
      column,
      file: id2,
      line
    };
  } else {
    properties.pos = pos;
    const location = locate(source, pos, { offsetLine: 1 });
    if (!location) return;
    const { line, column } = location;
    properties.loc = {
      column,
      file: id2,
      line
    };
  }
  if (properties.frame === void 0) {
    const { line, column } = properties.loc;
    properties.frame = getCodeFrame(source, line, column);
  }
}

// ../../node_modules/.bun/rolldown@1.2.11/node_modules/rolldown/dist/shared/normalize-string-or-regex-F14uvr6D.mjs
var import_binding = /* @__PURE__ */ n2(t2(), 1);
var BuiltinPlugin = class {
  name;
  _options;
  /** Vite-specific option to control plugin ordering */
  enforce;
  constructor(name50, _options) {
    this.name = name50;
    this._options = _options;
  }
};
function bindingifyBuiltInPlugin(plugin) {
  return {
    __name: plugin.name,
    options: plugin._options
  };
}
function bindingifyManifestPlugin(plugin, pluginContextData) {
  const { isOutputOptionsForLegacyChunks, ...options } = plugin._options;
  return {
    __name: plugin.name,
    options: {
      ...options,
      isLegacy: isOutputOptionsForLegacyChunks ? (opts) => {
        return isOutputOptionsForLegacyChunks(pluginContextData.getOutputOptions(opts));
      } : void 0
    }
  };
}
function normalizedStringOrRegex(pattern) {
  if (!pattern) return;
  if (!isReadonlyArray(pattern)) return [pattern];
  return pattern;
}
function isReadonlyArray(input) {
  return Array.isArray(input);
}

// ../../node_modules/.bun/rolldown@1.2.11/node_modules/rolldown/dist/shared/misc-DOSKtd97.mjs
function arraify(value) {
  return Array.isArray(value) ? value : [value];
}
function unimplemented(info) {
  if (info) throw new Error(`unimplemented: ${info}`);
  throw new Error("unimplemented");
}
function unreachable(info) {
  if (info) throw new Error(`unreachable: ${info}`);
  throw new Error("unreachable");
}
function unsupported(info) {
  throw new Error(`UNSUPPORTED: ${info}`);
}
function noop(..._args) {
}
var ABSOLUTE_PATH_REGEX = /^(?:\/|(?:[A-Za-z]:)?[/\\|])/;
function isPathFragment(name50) {
  return name50[0] === "/" || name50[0] === "." && (name50[1] === "/" || name50[1] === ".") || ABSOLUTE_PATH_REGEX.test(name50);
}

// ../../node_modules/.bun/rolldown@1.2.11/node_modules/rolldown/dist/shared/error-C7pxws0W.mjs
function bindingifySourcemap(map) {
  if (map == null) return;
  return { inner: typeof map === "string" ? map : {
    file: map.file ?? void 0,
    mappings: map.mappings,
    sourceRoot: "sourceRoot" in map ? map.sourceRoot ?? void 0 : void 0,
    sources: map.sources?.map((s2) => s2 ?? void 0),
    sourcesContent: map.sourcesContent?.map((s2) => s2 ?? void 0),
    names: map.names,
    x_google_ignoreList: map.x_google_ignoreList,
    debugId: "debugId" in map ? map.debugId : void 0
  } };
}
t2();
function unwrapBindingResult(container) {
  if (typeof container === "object" && container !== null && "isBindingErrors" in container && container.isBindingErrors) throw aggregateBindingErrorsIntoJsError(container.errors);
  return container;
}
function normalizeBindingError(e3) {
  return e3.type === "JsError" ? e3.field0 : Object.assign(/* @__PURE__ */ new Error(), {
    code: e3.field0.kind,
    kind: e3.field0.kind,
    message: e3.field0.message,
    id: e3.field0.id,
    exporter: e3.field0.exporter,
    loc: e3.field0.loc,
    pos: e3.field0.pos,
    stack: void 0
  });
}
function aggregateBindingErrorsIntoJsError(rawErrors) {
  const errors = rawErrors.map(normalizeBindingError);
  let summary = `Build failed with ${errors.length} error${errors.length < 2 ? "" : "s"}:
`;
  for (let i2 = 0; i2 < errors.length; i2++) {
    summary += "\n";
    if (i2 >= 5) {
      summary += "...";
      break;
    }
    summary += getErrorMessage(errors[i2]);
  }
  const wrapper = new Error(summary);
  Object.defineProperty(wrapper, "errors", {
    configurable: true,
    enumerable: true,
    get: () => errors,
    set: (value) => Object.defineProperty(wrapper, "errors", {
      configurable: true,
      enumerable: true,
      value
    })
  });
  return wrapper;
}
function getErrorMessage(e3) {
  if (Object.hasOwn(e3, "kind")) return e3.message;
  let s2 = "";
  if (e3.plugin) s2 += `[plugin ${e3.plugin}]`;
  const id2 = e3.id ?? e3.loc?.file;
  if (id2) {
    s2 += " " + id2;
    if (e3.loc) s2 += `:${e3.loc.line}:${e3.loc.column}`;
  }
  if (s2) s2 += "\n";
  const message2 = `${e3.name ?? "Error"}: ${e3.message}`;
  s2 += message2;
  if (e3.frame) s2 = joinNewLine(s2, e3.frame);
  if (e3.stack) s2 = joinNewLine(s2, e3.stack.replace(message2, ""));
  if (e3.cause) {
    s2 = joinNewLine(s2, "Caused by:");
    s2 = joinNewLine(s2, getErrorMessage(e3.cause).split("\n").map((line) => "  " + line).join("\n"));
  }
  return s2;
}
function joinNewLine(s1, s2) {
  return s1.replace(/\n+$/, "") + "\n" + s2.replace(/^\n+/, "");
}

// ../../node_modules/.bun/rolldown@1.2.11/node_modules/rolldown/dist/shared/parse-WKtEKiA6.mjs
var import_binding2 = /* @__PURE__ */ n2(t2(), 1);
function wrap(result) {
  let program, module, comments, errors;
  return {
    get program() {
      if (!program) program = jsonParseAst(result.program);
      return program;
    },
    get module() {
      if (!module) module = result.module;
      return module;
    },
    get comments() {
      if (!comments) comments = result.comments;
      return comments;
    },
    get errors() {
      if (!errors) errors = result.errors;
      return errors;
    }
  };
}
function jsonParseAst(programJson) {
  const { node: program, fixes } = JSON.parse(programJson);
  for (const fixPath of fixes) applyFix(program, fixPath);
  return program;
}
function applyFix(program, fixPath) {
  let node = program;
  for (const key of fixPath) node = node[key];
  if (node.bigint) node.value = BigInt(node.bigint);
  else try {
    node.value = RegExp(node.regex.pattern, node.regex.flags);
  } catch {
  }
}
function parseSync(filename, sourceText, options) {
  return wrap((0, import_binding2.parseSync)(filename, sourceText, options));
}

// ../../node_modules/.bun/rolldown@1.2.11/node_modules/rolldown/dist/parse-ast-index.mjs
function wrap2(result, filename, sourceText) {
  if (result.errors.length > 0) return normalizeParseError(filename, sourceText, result.errors);
  return result.program;
}
function normalizeParseError(filename, sourceText, errors) {
  let message2 = `Parse failed with ${errors.length} error${errors.length < 2 ? "" : "s"}:
`;
  const pos = errors[0]?.labels?.[0]?.start;
  for (let i2 = 0; i2 < errors.length; i2++) {
    if (i2 >= 5) {
      message2 += "\n...";
      break;
    }
    const e3 = errors[i2];
    message2 += e3.message + "\n" + e3.labels.map((label) => {
      const location = locate(sourceText, label.start, { offsetLine: 1 });
      if (!location) return;
      return getCodeFrame(sourceText, location.line, location.column);
    }).filter(Boolean).join("\n");
  }
  const log = logParseError(message2, filename, pos);
  if (pos !== void 0 && filename) augmentCodeLocation(log, pos, sourceText, filename);
  return error(log);
}
var defaultParserOptions = {
  lang: "js",
  preserveParens: false
};
function parseAst(sourceText, options, filename) {
  return wrap2(parseSync(filename ?? "file.js", sourceText, {
    ...defaultParserOptions,
    ...options
  }), filename, sourceText);
}

// ../../node_modules/.bun/rolldown@1.2.11/node_modules/rolldown/dist/shared/bindingify-input-options-XrReX_BJ.mjs
init_shims();
import path from "node:path";

// ../../node_modules/.bun/@rolldown+pluginutils@1.0.1/node_modules/@rolldown/pluginutils/dist/filter-B_mD-HGz.mjs
var And = class {
  kind;
  args;
  constructor(...args2) {
    if (args2.length === 0) throw new Error("`And` expects at least one operand");
    this.args = args2;
    this.kind = "and";
  }
};
var Or = class {
  kind;
  args;
  constructor(...args2) {
    if (args2.length === 0) throw new Error("`Or` expects at least one operand");
    this.args = args2;
    this.kind = "or";
  }
};
var Id = class {
  kind;
  pattern;
  params;
  constructor(pattern, params) {
    this.pattern = pattern;
    this.kind = "id";
    this.params = params ?? { cleanUrl: false };
  }
};
var ModuleType = class {
  kind;
  pattern;
  constructor(pattern) {
    this.pattern = pattern;
    this.kind = "moduleType";
  }
};
var Code = class {
  kind;
  pattern;
  constructor(expr) {
    this.pattern = expr;
    this.kind = "code";
  }
};
var Include = class {
  kind;
  expr;
  constructor(expr) {
    this.expr = expr;
    this.kind = "include";
  }
};
var Exclude = class {
  kind;
  expr;
  constructor(expr) {
    this.expr = expr;
    this.kind = "exclude";
  }
};
function and(...args2) {
  return new And(...args2);
}
function or(...args2) {
  return new Or(...args2);
}
function id(pattern, params) {
  return new Id(pattern, params);
}
function moduleType(pattern) {
  return new ModuleType(pattern);
}
function code(pattern) {
  return new Code(pattern);
}
function include(expr) {
  return new Include(expr);
}
function exclude(expr) {
  return new Exclude(expr);
}

// ../../node_modules/.bun/rolldown@1.2.11/node_modules/rolldown/dist/shared/bindingify-input-options-XrReX_BJ.mjs
init_shims();
init_shims();
var version = "1.2.11";
var VERSION = version;
var LOG_LEVEL_SILENT = "silent";
var LOG_LEVEL_WARN = "warn";
var LOG_LEVEL_INFO = "info";
var LOG_LEVEL_DEBUG = "debug";
var logLevelPriority = {
  [LOG_LEVEL_DEBUG]: 0,
  [LOG_LEVEL_INFO]: 1,
  [LOG_LEVEL_WARN]: 2,
  [LOG_LEVEL_SILENT]: 3
};
var normalizeLog = (log) => typeof log === "string" ? { message: log } : typeof log === "function" ? normalizeLog(log()) : log;
function getLogHandler(level, code3, logger2, pluginName, logLevel) {
  if (logLevelPriority[level] < logLevelPriority[logLevel]) return noop;
  return (log, pos) => {
    if (pos != null) logger2(LOG_LEVEL_WARN, logInvalidLogPosition(pluginName));
    log = normalizeLog(log);
    if (log.code && !log.pluginCode) log.pluginCode = log.code;
    log.code = code3;
    log.plugin = pluginName;
    logger2(level, log);
  };
}
function normalizeHook(hook) {
  if (typeof hook === "function" || typeof hook === "string") return {
    handler: hook,
    options: {},
    meta: {}
  };
  if (typeof hook === "object" && hook !== null) {
    const { handler, order, ...options } = hook;
    return {
      handler,
      options,
      meta: { order }
    };
  }
  unreachable("Invalid hook type");
}
function getParallelPluginInfo(plugin) {
  if (plugin === null || typeof plugin !== "object") return;
  const descriptor = Object.getOwnPropertyDescriptor(plugin, "_parallel");
  if (!descriptor || !("value" in descriptor)) return;
  const parallel = descriptor.value;
  if (parallel === null || typeof parallel !== "object" || typeof parallel.fileUrl !== "string") return;
  return parallel;
}
var MinimalPluginContextImpl = class {
  pluginName;
  hookName;
  info;
  warn;
  debug;
  meta;
  constructor(onLog, logLevel, pluginName, watchMode, hookName) {
    this.pluginName = pluginName;
    this.hookName = hookName;
    this.debug = getLogHandler(LOG_LEVEL_DEBUG, "PLUGIN_LOG", onLog, pluginName, logLevel);
    this.info = getLogHandler(LOG_LEVEL_INFO, "PLUGIN_LOG", onLog, pluginName, logLevel);
    this.warn = getLogHandler(LOG_LEVEL_WARN, "PLUGIN_WARNING", onLog, pluginName, logLevel);
    this.meta = {
      rollupVersion: "4.23.0",
      rolldownVersion: VERSION,
      watchMode
    };
  }
  error(e3) {
    return error(logPluginError(normalizeLog(e3), this.pluginName, { hook: this.hookName }));
  }
};
var import_binding3 = /* @__PURE__ */ n2(t2(), 1);
var LAZY_FIELDS_KEY = /* @__PURE__ */ Symbol("__lazy_fields__");
var PlainObjectLike = class {
  constructor() {
    setupLazyProperties(this);
  }
};
function setupLazyProperties(instance2) {
  const lazyFields = instance2.constructor[LAZY_FIELDS_KEY];
  if (!lazyFields) return;
  for (const [propertyKey, originalGetter] of lazyFields.entries()) {
    let cachedValue;
    let hasValue = false;
    Object.defineProperty(instance2, propertyKey, {
      get() {
        if (!hasValue) {
          cachedValue = originalGetter.call(this);
          hasValue = true;
        }
        return cachedValue;
      },
      enumerable: true,
      configurable: true
    });
  }
}
function getLazyFields(instance2) {
  const lazyFields = instance2.constructor[LAZY_FIELDS_KEY];
  return lazyFields ? new Set(lazyFields.keys()) : /* @__PURE__ */ new Set();
}
function lazyProp(target, propertyKey, descriptor) {
  if (!target.constructor[LAZY_FIELDS_KEY]) target.constructor[LAZY_FIELDS_KEY] = /* @__PURE__ */ new Map();
  const originalGetter = descriptor.get;
  target.constructor[LAZY_FIELDS_KEY].set(propertyKey, originalGetter);
  return {
    enumerable: false,
    configurable: true
  };
}
function transformAssetSource(bindingAssetSource2) {
  return bindingAssetSource2.inner;
}
function bindingAssetSource(source) {
  return { inner: source };
}
function __decorate(decorators, target, key, desc) {
  var c3 = arguments.length, r3 = c3 < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d2;
  if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r3 = Reflect.decorate(decorators, target, key, desc);
  else for (var i2 = decorators.length - 1; i2 >= 0; i2--) if (d2 = decorators[i2]) r3 = (c3 < 3 ? d2(r3) : c3 > 3 ? d2(target, key, r3) : d2(target, key)) || r3;
  return c3 > 3 && r3 && Object.defineProperty(target, key, r3), r3;
}
var OutputAssetImpl = class extends PlainObjectLike {
  bindingAsset;
  type = "asset";
  constructor(bindingAsset) {
    super();
    this.bindingAsset = bindingAsset;
  }
  get fileName() {
    return this.bindingAsset.getFileName();
  }
  get originalFileName() {
    return this.bindingAsset.getOriginalFileName() || null;
  }
  get originalFileNames() {
    return this.bindingAsset.getOriginalFileNames();
  }
  get name() {
    return this.bindingAsset.getName() ?? void 0;
  }
  get names() {
    return this.bindingAsset.getNames();
  }
  get source() {
    return transformAssetSource(this.bindingAsset.getSource());
  }
  __rolldown_external_memory_handle__(keepDataAlive) {
    if (keepDataAlive) this.#evaluateAllLazyFields();
    return this.bindingAsset.dropInner();
  }
  #evaluateAllLazyFields() {
    for (const field of getLazyFields(this)) this[field];
  }
};
__decorate([lazyProp], OutputAssetImpl.prototype, "fileName", null);
__decorate([lazyProp], OutputAssetImpl.prototype, "originalFileName", null);
__decorate([lazyProp], OutputAssetImpl.prototype, "originalFileNames", null);
__decorate([lazyProp], OutputAssetImpl.prototype, "name", null);
__decorate([lazyProp], OutputAssetImpl.prototype, "names", null);
__decorate([lazyProp], OutputAssetImpl.prototype, "source", null);
function transformToRenderedModule(bindingRenderedModule) {
  return {
    get code() {
      return bindingRenderedModule.code;
    },
    get renderedLength() {
      return bindingRenderedModule.code?.length || 0;
    },
    get renderedExports() {
      return bindingRenderedModule.renderedExports;
    }
  };
}
function transformRenderedChunk(chunk) {
  let modules = null;
  return {
    type: "chunk",
    get name() {
      return chunk.name;
    },
    get isEntry() {
      return chunk.isEntry;
    },
    get isDynamicEntry() {
      return chunk.isDynamicEntry;
    },
    get facadeModuleId() {
      return chunk.facadeModuleId;
    },
    get moduleIds() {
      return chunk.moduleIds;
    },
    get exports() {
      return chunk.exports;
    },
    get fileName() {
      return chunk.fileName;
    },
    get imports() {
      return chunk.imports;
    },
    get dynamicImports() {
      return chunk.dynamicImports;
    },
    get modules() {
      if (!modules) modules = transformChunkModules(chunk.modules);
      return modules;
    }
  };
}
function transformChunkModules(modules) {
  const result = {};
  for (let i2 = 0; i2 < modules.values.length; i2++) {
    let key = modules.keys[i2];
    const mod = modules.values[i2];
    result[key] = transformToRenderedModule(mod);
  }
  return result;
}
var OutputChunkImpl = class extends PlainObjectLike {
  bindingChunk;
  type = "chunk";
  constructor(bindingChunk) {
    super();
    this.bindingChunk = bindingChunk;
  }
  get fileName() {
    return this.bindingChunk.getFileName();
  }
  get name() {
    return this.bindingChunk.getName();
  }
  get exports() {
    return this.bindingChunk.getExports();
  }
  get isEntry() {
    return this.bindingChunk.getIsEntry();
  }
  get facadeModuleId() {
    return this.bindingChunk.getFacadeModuleId() || null;
  }
  get isDynamicEntry() {
    return this.bindingChunk.getIsDynamicEntry();
  }
  get sourcemapFileName() {
    return this.bindingChunk.getSourcemapFileName() || null;
  }
  get preliminaryFileName() {
    return this.bindingChunk.getPreliminaryFileName();
  }
  get code() {
    return this.bindingChunk.getCode();
  }
  get modules() {
    return transformChunkModules(this.bindingChunk.getModules());
  }
  get imports() {
    return this.bindingChunk.getImports();
  }
  get dynamicImports() {
    return this.bindingChunk.getDynamicImports();
  }
  get moduleIds() {
    return this.bindingChunk.getModuleIds();
  }
  get map() {
    const mapString = this.bindingChunk.getMap();
    return mapString ? transformToRollupSourceMap(mapString) : null;
  }
  __rolldown_external_memory_handle__(keepDataAlive) {
    if (keepDataAlive) this.#evaluateAllLazyFields();
    return this.bindingChunk.dropInner();
  }
  #evaluateAllLazyFields() {
    for (const field of getLazyFields(this)) this[field];
  }
};
__decorate([lazyProp], OutputChunkImpl.prototype, "fileName", null);
__decorate([lazyProp], OutputChunkImpl.prototype, "name", null);
__decorate([lazyProp], OutputChunkImpl.prototype, "exports", null);
__decorate([lazyProp], OutputChunkImpl.prototype, "isEntry", null);
__decorate([lazyProp], OutputChunkImpl.prototype, "facadeModuleId", null);
__decorate([lazyProp], OutputChunkImpl.prototype, "isDynamicEntry", null);
__decorate([lazyProp], OutputChunkImpl.prototype, "sourcemapFileName", null);
__decorate([lazyProp], OutputChunkImpl.prototype, "preliminaryFileName", null);
__decorate([lazyProp], OutputChunkImpl.prototype, "code", null);
__decorate([lazyProp], OutputChunkImpl.prototype, "modules", null);
__decorate([lazyProp], OutputChunkImpl.prototype, "imports", null);
__decorate([lazyProp], OutputChunkImpl.prototype, "dynamicImports", null);
__decorate([lazyProp], OutputChunkImpl.prototype, "moduleIds", null);
__decorate([lazyProp], OutputChunkImpl.prototype, "map", null);
function transformToRollupSourceMap(map) {
  const obj = {
    ...JSON.parse(map),
    toString() {
      return JSON.stringify(obj);
    },
    toUrl() {
      return `data:application/json;charset=utf-8;base64,${Buffer.from(obj.toString(), "utf-8").toString("base64")}`;
    }
  };
  return obj;
}
function transformToRollupOutputChunk(bindingChunk) {
  return new OutputChunkImpl(bindingChunk);
}
function transformToMutableRollupOutputChunk(bindingChunk, changed) {
  const chunk = {
    type: "chunk",
    get code() {
      return bindingChunk.getCode();
    },
    fileName: bindingChunk.getFileName(),
    name: bindingChunk.getName(),
    get modules() {
      return transformChunkModules(bindingChunk.getModules());
    },
    get imports() {
      return bindingChunk.getImports();
    },
    get dynamicImports() {
      return bindingChunk.getDynamicImports();
    },
    exports: bindingChunk.getExports(),
    isEntry: bindingChunk.getIsEntry(),
    facadeModuleId: bindingChunk.getFacadeModuleId() || null,
    isDynamicEntry: bindingChunk.getIsDynamicEntry(),
    get moduleIds() {
      return bindingChunk.getModuleIds();
    },
    get map() {
      const map = bindingChunk.getMap();
      return map ? transformToRollupSourceMap(map) : null;
    },
    sourcemapFileName: bindingChunk.getSourcemapFileName() || null,
    preliminaryFileName: bindingChunk.getPreliminaryFileName()
  };
  const cache = {};
  return new Proxy(chunk, {
    get(target, p) {
      if (p in cache) return cache[p];
      const value = target[p];
      cache[p] = value;
      return value;
    },
    set(_target, p, newValue) {
      cache[p] = newValue;
      changed.updated.add(bindingChunk.getFileName());
      return true;
    },
    has(target, p) {
      if (p in cache) return true;
      return p in target;
    }
  });
}
function transformToRollupOutputAsset(bindingAsset) {
  return new OutputAssetImpl(bindingAsset);
}
function transformToMutableRollupOutputAsset(bindingAsset, changed) {
  const asset = {
    type: "asset",
    fileName: bindingAsset.getFileName(),
    originalFileName: bindingAsset.getOriginalFileName() || null,
    originalFileNames: bindingAsset.getOriginalFileNames(),
    get source() {
      return transformAssetSource(bindingAsset.getSource());
    },
    name: bindingAsset.getName() ?? void 0,
    names: bindingAsset.getNames()
  };
  const cache = {};
  return new Proxy(asset, {
    get(target, p) {
      if (p in cache) return cache[p];
      const value = target[p];
      cache[p] = value;
      return value;
    },
    set(_target, p, newValue) {
      cache[p] = newValue;
      changed.updated.add(bindingAsset.getFileName());
      return true;
    }
  });
}
function transformToRollupOutput(output) {
  const { chunks, assets } = output;
  const transformed = { output: [...chunks.map((chunk) => transformToRollupOutputChunk(chunk)), ...assets.map((asset) => transformToRollupOutputAsset(asset))] };
  if (output.mangleCache !== void 0) transformed.mangleCache = output.mangleCache;
  return transformed;
}
function transformToMutableRollupOutput(output, changed) {
  const { chunks, assets } = output;
  return { output: [...chunks.map((chunk) => transformToMutableRollupOutputChunk(chunk, changed)), ...assets.map((asset) => transformToMutableRollupOutputAsset(asset, changed))] };
}
function transformToOutputBundle(context, output, changed) {
  const bundle = Object.fromEntries(transformToMutableRollupOutput(output, changed).output.map((item) => [item.fileName, item]));
  return new Proxy(bundle, {
    set(_target, _p, _newValue, _receiver) {
      const originalStackTraceLimit = Error.stackTraceLimit;
      Error.stackTraceLimit = 2;
      const message2 = "This plugin assigns to bundle variable. This is discouraged by Rollup and is not supported by Rolldown. This will be ignored. https://rollupjs.org/plugin-development/#generatebundle:~:text=DANGER,this.emitFile.";
      const stack = (/* @__PURE__ */ new Error(message2)).stack ?? message2;
      Error.stackTraceLimit = originalStackTraceLimit;
      context.warn({
        message: stack,
        code: "UNSUPPORTED_BUNDLE_ASSIGNMENT"
      });
      return true;
    },
    deleteProperty(target, property) {
      if (typeof property === "string") changed.deleted.add(property);
      delete target[property];
      return true;
    }
  });
}
function collectChangedBundle(changed, bundle) {
  const changes = {};
  for (const key in bundle) {
    if (changed.deleted.has(key) || !changed.updated.has(key)) continue;
    const item = bundle[key];
    if (item.type === "asset") changes[key] = {
      filename: item.fileName,
      originalFileNames: item.originalFileNames,
      source: bindingAssetSource(item.source),
      names: item.names
    };
    else changes[key] = {
      code: item.code,
      filename: item.fileName,
      name: item.name,
      isEntry: item.isEntry,
      exports: item.exports,
      modules: {},
      imports: item.imports,
      dynamicImports: item.dynamicImports,
      facadeModuleId: item.facadeModuleId || void 0,
      isDynamicEntry: item.isDynamicEntry,
      moduleIds: item.moduleIds,
      map: bindingifySourcemap(item.map),
      sourcemapFilename: item.sourcemapFileName || void 0,
      preliminaryFilename: item.preliminaryFileName
    };
  }
  return {
    changes,
    deleted: changed.deleted
  };
}
var NormalizedInputOptionsImpl = class extends PlainObjectLike {
  onLog;
  inputPlugins;
  inner;
  constructor(inner, onLog, inputPlugins) {
    super();
    this.onLog = onLog;
    this.inputPlugins = inputPlugins;
    this.inner = inner;
  }
  get shimMissingExports() {
    return this.inner.shimMissingExports;
  }
  get input() {
    return this.inner.input;
  }
  get cwd() {
    return this.inner.cwd;
  }
  get platform() {
    return this.inner.platform;
  }
  get context() {
    return this.inner.context;
  }
  get plugins() {
    return this.inputPlugins;
  }
};
__decorate([lazyProp], NormalizedInputOptionsImpl.prototype, "shimMissingExports", null);
__decorate([lazyProp], NormalizedInputOptionsImpl.prototype, "input", null);
__decorate([lazyProp], NormalizedInputOptionsImpl.prototype, "cwd", null);
__decorate([lazyProp], NormalizedInputOptionsImpl.prototype, "platform", null);
__decorate([lazyProp], NormalizedInputOptionsImpl.prototype, "context", null);
var NormalizedOutputOptionsImpl = class extends PlainObjectLike {
  inner;
  outputOptions;
  normalizedOutputPlugins;
  constructor(inner, outputOptions, normalizedOutputPlugins) {
    super();
    this.inner = inner;
    this.outputOptions = outputOptions;
    this.normalizedOutputPlugins = normalizedOutputPlugins;
  }
  get dir() {
    return this.inner.dir ?? void 0;
  }
  get entryFileNames() {
    return this.inner.entryFilenames || this.outputOptions.entryFileNames;
  }
  get chunkFileNames() {
    return this.inner.chunkFilenames || this.outputOptions.chunkFileNames;
  }
  get assetFileNames() {
    return this.inner.assetFilenames || this.outputOptions.assetFileNames;
  }
  get format() {
    return this.inner.format;
  }
  get exports() {
    return this.inner.exports;
  }
  get sourcemap() {
    return this.inner.sourcemap;
  }
  get sourcemapFileNames() {
    return this.inner.sourcemapFilenames || this.outputOptions.sourcemapFileNames;
  }
  get sourcemapBaseUrl() {
    return this.inner.sourcemapBaseUrl ?? void 0;
  }
  get shimMissingExports() {
    return this.inner.shimMissingExports;
  }
  get name() {
    return this.inner.name ?? void 0;
  }
  get file() {
    return this.inner.file ?? void 0;
  }
  get codeSplitting() {
    return this.inner.codeSplitting;
  }
  /**
  * @deprecated Use `codeSplitting` instead.
  */
  get inlineDynamicImports() {
    return !this.inner.codeSplitting;
  }
  get dynamicImportInCjs() {
    return this.inner.dynamicImportInCjs;
  }
  get externalLiveBindings() {
    return this.inner.externalLiveBindings;
  }
  get banner() {
    return normalizeAddon(this.outputOptions.banner);
  }
  get footer() {
    return normalizeAddon(this.outputOptions.footer);
  }
  get postBanner() {
    return normalizeAddon(this.outputOptions.postBanner);
  }
  get postFooter() {
    return normalizeAddon(this.outputOptions.postFooter);
  }
  get intro() {
    return normalizeAddon(this.outputOptions.intro);
  }
  get outro() {
    return normalizeAddon(this.outputOptions.outro);
  }
  get esModule() {
    return this.inner.esModule;
  }
  get extend() {
    return this.inner.extend;
  }
  get globals() {
    return this.inner.globals || this.outputOptions.globals;
  }
  get paths() {
    return this.outputOptions.paths;
  }
  get hashCharacters() {
    return this.inner.hashCharacters;
  }
  get sourcemapDebugIds() {
    return this.inner.sourcemapDebugIds;
  }
  get sourcemapExcludeSources() {
    return this.inner.sourcemapExcludeSources;
  }
  get sourcemapIgnoreList() {
    return this.outputOptions.sourcemapIgnoreList;
  }
  get sourcemapPathTransform() {
    return this.outputOptions.sourcemapPathTransform;
  }
  get minify() {
    let ret = this.inner.minify;
    if (typeof ret === "object" && ret !== null) {
      delete ret["codegen"];
      delete ret["module"];
      delete ret["sourcemap"];
    }
    return ret;
  }
  get legalComments() {
    return this.inner.legalComments;
  }
  get comments() {
    const c3 = this.inner.comments;
    return {
      legal: c3.legal ?? true,
      annotation: c3.annotation ?? true,
      jsdoc: c3.jsdoc ?? true
    };
  }
  get polyfillRequire() {
    return this.inner.polyfillRequire;
  }
  get plugins() {
    return this.normalizedOutputPlugins;
  }
  get preserveModules() {
    return this.inner.preserveModules;
  }
  get preserveModulesRoot() {
    return this.inner.preserveModulesRoot;
  }
  get virtualDirname() {
    return this.inner.virtualDirname;
  }
  get topLevelVar() {
    return this.inner.topLevelVar ?? false;
  }
  get minifyInternalExports() {
    return this.inner.minifyInternalExports ?? false;
  }
};
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "dir", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "entryFileNames", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "chunkFileNames", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "assetFileNames", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "format", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "exports", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "sourcemap", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "sourcemapFileNames", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "sourcemapBaseUrl", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "shimMissingExports", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "name", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "file", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "codeSplitting", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "inlineDynamicImports", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "dynamicImportInCjs", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "externalLiveBindings", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "banner", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "footer", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "postBanner", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "postFooter", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "intro", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "outro", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "esModule", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "extend", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "globals", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "paths", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "hashCharacters", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "sourcemapDebugIds", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "sourcemapExcludeSources", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "sourcemapIgnoreList", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "sourcemapPathTransform", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "minify", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "legalComments", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "comments", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "polyfillRequire", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "plugins", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "preserveModules", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "preserveModulesRoot", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "virtualDirname", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "topLevelVar", null);
__decorate([lazyProp], NormalizedOutputOptionsImpl.prototype, "minifyInternalExports", null);
function normalizeAddon(value) {
  if (typeof value === "function") return value;
  return () => value || "";
}
function transformModuleInfo(info, option) {
  return {
    get ast() {
      return unsupported("ModuleInfo#ast");
    },
    get code() {
      return info.code;
    },
    id: info.id,
    importers: info.importers,
    dynamicImporters: info.dynamicImporters,
    importedIds: info.importedIds,
    dynamicallyImportedIds: info.dynamicallyImportedIds,
    exports: info.exports,
    isEntry: info.isEntry,
    inputFormat: info.inputFormat,
    ...option
  };
}
var PluginContextData = class {
  onLog;
  outputOptions;
  normalizedInputPlugins;
  normalizedOutputPlugins;
  moduleOptionMap = /* @__PURE__ */ new Map();
  resolveOptionsMap = /* @__PURE__ */ new Map();
  loadModulePromiseMap = /* @__PURE__ */ new Map();
  renderedChunkMeta = null;
  normalizedInputOptions = null;
  normalizedOutputOptions = null;
  constructor(onLog, outputOptions, normalizedInputPlugins, normalizedOutputPlugins) {
    this.onLog = onLog;
    this.outputOptions = outputOptions;
    this.normalizedInputPlugins = normalizedInputPlugins;
    this.normalizedOutputPlugins = normalizedOutputPlugins;
  }
  updateModuleOption(id2, option) {
    const existing = this.moduleOptionMap.get(id2);
    if (existing) {
      if (option.moduleSideEffects != null) existing.moduleSideEffects = option.moduleSideEffects;
      if (option.meta != null) Object.assign(existing.meta, option.meta);
      if (option.invalidate != null) existing.invalidate = option.invalidate;
    } else {
      this.moduleOptionMap.set(id2, option);
      return option;
    }
    return existing;
  }
  getModuleOption(id2) {
    const option = this.moduleOptionMap.get(id2);
    if (!option) {
      const raw = {
        moduleSideEffects: null,
        meta: {}
      };
      this.moduleOptionMap.set(id2, raw);
      return raw;
    }
    return option;
  }
  getModuleInfo(id2, context) {
    const bindingInfo = context.getModuleInfo(id2);
    if (bindingInfo) {
      const info = transformModuleInfo(bindingInfo, this.getModuleOption(id2));
      return this.proxyModuleInfo(id2, info);
    }
    return null;
  }
  proxyModuleInfo(id2, info) {
    let moduleSideEffects = info.moduleSideEffects;
    Object.defineProperty(info, "moduleSideEffects", {
      get() {
        return moduleSideEffects;
      },
      set: (v2) => {
        this.updateModuleOption(id2, {
          moduleSideEffects: v2,
          meta: info.meta,
          invalidate: true
        });
        moduleSideEffects = v2;
      }
    });
    return info;
  }
  getModuleIds(context) {
    return context.getModuleIds().values();
  }
  saveResolveOptions(options) {
    const index = this.resolveOptionsMap.size;
    this.resolveOptionsMap.set(index, options);
    return index;
  }
  getSavedResolveOptions(receipt) {
    return this.resolveOptionsMap.get(receipt);
  }
  removeSavedResolveOptions(receipt) {
    this.resolveOptionsMap.delete(receipt);
  }
  setRenderChunkMeta(meta) {
    this.renderedChunkMeta = meta;
  }
  getRenderChunkMeta() {
    return this.renderedChunkMeta;
  }
  getInputOptions(opts) {
    this.normalizedInputOptions ??= new NormalizedInputOptionsImpl(opts, this.onLog, this.normalizedInputPlugins);
    return this.normalizedInputOptions;
  }
  getOutputOptions(opts) {
    this.normalizedOutputOptions ??= new NormalizedOutputOptionsImpl(opts, this.outputOptions, this.normalizedOutputPlugins);
    return this.normalizedOutputOptions;
  }
  clear() {
    this.renderedChunkMeta = null;
    this.loadModulePromiseMap.clear();
  }
};
Object.defineProperty(import_binding3.BindingMagicString.prototype, "isRolldownMagicString", {
  value: true,
  writable: false,
  configurable: false
});
function assertString(content, msg) {
  if (typeof content !== "string") throw new TypeError(msg);
}
var nativeAppend = import_binding3.BindingMagicString.prototype.append;
var nativePrepend = import_binding3.BindingMagicString.prototype.prepend;
var nativeAppendLeft = import_binding3.BindingMagicString.prototype.appendLeft;
var nativeAppendRight = import_binding3.BindingMagicString.prototype.appendRight;
var nativePrependLeft = import_binding3.BindingMagicString.prototype.prependLeft;
var nativePrependRight = import_binding3.BindingMagicString.prototype.prependRight;
var nativeOverwrite = import_binding3.BindingMagicString.prototype.overwrite;
var nativeUpdate = import_binding3.BindingMagicString.prototype.update;
import_binding3.BindingMagicString.prototype.append = function(content) {
  assertString(content, "outro content must be a string");
  return nativeAppend.call(this, content);
};
import_binding3.BindingMagicString.prototype.prepend = function(content) {
  assertString(content, "outro content must be a string");
  return nativePrepend.call(this, content);
};
import_binding3.BindingMagicString.prototype.appendLeft = function(index, content) {
  assertString(content, "inserted content must be a string");
  return nativeAppendLeft.call(this, index, content);
};
import_binding3.BindingMagicString.prototype.appendRight = function(index, content) {
  assertString(content, "inserted content must be a string");
  return nativeAppendRight.call(this, index, content);
};
import_binding3.BindingMagicString.prototype.prependLeft = function(index, content) {
  assertString(content, "inserted content must be a string");
  return nativePrependLeft.call(this, index, content);
};
import_binding3.BindingMagicString.prototype.prependRight = function(index, content) {
  assertString(content, "inserted content must be a string");
  return nativePrependRight.call(this, index, content);
};
import_binding3.BindingMagicString.prototype.overwrite = function(start, end, content, options) {
  assertString(content, "replacement content must be a string");
  return nativeOverwrite.call(this, start, end, content, options);
};
import_binding3.BindingMagicString.prototype.update = function(start, end, content, options) {
  assertString(content, "replacement content must be a string");
  return nativeUpdate.call(this, start, end, content, options);
};
var nativeReplace = import_binding3.BindingMagicString.prototype.replace;
var nativeReplaceAll = import_binding3.BindingMagicString.prototype.replaceAll;
import_binding3.BindingMagicString.prototype.replace = function(searchValue, replacement) {
  if (typeof searchValue === "string") return nativeReplace.call(this, searchValue, replacement);
  if (searchValue.global) searchValue.lastIndex = 0;
  const lastMatchEnd = this.replaceRegex(searchValue, replacement);
  if (searchValue.global) searchValue.lastIndex = 0;
  else if (searchValue.sticky) searchValue.lastIndex = lastMatchEnd === -1 ? 0 : lastMatchEnd;
  return this;
};
import_binding3.BindingMagicString.prototype.replaceAll = function(searchValue, replacement) {
  if (typeof searchValue === "string") return nativeReplaceAll.call(this, searchValue, replacement);
  if (!searchValue.global) throw new TypeError("MagicString.prototype.replaceAll called with a non-global RegExp argument");
  searchValue.lastIndex = 0;
  this.replaceRegex(searchValue, replacement);
  searchValue.lastIndex = 0;
  return this;
};
var RolldownMagicString = import_binding3.BindingMagicString;
function isEmptySourcemapFiled(array2) {
  if (!array2) return true;
  if (array2.length === 0 || !array2[0]) return true;
  return false;
}
function normalizeTransformHookSourcemap(id2, originalCode, rawMap) {
  if (!rawMap) return;
  let map = typeof rawMap === "object" ? rawMap : JSON.parse(rawMap);
  if (isEmptySourcemapFiled(map.sourcesContent)) map.sourcesContent = [originalCode];
  if (isEmptySourcemapFiled(map.sources) || map.sources && map.sources.length === 1 && map.sources[0] !== id2) map.sources = [id2];
  return map;
}
function e(e3, t5, n5) {
  let r3 = (n6) => e3(n6, ...t5);
  return n5 === void 0 ? r3 : Object.assign(r3, {
    lazy: n5,
    lazyArgs: t5
  });
}
function t$1(t5, n5, r3) {
  let i2 = t5.length - n5.length;
  if (i2 === 0) return t5(...n5);
  if (i2 === 1) return e(t5, n5, r3);
  throw Error(`Wrong number of arguments`);
}
function t3(...t5) {
  return t$1(n3, t5);
}
var n3 = (e3, t5) => {
  let n5 = [[], []];
  for (let [r3, i2] of e3.entries()) t5(i2, r3, e3) ? n5[0].push(i2) : n5[1].push(i2);
  return n5;
};
function generalHookFilterMatcherToFilterExprs(matcher, stringKind) {
  if (typeof matcher === "string" || matcher instanceof RegExp) return [include(generateAtomMatcher(stringKind, matcher))];
  if (Array.isArray(matcher)) return matcher.map((m2) => include(generateAtomMatcher(stringKind, m2)));
  let ret = [];
  if (matcher.exclude) ret.push(...arraify(matcher.exclude).map((m2) => exclude(generateAtomMatcher(stringKind, m2))));
  if (matcher.include) ret.push(...arraify(matcher.include).map((m2) => include(generateAtomMatcher(stringKind, m2))));
  return ret;
}
function generateAtomMatcher(kind, matcher) {
  return kind === "code" ? code(matcher) : id(matcher);
}
function transformFilterMatcherToFilterExprs(filterOption) {
  if (!filterOption) return;
  if (Array.isArray(filterOption)) return filterOption;
  const { id: id2, code: code3, moduleType: moduleType2 } = filterOption;
  let ret = [];
  let idIncludes = [];
  let idExcludes = [];
  let codeIncludes = [];
  let codeExcludes = [];
  if (id2) [idIncludes, idExcludes] = t3(generalHookFilterMatcherToFilterExprs(id2, "id") ?? [], (m2) => m2.kind === "include");
  if (code3) [codeIncludes, codeExcludes] = t3(generalHookFilterMatcherToFilterExprs(code3, "code") ?? [], (m2) => m2.kind === "include");
  ret.push(...idExcludes);
  ret.push(...codeExcludes);
  let andExprList = [];
  if (moduleType2) {
    let moduleTypes = Array.isArray(moduleType2) ? moduleType2 : moduleType2.include ?? [];
    andExprList.push(or(...moduleTypes.map((m2) => moduleType(m2))));
  }
  if (idIncludes.length) andExprList.push(or(...idIncludes.map((item) => item.expr)));
  if (codeIncludes.length) andExprList.push(or(...codeIncludes.map((item) => item.expr)));
  if (andExprList.length) ret.push(include(and(...andExprList)));
  return ret;
}
function bindingifyGeneralHookFilter(stringKind, pattern) {
  let filterExprs = generalHookFilterMatcherToFilterExprs(pattern, stringKind);
  let ret = [];
  if (filterExprs) ret = filterExprs.map(bindingifyFilterExpr);
  return ret.length > 0 ? { value: ret } : void 0;
}
function bindingifyFilterExpr(expr) {
  let list2 = [];
  bindingifyFilterExprImpl(expr, list2);
  return list2;
}
function containsImporterId(expr) {
  switch (expr.kind) {
    case "and":
    case "or":
      return expr.args.some(containsImporterId);
    case "not":
    case "include":
    case "exclude":
      return containsImporterId(expr.expr);
    case "importerId":
      return true;
    default:
      return false;
  }
}
function assertNoImporterId(filterExprs, hookName) {
  if (filterExprs?.some(containsImporterId)) throw new Error(`The \`importerId\` filter can only be used with the \`resolveId\` hook, but it was used with the \`${hookName}\` hook.`);
}
function containsStringId(expr) {
  switch (expr.kind) {
    case "and":
    case "or":
      return expr.args.some(containsStringId);
    case "not":
    case "include":
    case "exclude":
      return containsStringId(expr.expr);
    case "id":
      return typeof expr.pattern === "string";
    default:
      return false;
  }
}
function assertNoStringId(filterExprs, hookName) {
  if (filterExprs?.some(containsStringId)) throw new Error(`A string \`id\` filter is not supported for the \`${hookName}\` hook, because its \`id\` is the import specifier rather than a resolved path. Use a RegExp instead.`);
}
function bindingifyFilterExprImpl(expr, list2) {
  switch (expr.kind) {
    case "and": {
      let args2 = expr.args;
      for (let i2 = args2.length - 1; i2 >= 0; i2--) bindingifyFilterExprImpl(args2[i2], list2);
      list2.push({
        kind: "And",
        payload: args2.length
      });
      break;
    }
    case "or": {
      let args2 = expr.args;
      for (let i2 = args2.length - 1; i2 >= 0; i2--) bindingifyFilterExprImpl(args2[i2], list2);
      list2.push({
        kind: "Or",
        payload: args2.length
      });
      break;
    }
    case "not":
      bindingifyFilterExprImpl(expr.expr, list2);
      list2.push({ kind: "Not" });
      break;
    case "id":
      list2.push({
        kind: "Id",
        payload: expr.pattern
      });
      if (expr.params.cleanUrl) list2.push({ kind: "CleanUrl" });
      break;
    case "importerId":
      list2.push({
        kind: "ImporterId",
        payload: expr.pattern
      });
      if (expr.params.cleanUrl) list2.push({ kind: "CleanUrl" });
      break;
    case "moduleType":
      list2.push({
        kind: "ModuleType",
        payload: expr.pattern
      });
      break;
    case "code":
      list2.push({
        kind: "Code",
        payload: expr.pattern
      });
      break;
    case "include":
      bindingifyFilterExprImpl(expr.expr, list2);
      list2.push({ kind: "Include" });
      break;
    case "exclude":
      bindingifyFilterExprImpl(expr.expr, list2);
      list2.push({ kind: "Exclude" });
      break;
    case "query":
      list2.push({
        kind: "QueryKey",
        payload: expr.key
      });
      list2.push({
        kind: "QueryValue",
        payload: expr.pattern
      });
      break;
    default:
      throw new Error(`Unknown filter expression: ${expr}`);
  }
}
function bindingifyResolveIdFilter(filterOption) {
  if (!filterOption) return;
  const filterExprs = Array.isArray(filterOption) ? filterOption : filterOption.id ? generalHookFilterMatcherToFilterExprs(filterOption.id, "id") : void 0;
  assertNoStringId(filterExprs, "resolveId");
  if (!filterExprs) return;
  const value = filterExprs.map(bindingifyFilterExpr);
  return value.length > 0 ? { value } : void 0;
}
function bindingifyLoadFilter(filterOption) {
  if (!filterOption) return;
  if (Array.isArray(filterOption)) {
    assertNoImporterId(filterOption, "load");
    return { value: filterOption.map(bindingifyFilterExpr) };
  }
  return filterOption.id ? bindingifyGeneralHookFilter("id", filterOption.id) : void 0;
}
function bindingifyTransformFilter(filterOption) {
  if (!filterOption) return;
  let filterExprs = transformFilterMatcherToFilterExprs(filterOption);
  assertNoImporterId(filterExprs, "transform");
  let ret = [];
  if (filterExprs) ret = filterExprs.map(bindingifyFilterExpr);
  return { value: ret.length > 0 ? ret : void 0 };
}
function bindingifyRenderChunkFilter(filterOption) {
  if (!filterOption) return;
  if (Array.isArray(filterOption)) {
    assertNoImporterId(filterOption, "renderChunk");
    return { value: filterOption.map(bindingifyFilterExpr) };
  }
  return filterOption.code ? bindingifyGeneralHookFilter("code", filterOption.code) : void 0;
}
function bindingifyPluginHookMeta(options) {
  return { order: bindingPluginOrder(options.order) };
}
function bindingPluginOrder(order) {
  switch (order) {
    case "post":
      return import_binding3.BindingPluginOrder.Post;
    case "pre":
      return import_binding3.BindingPluginOrder.Pre;
    case null:
    case void 0:
      return;
    default:
      throw new Error(`Unknown plugin order: ${order}`);
  }
}
function bindingifyHook(hook, build3) {
  if (!hook) return {};
  const normalized = normalizeHook(hook);
  return {
    ...build3(normalized),
    meta: bindingifyPluginHookMeta(normalized.meta)
  };
}
var fsModule = {
  appendFile: shims_default.appendFile,
  copyFile: shims_default.copyFile,
  mkdir: shims_default.mkdir,
  mkdtemp: shims_default.mkdtemp,
  readdir: shims_default.readdir,
  readFile: shims_default.readFile,
  realpath: shims_default.realpath,
  rename: shims_default.rename,
  rmdir: shims_default.rmdir,
  stat: shims_default.stat,
  lstat: shims_default.lstat,
  unlink: shims_default.unlink,
  writeFile: shims_default.writeFile
};
var PluginContextImpl = class extends MinimalPluginContextImpl {
  outputOptions;
  context;
  data;
  onLog;
  currentLoadingModule;
  fs = fsModule;
  getModuleInfo;
  constructor(outputOptions, context, plugin, data, onLog, logLevel, watchMode, currentLoadingModule) {
    super(onLog, logLevel, plugin.name, watchMode);
    this.outputOptions = outputOptions;
    this.context = context;
    this.data = data;
    this.onLog = onLog;
    this.currentLoadingModule = currentLoadingModule;
    this.getModuleInfo = (id2) => this.data.getModuleInfo(id2, context);
  }
  async load(options) {
    const id2 = options.id;
    if (id2 === this.currentLoadingModule) this.onLog(LOG_LEVEL_WARN, logCycleLoading(this.pluginName, this.currentLoadingModule));
    const moduleInfo = this.data.getModuleInfo(id2, this.context);
    if (moduleInfo && moduleInfo.code !== null) return moduleInfo;
    const rawOptions = {
      meta: options.meta || {},
      moduleSideEffects: options.moduleSideEffects || null,
      invalidate: false
    };
    this.data.updateModuleOption(id2, rawOptions);
    let loadPromise = this.data.loadModulePromiseMap.get(id2);
    if (!loadPromise) {
      loadPromise = this.context.load(id2, options.moduleSideEffects ?? void 0, options.packageJsonPath ?? void 0).catch(() => {
        this.data.loadModulePromiseMap.delete(id2);
      });
      this.data.loadModulePromiseMap.set(id2, loadPromise);
    }
    await loadPromise;
    return this.data.getModuleInfo(id2, this.context);
  }
  async resolve(source, importer, options) {
    let receipt = void 0;
    if (options != null) receipt = this.data.saveResolveOptions(options);
    const vitePluginCustom = Object.entries(options?.custom ?? {}).reduce((acc, [key, value]) => {
      if (key.startsWith("vite:")) (acc ??= {})[key] = value;
      return acc;
    }, void 0);
    const res = await this.context.resolve(source, importer, {
      importKind: options?.kind,
      custom: receipt,
      isEntry: options?.isEntry,
      skipSelf: options?.skipSelf,
      vitePluginCustom
    });
    if (receipt != null) this.data.removeSavedResolveOptions(receipt);
    if (res == null) return null;
    const info = this.data.getModuleOption(res.id) || {};
    return {
      ...res,
      external: res.external === "relative" ? unreachable(`The PluginContext resolve result external couldn't be 'relative'`) : res.external,
      ...info,
      moduleSideEffects: info.moduleSideEffects ?? res.moduleSideEffects ?? null,
      packageJsonPath: res.packageJsonPath
    };
  }
  emitFile = (file) => {
    if (file.type === "prebuilt-chunk") {
      if (typeof file.code !== "string") return error(logFailedValidation(`Emitted prebuilt chunks need to have a valid string code, received "${file.code}".`));
      if (typeof file.fileName !== "string" || isPathFragment(file.fileName)) return error(logFailedValidation(`The "fileName" property of emitted prebuilt chunks must be strings that are neither absolute nor relative paths, received "${file.fileName}".`));
      return this.context.emitPrebuiltChunk({
        fileName: file.fileName,
        name: file.name,
        code: file.code,
        exports: file.exports,
        map: bindingifySourcemap(file.map),
        sourcemapFileName: file.sourcemapFileName,
        facadeModuleId: file.facadeModuleId,
        isEntry: file.isEntry,
        isDynamicEntry: file.isDynamicEntry
      });
    }
    const validatedName = file.fileName || file.name;
    if (typeof validatedName === "string" && isPathFragment(validatedName)) return error(logFailedValidation(`The "fileName" or "name" properties of emitted chunks and assets must be strings that are neither absolute nor relative paths, received "${validatedName}".`));
    if (file.type === "chunk") return this.context.emitChunk({
      preserveEntrySignatures: bindingifyPreserveEntrySignatures(file.preserveSignature),
      ...file
    });
    const fnSanitizedFileName = file.fileName || typeof this.outputOptions.sanitizeFileName !== "function" ? void 0 : this.outputOptions.sanitizeFileName(file.name || "asset");
    const filename = file.fileName ? void 0 : this.getAssetFileNames(file);
    return this.context.emitFile({
      ...file,
      originalFileName: file.originalFileName || void 0,
      source: bindingAssetSource(file.source)
    }, filename, fnSanitizedFileName);
  };
  getAssetFileNames(file) {
    if (typeof this.outputOptions.assetFileNames === "function") return this.outputOptions.assetFileNames({
      type: "asset",
      name: file.name,
      names: file.name ? [file.name] : [],
      originalFileName: file.originalFileName,
      originalFileNames: file.originalFileName ? [file.originalFileName] : [],
      source: file.source
    });
  }
  getFileName(referenceId) {
    return this.context.getFileName(referenceId);
  }
  getModuleIds() {
    return this.data.getModuleIds(this.context);
  }
  addWatchFile(id2) {
    this.context.addWatchFile(id2);
  }
  parse(input, options) {
    return parseAst(input, options);
  }
};
function createPluginContext(args2, ctx) {
  return new PluginContextImpl(args2.outputOptions, ctx, args2.plugin, args2.pluginContextData, args2.onLog, args2.logLevel, args2.watchMode);
}
var LoadPluginContextImpl = class extends PluginContextImpl {
  inner;
  constructor(outputOptions, context, plugin, data, inner, moduleId, onLog, logLevelOption, watchMode) {
    super(outputOptions, context, plugin, data, onLog, logLevelOption, watchMode, moduleId);
    this.inner = inner;
  }
  addWatchFile(id2) {
    this.inner.addWatchFile(id2);
  }
};
var TransformPluginContextImpl = class extends PluginContextImpl {
  inner;
  moduleId;
  moduleSource;
  constructor(outputOptions, context, plugin, data, inner, moduleId, moduleSource, onLog, LogLevelOption, watchMode) {
    super(outputOptions, context, plugin, data, onLog, LogLevelOption, watchMode, moduleId);
    this.inner = inner;
    this.moduleId = moduleId;
    this.moduleSource = moduleSource;
    const getLogHandler2 = (handler) => (log, pos) => {
      log = normalizeLog(log);
      if (pos) augmentCodeLocation(log, pos, moduleSource, moduleId);
      log.id = moduleId;
      log.hook = "transform";
      handler(log);
    };
    this.debug = getLogHandler2(this.debug);
    this.warn = getLogHandler2(this.warn);
    this.info = getLogHandler2(this.info);
  }
  error(e3, pos) {
    if (typeof e3 === "string") e3 = { message: e3 };
    if (pos) augmentCodeLocation(e3, pos, this.moduleSource, this.moduleId);
    e3.id = this.moduleId;
    e3.hook = "transform";
    return error(logPluginError(normalizeLog(e3), this.pluginName));
  }
  getCombinedSourcemap() {
    return JSON.parse(this.inner.getCombinedSourcemap());
  }
  addWatchFile(id2) {
    this.inner.addWatchFile(id2);
  }
  sendMagicString(s2) {
    this.inner.sendMagicString(s2);
  }
};
function bindingifyBuildStart(args2) {
  return bindingifyHook(args2.plugin.buildStart, ({ handler }) => ({ plugin: async (ctx, opts) => {
    await handler.call(createPluginContext(args2, ctx), args2.pluginContextData.getInputOptions(opts));
  } }));
}
function bindingifyBuildEnd(args2) {
  return bindingifyHook(args2.plugin.buildEnd, ({ handler }) => ({ plugin: async (ctx, err) => {
    await handler.call(createPluginContext(args2, ctx), err ? aggregateBindingErrorsIntoJsError(err) : void 0);
  } }));
}
function bindingifyResolveId(args2) {
  const hook = args2.plugin.resolveId;
  return bindingifyHook(hook, ({ handler, options }) => ({
    plugin: async (ctx, specifier, importer, extraOptions) => {
      const contextResolveOptions = extraOptions.custom != null ? args2.pluginContextData.getSavedResolveOptions(extraOptions.custom) : void 0;
      const ret = await handler.call(createPluginContext(args2, ctx), specifier, importer ?? void 0, {
        ...extraOptions,
        custom: contextResolveOptions?.custom
      });
      if (ret == null) return;
      if (ret === false) return {
        id: specifier,
        external: true,
        normalizeExternalId: true
      };
      if (typeof ret === "string") return {
        id: ret,
        normalizeExternalId: false
      };
      let exist = args2.pluginContextData.updateModuleOption(ret.id, {
        meta: ret.meta || {},
        moduleSideEffects: ret.moduleSideEffects ?? null,
        invalidate: false
      });
      return {
        id: ret.id,
        external: ret.external,
        normalizeExternalId: false,
        moduleSideEffects: exist.moduleSideEffects ?? void 0,
        packageJsonPath: ret.packageJsonPath
      };
    },
    filter: bindingifyResolveIdFilter(options.filter)
  }));
}
function bindingifyResolveDynamicImport(args2) {
  return bindingifyHook(args2.plugin.resolveDynamicImport, ({ handler }) => ({ plugin: async (ctx, specifier, importer) => {
    const ret = await handler.call(createPluginContext(args2, ctx), specifier, importer ?? void 0);
    if (ret == null) return;
    if (ret === false) return {
      id: specifier,
      external: true
    };
    if (typeof ret === "string") return { id: ret };
    const result = {
      id: ret.id,
      external: ret.external,
      packageJsonPath: ret.packageJsonPath
    };
    if (ret.moduleSideEffects !== null) result.moduleSideEffects = ret.moduleSideEffects;
    args2.pluginContextData.updateModuleOption(ret.id, {
      meta: ret.meta || {},
      moduleSideEffects: ret.moduleSideEffects || null,
      invalidate: false
    });
    return result;
  } }));
}
function bindingifyTransform(args2) {
  return bindingifyHook(args2.plugin.transform, ({ handler, options }) => ({
    plugin: async (ctx, code3, id2, meta) => {
      let magicStringInstance, astInstance;
      Object.defineProperties(meta, {
        magicString: { get() {
          if (magicStringInstance) return magicStringInstance;
          magicStringInstance = new RolldownMagicString(code3);
          return magicStringInstance;
        } },
        ast: { get() {
          if (astInstance) return astInstance;
          let lang = "js";
          switch (meta.moduleType) {
            case "js":
            case "jsx":
            case "ts":
            case "tsx":
              lang = meta.moduleType;
          }
          astInstance = parseAst(code3, {
            astType: meta.moduleType.includes("ts") ? "ts" : "js",
            lang
          });
          return astInstance;
        } }
      });
      const transformCtx = new TransformPluginContextImpl(args2.outputOptions, ctx.inner(), args2.plugin, args2.pluginContextData, ctx, id2, code3, args2.onLog, args2.logLevel, args2.watchMode);
      const ret = await handler.call(transformCtx, code3, id2, meta);
      if (ret == null) return;
      if (typeof ret === "string") return { code: ret };
      let moduleOption = args2.pluginContextData.updateModuleOption(id2, {
        meta: ret.meta ?? {},
        moduleSideEffects: ret.moduleSideEffects ?? null,
        invalidate: false
      });
      let normalizedCode = void 0;
      let map = ret.map;
      let mapHandledByNativeChannel = false;
      if (typeof ret.code === "string") normalizedCode = ret.code;
      else if (ret.code instanceof RolldownMagicString) {
        let magicString = ret.code;
        normalizedCode = magicString.toString();
        let fallbackSourcemap = ctx.sendMagicString(magicString);
        if (fallbackSourcemap != void 0) map = fallbackSourcemap;
        else mapHandledByNativeChannel = true;
      }
      return {
        code: normalizedCode,
        map: bindingifySourcemap(normalizeTransformHookSourcemap(id2, code3, map)) ?? (mapHandledByNativeChannel || ret.map === null ? null : void 0),
        moduleSideEffects: moduleOption.moduleSideEffects ?? void 0,
        moduleType: ret.moduleType
      };
    },
    filter: bindingifyTransformFilter(options.filter)
  }));
}
function bindingifyLoad(args2) {
  return bindingifyHook(args2.plugin.load, ({ handler, options }) => ({
    plugin: async (ctx, id2) => {
      const ret = await handler.call(new LoadPluginContextImpl(args2.outputOptions, ctx.inner(), args2.plugin, args2.pluginContextData, ctx, id2, args2.onLog, args2.logLevel, args2.watchMode), id2);
      if (ret == null) return;
      if (typeof ret === "string") return { code: ret };
      let moduleOption = args2.pluginContextData.updateModuleOption(id2, {
        meta: ret.meta || {},
        moduleSideEffects: ret.moduleSideEffects ?? null,
        invalidate: false
      });
      let map = preProcessSourceMap(ret, id2);
      return {
        code: ret.code,
        map: bindingifySourcemap(map),
        moduleType: ret.moduleType,
        moduleSideEffects: moduleOption.moduleSideEffects ?? void 0
      };
    },
    filter: bindingifyLoadFilter(options.filter)
  }));
}
function preProcessSourceMap(ret, id2) {
  if (!ret.map) return;
  let map = typeof ret.map === "object" ? ret.map : JSON.parse(ret.map);
  if (!isEmptySourcemapFiled(map.sources)) {
    const directory = path.dirname(id2) || ".";
    const sourceRoot = map.sourceRoot || ".";
    map.sources = map.sources.map((source) => path.resolve(directory, sourceRoot, source));
  }
  return map;
}
function bindingifyModuleParsed(args2) {
  return bindingifyHook(args2.plugin.moduleParsed, ({ handler }) => ({ plugin: async (ctx, moduleInfo) => {
    await handler.call(createPluginContext(args2, ctx), transformModuleInfo(moduleInfo, args2.pluginContextData.getModuleOption(moduleInfo.id)));
  } }));
}
function bindingifyRenderStart(args2) {
  return bindingifyHook(args2.plugin.renderStart, ({ handler }) => ({ plugin: async (ctx, opts) => {
    await handler.call(createPluginContext(args2, ctx), args2.pluginContextData.getOutputOptions(opts), args2.pluginContextData.getInputOptions(opts));
  } }));
}
function bindingifyRenderChunk(args2) {
  return bindingifyHook(args2.plugin.renderChunk, ({ handler, options }) => ({
    plugin: async (ctx, code3, chunk, opts, meta) => {
      if (args2.pluginContextData.getRenderChunkMeta() == null) args2.pluginContextData.setRenderChunkMeta({ chunks: Object.fromEntries(Object.entries(meta.chunks).map(([key, value]) => [key, transformRenderedChunk(value)])) });
      const renderChunkMeta = args2.pluginContextData.getRenderChunkMeta();
      let magicStringInstance;
      if (args2.options.experimental?.nativeMagicString) Object.defineProperty(renderChunkMeta, "magicString", {
        get() {
          if (magicStringInstance) return magicStringInstance;
          magicStringInstance = new RolldownMagicString(code3);
          return magicStringInstance;
        },
        configurable: true
      });
      const ret = await handler.call(createPluginContext(args2, ctx), code3, transformRenderedChunk(chunk), args2.pluginContextData.getOutputOptions(opts), renderChunkMeta);
      if (ret == null) return;
      if (ret instanceof RolldownMagicString) {
        const normalizedCode = ret.toString();
        const generatedMap = ret.generateMap();
        return {
          code: normalizedCode,
          map: bindingifySourcemap({
            file: generatedMap.file,
            mappings: generatedMap.mappings,
            names: generatedMap.names,
            sources: generatedMap.sources,
            sourcesContent: generatedMap.sourcesContent.map((s2) => s2 ?? null)
          })
        };
      }
      if (typeof ret === "string") return { code: ret };
      if (ret.code instanceof RolldownMagicString) {
        const magicString = ret.code;
        const normalizedCode = magicString.toString();
        if (ret.map === null) return {
          code: normalizedCode,
          map: null
        };
        if (ret.map === void 0) {
          const generatedMap = magicString.generateMap();
          return {
            code: normalizedCode,
            map: bindingifySourcemap({
              file: generatedMap.file,
              mappings: generatedMap.mappings,
              names: generatedMap.names,
              sources: generatedMap.sources,
              sourcesContent: generatedMap.sourcesContent.map((s2) => s2 ?? null)
            })
          };
        }
        return {
          code: normalizedCode,
          map: bindingifySourcemap(ret.map)
        };
      }
      if (ret.map === null) return {
        code: ret.code,
        map: null
      };
      return {
        code: ret.code,
        map: bindingifySourcemap(ret.map)
      };
    },
    filter: bindingifyRenderChunkFilter(options.filter)
  }));
}
function bindingifyAugmentChunkHash(args2) {
  return bindingifyHook(args2.plugin.augmentChunkHash, ({ handler }) => ({ plugin: async (ctx, chunk) => {
    return handler.call(createPluginContext(args2, ctx), transformRenderedChunk(chunk));
  } }));
}
function bindingifyResolveFileUrl(args2) {
  return bindingifyHook(args2.plugin.resolveFileUrl, ({ handler }) => ({ plugin: async (ctx, resolveFileUrlArgs) => {
    return handler.call(createPluginContext(args2, ctx), resolveFileUrlArgs);
  } }));
}
function bindingifyRenderError(args2) {
  return bindingifyHook(args2.plugin.renderError, ({ handler }) => ({ plugin: async (ctx, err) => {
    await handler.call(createPluginContext(args2, ctx), aggregateBindingErrorsIntoJsError(err));
  } }));
}
function createOutputBundle(args2, ctx, bundle) {
  const changed = {
    updated: /* @__PURE__ */ new Set(),
    deleted: /* @__PURE__ */ new Set()
  };
  const context = createPluginContext(args2, ctx);
  return {
    changed,
    context,
    output: transformToOutputBundle(context, unwrapBindingResult(bundle), changed)
  };
}
function bindingifyGenerateBundle(args2) {
  return bindingifyHook(args2.plugin.generateBundle, ({ handler }) => ({ plugin: async (ctx, bundle, isWrite, opts) => {
    const { changed, context, output } = createOutputBundle(args2, ctx, bundle);
    await handler.call(context, args2.pluginContextData.getOutputOptions(opts), output, isWrite);
    return collectChangedBundle(changed, output);
  } }));
}
function bindingifyWriteBundle(args2) {
  return bindingifyHook(args2.plugin.writeBundle, ({ handler }) => ({ plugin: async (ctx, bundle, opts) => {
    const { changed, context, output } = createOutputBundle(args2, ctx, bundle);
    await handler.call(context, args2.pluginContextData.getOutputOptions(opts), output);
    return collectChangedBundle(changed, output);
  } }));
}
function bindingifyCloseBundle(args2) {
  return bindingifyHook(args2.plugin.closeBundle, ({ handler }) => ({ plugin: async (ctx, err) => {
    await handler.call(createPluginContext(args2, ctx), err ? aggregateBindingErrorsIntoJsError(err) : void 0);
  } }));
}
function bindingifyAddonHook(args2, name50) {
  return bindingifyHook(args2.plugin[name50], ({ handler }) => ({ plugin: async (ctx, chunk) => {
    if (typeof handler === "string") return handler;
    return handler.call(createPluginContext(args2, ctx), transformRenderedChunk(chunk));
  } }));
}
function bindingifyHotUpdate(args2) {
  return bindingifyHook(args2.plugin.hotUpdate, ({ handler }) => ({ plugin: async (ctx, hookArgs) => {
    return await handler.call(createPluginContext(args2, ctx), {
      type: hookArgs.kind,
      file: hookArgs.file,
      modules: hookArgs.modules
    }) ?? void 0;
  } }));
}
function bindingifyWatchChange(args2) {
  return bindingifyHook(args2.plugin.watchChange, ({ handler }) => ({ plugin: async (ctx, id2, event) => {
    await handler.call(createPluginContext(args2, ctx), id2, { event });
  } }));
}
function bindingifyCloseWatcher(args2) {
  return bindingifyHook(args2.plugin.closeWatcher, ({ handler }) => ({ plugin: async (ctx) => {
    await handler.call(createPluginContext(args2, ctx));
  } }));
}
var HookUsage = class {
  bitflag = BigInt(0);
  constructor() {
  }
  union(kind) {
    this.bitflag |= BigInt(kind);
  }
  inner() {
    return Number(this.bitflag);
  }
};
function extractHookUsage(plugin) {
  let hookUsage = new HookUsage();
  if (plugin.buildStart) hookUsage.union(1);
  if (plugin.resolveId) hookUsage.union(2);
  if (plugin.resolveDynamicImport) hookUsage.union(4);
  if (plugin.load) hookUsage.union(8);
  if (plugin.transform) hookUsage.union(16);
  if (plugin.moduleParsed) hookUsage.union(32);
  if (plugin.buildEnd) hookUsage.union(64);
  if (plugin.renderStart) hookUsage.union(128);
  if (plugin.renderError) hookUsage.union(256);
  if (plugin.renderChunk) hookUsage.union(512);
  if (plugin.augmentChunkHash) hookUsage.union(1024);
  if (plugin.generateBundle) hookUsage.union(2048);
  if (plugin.writeBundle) hookUsage.union(4096);
  if (plugin.closeBundle) hookUsage.union(8192);
  if (plugin.watchChange) hookUsage.union(16384);
  if (plugin.closeWatcher) hookUsage.union(32768);
  if (plugin.banner) hookUsage.union(131072);
  if (plugin.footer) hookUsage.union(262144);
  if (plugin.intro) hookUsage.union(524288);
  if (plugin.outro) hookUsage.union(1048576);
  if (plugin.resolveFileUrl) hookUsage.union(2097152);
  if (plugin.hotUpdate) hookUsage.union(4194304);
  return hookUsage;
}
var OVERLAP_TOLERANCE = 0.01;
var recorders = /* @__PURE__ */ new WeakMap();
function pluginTimingsRecorderFor(key) {
  let recorder = recorders.get(key);
  if (recorder === void 0) {
    recorder = {
      costs: /* @__PURE__ */ new Map(),
      warnedMissingGroupLabels: /* @__PURE__ */ new Set(),
      busyMs: 0,
      inFlight: 0,
      busyStart: 0
    };
    recorders.set(key, recorder);
  }
  return recorder;
}
function costFor(recorder, owner, hookName) {
  let byHook = recorder.costs.get(owner.key);
  if (byHook === void 0) {
    byHook = /* @__PURE__ */ new Map();
    recorder.costs.set(owner.key, byHook);
  }
  let cost = byHook.get(hookName);
  if (cost === void 0) {
    cost = {
      owner: owner.name,
      kind: owner.kind,
      hookName,
      calls: 0,
      ms: 0,
      inFlight: 0,
      maxInFlight: 0,
      overlapMs: 0,
      lastChange: 0
    };
    byHook.set(hookName, cost);
  }
  return cost;
}
function markInFlightChange(cost, at) {
  if (cost.inFlight > 1) cost.overlapMs += (cost.inFlight - 1) * (at - cost.lastChange);
  cost.lastChange = at;
}
function settle(recorder, cost, started) {
  const ended = performance.now();
  markInFlightChange(cost, ended);
  cost.inFlight -= 1;
  cost.ms += ended - started;
  recorder.inFlight -= 1;
  if (recorder.inFlight === 0) recorder.busyMs += ended - recorder.busyStart;
}
function measureHookCost(recorder, owner, hookName, handler) {
  if (recorder === void 0) return handler;
  const cost = costFor(recorder, owner, hookName);
  return function(...args2) {
    const started = performance.now();
    markInFlightChange(cost, started);
    cost.calls += 1;
    cost.inFlight += 1;
    if (cost.inFlight > cost.maxInFlight) cost.maxInFlight = cost.inFlight;
    if (recorder.inFlight === 0) recorder.busyStart = started;
    recorder.inFlight += 1;
    let result;
    try {
      result = handler.apply(this, args2);
    } catch (error2) {
      settle(recorder, cost, started);
      throw error2;
    }
    if (typeof result?.then === "function") return result.then((value) => {
      settle(recorder, cost, started);
      return value;
    }, (error2) => {
      settle(recorder, cost, started);
      throw error2;
    });
    settle(recorder, cost, started);
    return result;
  };
}
var OUTPUT_OPTIONS_OWNER = {
  key: /* @__PURE__ */ Symbol("output options"),
  name: "output options",
  kind: "outputOption"
};
var INPUT_OPTIONS_OWNER = {
  key: /* @__PURE__ */ Symbol("input options"),
  name: "input options",
  kind: "inputOption"
};
function measureIfFunction(recorder, owner, hookName, value) {
  if (typeof value !== "function") return value;
  return measureHookCost(recorder, owner, hookName, value);
}
function summarizePluginTimings(key) {
  const recorder = recorders.get(key);
  if (recorder === void 0) return {
    busyMs: 0,
    rows: []
  };
  const rows = [];
  for (const byHook of recorder.costs.values()) for (const cost of byHook.values()) {
    if (cost.calls === 0) continue;
    rows.push({
      owner: cost.owner,
      kind: cost.kind,
      hook: cost.hookName,
      calls: cost.calls,
      ms: cost.ms,
      maxInFlight: cost.maxInFlight,
      overlapMs: cost.overlapMs,
      rankable: cost.overlapMs <= cost.ms * OVERLAP_TOLERANCE
    });
  }
  return {
    busyMs: recorder.busyMs,
    rows
  };
}
function bindingifyPlugin(plugin, options, outputOptions, pluginContextData, normalizedOutputPlugins, onLog, logLevel, watchMode, timings) {
  const args2 = {
    plugin,
    options,
    outputOptions,
    pluginContextData,
    onLog,
    logLevel,
    watchMode,
    normalizedOutputPlugins
  };
  const { plugin: buildStart, meta: buildStartMeta } = bindingifyBuildStart(args2);
  const { plugin: resolveId, meta: resolveIdMeta, filter: resolveIdFilter } = bindingifyResolveId(args2);
  const { plugin: resolveDynamicImport, meta: resolveDynamicImportMeta } = bindingifyResolveDynamicImport(args2);
  const { plugin: buildEnd, meta: buildEndMeta } = bindingifyBuildEnd(args2);
  const { plugin: transform2, meta: transformMeta, filter: transformFilter } = bindingifyTransform(args2);
  const { plugin: moduleParsed, meta: moduleParsedMeta } = bindingifyModuleParsed(args2);
  const { plugin: load2, meta: loadMeta, filter: loadFilter } = bindingifyLoad(args2);
  const { plugin: renderChunk, meta: renderChunkMeta, filter: renderChunkFilter } = bindingifyRenderChunk(args2);
  const { plugin: augmentChunkHash, meta: augmentChunkHashMeta } = bindingifyAugmentChunkHash(args2);
  const { plugin: resolveFileUrl, meta: resolveFileUrlMeta } = bindingifyResolveFileUrl(args2);
  const { plugin: renderStart, meta: renderStartMeta } = bindingifyRenderStart(args2);
  const { plugin: renderError, meta: renderErrorMeta } = bindingifyRenderError(args2);
  const { plugin: generateBundle, meta: generateBundleMeta } = bindingifyGenerateBundle(args2);
  const { plugin: writeBundle, meta: writeBundleMeta } = bindingifyWriteBundle(args2);
  const { plugin: closeBundle, meta: closeBundleMeta } = bindingifyCloseBundle(args2);
  const { plugin: banner, meta: bannerMeta } = bindingifyAddonHook(args2, "banner");
  const { plugin: footer, meta: footerMeta } = bindingifyAddonHook(args2, "footer");
  const { plugin: intro, meta: introMeta } = bindingifyAddonHook(args2, "intro");
  const { plugin: outro, meta: outroMeta } = bindingifyAddonHook(args2, "outro");
  const { plugin: watchChange, meta: watchChangeMeta } = bindingifyWatchChange(args2);
  const { plugin: hotUpdate, meta: hotUpdateMeta } = bindingifyHotUpdate(args2);
  const { plugin: closeWatcher, meta: closeWatcherMeta } = bindingifyCloseWatcher(args2);
  let hookUsage = extractHookUsage(plugin).inner();
  const result = {
    name: plugin.name,
    buildStart,
    buildStartMeta,
    resolveId,
    resolveIdMeta,
    resolveIdFilter,
    resolveDynamicImport,
    resolveDynamicImportMeta,
    buildEnd,
    buildEndMeta,
    transform: transform2,
    transformMeta,
    transformFilter,
    moduleParsed,
    moduleParsedMeta,
    load: load2,
    loadMeta,
    loadFilter,
    renderChunk,
    renderChunkMeta,
    renderChunkFilter,
    augmentChunkHash,
    augmentChunkHashMeta,
    resolveFileUrl,
    resolveFileUrlMeta,
    renderStart,
    renderStartMeta,
    renderError,
    renderErrorMeta,
    generateBundle,
    generateBundleMeta,
    writeBundle,
    writeBundleMeta,
    closeBundle,
    closeBundleMeta,
    banner,
    bannerMeta,
    footer,
    footerMeta,
    intro,
    introMeta,
    outro,
    outroMeta,
    watchChange,
    watchChangeMeta,
    hotUpdate,
    hotUpdateMeta,
    closeWatcher,
    closeWatcherMeta,
    hookUsage
  };
  return wrapHandlers(result, {
    key: plugin,
    name: result.name,
    kind: "plugin"
  }, timings);
}
function wrapHandlers(plugin, owner, timings) {
  for (const hookName of [
    "buildStart",
    "resolveId",
    "resolveDynamicImport",
    "buildEnd",
    "transform",
    "moduleParsed",
    "load",
    "renderChunk",
    "augmentChunkHash",
    "resolveFileUrl",
    "renderStart",
    "renderError",
    "generateBundle",
    "writeBundle",
    "closeBundle",
    "banner",
    "footer",
    "intro",
    "outro",
    "watchChange",
    "hotUpdate",
    "closeWatcher"
  ]) {
    const raw = plugin[hookName];
    const handler = raw && measureHookCost(timings, owner, hookName, raw);
    if (handler) plugin[hookName] = async (...args2) => {
      try {
        return await handler(...args2);
      } catch (e3) {
        return error(logPluginError(e3, plugin.name, {
          hook: hookName,
          id: hookName === "transform" ? args2[2] : void 0
        }));
      }
    };
  }
  return plugin;
}
function normalizeTransformOptions(inputOptions) {
  const transform2 = inputOptions.transform;
  const define = transform2?.define ? Object.entries(transform2.define) : void 0;
  const inject = transform2?.inject;
  const dropLabels = transform2?.dropLabels;
  let oxcTransformOptions;
  if (transform2) {
    const { define: _define, inject: _inject, dropLabels: _dropLabels, ...rest } = transform2;
    if (Object.keys(rest).length > 0) {
      if (rest.jsx === false) rest.jsx = "disable";
      oxcTransformOptions = rest;
    }
  }
  return {
    define,
    inject,
    dropLabels,
    oxcTransformOptions
  };
}
function getDefaultDevRuntime(host = "localhost", port = 3e3) {
  const runtimeEntry = shims_default.readFileSync(fileURLToPath(import.meta.resolve("#runtime")), "utf8");
  const runtimeHelperImportEnd = runtimeEntry.indexOf("\n");
  if (!runtimeEntry.startsWith("import ") || runtimeHelperImportEnd === -1) throw new Error("Expected the standalone runtime to start with a helper import");
  return `${runtimeEntry.slice(runtimeHelperImportEnd + 1)}
${shims_default.readFileSync(fileURLToPath(import.meta.resolve("#default-runtime")), "utf8").replaceAll("$ADDR", `${host}:${port}`)}`;
}
function bindingifyInputOptions(rawPlugins, inputOptions, outputOptions, pluginContextData, normalizedOutputPlugins, onLog, logLevel, watchMode, timings) {
  const plugins = rawPlugins.map((plugin) => {
    if (getParallelPluginInfo(plugin)) return;
    if (plugin instanceof BuiltinPlugin) switch (plugin.name) {
      case "builtin:vite-manifest":
        return bindingifyManifestPlugin(plugin, pluginContextData);
      default:
        return bindingifyBuiltInPlugin(plugin);
    }
    return bindingifyPlugin(plugin, inputOptions, outputOptions, pluginContextData, normalizedOutputPlugins, onLog, logLevel, watchMode, timings);
  });
  const normalizedTransform = normalizeTransformOptions(inputOptions);
  return {
    input: bindingifyInput(inputOptions.input),
    plugins,
    cwd: inputOptions.cwd ?? process.cwd(),
    external: bindingifyExternal(inputOptions.external, timings),
    resolve: bindingifyResolve(inputOptions.resolve),
    platform: inputOptions.platform,
    shimMissingExports: inputOptions.shimMissingExports,
    logLevel: bindingifyLogLevel(logLevel),
    onLog,
    treeshake: bindingifyTreeshakeOptions(inputOptions.treeshake, timings),
    moduleTypes: inputOptions.moduleTypes,
    define: normalizedTransform.define,
    inject: bindingifyInject(normalizedTransform.inject),
    experimental: bindingifyExperimental(inputOptions.experimental),
    profilerNames: outputOptions.generatedCode?.profilerNames,
    transform: normalizedTransform.oxcTransformOptions,
    watch: bindingifyWatch(inputOptions.watch),
    dropLabels: normalizedTransform.dropLabels,
    keepNames: outputOptions.keepNames,
    checks: inputOptions.checks,
    pluginTimings: timings ? () => summarizePluginTimings(inputOptions) : void 0,
    deferSyncScanData: () => {
      let ret = [];
      pluginContextData.moduleOptionMap.forEach((value, key) => {
        if (value.invalidate) ret.push({
          id: key,
          sideEffects: value.moduleSideEffects ?? void 0
        });
      });
      return ret;
    },
    makeAbsoluteExternalsRelative: bindingifyMakeAbsoluteExternalsRelative(inputOptions.makeAbsoluteExternalsRelative),
    devtools: inputOptions.devtools,
    invalidateJsSideCache: pluginContextData.clear.bind(pluginContextData),
    preserveEntrySignatures: bindingifyPreserveEntrySignatures(inputOptions.preserveEntrySignatures),
    optimization: inputOptions.optimization,
    context: inputOptions.context,
    tsconfig: inputOptions.resolve?.tsconfigFilename ?? inputOptions.tsconfig
  };
}
function bindingifyDevMode(devMode) {
  if (devMode) {
    if (typeof devMode === "boolean") return devMode ? {
      implement: getDefaultDevRuntime(),
      skipCommonRuntimeInjection: true
    } : void 0;
    const usesDefaultRuntime = devMode.implement == null;
    return {
      ...devMode,
      implement: devMode.implement ?? getDefaultDevRuntime(devMode.host, devMode.port),
      skipCommonRuntimeInjection: usesDefaultRuntime ? true : devMode.skipCommonRuntimeInjection
    };
  }
}
function bindingifyAttachDebugInfo(attachDebugInfo) {
  switch (attachDebugInfo) {
    case void 0:
      return;
    case "full":
      return import_binding3.BindingAttachDebugInfo.Full;
    case "simple":
      return import_binding3.BindingAttachDebugInfo.Simple;
    case "none":
      return import_binding3.BindingAttachDebugInfo.None;
  }
}
function bindingifyExternal(external, timings) {
  if (external) {
    if (typeof external === "function") {
      const measured = measureHookCost(timings, INPUT_OPTIONS_OWNER, "external", external);
      return (id2, importer, isResolved) => {
        if (id2.startsWith("\0")) return false;
        return measured(id2, importer, isResolved) ?? false;
      };
    }
    return arraify(external);
  }
}
function bindingifyExperimental(experimental) {
  let chunkModulesOrder = import_binding3.BindingChunkModuleOrderBy.ExecOrder;
  if (experimental?.chunkModulesOrder) switch (experimental.chunkModulesOrder) {
    case "exec-order":
      chunkModulesOrder = import_binding3.BindingChunkModuleOrderBy.ExecOrder;
      break;
    case "module-id":
      chunkModulesOrder = import_binding3.BindingChunkModuleOrderBy.ModuleId;
      break;
    default:
      throw new Error(`Unexpected chunkModulesOrder: ${experimental.chunkModulesOrder}`);
  }
  return {
    viteMode: experimental?.viteMode,
    resolveNewUrlToAsset: experimental?.resolveNewUrlToAsset,
    devMode: bindingifyDevMode(experimental?.devMode),
    attachDebugInfo: bindingifyAttachDebugInfo(experimental?.attachDebugInfo),
    chunkModulesOrder,
    chunkImportMap: experimental?.chunkImportMap,
    onDemandWrapping: experimental?.onDemandWrapping,
    incrementalBuild: experimental?.incrementalBuild,
    nativeMagicString: experimental?.nativeMagicString,
    chunkOptimization: experimental?.chunkOptimization,
    lazyBarrel: experimental?.lazyBarrel
  };
}
function bindingifyResolve(resolve) {
  const yarnPnp2 = typeof process === "object" && !!process.versions?.pnp;
  if (resolve) {
    const { alias, extensionAlias, ...rest } = resolve;
    return {
      alias: alias ? Object.entries(alias).map(([name50, replacement]) => ({
        find: name50,
        replacements: replacement === false ? [void 0] : arraify(replacement)
      })) : void 0,
      extensionAlias: extensionAlias ? Object.entries(extensionAlias).map(([name50, value]) => ({
        target: name50,
        replacements: value
      })) : void 0,
      yarnPnp: yarnPnp2,
      ...rest
    };
  } else return { yarnPnp: yarnPnp2 };
}
function bindingifyInject(inject) {
  if (inject) return Object.entries(inject).map(([alias, item]) => {
    if (Array.isArray(item)) {
      if (item[1] === "*") return {
        tagNamespace: true,
        alias,
        from: item[0]
      };
      return {
        tagNamed: true,
        alias,
        from: item[0],
        imported: item[1]
      };
    } else return {
      tagNamed: true,
      imported: "default",
      alias,
      from: item
    };
  });
}
function bindingifyLogLevel(logLevel) {
  switch (logLevel) {
    case "silent":
      return import_binding3.BindingLogLevel.Silent;
    case "debug":
      return import_binding3.BindingLogLevel.Debug;
    case "warn":
      return import_binding3.BindingLogLevel.Warn;
    case "info":
      return import_binding3.BindingLogLevel.Info;
    default:
      throw new Error(`Unexpected log level: ${logLevel}`);
  }
}
function bindingifyInput(input) {
  if (input === void 0) return [];
  if (typeof input === "string") return [{ import: input }];
  if (Array.isArray(input)) return input.map((src2) => ({ import: src2 }));
  return Object.entries(input).map(([name50, import_path2]) => {
    return {
      name: name50,
      import: import_path2
    };
  });
}
function bindingifyWatch(watch2) {
  if (watch2) {
    const watcher = watch2.watcher ?? {};
    return {
      buildDelay: watch2.buildDelay,
      skipWrite: watch2.skipWrite,
      usePolling: watcher.usePolling,
      pollInterval: watcher.pollInterval,
      compareContentsForPolling: watcher.compareContentsForPolling,
      useDebounce: watcher.useDebounce,
      debounceDelay: watcher.debounceDelay,
      debounceTickRate: watcher.debounceTickRate,
      include: normalizedStringOrRegex(watch2.include),
      exclude: normalizedStringOrRegex(watch2.exclude),
      onInvalidate: (...args2) => watch2.onInvalidate?.(...args2)
    };
  }
}
function bindingifyTreeshakeOptions(config, timings) {
  if (config === false) return;
  if (config === true || config === void 0) return { moduleSideEffects: true };
  let normalizedConfig = {
    moduleSideEffects: true,
    annotations: config.annotations,
    manualPureFunctions: config.manualPureFunctions,
    unknownGlobalSideEffects: config.unknownGlobalSideEffects,
    invalidImportSideEffects: config.invalidImportSideEffects,
    commonjs: config.commonjs
  };
  switch (config.propertyReadSideEffects) {
    case "always":
      normalizedConfig.propertyReadSideEffects = import_binding3.BindingPropertyReadSideEffects.Always;
      break;
    case false:
      normalizedConfig.propertyReadSideEffects = import_binding3.BindingPropertyReadSideEffects.False;
  }
  switch (config.propertyWriteSideEffects) {
    case "always":
      normalizedConfig.propertyWriteSideEffects = import_binding3.BindingPropertyWriteSideEffects.Always;
      break;
    case false:
      normalizedConfig.propertyWriteSideEffects = import_binding3.BindingPropertyWriteSideEffects.False;
  }
  if (config.moduleSideEffects === void 0) normalizedConfig.moduleSideEffects = true;
  else if (config.moduleSideEffects === "no-external") normalizedConfig.moduleSideEffects = [{
    external: true,
    sideEffects: false
  }, {
    external: false,
    sideEffects: true
  }];
  else normalizedConfig.moduleSideEffects = measureIfFunction(timings, INPUT_OPTIONS_OWNER, "treeshake.moduleSideEffects", config.moduleSideEffects);
  return normalizedConfig;
}
function bindingifyMakeAbsoluteExternalsRelative(makeAbsoluteExternalsRelative) {
  if (makeAbsoluteExternalsRelative === "ifRelativeSource") return { type: "IfRelativeSource" };
  if (typeof makeAbsoluteExternalsRelative === "boolean") return {
    type: "Bool",
    field0: makeAbsoluteExternalsRelative
  };
}
function bindingifyPreserveEntrySignatures(preserveEntrySignatures) {
  if (preserveEntrySignatures == void 0) return;
  else if (typeof preserveEntrySignatures === "string") return {
    type: "String",
    field0: preserveEntrySignatures
  };
  else return {
    type: "Bool",
    field0: preserveEntrySignatures
  };
}

// ../../node_modules/.bun/rolldown@1.2.11/node_modules/rolldown/dist/shared/create-bundler-option-YGKfBl_D.mjs
init_shims();
init_shims();
init_shims();
init_shims();
init_shims();
import path2, { sep } from "node:path";
function getLogger(plugins, onLog, logLevel, watchMode) {
  const minimalPriority = logLevelPriority[logLevel];
  const logger2 = (level, log, skipped = /* @__PURE__ */ new Set()) => {
    if (logLevelPriority[level] < minimalPriority) return;
    for (const plugin of getSortedPlugins("onLog", plugins)) {
      if (skipped.has(plugin)) continue;
      const { onLog: pluginOnLog } = plugin;
      if (pluginOnLog) {
        const getLogHandler2 = (level2) => {
          if (logLevelPriority[level2] < minimalPriority) return () => {
          };
          return (log2) => logger2(level2, normalizeLog(log2), new Set(skipped).add(plugin));
        };
        if (("handler" in pluginOnLog ? pluginOnLog.handler : pluginOnLog).call({
          debug: getLogHandler2("debug"),
          error: (log2) => error(normalizeLog(log2)),
          info: getLogHandler2("info"),
          meta: {
            rollupVersion: "4.23.0",
            rolldownVersion: VERSION,
            watchMode
          },
          warn: getLogHandler2("warn"),
          pluginName: plugin.name || "unknown"
        }, level, log) === false) return;
      }
    }
    onLog(level, log);
  };
  return logger2;
}
var getOnLog = (config, logLevel, printLog = defaultPrintLog) => {
  const { onwarn, onLog } = config;
  const defaultOnLog = getDefaultOnLog(printLog, onwarn);
  if (onLog) {
    const minimalPriority = logLevelPriority[logLevel];
    return (level, log) => onLog(level, addLogToString(log), (level2, handledLog) => {
      if (level2 === "error") return error(normalizeLog(handledLog));
      if (logLevelPriority[level2] >= minimalPriority) defaultOnLog(level2, normalizeLog(handledLog));
    });
  }
  return defaultOnLog;
};
var getDefaultOnLog = (printLog, onwarn) => onwarn ? (level, log) => {
  if (level === "warn") onwarn(addLogToString(log), (warning) => printLog(LOG_LEVEL_WARN, normalizeLog(warning)));
  else printLog(level, log);
} : printLog;
var addLogToString = (log) => {
  Object.defineProperty(log, "toString", {
    value: () => getExtendedLogMessage(log),
    writable: true
  });
  return log;
};
var defaultPrintLog = (level, log) => {
  const message2 = getExtendedLogMessage(log);
  switch (level) {
    case LOG_LEVEL_WARN:
      return console.warn(message2);
    case LOG_LEVEL_DEBUG:
      return console.debug(message2);
    default:
      return console.info(message2);
  }
};
var getExtendedLogMessage = (log) => {
  let prefix = "";
  if (log.plugin) prefix += `(${log.plugin} plugin) `;
  if (log.loc) prefix += `${relativeId(log.loc.file)} (${log.loc.line}:${log.loc.column}) `;
  return prefix + log.message;
};
function relativeId(id2) {
  if (!path2.isAbsolute(id2)) return id2;
  return path2.relative(path2.resolve(), id2);
}
var ENUMERATED_INPUT_PLUGIN_HOOK_NAMES = [
  "options",
  "buildStart",
  "resolveId",
  "load",
  "transform",
  "moduleParsed",
  "buildEnd",
  "onLog",
  "resolveDynamicImport",
  "closeBundle",
  "closeWatcher",
  "watchChange"
];
var ENUMERATED_OUTPUT_PLUGIN_HOOK_NAMES = [
  "augmentChunkHash",
  "outputOptions",
  "renderChunk",
  "renderStart",
  "renderError",
  "writeBundle",
  "generateBundle",
  "resolveFileUrl"
];
var ENUMERATED_PLUGIN_HOOK_NAMES = [
  ...ENUMERATED_INPUT_PLUGIN_HOOK_NAMES,
  ...ENUMERATED_OUTPUT_PLUGIN_HOOK_NAMES,
  "footer",
  "banner",
  "intro",
  "outro"
];
ENUMERATED_PLUGIN_HOOK_NAMES[0], ENUMERATED_PLUGIN_HOOK_NAMES[0], ENUMERATED_PLUGIN_HOOK_NAMES[1], ENUMERATED_PLUGIN_HOOK_NAMES[1], ENUMERATED_PLUGIN_HOOK_NAMES[2], ENUMERATED_PLUGIN_HOOK_NAMES[2], ENUMERATED_PLUGIN_HOOK_NAMES[3], ENUMERATED_PLUGIN_HOOK_NAMES[3], ENUMERATED_PLUGIN_HOOK_NAMES[4], ENUMERATED_PLUGIN_HOOK_NAMES[4], ENUMERATED_PLUGIN_HOOK_NAMES[5], ENUMERATED_PLUGIN_HOOK_NAMES[5], ENUMERATED_PLUGIN_HOOK_NAMES[6], ENUMERATED_PLUGIN_HOOK_NAMES[6], ENUMERATED_PLUGIN_HOOK_NAMES[7], ENUMERATED_PLUGIN_HOOK_NAMES[7], ENUMERATED_PLUGIN_HOOK_NAMES[8], ENUMERATED_PLUGIN_HOOK_NAMES[8], ENUMERATED_PLUGIN_HOOK_NAMES[9], ENUMERATED_PLUGIN_HOOK_NAMES[9], ENUMERATED_PLUGIN_HOOK_NAMES[10], ENUMERATED_PLUGIN_HOOK_NAMES[10], ENUMERATED_PLUGIN_HOOK_NAMES[11], ENUMERATED_PLUGIN_HOOK_NAMES[11], ENUMERATED_PLUGIN_HOOK_NAMES[12], ENUMERATED_PLUGIN_HOOK_NAMES[12], ENUMERATED_PLUGIN_HOOK_NAMES[13], ENUMERATED_PLUGIN_HOOK_NAMES[13], ENUMERATED_PLUGIN_HOOK_NAMES[14], ENUMERATED_PLUGIN_HOOK_NAMES[14], ENUMERATED_PLUGIN_HOOK_NAMES[15], ENUMERATED_PLUGIN_HOOK_NAMES[15], ENUMERATED_PLUGIN_HOOK_NAMES[16], ENUMERATED_PLUGIN_HOOK_NAMES[16], ENUMERATED_PLUGIN_HOOK_NAMES[17], ENUMERATED_PLUGIN_HOOK_NAMES[17], ENUMERATED_PLUGIN_HOOK_NAMES[18], ENUMERATED_PLUGIN_HOOK_NAMES[18], ENUMERATED_PLUGIN_HOOK_NAMES[19], ENUMERATED_PLUGIN_HOOK_NAMES[19], ENUMERATED_PLUGIN_HOOK_NAMES[20], ENUMERATED_PLUGIN_HOOK_NAMES[20], ENUMERATED_PLUGIN_HOOK_NAMES[21], ENUMERATED_PLUGIN_HOOK_NAMES[21], ENUMERATED_PLUGIN_HOOK_NAMES[22], ENUMERATED_PLUGIN_HOOK_NAMES[22], ENUMERATED_PLUGIN_HOOK_NAMES[23], ENUMERATED_PLUGIN_HOOK_NAMES[23];
var INTERNAL_PLUGIN_HOOK_NAMES = ["hotUpdate"];
async function asyncFlatten(array2) {
  do
    array2 = (await Promise.all(array2)).flat(Infinity);
  while (array2.some((v2) => v2?.then));
  return array2;
}
var normalizePluginOption = async (plugins) => (await asyncFlatten([plugins])).filter(Boolean);
function checkOutputPluginOption(plugins, onLog) {
  for (const plugin of plugins) for (const hook of [...ENUMERATED_INPUT_PLUGIN_HOOK_NAMES, ...INTERNAL_PLUGIN_HOOK_NAMES]) if (hook in plugin) {
    delete plugin[hook];
    onLog(LOG_LEVEL_WARN, logInputHookInOutputPlugin(plugin.name, hook));
  }
  return plugins;
}
function normalizePlugins(plugins, anonymousPrefix) {
  for (const [index, plugin] of plugins.entries()) {
    if (getParallelPluginInfo(plugin)) continue;
    if (plugin instanceof BuiltinPlugin) continue;
    const objectPlugin = plugin;
    if (!objectPlugin.name) objectPlugin.name = `${anonymousPrefix}${index + 1}`;
  }
  return plugins;
}
var ANONYMOUS_PLUGIN_PREFIX = "at position ";
var ANONYMOUS_OUTPUT_PLUGIN_PREFIX = "at output position ";
var PluginDriver = class {
  static async callOptionsHook(inputOptions, watchMode = false) {
    const logLevel = inputOptions.logLevel || "info";
    const plugins = getSortedPlugins("options", getObjectPlugins(await normalizePluginOption(inputOptions.plugins)));
    const logger2 = getLogger(plugins, getOnLog(inputOptions, logLevel), logLevel, watchMode);
    for (const plugin of plugins) {
      const name50 = plugin.name || "unknown";
      const options = plugin.options;
      if (options) {
        const { handler } = normalizeHook(options);
        const result = await handler.call(new MinimalPluginContextImpl(logger2, logLevel, name50, watchMode, "onLog"), inputOptions);
        if (result) inputOptions = result;
      }
    }
    return inputOptions;
  }
  static callOutputOptionsHook(rawPlugins, outputOptions, onLog, logLevel, watchMode) {
    const sortedPlugins = getSortedPlugins("outputOptions", getObjectPlugins(rawPlugins));
    for (const plugin of sortedPlugins) {
      const name50 = plugin.name || "unknown";
      const options = plugin.outputOptions;
      if (options) {
        const { handler } = normalizeHook(options);
        const result = handler.call(new MinimalPluginContextImpl(onLog, logLevel, name50, watchMode), outputOptions);
        if (result) outputOptions = result;
      }
    }
    return outputOptions;
  }
};
function getObjectPlugins(plugins) {
  return plugins.filter((plugin) => {
    if (!plugin) return;
    if (getParallelPluginInfo(plugin)) return;
    if (plugin instanceof BuiltinPlugin) return;
    return plugin;
  });
}
function getSortedPlugins(hookName, plugins) {
  const pre = [];
  const normal = [];
  const post = [];
  for (const plugin of plugins) {
    const hook = plugin[hookName];
    if (hook) {
      if (typeof hook === "object") {
        if (hook.order === "pre") {
          pre.push(plugin);
          continue;
        }
        if (hook.order === "post") {
          post.push(plugin);
          continue;
        }
      }
      normal.push(plugin);
    }
  }
  return [
    ...pre,
    ...normal,
    ...post
  ];
}
var DEFAULT_CONFIG = {
  lang: void 0,
  message: void 0,
  abortEarly: void 0,
  abortPipeEarly: void 0
};
// @__NO_SIDE_EFFECTS__
function getGlobalConfig(config$1) {
  if (!config$1 && true) return DEFAULT_CONFIG;
  return {
    lang: config$1?.lang ?? void 0,
    message: config$1?.message,
    abortEarly: config$1?.abortEarly ?? void 0,
    abortPipeEarly: config$1?.abortPipeEarly ?? void 0
  };
}
// @__NO_SIDE_EFFECTS__
function _stringify(input) {
  const type = typeof input;
  if (type === "string") return `"${input}"`;
  if (type === "number" || type === "bigint" || type === "boolean") return `${input}`;
  if (type === "object" || type === "function") return (input && Object.getPrototypeOf(input)?.constructor?.name) ?? "null";
  return type;
}
function _addIssue(context, label, dataset, config$1, other) {
  const input = other && "input" in other ? other.input : dataset.value;
  const expected = other?.expected ?? context.expects ?? null;
  const received = other?.received ?? /* @__PURE__ */ _stringify(input);
  const issue = {
    kind: context.kind,
    type: context.type,
    input,
    expected,
    received,
    message: `Invalid ${label}: ${expected ? `Expected ${expected} but r` : "R"}eceived ${received}`,
    requirement: context.requirement,
    path: other?.path,
    issues: other?.issues,
    lang: config$1.lang,
    abortEarly: config$1.abortEarly,
    abortPipeEarly: config$1.abortPipeEarly
  };
  const isSchema = context.kind === "schema";
  const message$1 = other?.message ?? context.message ?? (context.reference, issue.lang, void 0) ?? (isSchema ? (issue.lang, void 0) : null) ?? config$1.message ?? (issue.lang, void 0);
  if (message$1 !== void 0) issue.message = typeof message$1 === "function" ? message$1(issue) : message$1;
  if (isSchema) dataset.typed = false;
  if (dataset.issues) dataset.issues.push(issue);
  else dataset.issues = [issue];
}
// @__NO_SIDE_EFFECTS__
function _isSameValueZero(value1, value2) {
  return value1 === value2 || Number.isNaN(value1) && Number.isNaN(value2);
}
// @__NO_SIDE_EFFECTS__
function _isValidObjectKey(object$1, key) {
  return Object.prototype.hasOwnProperty.call(object$1, key) && key !== "__proto__" && key !== "prototype" && key !== "constructor";
}
// @__NO_SIDE_EFFECTS__
function _joinExpects(values$1, separator) {
  const list2 = [...new Set(values$1)];
  if (list2.length > 1) return `(${list2.join(` ${separator} `)})`;
  return list2[0] ?? "never";
}
function _standardSchema(schema) {
  schema["~standard"] = {
    version: 1,
    vendor: "valibot",
    validate: (value$1) => schema["~run"]({ value: value$1 }, /* @__PURE__ */ getGlobalConfig())
  };
  return schema;
}
var ValiError = class extends Error {
  /**
  * Creates a Valibot error with useful information.
  *
  * @param issues The error issues.
  */
  constructor(issues) {
    super(issues[0].message);
    this.name = "ValiError";
    this.issues = issues;
  }
};
// @__NO_SIDE_EFFECTS__
function args(schema) {
  return {
    kind: "transformation",
    type: "args",
    reference: args,
    async: false,
    schema,
    "~run"(dataset, config$1) {
      const func = dataset.value;
      dataset.value = (...args_) => {
        const argsDataset = this.schema["~run"]({ value: args_ }, config$1);
        if (argsDataset.issues) throw new ValiError(argsDataset.issues);
        return func(...argsDataset.value);
      };
      return dataset;
    }
  };
}
// @__NO_SIDE_EFFECTS__
function awaitAsync() {
  return {
    kind: "transformation",
    type: "await",
    reference: awaitAsync,
    async: true,
    async "~run"(dataset) {
      dataset.value = await dataset.value;
      return dataset;
    }
  };
}
// @__NO_SIDE_EFFECTS__
function description(description_) {
  return {
    kind: "metadata",
    type: "description",
    reference: description,
    description: description_
  };
}
// @__NO_SIDE_EFFECTS__
function returns(schema) {
  return {
    kind: "transformation",
    type: "returns",
    reference: returns,
    async: false,
    schema,
    "~run"(dataset, config$1) {
      const func = dataset.value;
      dataset.value = (...args_) => {
        const returnsDataset = this.schema["~run"]({ value: func(...args_) }, config$1);
        if (returnsDataset.issues) throw new ValiError(returnsDataset.issues);
        return returnsDataset.value;
      };
      return dataset;
    }
  };
}
// @__NO_SIDE_EFFECTS__
function returnsAsync(schema) {
  return {
    kind: "transformation",
    type: "returns",
    reference: returnsAsync,
    async: false,
    schema,
    "~run"(dataset, config$1) {
      const func = dataset.value;
      dataset.value = async (...args_) => {
        const returnsDataset = await this.schema["~run"]({ value: await func(...args_) }, config$1);
        if (returnsDataset.issues) throw new ValiError(returnsDataset.issues);
        return returnsDataset.value;
      };
      return dataset;
    }
  };
}
var ABORT_EARLY_CONFIG = { abortEarly: true };
// @__NO_SIDE_EFFECTS__
function getFallback(schema, dataset, config$1) {
  return typeof schema.fallback === "function" ? schema.fallback(dataset, config$1) : schema.fallback;
}
// @__NO_SIDE_EFFECTS__
function getDefault(schema, dataset, config$1) {
  return typeof schema.default === "function" ? schema.default(dataset, config$1) : schema.default;
}
// @__NO_SIDE_EFFECTS__
function is(schema, input) {
  return !schema["~run"]({ value: input }, ABORT_EARLY_CONFIG).issues;
}
// @__NO_SIDE_EFFECTS__
function any() {
  return _standardSchema({
    kind: "schema",
    type: "any",
    reference: any,
    expects: "any",
    async: false,
    "~run"(dataset) {
      dataset.typed = true;
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function array(item, message$1) {
  return _standardSchema({
    kind: "schema",
    type: "array",
    reference: array,
    expects: "Array",
    async: false,
    item,
    message: message$1,
    "~run"(dataset, config$1) {
      const input = dataset.value;
      if (Array.isArray(input)) {
        dataset.typed = true;
        dataset.value = [];
        for (let key = 0; key < input.length; key++) {
          const value$1 = input[key];
          const itemDataset = this.item["~run"]({ value: value$1 }, config$1);
          if (itemDataset.issues) {
            const pathItem = {
              type: "array",
              origin: "value",
              input,
              key,
              value: value$1
            };
            for (const issue of itemDataset.issues) {
              if (issue.path) issue.path.unshift(pathItem);
              else issue.path = [pathItem];
              dataset.issues?.push(issue);
            }
            if (!dataset.issues) dataset.issues = itemDataset.issues;
            if (config$1.abortEarly) {
              dataset.typed = false;
              break;
            }
          }
          if (!itemDataset.typed) dataset.typed = false;
          dataset.value.push(itemDataset.value);
        }
      } else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function boolean(message$1) {
  return _standardSchema({
    kind: "schema",
    type: "boolean",
    reference: boolean,
    expects: "boolean",
    async: false,
    message: message$1,
    "~run"(dataset, config$1) {
      if (typeof dataset.value === "boolean") dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function custom(check$1, message$1) {
  return _standardSchema({
    kind: "schema",
    type: "custom",
    reference: custom,
    expects: "unknown",
    async: false,
    check: check$1,
    message: message$1,
    "~run"(dataset, config$1) {
      if (this.check(dataset.value)) dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function function_(message$1) {
  return _standardSchema({
    kind: "schema",
    type: "function",
    reference: function_,
    expects: "Function",
    async: false,
    message: message$1,
    "~run"(dataset, config$1) {
      if (typeof dataset.value === "function") dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function instance(class_, message$1) {
  return _standardSchema({
    kind: "schema",
    type: "instance",
    reference: instance,
    expects: class_.name,
    async: false,
    class: class_,
    message: message$1,
    "~run"(dataset, config$1) {
      if (dataset.value instanceof this.class) dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function literal(literal_, message$1) {
  return _standardSchema({
    kind: "schema",
    type: "literal",
    reference: literal,
    expects: /* @__PURE__ */ _stringify(literal_),
    async: false,
    literal: literal_,
    message: message$1,
    "~run"(dataset, config$1) {
      if (/* @__PURE__ */ _isSameValueZero(dataset.value, this.literal)) dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function never(message$1) {
  return _standardSchema({
    kind: "schema",
    type: "never",
    reference: never,
    expects: "never",
    async: false,
    message: message$1,
    "~run"(dataset, config$1) {
      _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function nullish(wrapped, default_) {
  return _standardSchema({
    kind: "schema",
    type: "nullish",
    reference: nullish,
    expects: `(${wrapped.expects} | null | undefined)`,
    async: false,
    wrapped,
    default: default_,
    "~run"(dataset, config$1) {
      if (dataset.value === null || dataset.value === void 0) {
        if (this.default !== void 0) dataset.value = /* @__PURE__ */ getDefault(this, dataset, config$1);
        if (dataset.value === null || dataset.value === void 0) {
          dataset.typed = true;
          return dataset;
        }
      }
      return this.wrapped["~run"](dataset, config$1);
    }
  });
}
// @__NO_SIDE_EFFECTS__
function number(message$1) {
  return _standardSchema({
    kind: "schema",
    type: "number",
    reference: number,
    expects: "number",
    async: false,
    message: message$1,
    "~run"(dataset, config$1) {
      if (typeof dataset.value === "number" && !isNaN(dataset.value)) dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function object(entries$1, message$1) {
  return _standardSchema({
    kind: "schema",
    type: "object",
    reference: object,
    expects: "Object",
    async: false,
    entries: entries$1,
    message: message$1,
    "~run"(dataset, config$1) {
      const input = dataset.value;
      if (input && typeof input === "object") {
        dataset.typed = true;
        dataset.value = {};
        for (const key in this.entries) {
          const valueSchema = this.entries[key];
          if (key in input || (valueSchema.type === "exact_optional" || valueSchema.type === "optional" || valueSchema.type === "nullish") && valueSchema.default !== void 0) {
            const value$1 = key in input ? input[key] : /* @__PURE__ */ getDefault(valueSchema);
            const valueDataset = valueSchema["~run"]({ value: value$1 }, config$1);
            if (valueDataset.issues) {
              const pathItem = {
                type: "object",
                origin: "value",
                input,
                key,
                value: value$1
              };
              for (const issue of valueDataset.issues) {
                if (issue.path) issue.path.unshift(pathItem);
                else issue.path = [pathItem];
                dataset.issues?.push(issue);
              }
              if (!dataset.issues) dataset.issues = valueDataset.issues;
              if (config$1.abortEarly) {
                dataset.typed = false;
                break;
              }
            }
            if (!valueDataset.typed) dataset.typed = false;
            dataset.value[key] = valueDataset.value;
          } else if (valueSchema.fallback !== void 0) dataset.value[key] = /* @__PURE__ */ getFallback(valueSchema);
          else if (valueSchema.type !== "exact_optional" && valueSchema.type !== "optional" && valueSchema.type !== "nullish") {
            _addIssue(this, "key", dataset, config$1, {
              input: void 0,
              expected: `"${key}"`,
              path: [{
                type: "object",
                origin: "key",
                input,
                key,
                value: input[key]
              }]
            });
            if (config$1.abortEarly) break;
          }
        }
      } else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function optional(wrapped, default_) {
  return _standardSchema({
    kind: "schema",
    type: "optional",
    reference: optional,
    expects: `(${wrapped.expects} | undefined)`,
    async: false,
    wrapped,
    default: default_,
    "~run"(dataset, config$1) {
      if (dataset.value === void 0) {
        if (this.default !== void 0) dataset.value = /* @__PURE__ */ getDefault(this, dataset, config$1);
        if (dataset.value === void 0) {
          dataset.typed = true;
          return dataset;
        }
      }
      return this.wrapped["~run"](dataset, config$1);
    }
  });
}
// @__NO_SIDE_EFFECTS__
function promise(message$1) {
  return _standardSchema({
    kind: "schema",
    type: "promise",
    reference: promise,
    expects: "Promise",
    async: false,
    message: message$1,
    "~run"(dataset, config$1) {
      if (dataset.value instanceof Promise) dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function record(key, value$1, message$1) {
  return _standardSchema({
    kind: "schema",
    type: "record",
    reference: record,
    expects: "Object",
    async: false,
    key,
    value: value$1,
    message: message$1,
    "~run"(dataset, config$1) {
      const input = dataset.value;
      if (input && typeof input === "object") {
        dataset.typed = true;
        dataset.value = {};
        for (const entryKey in input) if (/* @__PURE__ */ _isValidObjectKey(input, entryKey)) {
          const entryValue = input[entryKey];
          const keyDataset = this.key["~run"]({ value: entryKey }, config$1);
          if (keyDataset.issues) {
            const pathItem = {
              type: "object",
              origin: "key",
              input,
              key: entryKey,
              value: entryValue
            };
            for (const issue of keyDataset.issues) {
              issue.path = [pathItem];
              dataset.issues?.push(issue);
            }
            if (!dataset.issues) dataset.issues = keyDataset.issues;
            if (config$1.abortEarly) {
              dataset.typed = false;
              break;
            }
          }
          const valueDataset = this.value["~run"]({ value: entryValue }, config$1);
          if (valueDataset.issues) {
            const pathItem = {
              type: "object",
              origin: "value",
              input,
              key: entryKey,
              value: entryValue
            };
            for (const issue of valueDataset.issues) {
              if (issue.path) issue.path.unshift(pathItem);
              else issue.path = [pathItem];
              dataset.issues?.push(issue);
            }
            if (!dataset.issues) dataset.issues = valueDataset.issues;
            if (config$1.abortEarly) {
              dataset.typed = false;
              break;
            }
          }
          if (!keyDataset.typed || !valueDataset.typed) dataset.typed = false;
          if (keyDataset.typed) dataset.value[keyDataset.value] = valueDataset.value;
        }
      } else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function strictObject(entries$1, message$1) {
  return _standardSchema({
    kind: "schema",
    type: "strict_object",
    reference: strictObject,
    expects: "Object",
    async: false,
    entries: entries$1,
    message: message$1,
    "~run"(dataset, config$1) {
      const input = dataset.value;
      if (input && typeof input === "object") {
        dataset.typed = true;
        dataset.value = {};
        for (const key in this.entries) {
          const valueSchema = this.entries[key];
          if (key in input || (valueSchema.type === "exact_optional" || valueSchema.type === "optional" || valueSchema.type === "nullish") && valueSchema.default !== void 0) {
            const value$1 = key in input ? input[key] : /* @__PURE__ */ getDefault(valueSchema);
            const valueDataset = valueSchema["~run"]({ value: value$1 }, config$1);
            if (valueDataset.issues) {
              const pathItem = {
                type: "object",
                origin: "value",
                input,
                key,
                value: value$1
              };
              for (const issue of valueDataset.issues) {
                if (issue.path) issue.path.unshift(pathItem);
                else issue.path = [pathItem];
                dataset.issues?.push(issue);
              }
              if (!dataset.issues) dataset.issues = valueDataset.issues;
              if (config$1.abortEarly) {
                dataset.typed = false;
                break;
              }
            }
            if (!valueDataset.typed) dataset.typed = false;
            dataset.value[key] = valueDataset.value;
          } else if (valueSchema.fallback !== void 0) dataset.value[key] = /* @__PURE__ */ getFallback(valueSchema);
          else if (valueSchema.type !== "exact_optional" && valueSchema.type !== "optional" && valueSchema.type !== "nullish") {
            _addIssue(this, "key", dataset, config$1, {
              input: void 0,
              expected: `"${key}"`,
              path: [{
                type: "object",
                origin: "key",
                input,
                key,
                value: input[key]
              }]
            });
            if (config$1.abortEarly) break;
          }
        }
        if (!dataset.issues || !config$1.abortEarly) {
          for (const key in input) if (!Object.prototype.hasOwnProperty.call(this.entries, key)) {
            _addIssue(this, "key", dataset, config$1, {
              input: key,
              expected: "never",
              path: [{
                type: "object",
                origin: "key",
                input,
                key,
                value: input[key]
              }]
            });
            break;
          }
        }
      } else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function string(message$1) {
  return _standardSchema({
    kind: "schema",
    type: "string",
    reference: string,
    expects: "string",
    async: false,
    message: message$1,
    "~run"(dataset, config$1) {
      if (typeof dataset.value === "string") dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function tuple(items, message$1) {
  return _standardSchema({
    kind: "schema",
    type: "tuple",
    reference: tuple,
    expects: "Array",
    async: false,
    items,
    message: message$1,
    "~run"(dataset, config$1) {
      const input = dataset.value;
      if (Array.isArray(input)) {
        dataset.typed = true;
        dataset.value = [];
        for (let key = 0; key < this.items.length; key++) {
          const value$1 = input[key];
          const itemDataset = this.items[key]["~run"]({ value: value$1 }, config$1);
          if (itemDataset.issues) {
            const pathItem = {
              type: "array",
              origin: "value",
              input,
              key,
              value: value$1
            };
            for (const issue of itemDataset.issues) {
              if (issue.path) issue.path.unshift(pathItem);
              else issue.path = [pathItem];
              dataset.issues?.push(issue);
            }
            if (!dataset.issues) dataset.issues = itemDataset.issues;
            if (config$1.abortEarly) {
              dataset.typed = false;
              break;
            }
          }
          if (!itemDataset.typed) dataset.typed = false;
          dataset.value.push(itemDataset.value);
        }
      } else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function undefined_(message$1) {
  return _standardSchema({
    kind: "schema",
    type: "undefined",
    reference: undefined_,
    expects: "undefined",
    async: false,
    message: message$1,
    "~run"(dataset, config$1) {
      if (dataset.value === void 0) dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function _subIssues(datasets) {
  let issues;
  if (datasets) for (const dataset of datasets) if (issues) for (const issue of dataset.issues) issues.push(issue);
  else issues = dataset.issues;
  return issues;
}
// @__NO_SIDE_EFFECTS__
function union(options, message$1) {
  return _standardSchema({
    kind: "schema",
    type: "union",
    reference: union,
    expects: /* @__PURE__ */ _joinExpects(options.map((option) => option.expects), "|"),
    async: false,
    options,
    message: message$1,
    "~run"(dataset, config$1) {
      let validDataset;
      let typedDatasets;
      let untypedDatasets;
      for (const schema of this.options) {
        const optionDataset = schema["~run"]({ value: dataset.value }, config$1);
        if (optionDataset.typed) if (optionDataset.issues) if (typedDatasets) typedDatasets.push(optionDataset);
        else typedDatasets = [optionDataset];
        else {
          validDataset = optionDataset;
          break;
        }
        else if (untypedDatasets) untypedDatasets.push(optionDataset);
        else untypedDatasets = [optionDataset];
      }
      if (validDataset) return validDataset;
      if (typedDatasets) {
        if (typedDatasets.length === 1) return typedDatasets[0];
        _addIssue(this, "type", dataset, config$1, { issues: /* @__PURE__ */ _subIssues(typedDatasets) });
        dataset.typed = true;
      } else if (untypedDatasets?.length === 1) return untypedDatasets[0];
      else _addIssue(this, "type", dataset, config$1, { issues: /* @__PURE__ */ _subIssues(untypedDatasets) });
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function unionAsync(options, message$1) {
  return _standardSchema({
    kind: "schema",
    type: "union",
    reference: unionAsync,
    expects: /* @__PURE__ */ _joinExpects(options.map((option) => option.expects), "|"),
    async: true,
    options,
    message: message$1,
    async "~run"(dataset, config$1) {
      let validDataset;
      let typedDatasets;
      let untypedDatasets;
      for (const schema of this.options) {
        const optionDataset = await schema["~run"]({ value: dataset.value }, config$1);
        if (optionDataset.typed) if (optionDataset.issues) if (typedDatasets) typedDatasets.push(optionDataset);
        else typedDatasets = [optionDataset];
        else {
          validDataset = optionDataset;
          break;
        }
        else if (untypedDatasets) untypedDatasets.push(optionDataset);
        else untypedDatasets = [optionDataset];
      }
      if (validDataset) return validDataset;
      if (typedDatasets) {
        if (typedDatasets.length === 1) return typedDatasets[0];
        _addIssue(this, "type", dataset, config$1, { issues: /* @__PURE__ */ _subIssues(typedDatasets) });
        dataset.typed = true;
      } else if (untypedDatasets?.length === 1) return untypedDatasets[0];
      else _addIssue(this, "type", dataset, config$1, { issues: /* @__PURE__ */ _subIssues(untypedDatasets) });
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function void_(message$1) {
  return _standardSchema({
    kind: "schema",
    type: "void",
    reference: void_,
    expects: "void",
    async: false,
    message: message$1,
    "~run"(dataset, config$1) {
      if (dataset.value === void 0) dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function omit(schema, keys) {
  const entries$1 = { ...schema.entries };
  for (const key of keys) delete entries$1[key];
  return _standardSchema({
    ...schema,
    entries: entries$1
  });
}
// @__NO_SIDE_EFFECTS__
function partial(schema, keys) {
  const entries$1 = {};
  for (const key in schema.entries) entries$1[key] = !keys || keys.includes(key) ? /* @__PURE__ */ optional(schema.entries[key]) : schema.entries[key];
  return _standardSchema({
    ...schema,
    entries: entries$1
  });
}
// @__NO_SIDE_EFFECTS__
function pipe(...pipe$1) {
  return _standardSchema({
    ...pipe$1[0],
    pipe: pipe$1,
    "~run"(dataset, config$1) {
      for (const item of pipe$1) if (item.kind !== "metadata") {
        if (dataset.issues && (item.kind === "schema" || item.kind === "transformation")) {
          dataset.typed = false;
          break;
        }
        if (!dataset.issues || !config$1.abortEarly && !config$1.abortPipeEarly) dataset = item["~run"](dataset, config$1);
      }
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function pipeAsync(...pipe$1) {
  return _standardSchema({
    ...pipe$1[0],
    pipe: pipe$1,
    async: true,
    async "~run"(dataset, config$1) {
      for (const item of pipe$1) if (item.kind !== "metadata") {
        if (dataset.issues && (item.kind === "schema" || item.kind === "transformation")) {
          dataset.typed = false;
          break;
        }
        if (!dataset.issues || !config$1.abortEarly && !config$1.abortPipeEarly) dataset = await item["~run"](dataset, config$1);
      }
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function safeParse(schema, input, config$1) {
  const dataset = schema["~run"]({ value: input }, /* @__PURE__ */ getGlobalConfig(config$1));
  return {
    typed: dataset.typed,
    success: !dataset.issues,
    output: dataset.value,
    issues: dataset.issues
  };
}
function styleText$1(...args2) {
  return styleText(...args2);
}
var StringOrRegExpSchema = /* @__PURE__ */ union([/* @__PURE__ */ string(), /* @__PURE__ */ instance(RegExp)]);
function vFunction() {
  return /* @__PURE__ */ function_();
}
var LogLevelSchema = /* @__PURE__ */ union([
  /* @__PURE__ */ literal("debug"),
  /* @__PURE__ */ literal("info"),
  /* @__PURE__ */ literal("warn")
]);
var LogLevelOptionSchema = /* @__PURE__ */ union([LogLevelSchema, /* @__PURE__ */ literal("silent")]);
var LogLevelWithErrorSchema = /* @__PURE__ */ union([LogLevelSchema, /* @__PURE__ */ literal("error")]);
var RollupLogSchema = /* @__PURE__ */ any();
var RollupLogWithStringSchema = /* @__PURE__ */ union([RollupLogSchema, /* @__PURE__ */ string()]);
var InputOptionSchema = /* @__PURE__ */ union([
  /* @__PURE__ */ string(),
  /* @__PURE__ */ array(/* @__PURE__ */ string()),
  /* @__PURE__ */ record(/* @__PURE__ */ string(), /* @__PURE__ */ string())
]);
var ExternalOptionFunctionSchema = /* @__PURE__ */ pipe(vFunction(), /* @__PURE__ */ args(/* @__PURE__ */ tuple([
  /* @__PURE__ */ string(),
  /* @__PURE__ */ optional(/* @__PURE__ */ string()),
  /* @__PURE__ */ boolean()
])), /* @__PURE__ */ returns(/* @__PURE__ */ nullish(/* @__PURE__ */ boolean())));
var ExternalOptionSchema = /* @__PURE__ */ union([
  StringOrRegExpSchema,
  /* @__PURE__ */ array(StringOrRegExpSchema),
  ExternalOptionFunctionSchema
]);
var ModuleTypesSchema = /* @__PURE__ */ record(/* @__PURE__ */ string(), /* @__PURE__ */ union([
  /* @__PURE__ */ literal("asset"),
  /* @__PURE__ */ literal("base64"),
  /* @__PURE__ */ literal("binary"),
  /* @__PURE__ */ literal("copy"),
  /* @__PURE__ */ literal("css"),
  /* @__PURE__ */ literal("dataurl"),
  /* @__PURE__ */ literal("empty"),
  /* @__PURE__ */ literal("js"),
  /* @__PURE__ */ literal("json"),
  /* @__PURE__ */ literal("jsx"),
  /* @__PURE__ */ literal("text"),
  /* @__PURE__ */ literal("ts"),
  /* @__PURE__ */ literal("tsx")
]));
var TransformOptionsSchema = /* @__PURE__ */ object({
  assumptions: /* @__PURE__ */ optional(/* @__PURE__ */ object({
    ignoreFunctionLength: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    noDocumentAll: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    objectRestNoSymbols: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    pureGetters: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    setPublicClassFields: /* @__PURE__ */ optional(/* @__PURE__ */ boolean())
  })),
  typescript: /* @__PURE__ */ optional(/* @__PURE__ */ object({
    jsxPragma: /* @__PURE__ */ optional(/* @__PURE__ */ string()),
    jsxPragmaFrag: /* @__PURE__ */ optional(/* @__PURE__ */ string()),
    onlyRemoveTypeImports: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    allowNamespaces: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    allowDeclareFields: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    removeClassFieldsWithoutInitializer: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    optimizeConstEnums: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    optimizeEnums: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    declaration: /* @__PURE__ */ optional(/* @__PURE__ */ object({
      stripInternal: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
      sourcemap: /* @__PURE__ */ optional(/* @__PURE__ */ boolean())
    })),
    rewriteImportExtensions: /* @__PURE__ */ optional(/* @__PURE__ */ union([
      /* @__PURE__ */ literal("rewrite"),
      /* @__PURE__ */ literal("remove"),
      /* @__PURE__ */ boolean()
    ]))
  })),
  helpers: /* @__PURE__ */ optional(/* @__PURE__ */ object({ mode: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ literal("Runtime"), /* @__PURE__ */ literal("External")])) })),
  decorator: /* @__PURE__ */ optional(/* @__PURE__ */ object({
    legacy: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    emitDecoratorMetadata: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    strictNullChecks: /* @__PURE__ */ optional(/* @__PURE__ */ boolean())
  })),
  jsx: /* @__PURE__ */ optional(/* @__PURE__ */ union([
    /* @__PURE__ */ literal(false),
    /* @__PURE__ */ literal("preserve"),
    /* @__PURE__ */ literal("react"),
    /* @__PURE__ */ literal("react-jsx"),
    /* @__PURE__ */ strictObject({
      runtime: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ literal("classic"), /* @__PURE__ */ literal("automatic")])), /* @__PURE__ */ description("Which runtime to use")),
      development: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Development specific information")),
      throwIfNamespace: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Toggles whether to throw an error when a tag name uses an XML namespace")),
      pure: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Mark JSX elements and top-level React method calls as pure for tree shaking.")),
      importSource: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description("Import the factory of element and fragment if mode is classic")),
      pragma: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description("Jsx element transformation")),
      pragmaFrag: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description("Jsx fragment transformation")),
      refresh: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ boolean(), /* @__PURE__ */ any()])), /* @__PURE__ */ description("Enable react fast refresh"))
    })
  ])),
  target: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ string(), /* @__PURE__ */ array(/* @__PURE__ */ string())])), /* @__PURE__ */ description("The JavaScript target environment")),
  define: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ record(/* @__PURE__ */ string(), /* @__PURE__ */ string())), /* @__PURE__ */ description("Define global variables (syntax: key:value,key2:value2)")),
  inject: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ record(/* @__PURE__ */ string(), /* @__PURE__ */ union([/* @__PURE__ */ string(), /* @__PURE__ */ tuple([/* @__PURE__ */ string(), /* @__PURE__ */ string()])]))), /* @__PURE__ */ description("Inject import statements on demand")),
  dropLabels: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ array(/* @__PURE__ */ string())), /* @__PURE__ */ description("Remove labeled statements with these label names")),
  plugins: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ object({
    styledComponents: /* @__PURE__ */ optional(/* @__PURE__ */ any()),
    taggedTemplateEscape: /* @__PURE__ */ optional(/* @__PURE__ */ boolean())
  })), /* @__PURE__ */ description("Third-party plugins to use"))
});
var WatcherFileWatcherOptionsSchema = /* @__PURE__ */ strictObject({
  usePolling: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Use polling-based file watching instead of native OS events")),
  pollInterval: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ number()), /* @__PURE__ */ description("Poll interval in milliseconds (only used when usePolling is true)")),
  compareContentsForPolling: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Compare file contents for poll-based watchers (only used when usePolling is true)")),
  useDebounce: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Use debounced event delivery at the filesystem level")),
  debounceDelay: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ number()), /* @__PURE__ */ description("Debounce delay in milliseconds (only used when useDebounce is true)")),
  debounceTickRate: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ number()), /* @__PURE__ */ description("Tick rate in milliseconds for debouncer (only used when useDebounce is true)"))
});
var WatcherOptionsSchema = /* @__PURE__ */ strictObject({
  chokidar: /* @__PURE__ */ optional(/* @__PURE__ */ never(`The "watch.chokidar" option is deprecated, please use "watch.watcher" instead of it`)),
  exclude: /* @__PURE__ */ optional(/* @__PURE__ */ union([StringOrRegExpSchema, /* @__PURE__ */ array(StringOrRegExpSchema)])),
  include: /* @__PURE__ */ optional(/* @__PURE__ */ union([StringOrRegExpSchema, /* @__PURE__ */ array(StringOrRegExpSchema)])),
  watcher: /* @__PURE__ */ optional(WatcherFileWatcherOptionsSchema),
  notify: /* @__PURE__ */ optional(WatcherFileWatcherOptionsSchema),
  skipWrite: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Skip the bundle.write() step")),
  buildDelay: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ number()), /* @__PURE__ */ description("Throttle watch rebuilds")),
  clearScreen: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to clear the screen when a rebuild is triggered")),
  onInvalidate: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(vFunction()), /* @__PURE__ */ description("An optional function that will be called immediately every time a module changes that is part of the build."))
});
var ChecksOptionsSchema = /* @__PURE__ */ strictObject({
  circularDependency: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when detecting circular dependency")),
  eval: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when detecting uses of direct `eval`s")),
  missingGlobalName: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when the `output.globals` option is missing when needed")),
  missingNameOptionForIifeExport: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when the `output.name` option is missing when needed")),
  invalidAnnotation: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when a `#__PURE__` / `@__PURE__` annotation has no effect due to its position")),
  mixedExports: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when the way to export values is ambiguous")),
  unresolvedEntry: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when an entrypoint cannot be resolved")),
  unresolvedImport: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when an import cannot be resolved")),
  filenameConflict: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when files generated have the same name with different contents")),
  moduleLevelDirective: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings for module-level directives other than `use strict`")),
  commonJsVariableInEsm: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when a CommonJS variable is used in an ES module")),
  importIsUndefined: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when an imported variable is not exported")),
  emptyImportMeta: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when `import.meta` is not supported with the output format and is replaced with an empty object (`{}`)")),
  toleratedTransform: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when detecting tolerated transform")),
  cannotCallNamespace: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when a namespace is called as a function")),
  configurationFieldConflict: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when a config value is overridden by another config value with a higher priority")),
  preferBuiltinFeature: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when a plugin that is covered by a built-in feature is used")),
  couldNotCleanDirectory: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when Rolldown could not clean the output directory")),
  bundlerTimings: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when plugins and option callbacks take significant time during the build process")),
  pluginTimings: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Deprecated alias for bundlerTimings. Rolldown uses bundlerTimings if both options have values.")),
  duplicateShebang: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when both the code and postBanner contain shebang")),
  unsupportedTsconfigOption: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when a tsconfig option or combination of options is not supported")),
  ineffectiveDynamicImport: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when a module is dynamically imported but also statically imported, making the dynamic import ineffective for code splitting")),
  largeBarrelModules: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit info logs when a barrel module has a very large number of re-exports (more than 5000)")),
  sourcemapBroken: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when a plugin transforms code without generating a sourcemap")),
  namespaceConflict: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to emit warnings when multiple star re-exports provide the same name from different modules"))
});
var MinifyOptionsSchema = /* @__PURE__ */ strictObject({
  compress: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ boolean(), /* @__PURE__ */ strictObject({
    target: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ string(), /* @__PURE__ */ array(/* @__PURE__ */ string())])),
    dropConsole: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    dropDebugger: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    keepNames: /* @__PURE__ */ optional(/* @__PURE__ */ strictObject({
      function: /* @__PURE__ */ boolean(),
      class: /* @__PURE__ */ boolean()
    })),
    unused: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ boolean(), /* @__PURE__ */ literal("keep_assign")])),
    joinVars: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    sequences: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    dropLabels: /* @__PURE__ */ optional(/* @__PURE__ */ array(/* @__PURE__ */ string())),
    maxIterations: /* @__PURE__ */ optional(/* @__PURE__ */ number()),
    treeshake: /* @__PURE__ */ optional(/* @__PURE__ */ strictObject({
      annotations: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
      manualPureFunctions: /* @__PURE__ */ optional(/* @__PURE__ */ array(/* @__PURE__ */ string())),
      propertyReadSideEffects: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ boolean(), /* @__PURE__ */ literal("always")])),
      propertyWriteSideEffects: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
      unknownGlobalSideEffects: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
      invalidImportSideEffects: /* @__PURE__ */ optional(/* @__PURE__ */ boolean())
    }))
  })])),
  mangle: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ boolean(), /* @__PURE__ */ strictObject({
    toplevel: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    keepNames: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ boolean(), /* @__PURE__ */ strictObject({
      function: /* @__PURE__ */ boolean(),
      class: /* @__PURE__ */ boolean()
    })])),
    reserved: /* @__PURE__ */ optional(/* @__PURE__ */ array(/* @__PURE__ */ string())),
    debug: /* @__PURE__ */ optional(/* @__PURE__ */ boolean())
  })])),
  mangleProps: /* @__PURE__ */ optional(/* @__PURE__ */ strictObject({
    include: /* @__PURE__ */ instance(RegExp),
    exclude: /* @__PURE__ */ optional(/* @__PURE__ */ instance(RegExp)),
    reserved: /* @__PURE__ */ optional(/* @__PURE__ */ array(/* @__PURE__ */ string())),
    quoted: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    debug: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    cache: /* @__PURE__ */ optional(/* @__PURE__ */ record(/* @__PURE__ */ string(), /* @__PURE__ */ union([/* @__PURE__ */ string(), /* @__PURE__ */ literal(false)])))
  })),
  codegen: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ boolean(), /* @__PURE__ */ strictObject({
    removeWhitespace: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    asciiOnly: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    legalComments: /* @__PURE__ */ optional(/* @__PURE__ */ union([
      /* @__PURE__ */ literal("none"),
      /* @__PURE__ */ literal("inline"),
      /* @__PURE__ */ literal("eof"),
      /* @__PURE__ */ literal("external"),
      /* @__PURE__ */ strictObject({ linked: /* @__PURE__ */ string() })
    ]))
  })]))
});
var ResolveOptionsSchema = /* @__PURE__ */ strictObject({
  alias: /* @__PURE__ */ optional(/* @__PURE__ */ record(/* @__PURE__ */ string(), /* @__PURE__ */ union([
    /* @__PURE__ */ literal(false),
    /* @__PURE__ */ string(),
    /* @__PURE__ */ array(/* @__PURE__ */ string())
  ]))),
  aliasFields: /* @__PURE__ */ optional(/* @__PURE__ */ array(/* @__PURE__ */ array(/* @__PURE__ */ string()))),
  conditionNames: /* @__PURE__ */ optional(/* @__PURE__ */ array(/* @__PURE__ */ string())),
  extensionAlias: /* @__PURE__ */ optional(/* @__PURE__ */ record(/* @__PURE__ */ string(), /* @__PURE__ */ array(/* @__PURE__ */ string()))),
  exportsFields: /* @__PURE__ */ optional(/* @__PURE__ */ array(/* @__PURE__ */ array(/* @__PURE__ */ string()))),
  extensions: /* @__PURE__ */ optional(/* @__PURE__ */ array(/* @__PURE__ */ string())),
  mainFields: /* @__PURE__ */ optional(/* @__PURE__ */ array(/* @__PURE__ */ string())),
  mainFiles: /* @__PURE__ */ optional(/* @__PURE__ */ array(/* @__PURE__ */ string())),
  modules: /* @__PURE__ */ optional(/* @__PURE__ */ array(/* @__PURE__ */ string())),
  symlinks: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
  tsconfigFilename: /* @__PURE__ */ optional(/* @__PURE__ */ string())
});
var TreeshakingOptionsSchema = /* @__PURE__ */ strictObject({
  moduleSideEffects: /* @__PURE__ */ optional(/* @__PURE__ */ any()),
  annotations: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
  manualPureFunctions: /* @__PURE__ */ optional(/* @__PURE__ */ custom((input) => /* @__PURE__ */ is(/* @__PURE__ */ array(/* @__PURE__ */ string()), input), "string array")),
  unknownGlobalSideEffects: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
  invalidImportSideEffects: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
  commonjs: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
  propertyReadSideEffects: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ literal(false), /* @__PURE__ */ literal("always")])),
  propertyWriteSideEffects: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ literal(false), /* @__PURE__ */ literal("always")]))
});
var OptimizationOptionsSchema = /* @__PURE__ */ strictObject({
  inlineConst: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ boolean(), /* @__PURE__ */ strictObject({
    mode: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ literal("all"), /* @__PURE__ */ literal("smart")])),
    pass: /* @__PURE__ */ optional(/* @__PURE__ */ number())
  })])), /* @__PURE__ */ description("Enable crossmodule constant inlining")),
  pifeForModuleWrappers: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Use PIFE pattern for module wrappers"))
});
var LogOrStringHandlerSchema = /* @__PURE__ */ pipe(vFunction(), /* @__PURE__ */ args(/* @__PURE__ */ tuple([LogLevelWithErrorSchema, RollupLogWithStringSchema])));
var OnLogSchema = /* @__PURE__ */ pipe(vFunction(), /* @__PURE__ */ args(/* @__PURE__ */ tuple([
  LogLevelSchema,
  RollupLogSchema,
  LogOrStringHandlerSchema
])));
var OnwarnSchema = /* @__PURE__ */ pipe(vFunction(), /* @__PURE__ */ args(/* @__PURE__ */ tuple([RollupLogSchema, /* @__PURE__ */ pipe(vFunction(), /* @__PURE__ */ args(/* @__PURE__ */ tuple([/* @__PURE__ */ union([RollupLogWithStringSchema, /* @__PURE__ */ pipe(vFunction(), /* @__PURE__ */ returns(RollupLogWithStringSchema))])])))])));
var DevModeSchema = /* @__PURE__ */ union([/* @__PURE__ */ boolean(), /* @__PURE__ */ strictObject({
  port: /* @__PURE__ */ optional(/* @__PURE__ */ number()),
  host: /* @__PURE__ */ optional(/* @__PURE__ */ string()),
  implement: /* @__PURE__ */ optional(/* @__PURE__ */ string()),
  skipCommonRuntimeInjection: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
  lazy: /* @__PURE__ */ optional(/* @__PURE__ */ boolean())
})]);
var InputOptionsSchema = /* @__PURE__ */ strictObject({
  input: /* @__PURE__ */ optional(InputOptionSchema),
  plugins: /* @__PURE__ */ optional(/* @__PURE__ */ custom(() => true)),
  external: /* @__PURE__ */ optional(ExternalOptionSchema),
  makeAbsoluteExternalsRelative: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ boolean(), /* @__PURE__ */ literal("ifRelativeSource")])),
  resolve: /* @__PURE__ */ optional(ResolveOptionsSchema),
  cwd: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description("Current working directory")),
  platform: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ union([
    /* @__PURE__ */ literal("browser"),
    /* @__PURE__ */ literal("neutral"),
    /* @__PURE__ */ literal("node")
  ])), /* @__PURE__ */ description(`Platform for which the code should be generated (node, ${styleText$1("underline", "browser")}, neutral)`)),
  shimMissingExports: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Create shim variables for missing exports")),
  treeshake: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ boolean(), TreeshakingOptionsSchema])),
  optimization: /* @__PURE__ */ optional(OptimizationOptionsSchema),
  logLevel: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(LogLevelOptionSchema), /* @__PURE__ */ description(`Log level (${styleText$1("dim", "silent")}, ${styleText$1(["underline", "gray"], "info")}, debug, ${styleText$1("yellow", "warn")})`)),
  onLog: /* @__PURE__ */ optional(OnLogSchema),
  onwarn: /* @__PURE__ */ optional(OnwarnSchema),
  moduleTypes: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(ModuleTypesSchema), /* @__PURE__ */ description("Module types for customized extensions")),
  experimental: /* @__PURE__ */ optional(/* @__PURE__ */ strictObject({
    viteMode: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    resolveNewUrlToAsset: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    devMode: /* @__PURE__ */ optional(DevModeSchema),
    chunkModulesOrder: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ literal("module-id"), /* @__PURE__ */ literal("exec-order")])),
    attachDebugInfo: /* @__PURE__ */ optional(/* @__PURE__ */ union([
      /* @__PURE__ */ literal("none"),
      /* @__PURE__ */ literal("simple"),
      /* @__PURE__ */ literal("full")
    ])),
    chunkImportMap: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ boolean(), /* @__PURE__ */ object({
      baseUrl: /* @__PURE__ */ optional(/* @__PURE__ */ string()),
      fileName: /* @__PURE__ */ optional(/* @__PURE__ */ string())
    })])),
    onDemandWrapping: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    incrementalBuild: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    nativeMagicString: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    chunkOptimization: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ boolean(), /* @__PURE__ */ strictObject({
      mergeCommonChunks: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
      avoidRedundantChunkLoads: /* @__PURE__ */ optional(/* @__PURE__ */ boolean())
    })])),
    lazyBarrel: /* @__PURE__ */ optional(/* @__PURE__ */ boolean())
  })),
  transform: /* @__PURE__ */ optional(TransformOptionsSchema),
  watch: /* @__PURE__ */ optional(/* @__PURE__ */ union([WatcherOptionsSchema, /* @__PURE__ */ literal(false)])),
  checks: /* @__PURE__ */ optional(ChecksOptionsSchema),
  devtools: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ object({ sessionId: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description("Used to name the build.")) })), /* @__PURE__ */ description("Enable debug mode. Emit debug information to disk. This might slow down the build process significantly.")),
  preserveEntrySignatures: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ union([
    /* @__PURE__ */ literal("strict"),
    /* @__PURE__ */ literal("allow-extension"),
    /* @__PURE__ */ literal("exports-only"),
    /* @__PURE__ */ literal(false)
  ]))),
  context: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description("The value of `this` at the top level of each module.")),
  tsconfig: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ boolean(), /* @__PURE__ */ string()])), /* @__PURE__ */ description("Path to the tsconfig.json file."))
});
var InputCliOverrideSchema = /* @__PURE__ */ strictObject({
  input: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ array(/* @__PURE__ */ string())), /* @__PURE__ */ description("Entry file")),
  external: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ array(/* @__PURE__ */ string())), /* @__PURE__ */ description("Comma-separated list of module ids to exclude from the bundle `<module-id>,...`")),
  treeshake: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("enable treeshaking")),
  makeAbsoluteExternalsRelative: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Prevent normalization of external imports")),
  preserveEntrySignatures: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ literal(false)), /* @__PURE__ */ description("Avoid facade chunks for entry points")),
  context: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description("The entity top-level `this` represents."))
});
var InputCliOptionsSchema = /* @__PURE__ */ omit(/* @__PURE__ */ strictObject({
  ...InputOptionsSchema.entries,
  ...InputCliOverrideSchema.entries
}), [
  "plugins",
  "onwarn",
  "onLog",
  "resolve",
  "experimental",
  "watch"
]);
var ModuleFormatSchema = /* @__PURE__ */ union([
  /* @__PURE__ */ literal("es"),
  /* @__PURE__ */ literal("cjs"),
  /* @__PURE__ */ literal("esm"),
  /* @__PURE__ */ literal("module"),
  /* @__PURE__ */ literal("commonjs"),
  /* @__PURE__ */ literal("iife"),
  /* @__PURE__ */ literal("umd")
]);
var AddonFunctionSchema = /* @__PURE__ */ pipe(vFunction(), /* @__PURE__ */ args(/* @__PURE__ */ tuple([/* @__PURE__ */ custom(() => true)])), /* @__PURE__ */ returnsAsync(/* @__PURE__ */ unionAsync([/* @__PURE__ */ string(), /* @__PURE__ */ pipeAsync(/* @__PURE__ */ promise(), /* @__PURE__ */ awaitAsync(), /* @__PURE__ */ string())])));
var ChunkFileNamesFunctionSchema = /* @__PURE__ */ pipe(vFunction(), /* @__PURE__ */ args(/* @__PURE__ */ tuple([/* @__PURE__ */ custom(() => true)])), /* @__PURE__ */ returns(/* @__PURE__ */ string()));
var ChunkFileNamesSchema = /* @__PURE__ */ union([/* @__PURE__ */ string(), ChunkFileNamesFunctionSchema]);
var AssetFileNamesFunctionSchema = /* @__PURE__ */ pipe(vFunction(), /* @__PURE__ */ args(/* @__PURE__ */ tuple([/* @__PURE__ */ custom(() => true)])), /* @__PURE__ */ returns(/* @__PURE__ */ string()));
var AssetFileNamesSchema = /* @__PURE__ */ union([/* @__PURE__ */ string(), AssetFileNamesFunctionSchema]);
var SanitizeFileNameFunctionSchema = /* @__PURE__ */ pipe(vFunction(), /* @__PURE__ */ args(/* @__PURE__ */ tuple([/* @__PURE__ */ string()])), /* @__PURE__ */ returns(/* @__PURE__ */ string()));
var SanitizeFileNameSchema = /* @__PURE__ */ union([/* @__PURE__ */ boolean(), SanitizeFileNameFunctionSchema]);
var GlobalsFunctionSchema = /* @__PURE__ */ pipe(vFunction(), /* @__PURE__ */ args(/* @__PURE__ */ tuple([/* @__PURE__ */ string()])), /* @__PURE__ */ returns(/* @__PURE__ */ string()));
var PathsFunctionSchema = /* @__PURE__ */ pipe(vFunction(), /* @__PURE__ */ args(/* @__PURE__ */ tuple([/* @__PURE__ */ string()])), /* @__PURE__ */ returns(/* @__PURE__ */ string()));
var ManualChunksFunctionSchema = /* @__PURE__ */ pipe(vFunction(), /* @__PURE__ */ args(/* @__PURE__ */ tuple([/* @__PURE__ */ string(), /* @__PURE__ */ object({})])), /* @__PURE__ */ returns(/* @__PURE__ */ nullish(/* @__PURE__ */ string())));
var AdvancedChunksNameFunctionSchema = /* @__PURE__ */ pipe(vFunction(), /* @__PURE__ */ args(/* @__PURE__ */ tuple([/* @__PURE__ */ string(), /* @__PURE__ */ object({})])), /* @__PURE__ */ returns(/* @__PURE__ */ nullish(/* @__PURE__ */ string())));
var AdvancedChunksTestFunctionSchema = /* @__PURE__ */ pipe(vFunction(), /* @__PURE__ */ args(/* @__PURE__ */ tuple([/* @__PURE__ */ string()])), /* @__PURE__ */ returns(/* @__PURE__ */ union([
  /* @__PURE__ */ boolean(),
  /* @__PURE__ */ void_(),
  /* @__PURE__ */ undefined_()
])));
var AdvancedChunksSchema = /* @__PURE__ */ strictObject({
  includeDependenciesRecursively: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
  minSize: /* @__PURE__ */ optional(/* @__PURE__ */ number()),
  maxSize: /* @__PURE__ */ optional(/* @__PURE__ */ number()),
  minModuleSize: /* @__PURE__ */ optional(/* @__PURE__ */ number()),
  maxModuleSize: /* @__PURE__ */ optional(/* @__PURE__ */ number()),
  minShareCount: /* @__PURE__ */ optional(/* @__PURE__ */ number()),
  groups: /* @__PURE__ */ optional(/* @__PURE__ */ array(/* @__PURE__ */ strictObject({
    debugName: /* @__PURE__ */ optional(/* @__PURE__ */ string()),
    name: /* @__PURE__ */ union([/* @__PURE__ */ string(), AdvancedChunksNameFunctionSchema]),
    test: /* @__PURE__ */ optional(/* @__PURE__ */ union([StringOrRegExpSchema, AdvancedChunksTestFunctionSchema])),
    priority: /* @__PURE__ */ optional(/* @__PURE__ */ number()),
    minSize: /* @__PURE__ */ optional(/* @__PURE__ */ number()),
    minShareCount: /* @__PURE__ */ optional(/* @__PURE__ */ number()),
    maxSize: /* @__PURE__ */ optional(/* @__PURE__ */ number()),
    minModuleSize: /* @__PURE__ */ optional(/* @__PURE__ */ number()),
    maxModuleSize: /* @__PURE__ */ optional(/* @__PURE__ */ number()),
    entriesAware: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    entriesAwareMergeThreshold: /* @__PURE__ */ optional(/* @__PURE__ */ number()),
    includeDependenciesRecursively: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    tags: /* @__PURE__ */ optional(/* @__PURE__ */ array(/* @__PURE__ */ string()))
  })))
});
var GeneratedCodeOptionsSchema = /* @__PURE__ */ strictObject({
  symbols: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to use Symbol.toStringTag for namespace objects")),
  preset: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ literal("es5"), /* @__PURE__ */ literal("es2015")])),
  profilerNames: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Whether to add readable names to internal variables for profiling purposes"))
});
var OutputOptionsSchema = /* @__PURE__ */ strictObject({
  dir: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description("Output directory, defaults to `dist` if `file` is not set")),
  file: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description("Single output file")),
  exports: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ union([
    /* @__PURE__ */ literal("auto"),
    /* @__PURE__ */ literal("named"),
    /* @__PURE__ */ literal("default"),
    /* @__PURE__ */ literal("none")
  ])), /* @__PURE__ */ description(`Specify a export mode (${styleText$1("underline", "auto")}, named, default, none)`)),
  hashCharacters: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ union([
    /* @__PURE__ */ literal("base64"),
    /* @__PURE__ */ literal("base36"),
    /* @__PURE__ */ literal("hex")
  ])), /* @__PURE__ */ description("Use the specified character set for file hashes")),
  format: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(ModuleFormatSchema), /* @__PURE__ */ description(`Output format of the generated bundle (supports ${styleText$1("underline", "esm")}, cjs, and iife)`)),
  sourcemap: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ union([
    /* @__PURE__ */ boolean(),
    /* @__PURE__ */ literal("inline"),
    /* @__PURE__ */ literal("hidden")
  ])), /* @__PURE__ */ description(`Generate sourcemap (\`-s inline\` for inline, or \`-s\` for \`.map\` file)`)),
  sourcemapBaseUrl: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description("Base URL used to prefix sourcemap paths")),
  sourcemapFileNames: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(ChunkFileNamesSchema), /* @__PURE__ */ description("Name pattern for emitted sourcemaps")),
  sourcemapDebugIds: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Inject sourcemap debug IDs")),
  sourcemapExcludeSources: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Exclude source content from sourcemaps")),
  sourcemapIgnoreList: /* @__PURE__ */ optional(/* @__PURE__ */ union([
    /* @__PURE__ */ boolean(),
    /* @__PURE__ */ custom(() => true),
    StringOrRegExpSchema
  ])),
  sourcemapPathTransform: /* @__PURE__ */ optional(/* @__PURE__ */ custom(() => true)),
  banner: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ string(), AddonFunctionSchema])),
  footer: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ string(), AddonFunctionSchema])),
  postBanner: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ string(), AddonFunctionSchema])),
  postFooter: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ string(), AddonFunctionSchema])),
  intro: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ string(), AddonFunctionSchema])),
  outro: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ string(), AddonFunctionSchema])),
  extend: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Extend global variable defined by name in IIFE / UMD formats")),
  esModule: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ boolean(), /* @__PURE__ */ literal("if-default-prop")])),
  assetFileNames: /* @__PURE__ */ optional(AssetFileNamesSchema),
  entryFileNames: /* @__PURE__ */ optional(ChunkFileNamesSchema),
  chunkFileNames: /* @__PURE__ */ optional(ChunkFileNamesSchema),
  sanitizeFileName: /* @__PURE__ */ optional(SanitizeFileNameSchema),
  minify: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ union([
    /* @__PURE__ */ boolean(),
    /* @__PURE__ */ literal("dce-only"),
    MinifyOptionsSchema
  ])), /* @__PURE__ */ description("Minify the bundled file")),
  name: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description("Name for UMD / IIFE format outputs")),
  globals: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ record(/* @__PURE__ */ string(), /* @__PURE__ */ string()), GlobalsFunctionSchema])), /* @__PURE__ */ description("Global variable of UMD / IIFE dependencies (syntax: `key:value`)")),
  paths: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ record(/* @__PURE__ */ string(), /* @__PURE__ */ string()), PathsFunctionSchema])), /* @__PURE__ */ description("Maps external module IDs to paths")),
  generatedCode: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ partial(GeneratedCodeOptionsSchema)), /* @__PURE__ */ description("Generated code options")),
  externalLiveBindings: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("external live bindings")),
  inlineDynamicImports: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Inline dynamic imports")),
  dynamicImportInCjs: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Dynamic import in CJS output")),
  manualChunks: /* @__PURE__ */ optional(ManualChunksFunctionSchema),
  codeSplitting: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ boolean(), AdvancedChunksSchema])),
  advancedChunks: /* @__PURE__ */ optional(AdvancedChunksSchema),
  legalComments: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ literal("none"), /* @__PURE__ */ literal("inline")])), /* @__PURE__ */ description("Control legal comments in the output")),
  comments: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ boolean(), /* @__PURE__ */ strictObject({
    legal: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    annotation: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    jsdoc: /* @__PURE__ */ optional(/* @__PURE__ */ boolean())
  })])), /* @__PURE__ */ description("Control comments in the output")),
  plugins: /* @__PURE__ */ optional(/* @__PURE__ */ custom(() => true)),
  polyfillRequire: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Disable require polyfill injection")),
  hoistTransitiveImports: /* @__PURE__ */ optional(/* @__PURE__ */ literal(false)),
  preserveModules: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Preserve module structure")),
  preserveModulesRoot: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description("Put preserved modules under this path at root level")),
  virtualDirname: /* @__PURE__ */ optional(/* @__PURE__ */ string()),
  minifyInternalExports: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Minify internal exports")),
  topLevelVar: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Rewrite top-level declarations to use `var`.")),
  cleanDir: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Clean output directory before emitting output")),
  keepNames: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Keep function and class names after bundling")),
  strictExecutionOrder: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Preserve source module execution order across generated chunks.")),
  strict: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ boolean(), /* @__PURE__ */ literal("auto")])), /* @__PURE__ */ description('Whether to always output `"use strict"` directive in non-ES module outputs.'))
});
var getAddonDescription = (placement, wrapper) => {
  return `Code to insert the ${styleText$1("bold", placement)} of the bundled file (${styleText$1("bold", wrapper)} the wrapper function)`;
};
var OutputCliOverrideSchema = /* @__PURE__ */ strictObject({
  assetFileNames: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description("Name pattern for asset files")),
  entryFileNames: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description("Name pattern for emitted entry chunks")),
  chunkFileNames: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description("Name pattern for emitted secondary chunks")),
  sanitizeFileName: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Sanitize file name")),
  banner: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description(getAddonDescription("top", "outside"))),
  footer: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description(getAddonDescription("bottom", "outside"))),
  postBanner: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description("A string to prepend to the top of each chunk. Applied after the `renderChunk` hook and minification")),
  postFooter: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description("A string to append to the bottom of each chunk. Applied after the `renderChunk` hook and minification")),
  intro: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description(getAddonDescription("top", "inside"))),
  outro: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ string()), /* @__PURE__ */ description(getAddonDescription("bottom", "inside"))),
  esModule: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Always generate `__esModule` marks in non-ESM formats, defaults to `if-default-prop` (use `--no-esModule` to always disable)")),
  globals: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ record(/* @__PURE__ */ string(), /* @__PURE__ */ string())), /* @__PURE__ */ description("Global variable of UMD / IIFE dependencies (syntax: `key:value`)")),
  codeSplitting: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ boolean(), /* @__PURE__ */ strictObject({
    minSize: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ number()), /* @__PURE__ */ description("Minimum size of the chunk")),
    minShareCount: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ number()), /* @__PURE__ */ description("Minimum share count of the chunk"))
  })])), /* @__PURE__ */ description("Code splitting options. Enabled by default; use `--no-codeSplitting` to disable, or `--codeSplitting.minSize` / `--codeSplitting.minShareCount` to configure")),
  advancedChunks: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ strictObject({
    minSize: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ number()), /* @__PURE__ */ description("Minimum size of the chunk")),
    minShareCount: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ number()), /* @__PURE__ */ description("Minimum share count of the chunk"))
  })), /* @__PURE__ */ description("Deprecated: use codeSplitting instead")),
  minify: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Minify the bundled file"))
});
var OutputCliOptionsSchema = /* @__PURE__ */ omit(/* @__PURE__ */ strictObject({
  ...OutputOptionsSchema.entries,
  ...OutputCliOverrideSchema.entries
}), [
  "sourcemapIgnoreList",
  "sourcemapPathTransform",
  "plugins",
  "hoistTransitiveImports"
]);
var CliOptionsSchema = /* @__PURE__ */ strictObject({
  config: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ string(), /* @__PURE__ */ boolean()])), /* @__PURE__ */ description("Path to the config file (default: `rolldown.config.js`)")),
  help: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Show help")),
  environment: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ string(), /* @__PURE__ */ array(/* @__PURE__ */ string())])), /* @__PURE__ */ description("Pass additional settings to the config file via process.ENV.")),
  version: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Show version number")),
  watch: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ boolean()), /* @__PURE__ */ description("Watch files in bundle and rebuild on changes")),
  configLoader: /* @__PURE__ */ pipe(/* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ literal("bundle"), /* @__PURE__ */ literal("native")])), /* @__PURE__ */ description("How to load the config file (bundle, native)")),
  ...InputCliOptionsSchema.entries,
  ...OutputCliOptionsSchema.entries
});
var inputHelperMsgRecord = {
  output: { ignored: true },
  "resolve.tsconfigFilename": { issueMsg: "It is deprecated. Please use the top-level `tsconfig` option instead." }
};
var outputHelperMsgRecord = {};
function validateOption(key, options) {
  if (typeof options !== "object") throw new Error(`Invalid ${key} options. Expected an Object but received ${JSON.stringify(options)}.`);
  if (globalThis.process?.env?.ROLLUP_TEST) return;
  let parsed = /* @__PURE__ */ safeParse(key === "input" ? InputOptionsSchema : OutputOptionsSchema, options);
  if (!parsed.success) {
    const errors = parsed.issues.map((issue) => {
      let issueMsg = issue.message;
      const issuePaths = issue.path.map((path3) => path3.key);
      if (issue.type === "union") {
        const subIssue = issue.issues?.find((i2) => !(i2.type !== issue.received && i2.input === issue.input));
        if (subIssue) {
          if (subIssue.path) issuePaths.push(subIssue.path.map((path3) => path3.key));
          issueMsg = subIssue.message;
        }
      }
      const stringPath = issuePaths.join(".");
      const helper = key === "input" ? inputHelperMsgRecord[stringPath] : outputHelperMsgRecord[stringPath];
      if (helper && helper.ignored) return "";
      return `- For the "${stringPath}". ${helper?.issueMsg || issueMsg + "."} ${helper?.help ? `
  Help: ${helper.help}` : ""}`;
    }).filter(Boolean);
    if (errors.length) console.warn(`\x1B[33mWarning: Invalid ${key} options (${errors.length} issue${errors.length === 1 ? "" : "s"} found)
${errors.join("\n")}\x1B[0m`);
  }
}
var ChunkingContextImpl = class {
  context;
  pluginContextData;
  moduleInfoCache = /* @__PURE__ */ new Map();
  constructor(context, pluginContextData) {
    this.context = context;
    this.pluginContextData = pluginContextData;
  }
  clearModuleInfoCache() {
    this.moduleInfoCache = void 0;
  }
  getModuleInfo(moduleId) {
    const cached = this.moduleInfoCache?.get(moduleId);
    if (cached) return cached;
    const bindingInfo = this.context.getModuleInfo(moduleId);
    if (bindingInfo) {
      const option = this.pluginContextData.getModuleOption(moduleId);
      const info = transformModuleInfo(bindingInfo, option);
      Object.defineProperty(info, "moduleSideEffects", {
        get: () => option.moduleSideEffects,
        set: (moduleSideEffects) => {
          option.moduleSideEffects = moduleSideEffects;
          option.invalidate = true;
        }
      });
      this.moduleInfoCache?.set(moduleId, info);
      return info;
    }
    return null;
  }
};
var LogLevels = {
  silent: Number.NEGATIVE_INFINITY,
  fatal: 0,
  error: 0,
  warn: 1,
  log: 2,
  info: 3,
  success: 3,
  fail: 3,
  ready: 3,
  start: 3,
  box: 3,
  debug: 4,
  trace: 5,
  verbose: Number.POSITIVE_INFINITY
};
var LogTypes = {
  silent: { level: -1 },
  fatal: { level: LogLevels.fatal },
  error: { level: LogLevels.error },
  warn: { level: LogLevels.warn },
  log: { level: LogLevels.log },
  info: { level: LogLevels.info },
  success: { level: LogLevels.success },
  fail: { level: LogLevels.fail },
  ready: { level: LogLevels.info },
  start: { level: LogLevels.info },
  box: { level: LogLevels.info },
  debug: { level: LogLevels.debug },
  trace: { level: LogLevels.trace },
  verbose: { level: LogLevels.verbose }
};
function isPlainObject$1(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype && Object.getPrototypeOf(prototype) !== null) return false;
  if (Symbol.iterator in value) return false;
  if (Symbol.toStringTag in value) return Object.prototype.toString.call(value) === "[object Module]";
  return true;
}
function _defu(baseObject, defaults, namespace = ".", merger) {
  if (!isPlainObject$1(defaults)) return _defu(baseObject, {}, namespace, merger);
  const object2 = Object.assign({}, defaults);
  for (const key in baseObject) {
    if (key === "__proto__" || key === "constructor") continue;
    const value = baseObject[key];
    if (value === null || value === void 0) continue;
    if (merger && merger(object2, key, value, namespace)) continue;
    if (Array.isArray(value) && Array.isArray(object2[key])) object2[key] = [...value, ...object2[key]];
    else if (isPlainObject$1(value) && isPlainObject$1(object2[key])) object2[key] = _defu(value, object2[key], (namespace ? `${namespace}.` : "") + key.toString(), merger);
    else object2[key] = value;
  }
  return object2;
}
function createDefu(merger) {
  return (...arguments_) => arguments_.reduce((p, c3) => _defu(p, c3, "", merger), {});
}
var defu = createDefu();
function isPlainObject(obj) {
  return Object.prototype.toString.call(obj) === "[object Object]";
}
function isLogObj(arg) {
  if (!isPlainObject(arg)) return false;
  if (!arg.message && !arg.args) return false;
  if (arg.stack) return false;
  return true;
}
var paused = false;
var queue = [];
var Consola = class Consola2 {
  options;
  _lastLog;
  _mockFn;
  /**
  * Creates an instance of Consola with specified options or defaults.
  *
  * @param {Partial<ConsolaOptions>} [options={}] - Configuration options for the Consola instance.
  */
  constructor(options = {}) {
    const types = options.types || LogTypes;
    this.options = defu({
      ...options,
      defaults: { ...options.defaults },
      level: _normalizeLogLevel(options.level, types),
      reporters: [...options.reporters || []]
    }, {
      types: LogTypes,
      throttle: 1e3,
      throttleMin: 5,
      formatOptions: {
        date: true,
        colors: false,
        compact: true
      }
    });
    for (const type in types) {
      const defaults = {
        type,
        ...this.options.defaults,
        ...types[type]
      };
      this[type] = this._wrapLogFn(defaults);
      this[type].raw = this._wrapLogFn(defaults, true);
    }
    if (this.options.mockFn) this.mockTypes();
    this._lastLog = {};
  }
  /**
  * Gets the current log level of the Consola instance.
  *
  * @returns {number} The current log level.
  */
  get level() {
    return this.options.level;
  }
  /**
  * Sets the minimum log level that will be output by the instance.
  *
  * @param {number} level - The new log level to set.
  */
  set level(level) {
    this.options.level = _normalizeLogLevel(level, this.options.types, this.options.level);
  }
  /**
  * Displays a prompt to the user and returns the response.
  * Throw an error if `prompt` is not supported by the current configuration.
  *
  * @template T
  * @param {string} message - The message to display in the prompt.
  * @param {T} [opts] - Optional options for the prompt. See {@link PromptOptions}.
  * @returns {promise<T>} A promise that infer with the prompt options. See {@link PromptOptions}.
  */
  prompt(message2, opts) {
    if (!this.options.prompt) throw new Error("prompt is not supported!");
    return this.options.prompt(message2, opts);
  }
  /**
  * Creates a new instance of Consola, inheriting options from the current instance, with possible overrides.
  *
  * @param {Partial<ConsolaOptions>} options - Optional overrides for the new instance. See {@link ConsolaOptions}.
  * @returns {ConsolaInstance} A new Consola instance. See {@link ConsolaInstance}.
  */
  create(options) {
    const instance2 = new Consola2({
      ...this.options,
      ...options
    });
    if (this._mockFn) instance2.mockTypes(this._mockFn);
    return instance2;
  }
  /**
  * Creates a new Consola instance with the specified default log object properties.
  *
  * @param {InputLogObject} defaults - Default properties to include in any log from the new instance. See {@link InputLogObject}.
  * @returns {ConsolaInstance} A new Consola instance. See {@link ConsolaInstance}.
  */
  withDefaults(defaults) {
    return this.create({
      ...this.options,
      defaults: {
        ...this.options.defaults,
        ...defaults
      }
    });
  }
  /**
  * Creates a new Consola instance with a specified tag, which will be included in every log.
  *
  * @param {string} tag - The tag to include in each log of the new instance.
  * @returns {ConsolaInstance} A new Consola instance. See {@link ConsolaInstance}.
  */
  withTag(tag) {
    return this.withDefaults({ tag: this.options.defaults.tag ? this.options.defaults.tag + ":" + tag : tag });
  }
  /**
  * Adds a custom reporter to the Consola instance.
  * Reporters will be called for each log message, depending on their implementation and log level.
  *
  * @param {ConsolaReporter} reporter - The reporter to add. See {@link ConsolaReporter}.
  * @returns {Consola} The current Consola instance.
  */
  addReporter(reporter) {
    this.options.reporters.push(reporter);
    return this;
  }
  /**
  * Removes a custom reporter from the Consola instance.
  * If no reporter is specified, all reporters will be removed.
  *
  * @param {ConsolaReporter} reporter - The reporter to remove. See {@link ConsolaReporter}.
  * @returns {Consola} The current Consola instance.
  */
  removeReporter(reporter) {
    if (reporter) {
      const i2 = this.options.reporters.indexOf(reporter);
      if (i2 !== -1) return this.options.reporters.splice(i2, 1);
    } else this.options.reporters.splice(0);
    return this;
  }
  /**
  * Replaces all reporters of the Consola instance with the specified array of reporters.
  *
  * @param {ConsolaReporter[]} reporters - The new reporters to set. See {@link ConsolaReporter}.
  * @returns {Consola} The current Consola instance.
  */
  setReporters(reporters) {
    this.options.reporters = Array.isArray(reporters) ? reporters : [reporters];
    return this;
  }
  wrapAll() {
    this.wrapConsole();
    this.wrapStd();
  }
  restoreAll() {
    this.restoreConsole();
    this.restoreStd();
  }
  /**
  * Overrides console methods with Consola logging methods for consistent logging.
  */
  wrapConsole() {
    for (const type in this.options.types) {
      if (!console["__" + type]) console["__" + type] = console[type];
      console[type] = this[type].raw;
    }
  }
  /**
  * Restores the original console methods, removing Consola overrides.
  */
  restoreConsole() {
    for (const type in this.options.types) if (console["__" + type]) {
      console[type] = console["__" + type];
      delete console["__" + type];
    }
  }
  /**
  * Overrides standard output and error streams to redirect them through Consola.
  */
  wrapStd() {
    this._wrapStream(this.options.stdout, "log");
    this._wrapStream(this.options.stderr, "log");
  }
  _wrapStream(stream, type) {
    if (!stream) return;
    if (!stream.__write) stream.__write = stream.write;
    stream.write = (data) => {
      this[type].raw(String(data).trim());
    };
  }
  /**
  * Restores the original standard output and error streams, removing the Consola redirection.
  */
  restoreStd() {
    this._restoreStream(this.options.stdout);
    this._restoreStream(this.options.stderr);
  }
  _restoreStream(stream) {
    if (!stream) return;
    if (stream.__write) {
      stream.write = stream.__write;
      delete stream.__write;
    }
  }
  /**
  * Pauses logging, queues incoming logs until resumed.
  */
  pauseLogs() {
    paused = true;
  }
  /**
  * Resumes logging, processing any queued logs.
  */
  resumeLogs() {
    paused = false;
    const _queue = queue.splice(0);
    for (const item of _queue) item[0]._logFn(item[1], item[2]);
  }
  /**
  * Replaces logging methods with mocks if a mock function is provided.
  *
  * @param {ConsolaOptions["mockFn"]} mockFn - The function to use for mocking logging methods. See {@link ConsolaOptions["mockFn"]}.
  */
  mockTypes(mockFn) {
    const _mockFn = mockFn || this.options.mockFn;
    this._mockFn = _mockFn;
    if (typeof _mockFn !== "function") return;
    for (const type in this.options.types) {
      this[type] = _mockFn(type, this.options.types[type]) || this[type];
      this[type].raw = this[type];
    }
  }
  _wrapLogFn(defaults, isRaw) {
    return (...args2) => {
      if (paused) {
        queue.push([
          this,
          defaults,
          args2,
          isRaw
        ]);
        return;
      }
      return this._logFn(defaults, args2, isRaw);
    };
  }
  _logFn(defaults, args2, isRaw) {
    if ((defaults.level || 0) > this.level) return false;
    const logObj = {
      date: /* @__PURE__ */ new Date(),
      args: [],
      ...defaults,
      level: _normalizeLogLevel(defaults.level, this.options.types)
    };
    if (!isRaw && args2.length === 1 && isLogObj(args2[0])) Object.assign(logObj, args2[0]);
    else logObj.args = [...args2];
    if (logObj.message) {
      logObj.args.unshift(logObj.message);
      delete logObj.message;
    }
    if (logObj.additional) {
      if (!Array.isArray(logObj.additional)) logObj.additional = logObj.additional.split("\n");
      logObj.args.push("\n" + logObj.additional.join("\n"));
      delete logObj.additional;
    }
    logObj.type = typeof logObj.type === "string" ? logObj.type.toLowerCase() : "log";
    logObj.tag = typeof logObj.tag === "string" ? logObj.tag : "";
    const resolveLog = (newLog = false) => {
      const repeated = (this._lastLog.count || 0) - this.options.throttleMin;
      if (this._lastLog.object && repeated > 0) {
        const args22 = [...this._lastLog.object.args];
        if (repeated > 1) args22.push(`(repeated ${repeated} times)`);
        this._log({
          ...this._lastLog.object,
          args: args22
        });
        this._lastLog.count = 1;
      }
      if (newLog) {
        this._lastLog.object = logObj;
        this._log(logObj);
      }
    };
    clearTimeout(this._lastLog.timeout);
    const diffTime = this._lastLog.time && logObj.date ? logObj.date.getTime() - this._lastLog.time.getTime() : 0;
    this._lastLog.time = logObj.date;
    if (diffTime < this.options.throttle) try {
      const serializedLog = JSON.stringify([
        logObj.type,
        logObj.tag,
        logObj.args
      ]);
      const isSameLog = this._lastLog.serialized === serializedLog;
      this._lastLog.serialized = serializedLog;
      if (isSameLog) {
        this._lastLog.count = (this._lastLog.count || 0) + 1;
        if (this._lastLog.count > this.options.throttleMin) {
          this._lastLog.timeout = setTimeout(resolveLog, this.options.throttle);
          return;
        }
      }
    } catch {
    }
    resolveLog(true);
  }
  _log(logObj) {
    for (const reporter of this.options.reporters) reporter.log(logObj, { options: this.options });
  }
};
function _normalizeLogLevel(input, types = {}, defaultLevel = 3) {
  if (input === void 0) return defaultLevel;
  if (typeof input === "number") return input;
  if (types[input] && types[input].level !== void 0) return types[input].level;
  return defaultLevel;
}
Consola.prototype.add = Consola.prototype.addReporter;
Consola.prototype.remove = Consola.prototype.removeReporter;
Consola.prototype.clear = Consola.prototype.removeReporter;
Consola.prototype.withScope = Consola.prototype.withTag;
Consola.prototype.mock = Consola.prototype.mockTypes;
Consola.prototype.pause = Consola.prototype.pauseLogs;
Consola.prototype.resume = Consola.prototype.resumeLogs;
function createConsola$1(options = {}) {
  return new Consola(options);
}
function parseStack(stack, message2) {
  const cwd2 = process.cwd() + sep;
  return stack.split("\n").splice(message2.split("\n").length).map((l2) => l2.trim().replace("file://", "").replace(cwd2, ""));
}
function writeStream(data, stream) {
  return (stream.__write || stream.write).call(stream, data);
}
var bracket = (x2) => x2 ? `[${x2}]` : "";
var BasicReporter = class {
  formatStack(stack, message2, opts) {
    const indent = "  ".repeat((opts?.errorLevel || 0) + 1);
    return indent + parseStack(stack, message2).join(`
${indent}`);
  }
  formatError(err, opts) {
    const message2 = err.message ?? formatWithOptions(opts, err);
    const stack = err.stack ? this.formatStack(err.stack, message2, opts) : "";
    const level = opts?.errorLevel || 0;
    const causedPrefix = level > 0 ? `${"  ".repeat(level)}[cause]: ` : "";
    const causedError = err.cause ? "\n\n" + this.formatError(err.cause, {
      ...opts,
      errorLevel: level + 1
    }) : "";
    return causedPrefix + message2 + "\n" + stack + causedError;
  }
  formatArgs(args2, opts) {
    const _args = args2.map((arg) => {
      if (arg && typeof arg.stack === "string") return this.formatError(arg, opts);
      return arg;
    });
    return formatWithOptions(opts, ..._args);
  }
  formatDate(date, opts) {
    return opts.date ? date.toLocaleTimeString() : "";
  }
  filterAndJoin(arr) {
    return arr.filter(Boolean).join(" ");
  }
  formatLogObj(logObj, opts) {
    const message2 = this.formatArgs(logObj.args, opts);
    if (logObj.type === "box") return "\n" + [
      bracket(logObj.tag),
      logObj.title && logObj.title,
      ...message2.split("\n")
    ].filter(Boolean).map((l2) => " > " + l2).join("\n") + "\n";
    return this.filterAndJoin([
      bracket(logObj.type),
      bracket(logObj.tag),
      message2
    ]);
  }
  log(logObj, ctx) {
    return writeStream(this.formatLogObj(logObj, {
      columns: ctx.options.stdout.columns || 0,
      ...ctx.options.formatOptions
    }) + "\n", logObj.level < 2 ? ctx.options.stderr || process.stderr : ctx.options.stdout || process.stdout);
  }
};
var { env: env2 = {}, argv: argv2 = [], platform: platform2 = "" } = typeof process === "undefined" ? {} : process;
var isDisabled = "NO_COLOR" in env2 || argv2.includes("--no-color");
var isForced = "FORCE_COLOR" in env2 || argv2.includes("--color");
var isWindows = platform2 === "win32";
var isDumbTerminal = env2.TERM === "dumb";
var isCompatibleTerminal = shims_exports && isatty && isatty(1) && env2.TERM && !isDumbTerminal;
var isCI = "CI" in env2 && ("GITHUB_ACTIONS" in env2 || "GITLAB_CI" in env2 || "CIRCLECI" in env2);
var isColorSupported = !isDisabled && (isForced || isWindows && !isDumbTerminal || isCompatibleTerminal || isCI);
function replaceClose(index, string2, close, replace, head = string2.slice(0, Math.max(0, index)) + replace, tail = string2.slice(Math.max(0, index + close.length)), next = tail.indexOf(close)) {
  return head + (next < 0 ? tail : replaceClose(next, tail, close, replace));
}
function clearBleed(index, string2, open, close, replace) {
  return index < 0 ? open + string2 + close : open + replaceClose(index, string2, close, replace) + close;
}
function filterEmpty(open, close, replace = open, at = open.length + 1) {
  return (string2) => string2 || !(string2 === "" || string2 === void 0) ? clearBleed(("" + string2).indexOf(close, at), string2, open, close, replace) : "";
}
function init(open, close, replace) {
  return filterEmpty(`\x1B[${open}m`, `\x1B[${close}m`, replace);
}
var colorDefs = {
  reset: init(0, 0),
  bold: init(1, 22, "\x1B[22m\x1B[1m"),
  dim: init(2, 22, "\x1B[22m\x1B[2m"),
  italic: init(3, 23),
  underline: init(4, 24),
  inverse: init(7, 27),
  hidden: init(8, 28),
  strikethrough: init(9, 29),
  black: init(30, 39),
  red: init(31, 39),
  green: init(32, 39),
  yellow: init(33, 39),
  blue: init(34, 39),
  magenta: init(35, 39),
  cyan: init(36, 39),
  white: init(37, 39),
  gray: init(90, 39),
  bgBlack: init(40, 49),
  bgRed: init(41, 49),
  bgGreen: init(42, 49),
  bgYellow: init(43, 49),
  bgBlue: init(44, 49),
  bgMagenta: init(45, 49),
  bgCyan: init(46, 49),
  bgWhite: init(47, 49),
  blackBright: init(90, 39),
  redBright: init(91, 39),
  greenBright: init(92, 39),
  yellowBright: init(93, 39),
  blueBright: init(94, 39),
  magentaBright: init(95, 39),
  cyanBright: init(96, 39),
  whiteBright: init(97, 39),
  bgBlackBright: init(100, 49),
  bgRedBright: init(101, 49),
  bgGreenBright: init(102, 49),
  bgYellowBright: init(103, 49),
  bgBlueBright: init(104, 49),
  bgMagentaBright: init(105, 49),
  bgCyanBright: init(106, 49),
  bgWhiteBright: init(107, 49)
};
function createColors(useColor = isColorSupported) {
  return useColor ? colorDefs : Object.fromEntries(Object.keys(colorDefs).map((key) => [key, String]));
}
var colors = createColors();
function getColor$1(color, fallback = "reset") {
  return colors[color] || colors[fallback];
}
var ansiRegex$1 = [String.raw`[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)`, String.raw`(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))`].join("|");
function stripAnsi$1(text) {
  return text.replace(new RegExp(ansiRegex$1, "g"), "");
}
var boxStylePresets = {
  solid: {
    tl: "\u250C",
    tr: "\u2510",
    bl: "\u2514",
    br: "\u2518",
    h: "\u2500",
    v: "\u2502"
  },
  double: {
    tl: "\u2554",
    tr: "\u2557",
    bl: "\u255A",
    br: "\u255D",
    h: "\u2550",
    v: "\u2551"
  },
  doubleSingle: {
    tl: "\u2553",
    tr: "\u2556",
    bl: "\u2559",
    br: "\u255C",
    h: "\u2500",
    v: "\u2551"
  },
  doubleSingleRounded: {
    tl: "\u256D",
    tr: "\u256E",
    bl: "\u2570",
    br: "\u256F",
    h: "\u2500",
    v: "\u2551"
  },
  singleThick: {
    tl: "\u250F",
    tr: "\u2513",
    bl: "\u2517",
    br: "\u251B",
    h: "\u2501",
    v: "\u2503"
  },
  singleDouble: {
    tl: "\u2552",
    tr: "\u2555",
    bl: "\u2558",
    br: "\u255B",
    h: "\u2550",
    v: "\u2502"
  },
  singleDoubleRounded: {
    tl: "\u256D",
    tr: "\u256E",
    bl: "\u2570",
    br: "\u256F",
    h: "\u2550",
    v: "\u2502"
  },
  rounded: {
    tl: "\u256D",
    tr: "\u256E",
    bl: "\u2570",
    br: "\u256F",
    h: "\u2500",
    v: "\u2502"
  }
};
var defaultStyle = {
  borderColor: "white",
  borderStyle: "rounded",
  valign: "center",
  padding: 2,
  marginLeft: 1,
  marginTop: 1,
  marginBottom: 1
};
function box(text, _opts = {}) {
  const opts = {
    ..._opts,
    style: {
      ...defaultStyle,
      ..._opts.style
    }
  };
  const textLines = text.split("\n");
  const boxLines = [];
  const _color = getColor$1(opts.style.borderColor);
  const borderStyle = { ...typeof opts.style.borderStyle === "string" ? boxStylePresets[opts.style.borderStyle] || boxStylePresets.solid : opts.style.borderStyle };
  if (_color) for (const key in borderStyle) borderStyle[key] = _color(borderStyle[key]);
  const paddingOffset = opts.style.padding % 2 === 0 ? opts.style.padding : opts.style.padding + 1;
  const height = textLines.length + paddingOffset;
  const width = Math.max(...textLines.map((line) => stripAnsi$1(line).length), opts.title ? stripAnsi$1(opts.title).length : 0) + paddingOffset;
  const widthOffset = width + paddingOffset;
  const leftSpace = opts.style.marginLeft > 0 ? " ".repeat(opts.style.marginLeft) : "";
  if (opts.style.marginTop > 0) boxLines.push("".repeat(opts.style.marginTop));
  if (opts.title) {
    const title = _color ? _color(opts.title) : opts.title;
    const left = borderStyle.h.repeat(Math.floor((width - stripAnsi$1(opts.title).length) / 2));
    const right = borderStyle.h.repeat(width - stripAnsi$1(opts.title).length - stripAnsi$1(left).length + paddingOffset);
    boxLines.push(`${leftSpace}${borderStyle.tl}${left}${title}${right}${borderStyle.tr}`);
  } else boxLines.push(`${leftSpace}${borderStyle.tl}${borderStyle.h.repeat(widthOffset)}${borderStyle.tr}`);
  const valignOffset = opts.style.valign === "center" ? Math.floor((height - textLines.length) / 2) : opts.style.valign === "top" ? height - textLines.length - paddingOffset : height - textLines.length;
  for (let i2 = 0; i2 < height; i2++) if (i2 < valignOffset || i2 >= valignOffset + textLines.length) boxLines.push(`${leftSpace}${borderStyle.v}${" ".repeat(widthOffset)}${borderStyle.v}`);
  else {
    const line = textLines[i2 - valignOffset];
    const left = " ".repeat(paddingOffset);
    const right = " ".repeat(width - stripAnsi$1(line).length);
    boxLines.push(`${leftSpace}${borderStyle.v}${left}${line}${right}${borderStyle.v}`);
  }
  boxLines.push(`${leftSpace}${borderStyle.bl}${borderStyle.h.repeat(widthOffset)}${borderStyle.br}`);
  if (opts.style.marginBottom > 0) boxLines.push("".repeat(opts.style.marginBottom));
  return boxLines.join("\n");
}
var r2 = /* @__PURE__ */ Object.create(null);
var i = (e3) => globalThis.process?.env || import.meta.env || globalThis.Deno?.env.toObject() || globalThis.__env__ || (e3 ? r2 : globalThis);
var o2 = new Proxy(r2, {
  get(e3, s2) {
    return i()[s2] ?? r2[s2];
  },
  has(e3, s2) {
    return s2 in i() || s2 in r2;
  },
  set(e3, s2, E) {
    const B2 = i(true);
    return B2[s2] = E, true;
  },
  deleteProperty(e3, s2) {
    if (!s2) return false;
    const E = i(true);
    return delete E[s2], true;
  },
  ownKeys() {
    const e3 = i(true);
    return Object.keys(e3);
  }
});
var t4 = typeof process < "u" && process.env && process.env.NODE_ENV || "";
var f = [
  ["APPVEYOR"],
  [
    "AWS_AMPLIFY",
    "AWS_APP_ID",
    { ci: true }
  ],
  ["AZURE_PIPELINES", "SYSTEM_TEAMFOUNDATIONCOLLECTIONURI"],
  ["AZURE_STATIC", "INPUT_AZURE_STATIC_WEB_APPS_API_TOKEN"],
  ["APPCIRCLE", "AC_APPCIRCLE"],
  ["BAMBOO", "bamboo_planKey"],
  ["BITBUCKET", "BITBUCKET_COMMIT"],
  ["BITRISE", "BITRISE_IO"],
  ["BUDDY", "BUDDY_WORKSPACE_ID"],
  ["BUILDKITE"],
  ["CIRCLE", "CIRCLECI"],
  ["CIRRUS", "CIRRUS_CI"],
  [
    "CLOUDFLARE_PAGES",
    "CF_PAGES",
    { ci: true }
  ],
  ["CODEBUILD", "CODEBUILD_BUILD_ARN"],
  ["CODEFRESH", "CF_BUILD_ID"],
  ["DRONE"],
  ["DRONE", "DRONE_BUILD_EVENT"],
  ["DSARI"],
  ["GITHUB_ACTIONS"],
  ["GITLAB", "GITLAB_CI"],
  ["GITLAB", "CI_MERGE_REQUEST_ID"],
  ["GOCD", "GO_PIPELINE_LABEL"],
  ["LAYERCI"],
  ["HUDSON", "HUDSON_URL"],
  ["JENKINS", "JENKINS_URL"],
  ["MAGNUM"],
  ["NETLIFY"],
  [
    "NETLIFY",
    "NETLIFY_LOCAL",
    { ci: false }
  ],
  ["NEVERCODE"],
  ["RENDER"],
  ["SAIL", "SAILCI"],
  ["SEMAPHORE"],
  ["SCREWDRIVER"],
  ["SHIPPABLE"],
  ["SOLANO", "TDDIUM"],
  ["STRIDER"],
  ["TEAMCITY", "TEAMCITY_VERSION"],
  ["TRAVIS"],
  ["VERCEL", "NOW_BUILDER"],
  [
    "VERCEL",
    "VERCEL",
    { ci: false }
  ],
  [
    "VERCEL",
    "VERCEL_ENV",
    { ci: false }
  ],
  ["APPCENTER", "APPCENTER_BUILD_ID"],
  [
    "CODESANDBOX",
    "CODESANDBOX_SSE",
    { ci: false }
  ],
  [
    "CODESANDBOX",
    "CODESANDBOX_HOST",
    { ci: false }
  ],
  ["STACKBLITZ"],
  ["STORMKIT"],
  ["CLEAVR"],
  ["ZEABUR"],
  [
    "CODESPHERE",
    "CODESPHERE_APP_ID",
    { ci: true }
  ],
  ["RAILWAY", "RAILWAY_PROJECT_ID"],
  ["RAILWAY", "RAILWAY_SERVICE_ID"],
  ["DENO-DEPLOY", "DENO_DEPLOYMENT_ID"],
  [
    "FIREBASE_APP_HOSTING",
    "FIREBASE_APP_HOSTING",
    { ci: true }
  ]
];
function b() {
  if (globalThis.process?.env) for (const e3 of f) {
    const s2 = e3[1] || e3[0];
    if (globalThis.process?.env[s2]) return {
      name: e3[0].toLowerCase(),
      ...e3[2]
    };
  }
  return globalThis.process?.env?.SHELL === "/bin/jsh" && globalThis.process?.versions?.webcontainer ? {
    name: "stackblitz",
    ci: false
  } : {
    name: "",
    ci: false
  };
}
var l = b();
l.name;
function n4(e3) {
  return e3 ? e3 !== "false" : false;
}
var I2 = globalThis.process?.platform || "";
var T2 = n4(o2.CI) || l.ci !== false;
var a = n4(globalThis.process?.stdout && globalThis.process?.stdout.isTTY);
var g = n4(o2.DEBUG);
var R2 = t4 === "test" || n4(o2.TEST);
o2.MINIMAL;
var A2 = /^win/i.test(I2);
!n4(o2.NO_COLOR) && (n4(o2.FORCE_COLOR) || (a || A2) && o2.TERM);
var C2 = (globalThis.process?.versions?.node || "").replace(/^v/, "") || null;
Number(C2?.split(".")[0]);
var y2 = globalThis.process || /* @__PURE__ */ Object.create(null);
var _2 = { versions: {} };
new Proxy(y2, { get(e3, s2) {
  if (s2 === "env") return o2;
  if (s2 in e3) return e3[s2];
  if (s2 in _2) return _2[s2];
} });
var c2 = globalThis.process?.release?.name === "node";
var O2 = !!globalThis.Bun || !!globalThis.process?.versions?.bun;
var D = !!globalThis.Deno;
var L2 = !!globalThis.fastly;
var S2 = !!globalThis.Netlify;
var u2 = !!globalThis.EdgeRuntime;
var N2 = globalThis.navigator?.userAgent === "Cloudflare-Workers";
var F2 = [
  [S2, "netlify"],
  [u2, "edge-light"],
  [N2, "workerd"],
  [L2, "fastly"],
  [D, "deno"],
  [O2, "bun"],
  [c2, "node"]
];
function G2() {
  const e3 = F2.find((s2) => s2[0]);
  if (e3) return { name: e3[1] };
}
G2()?.name;
function ansiRegex({ onlyFirst = false } = {}) {
  const pattern = [`[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?(?:\\u0007|\\u001B\\u005C|\\u009C))`, "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))"].join("|");
  return new RegExp(pattern, onlyFirst ? void 0 : "g");
}
var regex = ansiRegex();
function stripAnsi(string2) {
  if (typeof string2 !== "string") throw new TypeError(`Expected a \`string\`, got \`${typeof string2}\``);
  return string2.replace(regex, "");
}
function isAmbiguous(x2) {
  return x2 === 161 || x2 === 164 || x2 === 167 || x2 === 168 || x2 === 170 || x2 === 173 || x2 === 174 || x2 >= 176 && x2 <= 180 || x2 >= 182 && x2 <= 186 || x2 >= 188 && x2 <= 191 || x2 === 198 || x2 === 208 || x2 === 215 || x2 === 216 || x2 >= 222 && x2 <= 225 || x2 === 230 || x2 >= 232 && x2 <= 234 || x2 === 236 || x2 === 237 || x2 === 240 || x2 === 242 || x2 === 243 || x2 >= 247 && x2 <= 250 || x2 === 252 || x2 === 254 || x2 === 257 || x2 === 273 || x2 === 275 || x2 === 283 || x2 === 294 || x2 === 295 || x2 === 299 || x2 >= 305 && x2 <= 307 || x2 === 312 || x2 >= 319 && x2 <= 322 || x2 === 324 || x2 >= 328 && x2 <= 331 || x2 === 333 || x2 === 338 || x2 === 339 || x2 === 358 || x2 === 359 || x2 === 363 || x2 === 462 || x2 === 464 || x2 === 466 || x2 === 468 || x2 === 470 || x2 === 472 || x2 === 474 || x2 === 476 || x2 === 593 || x2 === 609 || x2 === 708 || x2 === 711 || x2 >= 713 && x2 <= 715 || x2 === 717 || x2 === 720 || x2 >= 728 && x2 <= 731 || x2 === 733 || x2 === 735 || x2 >= 768 && x2 <= 879 || x2 >= 913 && x2 <= 929 || x2 >= 931 && x2 <= 937 || x2 >= 945 && x2 <= 961 || x2 >= 963 && x2 <= 969 || x2 === 1025 || x2 >= 1040 && x2 <= 1103 || x2 === 1105 || x2 === 8208 || x2 >= 8211 && x2 <= 8214 || x2 === 8216 || x2 === 8217 || x2 === 8220 || x2 === 8221 || x2 >= 8224 && x2 <= 8226 || x2 >= 8228 && x2 <= 8231 || x2 === 8240 || x2 === 8242 || x2 === 8243 || x2 === 8245 || x2 === 8251 || x2 === 8254 || x2 === 8308 || x2 === 8319 || x2 >= 8321 && x2 <= 8324 || x2 === 8364 || x2 === 8451 || x2 === 8453 || x2 === 8457 || x2 === 8467 || x2 === 8470 || x2 === 8481 || x2 === 8482 || x2 === 8486 || x2 === 8491 || x2 === 8531 || x2 === 8532 || x2 >= 8539 && x2 <= 8542 || x2 >= 8544 && x2 <= 8555 || x2 >= 8560 && x2 <= 8569 || x2 === 8585 || x2 >= 8592 && x2 <= 8601 || x2 === 8632 || x2 === 8633 || x2 === 8658 || x2 === 8660 || x2 === 8679 || x2 === 8704 || x2 === 8706 || x2 === 8707 || x2 === 8711 || x2 === 8712 || x2 === 8715 || x2 === 8719 || x2 === 8721 || x2 === 8725 || x2 === 8730 || x2 >= 8733 && x2 <= 8736 || x2 === 8739 || x2 === 8741 || x2 >= 8743 && x2 <= 8748 || x2 === 8750 || x2 >= 8756 && x2 <= 8759 || x2 === 8764 || x2 === 8765 || x2 === 8776 || x2 === 8780 || x2 === 8786 || x2 === 8800 || x2 === 8801 || x2 >= 8804 && x2 <= 8807 || x2 === 8810 || x2 === 8811 || x2 === 8814 || x2 === 8815 || x2 === 8834 || x2 === 8835 || x2 === 8838 || x2 === 8839 || x2 === 8853 || x2 === 8857 || x2 === 8869 || x2 === 8895 || x2 === 8978 || x2 >= 9312 && x2 <= 9449 || x2 >= 9451 && x2 <= 9547 || x2 >= 9552 && x2 <= 9587 || x2 >= 9600 && x2 <= 9615 || x2 >= 9618 && x2 <= 9621 || x2 === 9632 || x2 === 9633 || x2 >= 9635 && x2 <= 9641 || x2 === 9650 || x2 === 9651 || x2 === 9654 || x2 === 9655 || x2 === 9660 || x2 === 9661 || x2 === 9664 || x2 === 9665 || x2 >= 9670 && x2 <= 9672 || x2 === 9675 || x2 >= 9678 && x2 <= 9681 || x2 >= 9698 && x2 <= 9701 || x2 === 9711 || x2 === 9733 || x2 === 9734 || x2 === 9737 || x2 === 9742 || x2 === 9743 || x2 === 9756 || x2 === 9758 || x2 === 9792 || x2 === 9794 || x2 === 9824 || x2 === 9825 || x2 >= 9827 && x2 <= 9829 || x2 >= 9831 && x2 <= 9834 || x2 === 9836 || x2 === 9837 || x2 === 9839 || x2 === 9886 || x2 === 9887 || x2 === 9919 || x2 >= 9926 && x2 <= 9933 || x2 >= 9935 && x2 <= 9939 || x2 >= 9941 && x2 <= 9953 || x2 === 9955 || x2 === 9960 || x2 === 9961 || x2 >= 9963 && x2 <= 9969 || x2 === 9972 || x2 >= 9974 && x2 <= 9977 || x2 === 9979 || x2 === 9980 || x2 === 9982 || x2 === 9983 || x2 === 10045 || x2 >= 10102 && x2 <= 10111 || x2 >= 11094 && x2 <= 11097 || x2 >= 12872 && x2 <= 12879 || x2 >= 57344 && x2 <= 63743 || x2 >= 65024 && x2 <= 65039 || x2 === 65533 || x2 >= 127232 && x2 <= 127242 || x2 >= 127248 && x2 <= 127277 || x2 >= 127280 && x2 <= 127337 || x2 >= 127344 && x2 <= 127373 || x2 === 127375 || x2 === 127376 || x2 >= 127387 && x2 <= 127404 || x2 >= 917760 && x2 <= 917999 || x2 >= 983040 && x2 <= 1048573 || x2 >= 1048576 && x2 <= 1114109;
}
function isFullWidth(x2) {
  return x2 === 12288 || x2 >= 65281 && x2 <= 65376 || x2 >= 65504 && x2 <= 65510;
}
function isWide(x2) {
  return x2 >= 4352 && x2 <= 4447 || x2 === 8986 || x2 === 8987 || x2 === 9001 || x2 === 9002 || x2 >= 9193 && x2 <= 9196 || x2 === 9200 || x2 === 9203 || x2 === 9725 || x2 === 9726 || x2 === 9748 || x2 === 9749 || x2 >= 9776 && x2 <= 9783 || x2 >= 9800 && x2 <= 9811 || x2 === 9855 || x2 >= 9866 && x2 <= 9871 || x2 === 9875 || x2 === 9889 || x2 === 9898 || x2 === 9899 || x2 === 9917 || x2 === 9918 || x2 === 9924 || x2 === 9925 || x2 === 9934 || x2 === 9940 || x2 === 9962 || x2 === 9970 || x2 === 9971 || x2 === 9973 || x2 === 9978 || x2 === 9981 || x2 === 9989 || x2 === 9994 || x2 === 9995 || x2 === 10024 || x2 === 10060 || x2 === 10062 || x2 >= 10067 && x2 <= 10069 || x2 === 10071 || x2 >= 10133 && x2 <= 10135 || x2 === 10160 || x2 === 10175 || x2 === 11035 || x2 === 11036 || x2 === 11088 || x2 === 11093 || x2 >= 11904 && x2 <= 11929 || x2 >= 11931 && x2 <= 12019 || x2 >= 12032 && x2 <= 12245 || x2 >= 12272 && x2 <= 12287 || x2 >= 12289 && x2 <= 12350 || x2 >= 12353 && x2 <= 12438 || x2 >= 12441 && x2 <= 12543 || x2 >= 12549 && x2 <= 12591 || x2 >= 12593 && x2 <= 12686 || x2 >= 12688 && x2 <= 12773 || x2 >= 12783 && x2 <= 12830 || x2 >= 12832 && x2 <= 12871 || x2 >= 12880 && x2 <= 42124 || x2 >= 42128 && x2 <= 42182 || x2 >= 43360 && x2 <= 43388 || x2 >= 44032 && x2 <= 55203 || x2 >= 63744 && x2 <= 64255 || x2 >= 65040 && x2 <= 65049 || x2 >= 65072 && x2 <= 65106 || x2 >= 65108 && x2 <= 65126 || x2 >= 65128 && x2 <= 65131 || x2 >= 94176 && x2 <= 94180 || x2 === 94192 || x2 === 94193 || x2 >= 94208 && x2 <= 100343 || x2 >= 100352 && x2 <= 101589 || x2 >= 101631 && x2 <= 101640 || x2 >= 110576 && x2 <= 110579 || x2 >= 110581 && x2 <= 110587 || x2 === 110589 || x2 === 110590 || x2 >= 110592 && x2 <= 110882 || x2 === 110898 || x2 >= 110928 && x2 <= 110930 || x2 === 110933 || x2 >= 110948 && x2 <= 110951 || x2 >= 110960 && x2 <= 111355 || x2 >= 119552 && x2 <= 119638 || x2 >= 119648 && x2 <= 119670 || x2 === 126980 || x2 === 127183 || x2 === 127374 || x2 >= 127377 && x2 <= 127386 || x2 >= 127488 && x2 <= 127490 || x2 >= 127504 && x2 <= 127547 || x2 >= 127552 && x2 <= 127560 || x2 === 127568 || x2 === 127569 || x2 >= 127584 && x2 <= 127589 || x2 >= 127744 && x2 <= 127776 || x2 >= 127789 && x2 <= 127797 || x2 >= 127799 && x2 <= 127868 || x2 >= 127870 && x2 <= 127891 || x2 >= 127904 && x2 <= 127946 || x2 >= 127951 && x2 <= 127955 || x2 >= 127968 && x2 <= 127984 || x2 === 127988 || x2 >= 127992 && x2 <= 128062 || x2 === 128064 || x2 >= 128066 && x2 <= 128252 || x2 >= 128255 && x2 <= 128317 || x2 >= 128331 && x2 <= 128334 || x2 >= 128336 && x2 <= 128359 || x2 === 128378 || x2 === 128405 || x2 === 128406 || x2 === 128420 || x2 >= 128507 && x2 <= 128591 || x2 >= 128640 && x2 <= 128709 || x2 === 128716 || x2 >= 128720 && x2 <= 128722 || x2 >= 128725 && x2 <= 128727 || x2 >= 128732 && x2 <= 128735 || x2 === 128747 || x2 === 128748 || x2 >= 128756 && x2 <= 128764 || x2 >= 128992 && x2 <= 129003 || x2 === 129008 || x2 >= 129292 && x2 <= 129338 || x2 >= 129340 && x2 <= 129349 || x2 >= 129351 && x2 <= 129535 || x2 >= 129648 && x2 <= 129660 || x2 >= 129664 && x2 <= 129673 || x2 >= 129679 && x2 <= 129734 || x2 >= 129742 && x2 <= 129756 || x2 >= 129759 && x2 <= 129769 || x2 >= 129776 && x2 <= 129784 || x2 >= 131072 && x2 <= 196605 || x2 >= 196608 && x2 <= 262141;
}
function validate(codePoint) {
  if (!Number.isSafeInteger(codePoint)) throw new TypeError(`Expected a code point, got \`${typeof codePoint}\`.`);
}
function eastAsianWidth(codePoint, { ambiguousAsWide = false } = {}) {
  validate(codePoint);
  if (isFullWidth(codePoint) || isWide(codePoint) || ambiguousAsWide && isAmbiguous(codePoint)) return 2;
  return 1;
}
var emojiRegex = () => {
  return /[#*0-9]\uFE0F?\u20E3|[\xA9\xAE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u231A\u231B\u2328\u23CF\u23ED-\u23EF\u23F1\u23F2\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB\u25FC\u25FE\u2600-\u2604\u260E\u2611\u2614\u2615\u2618\u2620\u2622\u2623\u2626\u262A\u262E\u262F\u2638-\u263A\u2640\u2642\u2648-\u2653\u265F\u2660\u2663\u2665\u2666\u2668\u267B\u267E\u267F\u2692\u2694-\u2697\u2699\u269B\u269C\u26A0\u26A7\u26AA\u26B0\u26B1\u26BD\u26BE\u26C4\u26C8\u26CF\u26D1\u26E9\u26F0-\u26F5\u26F7\u26F8\u26FA\u2702\u2708\u2709\u270F\u2712\u2714\u2716\u271D\u2721\u2733\u2734\u2744\u2747\u2757\u2763\u27A1\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B55\u3030\u303D\u3297\u3299]\uFE0F?|[\u261D\u270C\u270D](?:\uD83C[\uDFFB-\uDFFF]|\uFE0F)?|[\u270A\u270B](?:\uD83C[\uDFFB-\uDFFF])?|[\u23E9-\u23EC\u23F0\u23F3\u25FD\u2693\u26A1\u26AB\u26C5\u26CE\u26D4\u26EA\u26FD\u2705\u2728\u274C\u274E\u2753-\u2755\u2795-\u2797\u27B0\u27BF\u2B50]|\u26D3\uFE0F?(?:\u200D\uD83D\uDCA5)?|\u26F9(?:\uD83C[\uDFFB-\uDFFF]|\uFE0F)?(?:\u200D[\u2640\u2642]\uFE0F?)?|\u2764\uFE0F?(?:\u200D(?:\uD83D\uDD25|\uD83E\uDE79))?|\uD83C(?:[\uDC04\uDD70\uDD71\uDD7E\uDD7F\uDE02\uDE37\uDF21\uDF24-\uDF2C\uDF36\uDF7D\uDF96\uDF97\uDF99-\uDF9B\uDF9E\uDF9F\uDFCD\uDFCE\uDFD4-\uDFDF\uDFF5\uDFF7]\uFE0F?|[\uDF85\uDFC2\uDFC7](?:\uD83C[\uDFFB-\uDFFF])?|[\uDFC4\uDFCA](?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDFCB\uDFCC](?:\uD83C[\uDFFB-\uDFFF]|\uFE0F)?(?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDCCF\uDD8E\uDD91-\uDD9A\uDE01\uDE1A\uDE2F\uDE32-\uDE36\uDE38-\uDE3A\uDE50\uDE51\uDF00-\uDF20\uDF2D-\uDF35\uDF37-\uDF43\uDF45-\uDF4A\uDF4C-\uDF7C\uDF7E-\uDF84\uDF86-\uDF93\uDFA0-\uDFC1\uDFC5\uDFC6\uDFC8\uDFC9\uDFCF-\uDFD3\uDFE0-\uDFF0\uDFF8-\uDFFF]|\uDDE6\uD83C[\uDDE8-\uDDEC\uDDEE\uDDF1\uDDF2\uDDF4\uDDF6-\uDDFA\uDDFC\uDDFD\uDDFF]|\uDDE7\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEF\uDDF1-\uDDF4\uDDF6-\uDDF9\uDDFB\uDDFC\uDDFE\uDDFF]|\uDDE8\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDEE\uDDF0-\uDDF7\uDDFA-\uDDFF]|\uDDE9\uD83C[\uDDEA\uDDEC\uDDEF\uDDF0\uDDF2\uDDF4\uDDFF]|\uDDEA\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDED\uDDF7-\uDDFA]|\uDDEB\uD83C[\uDDEE-\uDDF0\uDDF2\uDDF4\uDDF7]|\uDDEC\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEE\uDDF1-\uDDF3\uDDF5-\uDDFA\uDDFC\uDDFE]|\uDDED\uD83C[\uDDF0\uDDF2\uDDF3\uDDF7\uDDF9\uDDFA]|\uDDEE\uD83C[\uDDE8-\uDDEA\uDDF1-\uDDF4\uDDF6-\uDDF9]|\uDDEF\uD83C[\uDDEA\uDDF2\uDDF4\uDDF5]|\uDDF0\uD83C[\uDDEA\uDDEC-\uDDEE\uDDF2\uDDF3\uDDF5\uDDF7\uDDFC\uDDFE\uDDFF]|\uDDF1\uD83C[\uDDE6-\uDDE8\uDDEE\uDDF0\uDDF7-\uDDFB\uDDFE]|\uDDF2\uD83C[\uDDE6\uDDE8-\uDDED\uDDF0-\uDDFF]|\uDDF3\uD83C[\uDDE6\uDDE8\uDDEA-\uDDEC\uDDEE\uDDF1\uDDF4\uDDF5\uDDF7\uDDFA\uDDFF]|\uDDF4\uD83C\uDDF2|\uDDF5\uD83C[\uDDE6\uDDEA-\uDDED\uDDF0-\uDDF3\uDDF7-\uDDF9\uDDFC\uDDFE]|\uDDF6\uD83C\uDDE6|\uDDF7\uD83C[\uDDEA\uDDF4\uDDF8\uDDFA\uDDFC]|\uDDF8\uD83C[\uDDE6-\uDDEA\uDDEC-\uDDF4\uDDF7-\uDDF9\uDDFB\uDDFD-\uDDFF]|\uDDF9\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDED\uDDEF-\uDDF4\uDDF7\uDDF9\uDDFB\uDDFC\uDDFF]|\uDDFA\uD83C[\uDDE6\uDDEC\uDDF2\uDDF3\uDDF8\uDDFE\uDDFF]|\uDDFB\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDEE\uDDF3\uDDFA]|\uDDFC\uD83C[\uDDEB\uDDF8]|\uDDFD\uD83C\uDDF0|\uDDFE\uD83C[\uDDEA\uDDF9]|\uDDFF\uD83C[\uDDE6\uDDF2\uDDFC]|\uDF44(?:\u200D\uD83D\uDFEB)?|\uDF4B(?:\u200D\uD83D\uDFE9)?|\uDFC3(?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D(?:[\u2640\u2642]\uFE0F?(?:\u200D\u27A1\uFE0F?)?|\u27A1\uFE0F?))?|\uDFF3\uFE0F?(?:\u200D(?:\u26A7\uFE0F?|\uD83C\uDF08))?|\uDFF4(?:\u200D\u2620\uFE0F?|\uDB40\uDC67\uDB40\uDC62\uDB40(?:\uDC65\uDB40\uDC6E\uDB40\uDC67|\uDC73\uDB40\uDC63\uDB40\uDC74|\uDC77\uDB40\uDC6C\uDB40\uDC73)\uDB40\uDC7F)?)|\uD83D(?:[\uDC3F\uDCFD\uDD49\uDD4A\uDD6F\uDD70\uDD73\uDD76-\uDD79\uDD87\uDD8A-\uDD8D\uDDA5\uDDA8\uDDB1\uDDB2\uDDBC\uDDC2-\uDDC4\uDDD1-\uDDD3\uDDDC-\uDDDE\uDDE1\uDDE3\uDDE8\uDDEF\uDDF3\uDDFA\uDECB\uDECD-\uDECF\uDEE0-\uDEE5\uDEE9\uDEF0\uDEF3]\uFE0F?|[\uDC42\uDC43\uDC46-\uDC50\uDC66\uDC67\uDC6B-\uDC6D\uDC72\uDC74-\uDC76\uDC78\uDC7C\uDC83\uDC85\uDC8F\uDC91\uDCAA\uDD7A\uDD95\uDD96\uDE4C\uDE4F\uDEC0\uDECC](?:\uD83C[\uDFFB-\uDFFF])?|[\uDC6E\uDC70\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4\uDEB5](?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDD74\uDD90](?:\uD83C[\uDFFB-\uDFFF]|\uFE0F)?|[\uDC00-\uDC07\uDC09-\uDC14\uDC16-\uDC25\uDC27-\uDC3A\uDC3C-\uDC3E\uDC40\uDC44\uDC45\uDC51-\uDC65\uDC6A\uDC79-\uDC7B\uDC7D-\uDC80\uDC84\uDC88-\uDC8E\uDC90\uDC92-\uDCA9\uDCAB-\uDCFC\uDCFF-\uDD3D\uDD4B-\uDD4E\uDD50-\uDD67\uDDA4\uDDFB-\uDE2D\uDE2F-\uDE34\uDE37-\uDE41\uDE43\uDE44\uDE48-\uDE4A\uDE80-\uDEA2\uDEA4-\uDEB3\uDEB7-\uDEBF\uDEC1-\uDEC5\uDED0-\uDED2\uDED5-\uDED7\uDEDC-\uDEDF\uDEEB\uDEEC\uDEF4-\uDEFC\uDFE0-\uDFEB\uDFF0]|\uDC08(?:\u200D\u2B1B)?|\uDC15(?:\u200D\uD83E\uDDBA)?|\uDC26(?:\u200D(?:\u2B1B|\uD83D\uDD25))?|\uDC3B(?:\u200D\u2744\uFE0F?)?|\uDC41\uFE0F?(?:\u200D\uD83D\uDDE8\uFE0F?)?|\uDC68(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDC68\uDC69]\u200D\uD83D(?:\uDC66(?:\u200D\uD83D\uDC66)?|\uDC67(?:\u200D\uD83D[\uDC66\uDC67])?)|[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC66(?:\u200D\uD83D\uDC66)?|\uDC67(?:\u200D\uD83D[\uDC66\uDC67])?)|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]))|\uD83C(?:\uDFFB(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D\uDC68\uD83C[\uDFFC-\uDFFF])))?|\uDFFC(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D\uDC68\uD83C[\uDFFB\uDFFD-\uDFFF])))?|\uDFFD(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D\uDC68\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])))?|\uDFFE(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D\uDC68\uD83C[\uDFFB-\uDFFD\uDFFF])))?|\uDFFF(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D\uDC68\uD83C[\uDFFB-\uDFFE])))?))?|\uDC69(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?[\uDC68\uDC69]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC66(?:\u200D\uD83D\uDC66)?|\uDC67(?:\u200D\uD83D[\uDC66\uDC67])?|\uDC69\u200D\uD83D(?:\uDC66(?:\u200D\uD83D\uDC66)?|\uDC67(?:\u200D\uD83D[\uDC66\uDC67])?))|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]))|\uD83C(?:\uDFFB(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFC-\uDFFF])))?|\uDFFC(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFB\uDFFD-\uDFFF])))?|\uDFFD(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])))?|\uDFFE(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFB-\uDFFD\uDFFF])))?|\uDFFF(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFB-\uDFFE])))?))?|\uDC6F(?:\u200D[\u2640\u2642]\uFE0F?)?|\uDD75(?:\uD83C[\uDFFB-\uDFFF]|\uFE0F)?(?:\u200D[\u2640\u2642]\uFE0F?)?|\uDE2E(?:\u200D\uD83D\uDCA8)?|\uDE35(?:\u200D\uD83D\uDCAB)?|\uDE36(?:\u200D\uD83C\uDF2B\uFE0F?)?|\uDE42(?:\u200D[\u2194\u2195]\uFE0F?)?|\uDEB6(?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D(?:[\u2640\u2642]\uFE0F?(?:\u200D\u27A1\uFE0F?)?|\u27A1\uFE0F?))?)|\uD83E(?:[\uDD0C\uDD0F\uDD18-\uDD1F\uDD30-\uDD34\uDD36\uDD77\uDDB5\uDDB6\uDDBB\uDDD2\uDDD3\uDDD5\uDEC3-\uDEC5\uDEF0\uDEF2-\uDEF8](?:\uD83C[\uDFFB-\uDFFF])?|[\uDD26\uDD35\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD\uDDCF\uDDD4\uDDD6-\uDDDD](?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDDDE\uDDDF](?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDD0D\uDD0E\uDD10-\uDD17\uDD20-\uDD25\uDD27-\uDD2F\uDD3A\uDD3F-\uDD45\uDD47-\uDD76\uDD78-\uDDB4\uDDB7\uDDBA\uDDBC-\uDDCC\uDDD0\uDDE0-\uDDFF\uDE70-\uDE7C\uDE80-\uDE89\uDE8F-\uDEC2\uDEC6\uDECE-\uDEDC\uDEDF-\uDEE9]|\uDD3C(?:\u200D[\u2640\u2642]\uFE0F?|\uD83C[\uDFFB-\uDFFF])?|\uDDCE(?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D(?:[\u2640\u2642]\uFE0F?(?:\u200D\u27A1\uFE0F?)?|\u27A1\uFE0F?))?|\uDDD1(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83E\uDDD1|\uDDD1\u200D\uD83E\uDDD2(?:\u200D\uD83E\uDDD2)?|\uDDD2(?:\u200D\uD83E\uDDD2)?))|\uD83C(?:\uDFFB(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFC-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF])))?|\uDFFC(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFB\uDFFD-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF])))?|\uDFFD(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF])))?|\uDFFE(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFB-\uDFFD\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF])))?|\uDFFF(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFB-\uDFFE]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF])))?))?|\uDEF1(?:\uD83C(?:\uDFFB(?:\u200D\uD83E\uDEF2\uD83C[\uDFFC-\uDFFF])?|\uDFFC(?:\u200D\uD83E\uDEF2\uD83C[\uDFFB\uDFFD-\uDFFF])?|\uDFFD(?:\u200D\uD83E\uDEF2\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])?|\uDFFE(?:\u200D\uD83E\uDEF2\uD83C[\uDFFB-\uDFFD\uDFFF])?|\uDFFF(?:\u200D\uD83E\uDEF2\uD83C[\uDFFB-\uDFFE])?))?)/g;
};
var segmenter = globalThis.Intl?.Segmenter ? new Intl.Segmenter() : { segment: (str) => str.split("") };
var defaultIgnorableCodePointRegex = /^\p{Default_Ignorable_Code_Point}$/u;
function stringWidth$1(string2, options = {}) {
  if (typeof string2 !== "string" || string2.length === 0) return 0;
  const { ambiguousIsNarrow = true, countAnsiEscapeCodes = false } = options;
  if (!countAnsiEscapeCodes) string2 = stripAnsi(string2);
  if (string2.length === 0) return 0;
  let width = 0;
  const eastAsianWidthOptions = { ambiguousAsWide: !ambiguousIsNarrow };
  for (const { segment: character } of segmenter.segment(string2)) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 31 || codePoint >= 127 && codePoint <= 159) continue;
    if (codePoint >= 8203 && codePoint <= 8207 || codePoint === 65279) continue;
    if (codePoint >= 768 && codePoint <= 879 || codePoint >= 6832 && codePoint <= 6911 || codePoint >= 7616 && codePoint <= 7679 || codePoint >= 8400 && codePoint <= 8447 || codePoint >= 65056 && codePoint <= 65071) continue;
    if (codePoint >= 55296 && codePoint <= 57343) continue;
    if (codePoint >= 65024 && codePoint <= 65039) continue;
    if (defaultIgnorableCodePointRegex.test(character)) continue;
    if (emojiRegex().test(character)) {
      width += 2;
      continue;
    }
    width += eastAsianWidth(codePoint, eastAsianWidthOptions);
  }
  return width;
}
function isUnicodeSupported() {
  const { env: env3 } = shims_default;
  const { TERM, TERM_PROGRAM } = env3;
  if (shims_default.platform !== "win32") return TERM !== "linux";
  return Boolean(env3.WT_SESSION) || Boolean(env3.TERMINUS_SUBLIME) || env3.ConEmuTask === "{cmd::Cmder}" || TERM_PROGRAM === "Terminus-Sublime" || TERM_PROGRAM === "vscode" || TERM === "xterm-256color" || TERM === "alacritty" || TERM === "rxvt-unicode" || TERM === "rxvt-unicode-256color" || env3.TERMINAL_EMULATOR === "JetBrains-JediTerm";
}
var TYPE_COLOR_MAP = {
  info: "cyan",
  fail: "red",
  success: "green",
  ready: "green",
  start: "magenta"
};
var LEVEL_COLOR_MAP = {
  0: "red",
  1: "yellow"
};
var unicode = isUnicodeSupported();
var s = (c3, fallback) => unicode ? c3 : fallback;
var TYPE_ICONS = {
  error: s("\u2716", "\xD7"),
  fatal: s("\u2716", "\xD7"),
  ready: s("\u2714", "\u221A"),
  warn: s("\u26A0", "\u203C"),
  info: s("\u2139", "i"),
  success: s("\u2714", "\u221A"),
  debug: s("\u2699", "D"),
  trace: s("\u2192", "\u2192"),
  fail: s("\u2716", "\xD7"),
  start: s("\u25D0", "o"),
  log: ""
};
function stringWidth(str) {
  if (!(typeof Intl === "object") || !Intl.Segmenter) return stripAnsi$1(str).length;
  return stringWidth$1(str);
}
var FancyReporter = class extends BasicReporter {
  formatStack(stack, message2, opts) {
    const indent = "  ".repeat((opts?.errorLevel || 0) + 1);
    return `
${indent}` + parseStack(stack, message2).map((line) => "  " + line.replace(/^at +/, (m2) => colors.gray(m2)).replace(/\((.+)\)/, (_3, m2) => `(${colors.cyan(m2)})`)).join(`
${indent}`);
  }
  formatType(logObj, isBadge, opts) {
    const typeColor = TYPE_COLOR_MAP[logObj.type] || LEVEL_COLOR_MAP[logObj.level] || "gray";
    if (isBadge) return getBgColor(typeColor)(colors.black(` ${logObj.type.toUpperCase()} `));
    const _type = typeof TYPE_ICONS[logObj.type] === "string" ? TYPE_ICONS[logObj.type] : logObj.icon || logObj.type;
    return _type ? getColor(typeColor)(_type) : "";
  }
  formatLogObj(logObj, opts) {
    const [message2, ...additional] = this.formatArgs(logObj.args, opts).split("\n");
    if (logObj.type === "box") return box(characterFormat(message2 + (additional.length > 0 ? "\n" + additional.join("\n") : "")), {
      title: logObj.title ? characterFormat(logObj.title) : void 0,
      style: logObj.style
    });
    const date = this.formatDate(logObj.date, opts);
    const coloredDate = date && colors.gray(date);
    const isBadge = logObj.badge ?? logObj.level < 2;
    const type = this.formatType(logObj, isBadge, opts);
    const tag = logObj.tag ? colors.gray(logObj.tag) : "";
    let line;
    const left = this.filterAndJoin([type, characterFormat(message2)]);
    const right = this.filterAndJoin(opts.columns ? [tag, coloredDate] : [tag]);
    const space = (opts.columns || 0) - stringWidth(left) - stringWidth(right) - 2;
    line = space > 0 && (opts.columns || 0) >= 80 ? left + " ".repeat(space) + right : (right ? `${colors.gray(`[${right}]`)} ` : "") + left;
    line += characterFormat(additional.length > 0 ? "\n" + additional.join("\n") : "");
    if (logObj.type === "trace") {
      const _err = /* @__PURE__ */ new Error("Trace: " + logObj.message);
      line += this.formatStack(_err.stack || "", _err.message);
    }
    return isBadge ? "\n" + line + "\n" : line;
  }
};
function characterFormat(str) {
  return str.replace(/`([^`]+)`/gm, (_3, m2) => colors.cyan(m2)).replace(/\s+_([^_]+)_\s+/gm, (_3, m2) => ` ${colors.underline(m2)} `);
}
function getColor(color = "white") {
  return colors[color] || colors.white;
}
function getBgColor(color = "bgWhite") {
  return colors[`bg${color[0].toUpperCase()}${color.slice(1)}`] || colors.bgWhite;
}
function createConsola(options = {}) {
  let level = _getDefaultLogLevel();
  if (process.env.CONSOLA_LEVEL) level = Number.parseInt(process.env.CONSOLA_LEVEL) ?? level;
  return createConsola$1({
    level,
    defaults: { level },
    stdout: process.stdout,
    stderr: process.stderr,
    prompt: (...args2) => Promise.resolve().then(() => (init_prompt_CH6TK0bC(), prompt_CH6TK0bC_exports)).then((m2) => m2.prompt(...args2)),
    reporters: options.reporters || [options.fancy ?? !(T2 || R2) ? new FancyReporter() : new BasicReporter()],
    ...options
  });
}
function _getDefaultLogLevel() {
  if (g) return LogLevels.debug;
  if (R2) return LogLevels.warn;
  return LogLevels.info;
}
createConsola();
var logger = process.env.ROLLDOWN_TEST ? createTestingLogger() : createConsola({ formatOptions: { date: false } });
function createTestingLogger() {
  const types = [
    "silent",
    "fatal",
    "error",
    "warn",
    "log",
    "info",
    "success",
    "fail",
    "ready",
    "start",
    "box",
    "debug",
    "trace",
    "verbose"
  ];
  const ret = /* @__PURE__ */ Object.create(null);
  for (const type of types) ret[type] = (...args2) => console.log(...args2);
  return ret;
}
function bindingifyOutputOptions(outputOptions, pluginContextData, onLog, timings) {
  const { dir, format, exports, hashCharacters, sourcemap, sourcemapBaseUrl, sourcemapDebugIds, sourcemapFileNames, sourcemapExcludeSources, sourcemapIgnoreList, sourcemapPathTransform, name: name50, assetFileNames, entryFileNames, chunkFileNames, banner, footer, postBanner, postFooter, intro, outro, esModule, globals, paths, generatedCode, file, sanitizeFileName, preserveModules, virtualDirname, legalComments, comments, preserveModulesRoot, manualChunks, topLevelVar, cleanDir, strictExecutionOrder } = outputOptions;
  if (legalComments != null) logger.warn("`legalComments` option is deprecated, please use `comments.legal` instead.");
  const { inlineDynamicImports, advancedChunks } = bindingifyCodeSplitting(outputOptions.codeSplitting, outputOptions.inlineDynamicImports, outputOptions.advancedChunks, manualChunks, pluginContextData, onLog, timings);
  return {
    dir,
    file: file == null ? void 0 : file,
    format: bindingifyFormat(format),
    exports,
    hashCharacters,
    sourcemap: bindingifySourcemap2(sourcemap),
    sourcemapBaseUrl,
    sourcemapDebugIds,
    sourcemapFileNames: measureIfFunction(timings, OUTPUT_OPTIONS_OWNER, "sourcemapFileNames", sourcemapFileNames),
    sourcemapExcludeSources,
    sourcemapIgnoreList: batchSourcemapIgnoreList(measureIfFunction(timings, OUTPUT_OPTIONS_OWNER, "sourcemapIgnoreList", sourcemapIgnoreList ?? /node_modules/)),
    sourcemapPathTransform: batchSourcemapPathTransform(measureIfFunction(timings, OUTPUT_OPTIONS_OWNER, "sourcemapPathTransform", sourcemapPathTransform)),
    banner: bindingifyAddon(banner, "banner", timings),
    footer: bindingifyAddon(footer, "footer", timings),
    postBanner: bindingifyAddon(postBanner, "postBanner", timings),
    postFooter: bindingifyAddon(postFooter, "postFooter", timings),
    intro: bindingifyAddon(intro, "intro", timings),
    outro: bindingifyAddon(outro, "outro", timings),
    extend: outputOptions.extend,
    globals: measureIfFunction(timings, OUTPUT_OPTIONS_OWNER, "globals", globals),
    paths: measureIfFunction(timings, OUTPUT_OPTIONS_OWNER, "paths", paths),
    generatedCode,
    esModule,
    name: name50,
    assetFileNames: bindingifyAssetFilenames(assetFileNames),
    entryFileNames: measureIfFunction(timings, OUTPUT_OPTIONS_OWNER, "entryFileNames", entryFileNames),
    chunkFileNames: measureIfFunction(timings, OUTPUT_OPTIONS_OWNER, "chunkFileNames", chunkFileNames),
    plugins: [],
    minify: outputOptions.minify,
    externalLiveBindings: outputOptions.externalLiveBindings,
    inlineDynamicImports,
    dynamicImportInCjs: outputOptions.dynamicImportInCjs,
    manualCodeSplitting: advancedChunks,
    polyfillRequire: outputOptions.polyfillRequire,
    sanitizeFileName,
    preserveModules,
    virtualDirname,
    legalComments,
    comments: bindingifyComments(comments),
    preserveModulesRoot,
    topLevelVar,
    minifyInternalExports: outputOptions.minifyInternalExports,
    cleanDir,
    strictExecutionOrder,
    strict: outputOptions.strict
  };
}
function bindingifyAddon(configAddon, name50, timings) {
  if (configAddon == null || configAddon === "") return;
  if (typeof configAddon === "function") {
    const measured = measureHookCost(timings, OUTPUT_OPTIONS_OWNER, name50, configAddon);
    return async (chunk) => measured(transformRenderedChunk(chunk));
  }
  return configAddon;
}
function bindingifyFormat(format) {
  switch (format) {
    case void 0:
    case "es":
    case "esm":
    case "module":
      return "es";
    case "cjs":
    case "commonjs":
      return "cjs";
    case "iife":
      return "iife";
    case "umd":
      return "umd";
    default:
      unimplemented(`output.format: ${format}`);
  }
}
function bindingifySourcemap2(sourcemap) {
  switch (sourcemap) {
    case true:
      return "file";
    case "inline":
      return "inline";
    case false:
    case void 0:
      return;
    case "hidden":
      return "hidden";
    default:
      throw new Error(`unknown sourcemap: ${sourcemap}`);
  }
}
function bindingifyAssetFilenames(assetFileNames) {
  if (typeof assetFileNames === "function") return (asset) => {
    return assetFileNames({
      name: asset.name,
      names: asset.names,
      originalFileName: asset.originalFileName,
      originalFileNames: asset.originalFileNames,
      source: transformAssetSource(asset.source),
      type: "asset"
    });
  };
  return assetFileNames;
}
function bindingifyComments(comments) {
  if (comments == null) return;
  if (typeof comments === "boolean") return comments;
  return comments;
}
function bindingifyCodeSplitting(codeSplitting, inlineDynamicImportsOption, advancedChunks, manualChunks, pluginContextData, onLog, timings) {
  let inlineDynamicImports;
  let effectiveChunksOption;
  let migratedManualChunksGroup;
  let chunksOptionName = "codeSplitting";
  if (codeSplitting === false) {
    if (inlineDynamicImportsOption != null) logger.warn("`inlineDynamicImports` option is ignored because `codeSplitting: false` is set.");
    if (manualChunks != null) throw new Error('Invalid configuration: "output.manualChunks" cannot be used when "output.codeSplitting" is set to false.');
    if (advancedChunks != null) logger.warn("`advancedChunks` option is ignored because `codeSplitting` is set to `false`.");
    return {
      inlineDynamicImports: true,
      advancedChunks: void 0
    };
  } else if (codeSplitting === true) {
    if (inlineDynamicImportsOption != null) logger.warn("`inlineDynamicImports` option is ignored because `codeSplitting: true` is set.");
  } else if (codeSplitting == null) {
    if (inlineDynamicImportsOption != null) {
      logger.warn("`inlineDynamicImports` option is deprecated, please use `codeSplitting: false` instead.");
      inlineDynamicImports = inlineDynamicImportsOption;
    }
  } else {
    effectiveChunksOption = codeSplitting;
    chunksOptionName = "codeSplitting";
    if (inlineDynamicImportsOption != null) logger.warn("`inlineDynamicImports` option is ignored because the `codeSplitting` option is specified.");
  }
  if (inlineDynamicImports === true && manualChunks != null) throw new Error('Invalid value "true" for option "output.inlineDynamicImports" - this option is not supported for "output.manualChunks".');
  if (effectiveChunksOption == null) {
    if (advancedChunks != null) {
      logger.warn("`advancedChunks` option is deprecated, please use `codeSplitting` instead.");
      effectiveChunksOption = advancedChunks;
      chunksOptionName = "advancedChunks";
    }
  } else if (advancedChunks != null) logger.warn("`advancedChunks` option is ignored because the `codeSplitting` option is specified.");
  if (manualChunks != null && effectiveChunksOption != null) logger.warn("`manualChunks` option is ignored because the `codeSplitting` option is specified.");
  else if (manualChunks != null) {
    chunksOptionName = "manualChunks";
    migratedManualChunksGroup = { name(moduleId, ctx) {
      return manualChunks(moduleId, { getModuleInfo: (id2) => ctx.getModuleInfo(id2) });
    } };
    effectiveChunksOption = { groups: [migratedManualChunksGroup] };
  }
  if (inlineDynamicImports === true && effectiveChunksOption != null) {
    logger.warn("`advancedChunks` option is ignored because `inlineDynamicImports: true` disables code splitting.");
    effectiveChunksOption = void 0;
  }
  let advancedChunksResult;
  if (effectiveChunksOption != null) {
    const { groups, ...restOptions } = effectiveChunksOption;
    let chunkingContext;
    const getChunkingContext = (bindingContext) => chunkingContext ??= new ChunkingContextImpl(bindingContext, pluginContextData);
    advancedChunksResult = {
      ...restOptions,
      internalInvalidateModuleInfoCache: () => {
        chunkingContext?.clearModuleInfoCache();
        chunkingContext = void 0;
      },
      groups: groups?.map((group, index) => {
        const { debugName, name: name50, test, ...restGroup } = group;
        const timingKey = group === migratedManualChunksGroup ? manualChunks ?? group : group;
        const timingOwner = timings === void 0 ? OUTPUT_OPTIONS_OWNER : {
          ...OUTPUT_OPTIONS_OWNER,
          key: timingKey
        };
        const groupName = `${chunksOptionName} groups[${index}]`;
        let testTimingName = `${groupName}.test`;
        let nameTimingName = `${groupName}.name`;
        if (timings !== void 0) {
          if (chunksOptionName === "manualChunks") nameTimingName = "manualChunks";
          else {
            const label = debugName ?? (typeof name50 === "string" ? name50 : void 0);
            if (label === void 0) {
              if (typeof name50 === "function" && !timings.warnedMissingGroupLabels.has(timingKey)) {
                timings.warnedMissingGroupLabels.add(timingKey);
                onLog(LOG_LEVEL_WARN, logMissingCodeSplittingGroupDebugName(`output.${chunksOptionName}.groups[${index}]`));
              }
            } else {
              const labelSuffix = ` ${JSON.stringify(label)}`;
              testTimingName = `${groupName}.test${labelSuffix}`;
              nameTimingName = `${groupName}.name${labelSuffix}`;
            }
          }
        }
        return {
          ...restGroup,
          test: typeof test === "function" ? batchTest(measureHookCost(timings, timingOwner, testTimingName, test)) : test,
          name: typeof name50 === "function" ? batchName(measureHookCost(timings, timingOwner, nameTimingName, name50), getChunkingContext) : name50
        };
      })
    };
  }
  return {
    inlineDynamicImports,
    advancedChunks: advancedChunksResult
  };
}
function batchTest(test) {
  return (ids) => {
    const results = new Uint8Array(ids.length);
    for (let index = 0; index < ids.length; index++) {
      const result = test(ids[index]);
      if (result != null && typeof result !== "boolean") throw new TypeError(`\`output.codeSplitting.groups[].test\` returned ${typeof result} for module "${ids[index]}", but expected a boolean, null or undefined.`);
      results[index] = result === true ? 1 : 0;
    }
    return results;
  };
}
function batchName(name50, getChunkingContext) {
  return (ids, bindingContext) => {
    const context = getChunkingContext(bindingContext);
    const results = [];
    for (let index = 0; index < ids.length; index++) {
      const result = name50(ids[index], context);
      if (result != null && typeof result !== "string") throw new TypeError(`\`output.codeSplitting.groups[].name\` returned ${typeof result} for module "${ids[index]}", but expected a string, null or undefined.`);
      results.push(result);
    }
    return results;
  };
}
function batchSourcemapIgnoreList(ignoreList) {
  if (typeof ignoreList !== "function") return ignoreList;
  return (sources, sourcemapPath) => {
    const results = new Uint8Array(sources.length);
    for (let index = 0; index < sources.length; index++) {
      const result = ignoreList(sources[index], sourcemapPath);
      if (typeof result !== "boolean") throw new TypeError(`\`output.sourcemapIgnoreList\` returned ${typeof result} for source "${sources[index]}", but expected a boolean.`);
      results[index] = result ? 1 : 0;
    }
    return results;
  };
}
function batchSourcemapPathTransform(pathTransform) {
  if (typeof pathTransform !== "function") return pathTransform;
  return (sources, sourcemapPath) => {
    const results = [];
    for (let index = 0; index < sources.length; index++) {
      const result = pathTransform(sources[index], sourcemapPath);
      if (typeof result !== "string") throw new TypeError(`\`output.sourcemapPathTransform\` returned ${typeof result} for source "${sources[index]}", but expected a string.`);
      results.push(result);
    }
    return results;
  };
}
var import_binding4 = /* @__PURE__ */ n2(t2(), 1);
async function initializeParallelPlugins(plugins) {
  const pluginInfos = [];
  for (const [index, plugin] of plugins.entries()) {
    const parallel = getParallelPluginInfo(plugin);
    if (parallel) {
      const { fileUrl, options } = parallel;
      pluginInfos.push({
        index,
        fileUrl,
        options
      });
    }
  }
  if (pluginInfos.length <= 0) return;
  const count = availableParallelism();
  const parallelJsPluginRegistry = new import_binding4.ParallelJsPluginRegistry(count);
  const registryId = parallelJsPluginRegistry.id;
  const workers = await initializeWorkers(registryId, count, pluginInfos);
  const stopWorkers = async () => {
    await Promise.all(workers.map((worker) => worker.terminate()));
  };
  return {
    registry: parallelJsPluginRegistry,
    stopWorkers
  };
}
function initializeWorkers(registryId, count, pluginInfos) {
  return Promise.all(Array.from({ length: count }, (_3, i2) => initializeWorker(registryId, pluginInfos, i2)));
}
async function initializeWorker(registryId, pluginInfos, threadNumber) {
  const urlString = import.meta.resolve("#parallel-plugin-worker");
  const workerData = {
    registryId,
    pluginInfos,
    threadNumber
  };
  let worker;
  try {
    worker = new Worker(new URL(urlString), { workerData });
    worker.unref();
    await new Promise((resolve, reject) => {
      worker.once("message", async (message2) => {
        if (message2.type === "error") reject(message2.error);
        else resolve();
      });
    });
    return worker;
  } catch (e3) {
    worker?.terminate();
    throw e3;
  }
}
var availableParallelism = () => {
  let availableParallelism2 = 1;
  try {
    availableParallelism2 = shims_default.availableParallelism();
  } catch {
    const cpus2 = shims_default.cpus();
    if (Array.isArray(cpus2) && cpus2.length > 0) availableParallelism2 = cpus2.length;
  }
  return Math.min(availableParallelism2, 8);
};
async function createBundlerOptions(inputOptions, outputOptions, watchMode, measureTimings = false) {
  const inputPlugins = await normalizePluginOption(inputOptions.plugins);
  const outputPlugins = await normalizePluginOption(outputOptions.plugins);
  const logLevel = inputOptions.logLevel || "info";
  const onLog = getLogger(getObjectPlugins(inputPlugins), getOnLog(inputOptions, logLevel), logLevel, watchMode);
  outputOptions = PluginDriver.callOutputOptionsHook([...inputPlugins, ...outputPlugins], outputOptions, onLog, logLevel, watchMode);
  const hookOutputPlugins = await normalizePluginOption(outputOptions.plugins);
  const normalizedInputPlugins = normalizePlugins(inputPlugins, ANONYMOUS_PLUGIN_PREFIX);
  const normalizedOutputPlugins = normalizePlugins(hookOutputPlugins, ANONYMOUS_OUTPUT_PLUGIN_PREFIX);
  let plugins = [...normalizedInputPlugins, ...checkOutputPluginOption(normalizedOutputPlugins, onLog)];
  const timings = measureTimings && (inputOptions.checks?.bundlerTimings ?? inputOptions.checks?.pluginTimings ?? true) ? pluginTimingsRecorderFor(inputOptions) : void 0;
  if (timings) outputOptions = {
    ...outputOptions,
    assetFileNames: measureIfFunction(timings, OUTPUT_OPTIONS_OWNER, "assetFileNames", outputOptions.assetFileNames),
    sanitizeFileName: measureIfFunction(timings, OUTPUT_OPTIONS_OWNER, "sanitizeFileName", outputOptions.sanitizeFileName)
  };
  const parallelPluginInitResult = await initializeParallelPlugins(plugins);
  if (inputOptions.experimental?.strictExecutionOrder !== void 0) console.warn("`experimental.strictExecutionOrder` has been stabilized and moved to `output.strictExecutionOrder`. Please update your configuration.");
  try {
    const pluginContextData = new PluginContextData(onLog, outputOptions, normalizedInputPlugins, normalizedOutputPlugins);
    return {
      bundlerOptions: {
        inputOptions: bindingifyInputOptions(plugins, inputOptions, outputOptions, pluginContextData, normalizedOutputPlugins, onLog, logLevel, watchMode, timings),
        outputOptions: bindingifyOutputOptions(outputOptions, pluginContextData, onLog, timings),
        parallelPluginsRegistry: parallelPluginInitResult?.registry
      },
      inputOptions,
      onLog,
      stopWorkers: parallelPluginInitResult?.stopWorkers
    };
  } catch (e3) {
    await parallelPluginInitResult?.stopWorkers();
    throw e3;
  }
}

// ../../node_modules/.bun/rolldown@1.2.11/node_modules/rolldown/dist/shared/watch-DUTFlQ6u.mjs
var signals = [];
signals.push("SIGHUP", "SIGINT", "SIGTERM");
if (process.platform !== "win32") signals.push("SIGALRM", "SIGABRT", "SIGVTALRM", "SIGXCPU", "SIGXFSZ", "SIGUSR2", "SIGTRAP", "SIGSYS", "SIGQUIT", "SIGIOT");
if (process.platform === "linux") signals.push("SIGIO", "SIGPOLL", "SIGPWR", "SIGSTKFLT");
var processOk = (process2) => !!process2 && typeof process2 === "object" && typeof process2.removeListener === "function" && typeof process2.emit === "function" && typeof process2.reallyExit === "function" && typeof process2.listeners === "function" && typeof process2.kill === "function" && typeof process2.pid === "number" && typeof process2.on === "function";
var kExitEmitter = /* @__PURE__ */ Symbol.for("signal-exit emitter");
var global = globalThis;
var ObjectDefineProperty = Object.defineProperty.bind(Object);
var Emitter = class {
  emitted = {
    afterExit: false,
    exit: false
  };
  listeners = {
    afterExit: [],
    exit: []
  };
  count = 0;
  id = Math.random();
  constructor() {
    if (global[kExitEmitter]) return global[kExitEmitter];
    ObjectDefineProperty(global, kExitEmitter, {
      value: this,
      writable: false,
      enumerable: false,
      configurable: false
    });
  }
  on(ev, fn) {
    this.listeners[ev].push(fn);
  }
  removeListener(ev, fn) {
    const list2 = this.listeners[ev];
    const i2 = list2.indexOf(fn);
    if (i2 === -1) return;
    if (i2 === 0 && list2.length === 1) list2.length = 0;
    else list2.splice(i2, 1);
  }
  emit(ev, code3, signal) {
    if (this.emitted[ev]) return false;
    this.emitted[ev] = true;
    let ret = false;
    for (const fn of this.listeners[ev]) ret = fn(code3, signal) === true || ret;
    if (ev === "exit") ret = this.emit("afterExit", code3, signal) || ret;
    return ret;
  }
};
var SignalExitBase = class {
};
var signalExitWrap = (handler) => {
  return {
    onExit(cb, opts) {
      return handler.onExit(cb, opts);
    },
    load() {
      return handler.load();
    },
    unload() {
      return handler.unload();
    }
  };
};
var SignalExitFallback = class extends SignalExitBase {
  onExit() {
    return () => {
    };
  }
  load() {
  }
  unload() {
  }
};
var SignalExit = class extends SignalExitBase {
  /* c8 ignore start */
  #hupSig = process$1.platform === "win32" ? "SIGINT" : "SIGHUP";
  /* c8 ignore stop */
  #emitter = new Emitter();
  #process;
  #originalProcessEmit;
  #originalProcessReallyExit;
  #sigListeners = {};
  #loaded = false;
  constructor(process2) {
    super();
    this.#process = process2;
    this.#sigListeners = {};
    for (const sig of signals) this.#sigListeners[sig] = () => {
      const listeners = this.#process.listeners(sig);
      let { count } = this.#emitter;
      const p = process2;
      if (typeof p.__signal_exit_emitter__ === "object" && typeof p.__signal_exit_emitter__.count === "number") count += p.__signal_exit_emitter__.count;
      if (listeners.length === count) {
        this.unload();
        const ret = this.#emitter.emit("exit", null, sig);
        const s2 = sig === "SIGHUP" ? this.#hupSig : sig;
        if (!ret) process2.kill(process2.pid, s2);
      }
    };
    this.#originalProcessReallyExit = process2.reallyExit;
    this.#originalProcessEmit = process2.emit;
  }
  onExit(cb, opts) {
    if (!processOk(this.#process)) return () => {
    };
    if (this.#loaded === false) this.load();
    const ev = opts?.alwaysLast ? "afterExit" : "exit";
    this.#emitter.on(ev, cb);
    return () => {
      this.#emitter.removeListener(ev, cb);
      if (this.#emitter.listeners["exit"].length === 0 && this.#emitter.listeners["afterExit"].length === 0) this.unload();
    };
  }
  load() {
    if (this.#loaded) return;
    this.#loaded = true;
    this.#emitter.count += 1;
    for (const sig of signals) try {
      const fn = this.#sigListeners[sig];
      if (fn) this.#process.on(sig, fn);
    } catch (_3) {
    }
    this.#process.emit = (ev, ...a2) => {
      return this.#processEmit(ev, ...a2);
    };
    this.#process.reallyExit = (code3) => {
      return this.#processReallyExit(code3);
    };
  }
  unload() {
    if (!this.#loaded) return;
    this.#loaded = false;
    signals.forEach((sig) => {
      const listener = this.#sigListeners[sig];
      if (!listener) throw new Error("Listener not defined for signal: " + sig);
      try {
        this.#process.removeListener(sig, listener);
      } catch (_3) {
      }
    });
    this.#process.emit = this.#originalProcessEmit;
    this.#process.reallyExit = this.#originalProcessReallyExit;
    this.#emitter.count -= 1;
  }
  #processReallyExit(code3) {
    if (!processOk(this.#process)) return 0;
    this.#process.exitCode = code3 || 0;
    this.#emitter.emit("exit", this.#process.exitCode, null);
    return this.#originalProcessReallyExit.call(this.#process, this.#process.exitCode);
  }
  #processEmit(ev, ...args2) {
    const og = this.#originalProcessEmit;
    if (ev === "exit" && processOk(this.#process)) {
      if (typeof args2[0] === "number") this.#process.exitCode = args2[0];
      const ret = og.call(this.#process, ev, ...args2);
      this.#emitter.emit("exit", this.#process.exitCode, null);
      return ret;
    } else return og.call(this.#process, ev, ...args2);
  }
};
var process$1 = globalThis.process;
var { onExit: onExit$1, load, unload } = signalExitWrap(processOk(process$1) ? new SignalExit(process$1) : new SignalExitFallback());
function onExit(...args2) {
  if (typeof process === "object" && process.versions.webcontainer) {
    process.on("exit", (code3) => {
      args2[0](code3, null);
    });
    return;
  }
  onExit$1(...args2);
}
var import_binding5 = /* @__PURE__ */ n2(t2(), 1);

// ../../node_modules/.bun/rolldown@1.2.11/node_modules/rolldown/dist/shared/rolldown-CgWItHdG.mjs
var import_binding6 = /* @__PURE__ */ n2(t2(), 1);
var RolldownOutputImpl = class extends PlainObjectLike {
  bindingOutputs;
  constructor(bindingOutputs) {
    super();
    this.bindingOutputs = bindingOutputs;
    if (bindingOutputs.mangleCache !== void 0) this.mangleCache = bindingOutputs.mangleCache;
  }
  get output() {
    return transformToRollupOutput(this.bindingOutputs).output;
  }
  __rolldown_external_memory_handle__(keepDataAlive) {
    const results = this.output.map((item) => item.__rolldown_external_memory_handle__(keepDataAlive));
    if (!results.every((r3) => r3.freed)) {
      const reasons = results.filter((r3) => !r3.freed).map((r3) => r3.reason).filter(Boolean);
      return {
        freed: false,
        reason: `Failed to free ${reasons.length} item(s): ${reasons.join("; ")}`
      };
    }
    return { freed: true };
  }
};
__decorate([lazyProp], RolldownOutputImpl.prototype, "output", null);
Symbol.asyncDispose ??= /* @__PURE__ */ Symbol("Symbol.asyncDispose");
var RolldownBuild = class {
  #inputOptions;
  #bundler;
  #stopWorkers;
  #asyncRuntimeReleased = false;
  /** @hidden should not be used directly */
  constructor(inputOptions) {
    this.#inputOptions = inputOptions;
    this.#bundler = new import_binding6.BindingBundler();
    (0, import_binding6.startAsyncRuntime)();
  }
  /**
  * Whether the bundle has been closed.
  *
  * If the bundle is closed, calling other methods will throw an error.
  */
  get closed() {
    return this.#bundler.closed;
  }
  /**
  * Generate bundles in-memory.
  *
  * If you directly want to write bundles to disk, use the {@linkcode write} method instead.
  *
  * @param outputOptions The output options.
  * @returns The generated bundle.
  * @throws {@linkcode BundleError} When an error occurs during the build.
  */
  async generate(outputOptions = {}) {
    return this.#build(false, outputOptions);
  }
  /**
  * Generate and write bundles to disk.
  *
  * If you want to generate bundles in-memory, use the {@linkcode generate} method instead.
  *
  * @param outputOptions The output options.
  * @returns The generated bundle.
  * @throws {@linkcode BundleError} When an error occurs during the build.
  */
  async write(outputOptions = {}) {
    return this.#build(true, outputOptions);
  }
  /**
  * Close the bundle and free resources.
  *
  * This method should be called even if the {@linkcode generate} method
  * or the {@linkcode write} method threw an error. It should be called
  * even if neither of the methods are called.
  *
  * This method is called automatically when using `using` syntax.
  *
  * @example
  * ```js
  * import { rolldown } from 'rolldown';
  *
  * {
  *   using bundle = await rolldown({ input: 'src/main.js' });
  *   const output = await bundle.generate({ format: 'esm' });
  *   console.log(output);
  *   // bundle.close() is called automatically here
  * }
  * ```
  */
  async close() {
    const shouldRelease = !this.#asyncRuntimeReleased;
    this.#asyncRuntimeReleased = true;
    try {
      await this.#stopWorkers?.();
      await this.#bundler.close();
      this.#stopWorkers = void 0;
    } finally {
      if (shouldRelease) (0, import_binding6.shutdownAsyncRuntime)();
    }
  }
  /** @hidden documented in close method */
  async [Symbol.asyncDispose]() {
    await this.close();
  }
  /**
  * @experimental
  * @hidden not ready for public usage yet
  */
  get watchFiles() {
    return Promise.resolve(this.#bundler.getWatchFiles());
  }
  async #build(isWrite, outputOptions) {
    validateOption("output", outputOptions);
    await this.#stopWorkers?.();
    const option = await createBundlerOptions(this.#inputOptions, outputOptions, false, true);
    try {
      this.#stopWorkers = option.stopWorkers;
      let output;
      if (isWrite) output = await this.#bundler.write(option.bundlerOptions);
      else output = await this.#bundler.generate(option.bundlerOptions);
      return new RolldownOutputImpl(unwrapBindingResult(output));
    } catch (e3) {
      await option.stopWorkers?.();
      throw e3;
    }
  }
};
var rolldown = async (input) => {
  validateOption("input", input);
  return new RolldownBuild(await PluginDriver.callOptionsHook(input));
};

// ../../node_modules/.bun/rolldown@1.2.11/node_modules/rolldown/dist/index.mjs
init_shims();
var import_binding7 = /* @__PURE__ */ n(t(), 1);
if (isMainThread) {
  const subscriberGuard = (0, import_binding7.initTraceSubscriber)();
  onExit(() => {
    subscriberGuard?.close();
  });
}

// ../../node_modules/.bun/rolldown@1.2.11/node_modules/rolldown/dist/shared/resolve-tsconfig-DHwpIs5e.mjs
var import_binding8 = /* @__PURE__ */ n2(t2(), 1);
var yarnPnp$1 = typeof process === "object" && !!process.versions?.pnp;
function normalizeBindingWarning(warning) {
  if (warning.type === "JsError") return warning.field0;
  return {
    code: warning.field0.kind,
    message: warning.field0.message,
    id: warning.field0.id,
    exporter: warning.field0.exporter,
    loc: warning.field0.loc,
    pos: warning.field0.pos
  };
}
function transformSync(filename, sourceText, options, cache) {
  const result = (0, import_binding8.enhancedTransformSync)(filename, sourceText, options, cache, yarnPnp$1);
  return {
    ...result,
    errors: result.errors.map(normalizeBindingError),
    warnings: result.warnings.map(normalizeBindingWarning)
  };
}
var yarnPnp = typeof process === "object" && !!process.versions?.pnp;
var TsconfigCache = class extends import_binding8.TsconfigCache {
  constructor(pathToTsconfig) {
    super(yarnPnp, pathToTsconfig);
  }
};

// ../../node_modules/.bun/rolldown@1.2.11/node_modules/rolldown/dist/experimental-index.mjs
init_shims();
var import_binding9 = /* @__PURE__ */ n(t(), 1);
var parseSync2 = parseSync;
var transformSync2 = transformSync;
var BindingRebuildStrategy = import_binding9.BindingRebuildStrategy;
var ResolverFactory = import_binding9.ResolverFactory;
var getNativeMemoryStats = import_binding9.getNativeMemoryStats;
var isolatedDeclaration = import_binding9.isolatedDeclaration;
var isolatedDeclarationSync = import_binding9.isolatedDeclarationSync;
var moduleRunnerTransform = import_binding9.moduleRunnerTransform;
var resetNativeMemoryStats = import_binding9.resetNativeMemoryStats;

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/utils/List.js
var releasedCursors = null;
var List = class _List {
  static createItem(data) {
    return {
      prev: null,
      next: null,
      data
    };
  }
  constructor() {
    this.head = null;
    this.tail = null;
    this.cursor = null;
  }
  createItem(data) {
    return _List.createItem(data);
  }
  // cursor helpers
  allocateCursor(prev, next) {
    let cursor;
    if (releasedCursors !== null) {
      cursor = releasedCursors;
      releasedCursors = releasedCursors.cursor;
      cursor.prev = prev;
      cursor.next = next;
      cursor.cursor = this.cursor;
    } else {
      cursor = {
        prev,
        next,
        cursor: this.cursor
      };
    }
    this.cursor = cursor;
    return cursor;
  }
  releaseCursor() {
    const { cursor } = this;
    this.cursor = cursor.cursor;
    cursor.prev = null;
    cursor.next = null;
    cursor.cursor = releasedCursors;
    releasedCursors = cursor;
  }
  updateCursors(prevOld, prevNew, nextOld, nextNew) {
    let { cursor } = this;
    while (cursor !== null) {
      if (cursor.prev === prevOld) {
        cursor.prev = prevNew;
      }
      if (cursor.next === nextOld) {
        cursor.next = nextNew;
      }
      cursor = cursor.cursor;
    }
  }
  *[Symbol.iterator]() {
    for (let cursor = this.head; cursor !== null; cursor = cursor.next) {
      yield cursor.data;
    }
  }
  // getters
  get size() {
    let size = 0;
    for (let cursor = this.head; cursor !== null; cursor = cursor.next) {
      size++;
    }
    return size;
  }
  get isEmpty() {
    return this.head === null;
  }
  get first() {
    return this.head && this.head.data;
  }
  get last() {
    return this.tail && this.tail.data;
  }
  // convertors
  fromArray(array2) {
    let cursor = null;
    this.head = null;
    for (let data of array2) {
      const item = _List.createItem(data);
      if (cursor !== null) {
        cursor.next = item;
      } else {
        this.head = item;
      }
      item.prev = cursor;
      cursor = item;
    }
    this.tail = cursor;
    return this;
  }
  toArray() {
    return [...this];
  }
  toJSON() {
    return [...this];
  }
  // array-like methods
  forEach(fn, thisArg = this) {
    const cursor = this.allocateCursor(null, this.head);
    while (cursor.next !== null) {
      const item = cursor.next;
      cursor.next = item.next;
      fn.call(thisArg, item.data, item, this);
    }
    this.releaseCursor();
  }
  forEachRight(fn, thisArg = this) {
    const cursor = this.allocateCursor(this.tail, null);
    while (cursor.prev !== null) {
      const item = cursor.prev;
      cursor.prev = item.prev;
      fn.call(thisArg, item.data, item, this);
    }
    this.releaseCursor();
  }
  reduce(fn, initialValue, thisArg = this) {
    let cursor = this.allocateCursor(null, this.head);
    let acc = initialValue;
    let item;
    while (cursor.next !== null) {
      item = cursor.next;
      cursor.next = item.next;
      acc = fn.call(thisArg, acc, item.data, item, this);
    }
    this.releaseCursor();
    return acc;
  }
  reduceRight(fn, initialValue, thisArg = this) {
    let cursor = this.allocateCursor(this.tail, null);
    let acc = initialValue;
    let item;
    while (cursor.prev !== null) {
      item = cursor.prev;
      cursor.prev = item.prev;
      acc = fn.call(thisArg, acc, item.data, item, this);
    }
    this.releaseCursor();
    return acc;
  }
  some(fn, thisArg = this) {
    for (let cursor = this.head; cursor !== null; cursor = cursor.next) {
      if (fn.call(thisArg, cursor.data, cursor, this)) {
        return true;
      }
    }
    return false;
  }
  map(fn, thisArg = this) {
    const result = new _List();
    for (let cursor = this.head; cursor !== null; cursor = cursor.next) {
      result.appendData(fn.call(thisArg, cursor.data, cursor, this));
    }
    return result;
  }
  filter(fn, thisArg = this) {
    const result = new _List();
    for (let cursor = this.head; cursor !== null; cursor = cursor.next) {
      if (fn.call(thisArg, cursor.data, cursor, this)) {
        result.appendData(cursor.data);
      }
    }
    return result;
  }
  nextUntil(start, fn, thisArg = this) {
    if (start === null) {
      return;
    }
    const cursor = this.allocateCursor(null, start);
    while (cursor.next !== null) {
      const item = cursor.next;
      cursor.next = item.next;
      if (fn.call(thisArg, item.data, item, this)) {
        break;
      }
    }
    this.releaseCursor();
  }
  prevUntil(start, fn, thisArg = this) {
    if (start === null) {
      return;
    }
    const cursor = this.allocateCursor(start, null);
    while (cursor.prev !== null) {
      const item = cursor.prev;
      cursor.prev = item.prev;
      if (fn.call(thisArg, item.data, item, this)) {
        break;
      }
    }
    this.releaseCursor();
  }
  // mutation
  clear() {
    this.head = null;
    this.tail = null;
  }
  copy() {
    const result = new _List();
    for (let data of this) {
      result.appendData(data);
    }
    return result;
  }
  prepend(item) {
    this.updateCursors(null, item, this.head, item);
    if (this.head !== null) {
      this.head.prev = item;
      item.next = this.head;
    } else {
      this.tail = item;
    }
    this.head = item;
    return this;
  }
  prependData(data) {
    return this.prepend(_List.createItem(data));
  }
  append(item) {
    return this.insert(item);
  }
  appendData(data) {
    return this.insert(_List.createItem(data));
  }
  insert(item, before = null) {
    if (before !== null) {
      this.updateCursors(before.prev, item, before, item);
      if (before.prev === null) {
        if (this.head !== before) {
          throw new Error("before doesn't belong to list");
        }
        this.head = item;
        before.prev = item;
        item.next = before;
        this.updateCursors(null, item);
      } else {
        before.prev.next = item;
        item.prev = before.prev;
        before.prev = item;
        item.next = before;
      }
    } else {
      this.updateCursors(this.tail, item, null, item);
      if (this.tail !== null) {
        this.tail.next = item;
        item.prev = this.tail;
      } else {
        this.head = item;
      }
      this.tail = item;
    }
    return this;
  }
  insertData(data, before) {
    return this.insert(_List.createItem(data), before);
  }
  remove(item) {
    this.updateCursors(item, item.prev, item, item.next);
    if (item.prev !== null) {
      item.prev.next = item.next;
    } else {
      if (this.head !== item) {
        throw new Error("item doesn't belong to list");
      }
      this.head = item.next;
    }
    if (item.next !== null) {
      item.next.prev = item.prev;
    } else {
      if (this.tail !== item) {
        throw new Error("item doesn't belong to list");
      }
      this.tail = item.prev;
    }
    item.prev = null;
    item.next = null;
    return item;
  }
  push(data) {
    this.insert(_List.createItem(data));
  }
  pop() {
    return this.tail !== null ? this.remove(this.tail) : null;
  }
  unshift(data) {
    this.prepend(_List.createItem(data));
  }
  shift() {
    return this.head !== null ? this.remove(this.head) : null;
  }
  prependList(list2) {
    return this.insertList(list2, this.head);
  }
  appendList(list2) {
    return this.insertList(list2);
  }
  insertList(list2, before) {
    if (list2.head === null) {
      return this;
    }
    if (before !== void 0 && before !== null) {
      this.updateCursors(before.prev, list2.tail, before, list2.head);
      if (before.prev !== null) {
        before.prev.next = list2.head;
        list2.head.prev = before.prev;
      } else {
        this.head = list2.head;
      }
      before.prev = list2.tail;
      list2.tail.next = before;
    } else {
      this.updateCursors(this.tail, list2.tail, null, list2.head);
      if (this.tail !== null) {
        this.tail.next = list2.head;
        list2.head.prev = this.tail;
      } else {
        this.head = list2.head;
      }
      this.tail = list2.tail;
    }
    list2.head = null;
    list2.tail = null;
    return this;
  }
  replace(oldItem, newItemOrList) {
    if ("head" in newItemOrList) {
      this.insertList(newItemOrList, oldItem);
    } else {
      this.insert(newItemOrList, oldItem);
    }
    this.remove(oldItem);
  }
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/utils/create-custom-error.js
function createCustomError(name50, message2) {
  const error2 = Object.create(SyntaxError.prototype);
  const errorStack = new Error();
  return Object.assign(error2, {
    name: name50,
    message: message2,
    get stack() {
      return (errorStack.stack || "").replace(/^(.+\n){1,3}/, `${name50}: ${message2}
`);
    }
  });
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/parser/SyntaxError.js
var MAX_LINE_LENGTH = 100;
var OFFSET_CORRECTION = 60;
var TAB_REPLACEMENT = "    ";
function sourceFragment({ source, line, column, baseLine, baseColumn }, extraLines) {
  function processLines(start, end) {
    return lines.slice(start, end).map(
      (line2, idx) => String(start + idx + 1).padStart(maxNumLength) + " |" + line2
    ).join("\n");
  }
  const prelines = "\n".repeat(Math.max(baseLine - 1, 0));
  const precolumns = " ".repeat(Math.max(baseColumn - 1, 0));
  const lines = (prelines + precolumns + source).split(/\r\n?|\n|\f/);
  const startLine = Math.max(1, line - extraLines) - 1;
  const endLine = Math.min(line + extraLines, lines.length + 1);
  const maxNumLength = Math.max(4, String(endLine).length) + 1;
  let cutLeft = 0;
  column += (TAB_REPLACEMENT.length - 1) * (lines[line - 1].substr(0, column - 1).match(/\t/g) || []).length;
  if (column > MAX_LINE_LENGTH) {
    cutLeft = column - OFFSET_CORRECTION + 3;
    column = OFFSET_CORRECTION - 2;
  }
  for (let i2 = startLine; i2 <= endLine; i2++) {
    if (i2 >= 0 && i2 < lines.length) {
      lines[i2] = lines[i2].replace(/\t/g, TAB_REPLACEMENT);
      lines[i2] = (cutLeft > 0 && lines[i2].length > cutLeft ? "\u2026" : "") + lines[i2].substr(cutLeft, MAX_LINE_LENGTH - 2) + (lines[i2].length > cutLeft + MAX_LINE_LENGTH - 1 ? "\u2026" : "");
    }
  }
  return [
    processLines(startLine, line),
    new Array(column + maxNumLength + 2).join("-") + "^",
    processLines(line, endLine)
  ].filter(Boolean).join("\n").replace(/^(\s+\d+\s+\|\n)+/, "").replace(/\n(\s+\d+\s+\|)+$/, "");
}
function SyntaxError2(message2, source, offset, line, column, baseLine = 1, baseColumn = 1) {
  const error2 = Object.assign(createCustomError("SyntaxError", message2), {
    source,
    offset,
    line,
    column,
    sourceFragment(extraLines) {
      return sourceFragment({ source, line, column, baseLine, baseColumn }, isNaN(extraLines) ? 0 : extraLines);
    },
    get formattedMessage() {
      return `Parse error: ${message2}
` + sourceFragment({ source, line, column, baseLine, baseColumn }, 2);
    }
  });
  return error2;
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/tokenizer/types.js
var EOF = 0;
var Ident = 1;
var Function = 2;
var AtKeyword = 3;
var Hash = 4;
var String2 = 5;
var BadString = 6;
var Url = 7;
var BadUrl = 8;
var Delim = 9;
var Number2 = 10;
var Percentage = 11;
var Dimension = 12;
var WhiteSpace = 13;
var CDO = 14;
var CDC = 15;
var Colon = 16;
var Semicolon = 17;
var Comma = 18;
var LeftSquareBracket = 19;
var RightSquareBracket = 20;
var LeftParenthesis = 21;
var RightParenthesis = 22;
var LeftCurlyBracket = 23;
var RightCurlyBracket = 24;
var Comment = 25;

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/tokenizer/char-code-definitions.js
var EOF2 = 0;
function isDigit(code3) {
  return code3 >= 48 && code3 <= 57;
}
function isHexDigit(code3) {
  return isDigit(code3) || // 0 .. 9
  code3 >= 65 && code3 <= 70 || // A .. F
  code3 >= 97 && code3 <= 102;
}
function isUppercaseLetter(code3) {
  return code3 >= 65 && code3 <= 90;
}
function isLowercaseLetter(code3) {
  return code3 >= 97 && code3 <= 122;
}
function isLetter(code3) {
  return isUppercaseLetter(code3) || isLowercaseLetter(code3);
}
function isNonAscii(code3) {
  return code3 >= 128;
}
function isNameStart(code3) {
  return isLetter(code3) || isNonAscii(code3) || code3 === 95;
}
function isName(code3) {
  return isNameStart(code3) || isDigit(code3) || code3 === 45;
}
function isNonPrintable(code3) {
  return code3 >= 0 && code3 <= 8 || code3 === 11 || code3 >= 14 && code3 <= 31 || code3 === 127;
}
function isNewline(code3) {
  return code3 === 10 || code3 === 13 || code3 === 12;
}
function isWhiteSpace(code3) {
  return isNewline(code3) || code3 === 32 || code3 === 9;
}
function isValidEscape(first, second) {
  if (first !== 92) {
    return false;
  }
  if (isNewline(second) || second === EOF2) {
    return false;
  }
  return true;
}
function isIdentifierStart(first, second, third) {
  if (first === 45) {
    return isNameStart(second) || second === 45 || isValidEscape(second, third);
  }
  if (isNameStart(first)) {
    return true;
  }
  if (first === 92) {
    return isValidEscape(first, second);
  }
  return false;
}
function isNumberStart(first, second, third) {
  if (first === 43 || first === 45) {
    if (isDigit(second)) {
      return 2;
    }
    return second === 46 && isDigit(third) ? 3 : 0;
  }
  if (first === 46) {
    return isDigit(second) ? 2 : 0;
  }
  if (isDigit(first)) {
    return 1;
  }
  return 0;
}
function isBOM(code3) {
  if (code3 === 65279) {
    return 1;
  }
  if (code3 === 65534) {
    return 1;
  }
  return 0;
}
var CATEGORY = new Array(128);
var EofCategory = 128;
var WhiteSpaceCategory = 130;
var DigitCategory = 131;
var NameStartCategory = 132;
var NonPrintableCategory = 133;
for (let i2 = 0; i2 < CATEGORY.length; i2++) {
  CATEGORY[i2] = isWhiteSpace(i2) && WhiteSpaceCategory || isDigit(i2) && DigitCategory || isNameStart(i2) && NameStartCategory || isNonPrintable(i2) && NonPrintableCategory || i2 || EofCategory;
}
function charCodeCategory(code3) {
  return code3 < 128 ? CATEGORY[code3] : NameStartCategory;
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/tokenizer/utils.js
function getCharCode(source, offset) {
  return offset < source.length ? source.charCodeAt(offset) : 0;
}
function getNewlineLength(source, offset, code3) {
  if (code3 === 13 && getCharCode(source, offset + 1) === 10) {
    return 2;
  }
  return 1;
}
function cmpChar(testStr, offset, referenceCode) {
  let code3 = testStr.charCodeAt(offset);
  if (isUppercaseLetter(code3)) {
    code3 = code3 | 32;
  }
  return code3 === referenceCode;
}
function cmpStr(testStr, start, end, referenceStr) {
  if (end - start !== referenceStr.length) {
    return false;
  }
  if (start < 0 || end > testStr.length) {
    return false;
  }
  for (let i2 = start; i2 < end; i2++) {
    const referenceCode = referenceStr.charCodeAt(i2 - start);
    let testCode = testStr.charCodeAt(i2);
    if (isUppercaseLetter(testCode)) {
      testCode = testCode | 32;
    }
    if (testCode !== referenceCode) {
      return false;
    }
  }
  return true;
}
function findWhiteSpaceStart(source, offset) {
  for (; offset >= 0; offset--) {
    if (!isWhiteSpace(source.charCodeAt(offset))) {
      break;
    }
  }
  return offset + 1;
}
function findWhiteSpaceEnd(source, offset) {
  for (; offset < source.length; offset++) {
    if (!isWhiteSpace(source.charCodeAt(offset))) {
      break;
    }
  }
  return offset;
}
function findDecimalNumberEnd(source, offset) {
  for (; offset < source.length; offset++) {
    if (!isDigit(source.charCodeAt(offset))) {
      break;
    }
  }
  return offset;
}
function consumeEscaped(source, offset) {
  offset += 2;
  if (isHexDigit(getCharCode(source, offset - 1))) {
    for (const maxOffset = Math.min(source.length, offset + 5); offset < maxOffset; offset++) {
      if (!isHexDigit(getCharCode(source, offset))) {
        break;
      }
    }
    const code3 = getCharCode(source, offset);
    if (isWhiteSpace(code3)) {
      offset += getNewlineLength(source, offset, code3);
    }
  }
  return offset;
}
function consumeName(source, offset) {
  for (; offset < source.length; offset++) {
    const code3 = source.charCodeAt(offset);
    if (isName(code3)) {
      continue;
    }
    if (isValidEscape(code3, getCharCode(source, offset + 1))) {
      offset = consumeEscaped(source, offset) - 1;
      continue;
    }
    break;
  }
  return offset;
}
function consumeNumber(source, offset) {
  let code3 = source.charCodeAt(offset);
  if (code3 === 43 || code3 === 45) {
    code3 = source.charCodeAt(offset += 1);
  }
  if (isDigit(code3)) {
    offset = findDecimalNumberEnd(source, offset + 1);
    code3 = source.charCodeAt(offset);
  }
  if (code3 === 46 && isDigit(source.charCodeAt(offset + 1))) {
    offset += 2;
    offset = findDecimalNumberEnd(source, offset);
  }
  if (cmpChar(
    source,
    offset,
    101
    /* e */
  )) {
    let sign = 0;
    code3 = source.charCodeAt(offset + 1);
    if (code3 === 45 || code3 === 43) {
      sign = 1;
      code3 = source.charCodeAt(offset + 2);
    }
    if (isDigit(code3)) {
      offset = findDecimalNumberEnd(source, offset + 1 + sign + 1);
    }
  }
  return offset;
}
function consumeBadUrlRemnants(source, offset) {
  for (; offset < source.length; offset++) {
    const code3 = source.charCodeAt(offset);
    if (code3 === 41) {
      offset++;
      break;
    }
    if (isValidEscape(code3, getCharCode(source, offset + 1))) {
      offset = consumeEscaped(source, offset);
    }
  }
  return offset;
}
function decodeEscaped(escaped) {
  if (escaped.length === 1 && !isHexDigit(escaped.charCodeAt(0))) {
    return escaped[0];
  }
  let code3 = parseInt(escaped, 16);
  if (code3 === 0 || // If this number is zero,
  code3 >= 55296 && code3 <= 57343 || // or is for a surrogate,
  code3 > 1114111) {
    code3 = 65533;
  }
  return String.fromCodePoint(code3);
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/tokenizer/names.js
var names_default = [
  "EOF-token",
  "ident-token",
  "function-token",
  "at-keyword-token",
  "hash-token",
  "string-token",
  "bad-string-token",
  "url-token",
  "bad-url-token",
  "delim-token",
  "number-token",
  "percentage-token",
  "dimension-token",
  "whitespace-token",
  "CDO-token",
  "CDC-token",
  "colon-token",
  "semicolon-token",
  "comma-token",
  "[-token",
  "]-token",
  "(-token",
  ")-token",
  "{-token",
  "}-token",
  "comment-token"
];

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/tokenizer/adopt-buffer.js
var MIN_SIZE = 16 * 1024;
function adoptBuffer(buffer = null, size) {
  if (buffer === null || buffer.length < size) {
    return new Uint32Array(Math.max(size + 1024, MIN_SIZE));
  }
  return buffer;
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/tokenizer/OffsetToLocation.js
var N3 = 10;
var F3 = 12;
var R3 = 13;
function computeLinesAndColumns(host) {
  const source = host.source;
  const sourceLength = source.length;
  const startOffset = source.length > 0 ? isBOM(source.charCodeAt(0)) : 0;
  const lines = adoptBuffer(host.lines, sourceLength);
  const columns = adoptBuffer(host.columns, sourceLength);
  let line = host.startLine;
  let column = host.startColumn;
  for (let i2 = startOffset; i2 < sourceLength; i2++) {
    const code3 = source.charCodeAt(i2);
    lines[i2] = line;
    columns[i2] = column++;
    if (code3 === N3 || code3 === R3 || code3 === F3) {
      if (code3 === R3 && i2 + 1 < sourceLength && source.charCodeAt(i2 + 1) === N3) {
        i2++;
        lines[i2] = line;
        columns[i2] = column;
      }
      line++;
      column = 1;
    }
  }
  lines[sourceLength] = line;
  columns[sourceLength] = column;
  host.lines = lines;
  host.columns = columns;
  host.computed = true;
}
var OffsetToLocation = class {
  constructor(source, startOffset, startLine, startColumn) {
    this.setSource(source, startOffset, startLine, startColumn);
    this.lines = null;
    this.columns = null;
  }
  setSource(source = "", startOffset = 0, startLine = 1, startColumn = 1) {
    this.source = source;
    this.startOffset = startOffset;
    this.startLine = startLine;
    this.startColumn = startColumn;
    this.computed = false;
  }
  getLocation(offset, filename) {
    if (!this.computed) {
      computeLinesAndColumns(this);
    }
    return {
      source: filename,
      offset: this.startOffset + offset,
      line: this.lines[offset],
      column: this.columns[offset]
    };
  }
  getLocationRange(start, end, filename) {
    if (!this.computed) {
      computeLinesAndColumns(this);
    }
    return {
      source: filename,
      start: {
        offset: this.startOffset + start,
        line: this.lines[start],
        column: this.columns[start]
      },
      end: {
        offset: this.startOffset + end,
        line: this.lines[end],
        column: this.columns[end]
      }
    };
  }
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/tokenizer/TokenStream.js
var OFFSET_MASK = 16777215;
var TYPE_SHIFT = 24;
var BLOCK_OPEN_TOKEN = 1;
var BLOCK_CLOSE_TOKEN = 2;
var balancePair = new Uint8Array(32);
balancePair[Function] = RightParenthesis;
balancePair[LeftParenthesis] = RightParenthesis;
balancePair[LeftSquareBracket] = RightSquareBracket;
balancePair[LeftCurlyBracket] = RightCurlyBracket;
var blockTokens = new Uint8Array(32);
blockTokens[Function] = BLOCK_OPEN_TOKEN;
blockTokens[LeftParenthesis] = BLOCK_OPEN_TOKEN;
blockTokens[LeftSquareBracket] = BLOCK_OPEN_TOKEN;
blockTokens[LeftCurlyBracket] = BLOCK_OPEN_TOKEN;
blockTokens[RightParenthesis] = BLOCK_CLOSE_TOKEN;
blockTokens[RightSquareBracket] = BLOCK_CLOSE_TOKEN;
blockTokens[RightCurlyBracket] = BLOCK_CLOSE_TOKEN;
function boundIndex(index, min, max) {
  return index < min ? min : index > max ? max : index;
}
var TokenStream = class {
  constructor(source, tokenize2) {
    this.setSource(source, tokenize2);
  }
  reset() {
    this.eof = false;
    this.tokenIndex = -1;
    this.tokenType = 0;
    this.tokenStart = this.firstCharOffset;
    this.tokenEnd = this.firstCharOffset;
  }
  setSource(source = "", tokenize2 = () => {
  }) {
    source = String(source || "");
    const sourceLength = source.length;
    const offsetAndType = adoptBuffer(this.offsetAndType, source.length + 1);
    const balance = adoptBuffer(this.balance, source.length + 1);
    let tokenCount = 0;
    let firstCharOffset = -1;
    let balanceCloseType = 0;
    let balanceStart = source.length;
    this.offsetAndType = null;
    this.balance = null;
    balance.fill(0);
    tokenize2(source, (type, start, end) => {
      const index = tokenCount++;
      offsetAndType[index] = type << TYPE_SHIFT | end;
      if (firstCharOffset === -1) {
        firstCharOffset = start;
      }
      balance[index] = balanceStart;
      if (type === balanceCloseType) {
        const prevBalanceStart = balance[balanceStart];
        balance[balanceStart] = index;
        balanceStart = prevBalanceStart;
        balanceCloseType = balancePair[offsetAndType[prevBalanceStart] >> TYPE_SHIFT];
      } else if (this.isBlockOpenerTokenType(type)) {
        balanceStart = index;
        balanceCloseType = balancePair[type];
      }
    });
    offsetAndType[tokenCount] = EOF << TYPE_SHIFT | sourceLength;
    balance[tokenCount] = tokenCount;
    for (let i2 = 0; i2 < tokenCount; i2++) {
      const balanceStart2 = balance[i2];
      if (balanceStart2 <= i2) {
        const balanceEnd = balance[balanceStart2];
        if (balanceEnd !== i2) {
          balance[i2] = balanceEnd;
        }
      } else if (balanceStart2 > tokenCount) {
        balance[i2] = tokenCount;
      }
    }
    this.source = source;
    this.firstCharOffset = firstCharOffset === -1 ? 0 : firstCharOffset;
    this.tokenCount = tokenCount;
    this.offsetAndType = offsetAndType;
    this.balance = balance;
    this.reset();
    this.next();
  }
  lookupType(offset) {
    offset += this.tokenIndex;
    if (offset < this.tokenCount) {
      return this.offsetAndType[offset] >> TYPE_SHIFT;
    }
    return EOF;
  }
  lookupTypeNonSC(idx) {
    for (let offset = this.tokenIndex; offset < this.tokenCount; offset++) {
      const tokenType = this.offsetAndType[offset] >> TYPE_SHIFT;
      if (tokenType !== WhiteSpace && tokenType !== Comment) {
        if (idx-- === 0) {
          return tokenType;
        }
      }
    }
    return EOF;
  }
  lookupOffset(offset) {
    offset += this.tokenIndex;
    if (offset < this.tokenCount) {
      return this.offsetAndType[offset - 1] & OFFSET_MASK;
    }
    return this.source.length;
  }
  lookupOffsetNonSC(idx) {
    for (let offset = this.tokenIndex; offset < this.tokenCount; offset++) {
      const tokenType = this.offsetAndType[offset] >> TYPE_SHIFT;
      if (tokenType !== WhiteSpace && tokenType !== Comment) {
        if (idx-- === 0) {
          return offset - this.tokenIndex;
        }
      }
    }
    return EOF;
  }
  lookupValue(offset, referenceStr) {
    offset += this.tokenIndex;
    if (offset < this.tokenCount) {
      return cmpStr(
        this.source,
        this.offsetAndType[offset - 1] & OFFSET_MASK,
        this.offsetAndType[offset] & OFFSET_MASK,
        referenceStr
      );
    }
    return false;
  }
  getTokenStart(tokenIndex) {
    if (tokenIndex === this.tokenIndex) {
      return this.tokenStart;
    }
    if (tokenIndex > 0) {
      return tokenIndex < this.tokenCount ? this.offsetAndType[tokenIndex - 1] & OFFSET_MASK : this.offsetAndType[this.tokenCount] & OFFSET_MASK;
    }
    return this.firstCharOffset;
  }
  getTokenEnd(tokenIndex) {
    if (tokenIndex === this.tokenIndex) {
      return this.tokenEnd;
    }
    return this.offsetAndType[boundIndex(tokenIndex, 0, this.tokenCount)] & OFFSET_MASK;
  }
  getTokenType(tokenIndex) {
    if (tokenIndex === this.tokenIndex) {
      return this.tokenType;
    }
    return this.offsetAndType[boundIndex(tokenIndex, 0, this.tokenCount)] >> TYPE_SHIFT;
  }
  substrToCursor(start) {
    return this.source.substring(start, this.tokenStart);
  }
  isBlockOpenerTokenType(tokenType) {
    return blockTokens[tokenType] === BLOCK_OPEN_TOKEN;
  }
  isBlockCloserTokenType(tokenType) {
    return blockTokens[tokenType] === BLOCK_CLOSE_TOKEN;
  }
  getBlockTokenPairIndex(tokenIndex) {
    const type = this.getTokenType(tokenIndex);
    if (blockTokens[type] === 1) {
      const pairIndex = this.balance[tokenIndex];
      const closeType = this.getTokenType(pairIndex);
      return balancePair[type] === closeType ? pairIndex : -1;
    } else if (blockTokens[type] === 2) {
      const pairIndex = this.balance[tokenIndex];
      const openType = this.getTokenType(pairIndex);
      return balancePair[openType] === type ? pairIndex : -1;
    }
    return -1;
  }
  isBalanceEdge(tokenIndex) {
    return this.balance[this.tokenIndex] < tokenIndex;
  }
  isDelim(code3, offset) {
    if (offset) {
      return this.lookupType(offset) === Delim && this.source.charCodeAt(this.lookupOffset(offset)) === code3;
    }
    return this.tokenType === Delim && this.source.charCodeAt(this.tokenStart) === code3;
  }
  skip(tokenCount) {
    let next = this.tokenIndex + tokenCount;
    if (next < this.tokenCount) {
      this.tokenIndex = next;
      this.tokenStart = this.offsetAndType[next - 1] & OFFSET_MASK;
      next = this.offsetAndType[next];
      this.tokenType = next >> TYPE_SHIFT;
      this.tokenEnd = next & OFFSET_MASK;
    } else {
      this.tokenIndex = this.tokenCount;
      this.next();
    }
  }
  next() {
    let next = this.tokenIndex + 1;
    if (next < this.tokenCount) {
      this.tokenIndex = next;
      this.tokenStart = this.tokenEnd;
      next = this.offsetAndType[next];
      this.tokenType = next >> TYPE_SHIFT;
      this.tokenEnd = next & OFFSET_MASK;
    } else {
      this.eof = true;
      this.tokenIndex = this.tokenCount;
      this.tokenType = EOF;
      this.tokenStart = this.tokenEnd = this.source.length;
    }
  }
  skipSC() {
    while (this.tokenType === WhiteSpace || this.tokenType === Comment) {
      this.next();
    }
  }
  skipUntilBalanced(startToken, stopConsume) {
    let cursor = startToken;
    let balanceEnd = 0;
    let offset = 0;
    loop:
      for (; cursor < this.tokenCount; cursor++) {
        balanceEnd = this.balance[cursor];
        if (balanceEnd < startToken) {
          break loop;
        }
        offset = cursor > 0 ? this.offsetAndType[cursor - 1] & OFFSET_MASK : this.firstCharOffset;
        switch (stopConsume(this.source.charCodeAt(offset))) {
          case 1:
            break loop;
          case 2:
            cursor++;
            break loop;
          default:
            if (this.isBlockOpenerTokenType(this.offsetAndType[cursor] >> TYPE_SHIFT)) {
              cursor = balanceEnd;
            }
        }
      }
    this.skip(cursor - this.tokenIndex);
  }
  forEachToken(fn) {
    for (let i2 = 0, offset = this.firstCharOffset; i2 < this.tokenCount; i2++) {
      const start = offset;
      const item = this.offsetAndType[i2];
      const end = item & OFFSET_MASK;
      const type = item >> TYPE_SHIFT;
      offset = end;
      fn(type, start, end, i2);
    }
  }
  dump() {
    const tokens = new Array(this.tokenCount);
    this.forEachToken((type, start, end, index) => {
      tokens[index] = {
        idx: index,
        type: names_default[type],
        chunk: this.source.substring(start, end),
        balance: this.balance[index]
      };
    });
    return tokens;
  }
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/tokenizer/index.js
function tokenize(source, onToken) {
  function getCharCode2(offset2) {
    return offset2 < sourceLength ? source.charCodeAt(offset2) : 0;
  }
  function consumeNumericToken() {
    offset = consumeNumber(source, offset);
    if (isIdentifierStart(getCharCode2(offset), getCharCode2(offset + 1), getCharCode2(offset + 2))) {
      type = Dimension;
      offset = consumeName(source, offset);
      return;
    }
    if (getCharCode2(offset) === 37) {
      type = Percentage;
      offset++;
      return;
    }
    type = Number2;
  }
  function consumeIdentLikeToken() {
    const nameStartOffset = offset;
    offset = consumeName(source, offset);
    if (cmpStr(source, nameStartOffset, offset, "url") && getCharCode2(offset) === 40) {
      offset = findWhiteSpaceEnd(source, offset + 1);
      if (getCharCode2(offset) === 34 || getCharCode2(offset) === 39) {
        type = Function;
        offset = nameStartOffset + 4;
        return;
      }
      consumeUrlToken();
      return;
    }
    if (getCharCode2(offset) === 40) {
      type = Function;
      offset++;
      return;
    }
    type = Ident;
  }
  function consumeStringToken(endingCodePoint) {
    if (!endingCodePoint) {
      endingCodePoint = getCharCode2(offset++);
    }
    type = String2;
    for (; offset < source.length; offset++) {
      const code3 = source.charCodeAt(offset);
      switch (charCodeCategory(code3)) {
        // ending code point
        case endingCodePoint:
          offset++;
          return;
        // EOF
        // case EofCategory:
        // This is a parse error. Return the <string-token>.
        // return;
        // newline
        case WhiteSpaceCategory:
          if (isNewline(code3)) {
            offset += getNewlineLength(source, offset, code3);
            type = BadString;
            return;
          }
          break;
        // U+005C REVERSE SOLIDUS (\)
        case 92:
          if (offset === source.length - 1) {
            break;
          }
          const nextCode = getCharCode2(offset + 1);
          if (isNewline(nextCode)) {
            offset += getNewlineLength(source, offset + 1, nextCode);
          } else if (isValidEscape(code3, nextCode)) {
            offset = consumeEscaped(source, offset) - 1;
          }
          break;
      }
    }
  }
  function consumeUrlToken() {
    type = Url;
    offset = findWhiteSpaceEnd(source, offset);
    for (; offset < source.length; offset++) {
      const code3 = source.charCodeAt(offset);
      switch (charCodeCategory(code3)) {
        // U+0029 RIGHT PARENTHESIS ())
        case 41:
          offset++;
          return;
        // EOF
        // case EofCategory:
        // This is a parse error. Return the <url-token>.
        // return;
        // whitespace
        case WhiteSpaceCategory:
          offset = findWhiteSpaceEnd(source, offset);
          if (getCharCode2(offset) === 41 || offset >= source.length) {
            if (offset < source.length) {
              offset++;
            }
            return;
          }
          offset = consumeBadUrlRemnants(source, offset);
          type = BadUrl;
          return;
        // U+0022 QUOTATION MARK (")
        // U+0027 APOSTROPHE (')
        // U+0028 LEFT PARENTHESIS (()
        // non-printable code point
        case 34:
        case 39:
        case 40:
        case NonPrintableCategory:
          offset = consumeBadUrlRemnants(source, offset);
          type = BadUrl;
          return;
        // U+005C REVERSE SOLIDUS (\)
        case 92:
          if (isValidEscape(code3, getCharCode2(offset + 1))) {
            offset = consumeEscaped(source, offset) - 1;
            break;
          }
          offset = consumeBadUrlRemnants(source, offset);
          type = BadUrl;
          return;
      }
    }
  }
  source = String(source || "");
  const sourceLength = source.length;
  let start = isBOM(getCharCode2(0));
  let offset = start;
  let type;
  while (offset < sourceLength) {
    const code3 = source.charCodeAt(offset);
    switch (charCodeCategory(code3)) {
      // whitespace
      case WhiteSpaceCategory:
        type = WhiteSpace;
        offset = findWhiteSpaceEnd(source, offset + 1);
        break;
      // U+0022 QUOTATION MARK (")
      case 34:
        consumeStringToken();
        break;
      // U+0023 NUMBER SIGN (#)
      case 35:
        if (isName(getCharCode2(offset + 1)) || isValidEscape(getCharCode2(offset + 1), getCharCode2(offset + 2))) {
          type = Hash;
          offset = consumeName(source, offset + 1);
        } else {
          type = Delim;
          offset++;
        }
        break;
      // U+0027 APOSTROPHE (')
      case 39:
        consumeStringToken();
        break;
      // U+0028 LEFT PARENTHESIS (()
      case 40:
        type = LeftParenthesis;
        offset++;
        break;
      // U+0029 RIGHT PARENTHESIS ())
      case 41:
        type = RightParenthesis;
        offset++;
        break;
      // U+002B PLUS SIGN (+)
      case 43:
        if (isNumberStart(code3, getCharCode2(offset + 1), getCharCode2(offset + 2))) {
          consumeNumericToken();
        } else {
          type = Delim;
          offset++;
        }
        break;
      // U+002C COMMA (,)
      case 44:
        type = Comma;
        offset++;
        break;
      // U+002D HYPHEN-MINUS (-)
      case 45:
        if (isNumberStart(code3, getCharCode2(offset + 1), getCharCode2(offset + 2))) {
          consumeNumericToken();
        } else {
          if (getCharCode2(offset + 1) === 45 && getCharCode2(offset + 2) === 62) {
            type = CDC;
            offset = offset + 3;
          } else {
            if (isIdentifierStart(code3, getCharCode2(offset + 1), getCharCode2(offset + 2))) {
              consumeIdentLikeToken();
            } else {
              type = Delim;
              offset++;
            }
          }
        }
        break;
      // U+002E FULL STOP (.)
      case 46:
        if (isNumberStart(code3, getCharCode2(offset + 1), getCharCode2(offset + 2))) {
          consumeNumericToken();
        } else {
          type = Delim;
          offset++;
        }
        break;
      // U+002F SOLIDUS (/)
      case 47:
        if (getCharCode2(offset + 1) === 42) {
          type = Comment;
          offset = source.indexOf("*/", offset + 2);
          offset = offset === -1 ? source.length : offset + 2;
        } else {
          type = Delim;
          offset++;
        }
        break;
      // U+003A COLON (:)
      case 58:
        type = Colon;
        offset++;
        break;
      // U+003B SEMICOLON (;)
      case 59:
        type = Semicolon;
        offset++;
        break;
      // U+003C LESS-THAN SIGN (<)
      case 60:
        if (getCharCode2(offset + 1) === 33 && getCharCode2(offset + 2) === 45 && getCharCode2(offset + 3) === 45) {
          type = CDO;
          offset = offset + 4;
        } else {
          type = Delim;
          offset++;
        }
        break;
      // U+0040 COMMERCIAL AT (@)
      case 64:
        if (isIdentifierStart(getCharCode2(offset + 1), getCharCode2(offset + 2), getCharCode2(offset + 3))) {
          type = AtKeyword;
          offset = consumeName(source, offset + 1);
        } else {
          type = Delim;
          offset++;
        }
        break;
      // U+005B LEFT SQUARE BRACKET ([)
      case 91:
        type = LeftSquareBracket;
        offset++;
        break;
      // U+005C REVERSE SOLIDUS (\)
      case 92:
        if (isValidEscape(code3, getCharCode2(offset + 1))) {
          consumeIdentLikeToken();
        } else {
          type = Delim;
          offset++;
        }
        break;
      // U+005D RIGHT SQUARE BRACKET (])
      case 93:
        type = RightSquareBracket;
        offset++;
        break;
      // U+007B LEFT CURLY BRACKET ({)
      case 123:
        type = LeftCurlyBracket;
        offset++;
        break;
      // U+007D RIGHT CURLY BRACKET (})
      case 125:
        type = RightCurlyBracket;
        offset++;
        break;
      // digit
      case DigitCategory:
        consumeNumericToken();
        break;
      // name-start code point
      case NameStartCategory:
        consumeIdentLikeToken();
        break;
      // EOF
      // case EofCategory:
      // Return an <EOF-token>.
      // break;
      // anything else
      default:
        type = Delim;
        offset++;
    }
    onToken(type, start, start = offset);
  }
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/parser/sequence.js
function readSequence(recognizer) {
  const children = this.createList();
  let space = false;
  const context = {
    recognizer
  };
  while (!this.eof) {
    switch (this.tokenType) {
      case Comment:
        this.next();
        continue;
      case WhiteSpace:
        space = true;
        this.next();
        continue;
    }
    let child2 = recognizer.getNode.call(this, context);
    if (child2 === void 0) {
      break;
    }
    if (space) {
      if (recognizer.onWhiteSpace) {
        recognizer.onWhiteSpace.call(this, child2, children, context);
      }
      space = false;
    }
    children.push(child2);
  }
  if (space && recognizer.onWhiteSpace) {
    recognizer.onWhiteSpace.call(this, null, children, context);
  }
  return children;
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/parser/create.js
var NOOP = () => {
};
var EXCLAMATIONMARK = 33;
var NUMBERSIGN = 35;
var SEMICOLON = 59;
var LEFTCURLYBRACKET = 123;
var NULL = 0;
var arrayMethods = {
  createList() {
    return [];
  },
  createSingleNodeList(node) {
    return [node];
  },
  getFirstListNode(list2) {
    return list2 && list2[0] || null;
  },
  getLastListNode(list2) {
    return list2 && list2.length > 0 ? list2[list2.length - 1] : null;
  }
};
var listMethods = {
  createList() {
    return new List();
  },
  createSingleNodeList(node) {
    return new List().appendData(node);
  },
  getFirstListNode(list2) {
    return list2 && list2.first;
  },
  getLastListNode(list2) {
    return list2 && list2.last;
  }
};
function createParseContext(name50) {
  return function() {
    return this[name50]();
  };
}
function fetchParseValues(dict) {
  const result = /* @__PURE__ */ Object.create(null);
  for (const name50 of Object.keys(dict)) {
    const item = dict[name50];
    const fn = item.parse || item;
    if (fn) {
      result[name50] = fn;
    }
  }
  return result;
}
function processConfig(config) {
  const parseConfig = {
    context: /* @__PURE__ */ Object.create(null),
    features: Object.assign(/* @__PURE__ */ Object.create(null), config.features),
    scope: Object.assign(/* @__PURE__ */ Object.create(null), config.scope),
    atrule: fetchParseValues(config.atrule),
    pseudo: fetchParseValues(config.pseudo),
    node: fetchParseValues(config.node)
  };
  for (const [name50, context] of Object.entries(config.parseContext)) {
    switch (typeof context) {
      case "function":
        parseConfig.context[name50] = context;
        break;
      case "string":
        parseConfig.context[name50] = createParseContext(context);
        break;
    }
  }
  return {
    config: parseConfig,
    ...parseConfig,
    ...parseConfig.node
  };
}
function createParser(config) {
  let source = "";
  let filename = "<unknown>";
  let needPositions = false;
  let onParseError = NOOP;
  let onParseErrorThrow = false;
  const locationMap = new OffsetToLocation();
  const parser = Object.assign(new TokenStream(), processConfig(config || {}), {
    parseAtrulePrelude: true,
    parseRulePrelude: true,
    parseValue: true,
    parseCustomProperty: false,
    readSequence,
    consumeUntilBalanceEnd: () => 0,
    consumeUntilLeftCurlyBracket(code3) {
      return code3 === LEFTCURLYBRACKET ? 1 : 0;
    },
    consumeUntilLeftCurlyBracketOrSemicolon(code3) {
      return code3 === LEFTCURLYBRACKET || code3 === SEMICOLON ? 1 : 0;
    },
    consumeUntilExclamationMarkOrSemicolon(code3) {
      return code3 === EXCLAMATIONMARK || code3 === SEMICOLON ? 1 : 0;
    },
    consumeUntilSemicolonIncluded(code3) {
      return code3 === SEMICOLON ? 2 : 0;
    },
    createList: NOOP,
    createSingleNodeList: NOOP,
    getFirstListNode: NOOP,
    getLastListNode: NOOP,
    parseWithFallback(consumer, fallback) {
      const startIndex = this.tokenIndex;
      try {
        return consumer.call(this);
      } catch (e3) {
        if (onParseErrorThrow) {
          throw e3;
        }
        this.skip(startIndex - this.tokenIndex);
        const fallbackNode = fallback.call(this);
        onParseErrorThrow = true;
        onParseError(e3, fallbackNode);
        onParseErrorThrow = false;
        return fallbackNode;
      }
    },
    lookupNonWSType(offset) {
      let type;
      do {
        type = this.lookupType(offset++);
        if (type !== WhiteSpace && type !== Comment) {
          return type;
        }
      } while (type !== NULL);
      return NULL;
    },
    charCodeAt(offset) {
      return offset >= 0 && offset < source.length ? source.charCodeAt(offset) : 0;
    },
    substring(offsetStart, offsetEnd) {
      return source.substring(offsetStart, offsetEnd);
    },
    substrToCursor(start) {
      return this.source.substring(start, this.tokenStart);
    },
    cmpChar(offset, charCode) {
      return cmpChar(source, offset, charCode);
    },
    cmpStr(offsetStart, offsetEnd, str) {
      return cmpStr(source, offsetStart, offsetEnd, str);
    },
    consume(tokenType) {
      const start = this.tokenStart;
      this.eat(tokenType);
      return this.substrToCursor(start);
    },
    consumeFunctionName() {
      const name50 = source.substring(this.tokenStart, this.tokenEnd - 1);
      this.eat(Function);
      return name50;
    },
    consumeNumber(type) {
      const number2 = source.substring(this.tokenStart, consumeNumber(source, this.tokenStart));
      this.eat(type);
      return number2;
    },
    eat(tokenType) {
      if (this.tokenType !== tokenType) {
        const tokenName = names_default[tokenType].slice(0, -6).replace(/-/g, " ").replace(/^./, (m2) => m2.toUpperCase());
        let message2 = `${/[[\](){}]/.test(tokenName) ? `"${tokenName}"` : tokenName} is expected`;
        let offset = this.tokenStart;
        switch (tokenType) {
          case Ident:
            if (this.tokenType === Function || this.tokenType === Url) {
              offset = this.tokenEnd - 1;
              message2 = "Identifier is expected but function found";
            } else {
              message2 = "Identifier is expected";
            }
            break;
          case Hash:
            if (this.isDelim(NUMBERSIGN)) {
              this.next();
              offset++;
              message2 = "Name is expected";
            }
            break;
          case Percentage:
            if (this.tokenType === Number2) {
              offset = this.tokenEnd;
              message2 = "Percent sign is expected";
            }
            break;
        }
        this.error(message2, offset);
      }
      this.next();
    },
    eatIdent(name50) {
      if (this.tokenType !== Ident || this.lookupValue(0, name50) === false) {
        this.error(`Identifier "${name50}" is expected`);
      }
      this.next();
    },
    eatDelim(code3) {
      if (!this.isDelim(code3)) {
        this.error(`Delim "${String.fromCharCode(code3)}" is expected`);
      }
      this.next();
    },
    getLocation(start, end) {
      if (needPositions) {
        return locationMap.getLocationRange(
          start,
          end,
          filename
        );
      }
      return null;
    },
    getLocationFromList(list2) {
      if (needPositions) {
        const head = this.getFirstListNode(list2);
        const tail = this.getLastListNode(list2);
        return locationMap.getLocationRange(
          head !== null ? head.loc.start.offset - locationMap.startOffset : this.tokenStart,
          tail !== null ? tail.loc.end.offset - locationMap.startOffset : this.tokenStart,
          filename
        );
      }
      return null;
    },
    error(message2, offset) {
      const location = typeof offset !== "undefined" && offset < source.length ? locationMap.getLocation(offset) : this.eof ? locationMap.getLocation(findWhiteSpaceStart(source, source.length - 1)) : locationMap.getLocation(this.tokenStart);
      throw new SyntaxError2(
        message2 || "Unexpected input",
        source,
        location.offset,
        location.line,
        location.column,
        locationMap.startLine,
        locationMap.startColumn
      );
    }
  });
  const createTokenIterateAPI = () => ({
    filename,
    source,
    tokenCount: parser.tokenCount,
    getTokenType: (index) => parser.getTokenType(index),
    getTokenTypeName: (index) => names_default[parser.getTokenType(index)],
    getTokenStart: (index) => parser.getTokenStart(index),
    getTokenEnd: (index) => parser.getTokenEnd(index),
    getTokenValue: (index) => parser.source.substring(parser.getTokenStart(index), parser.getTokenEnd(index)),
    substring: (start, end) => parser.source.substring(start, end),
    balance: parser.balance.subarray(0, parser.tokenCount + 1),
    isBlockOpenerTokenType: parser.isBlockOpenerTokenType,
    isBlockCloserTokenType: parser.isBlockCloserTokenType,
    getBlockTokenPairIndex: (index) => parser.getBlockTokenPairIndex(index),
    getLocation: (offset) => locationMap.getLocation(offset, filename),
    getRangeLocation: (start, end) => locationMap.getLocationRange(start, end, filename)
  });
  const parse52 = function(source_, options) {
    source = source_;
    options = options || {};
    parser.setSource(source, tokenize);
    locationMap.setSource(
      source,
      options.offset,
      options.line,
      options.column
    );
    filename = options.filename || "<unknown>";
    needPositions = Boolean(options.positions);
    onParseError = typeof options.onParseError === "function" ? options.onParseError : NOOP;
    onParseErrorThrow = false;
    parser.parseAtrulePrelude = "parseAtrulePrelude" in options ? Boolean(options.parseAtrulePrelude) : true;
    parser.parseRulePrelude = "parseRulePrelude" in options ? Boolean(options.parseRulePrelude) : true;
    parser.parseValue = "parseValue" in options ? Boolean(options.parseValue) : true;
    parser.parseCustomProperty = "parseCustomProperty" in options ? Boolean(options.parseCustomProperty) : false;
    const { context = "default", list: list2 = true, onComment, onToken } = options;
    if (context in parser.context === false) {
      throw new Error("Unknown context `" + context + "`");
    }
    Object.assign(parser, list2 ? listMethods : arrayMethods);
    if (Array.isArray(onToken)) {
      parser.forEachToken((type, start, end) => {
        onToken.push({ type, start, end });
      });
    } else if (typeof onToken === "function") {
      parser.forEachToken(onToken.bind(createTokenIterateAPI()));
    }
    if (typeof onComment === "function") {
      parser.forEachToken((type, start, end) => {
        if (type === Comment) {
          const loc = parser.getLocation(start, end);
          const value = cmpStr(source, end - 2, end, "*/") ? source.slice(start + 2, end - 2) : source.slice(start + 2, end);
          onComment(value, loc);
        }
      });
    }
    const ast = parser.context[context].call(parser, options);
    if (!parser.eof) {
      parser.error();
    }
    return ast;
  };
  return Object.assign(parse52, {
    SyntaxError: SyntaxError2,
    config: parser.config
  });
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/scope/index.js
var scope_exports = {};
__export(scope_exports, {
  AtrulePrelude: () => atrulePrelude_default,
  Selector: () => selector_default,
  Value: () => value_default
});

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/scope/default.js
var NUMBERSIGN2 = 35;
var ASTERISK = 42;
var PLUSSIGN = 43;
var HYPHENMINUS = 45;
var SOLIDUS = 47;
var U = 117;
function defaultRecognizer(context) {
  switch (this.tokenType) {
    case Hash:
      return this.Hash();
    case Comma:
      return this.Operator();
    case LeftParenthesis:
      return this.Parentheses(this.readSequence, context.recognizer);
    case LeftSquareBracket:
      return this.Brackets(this.readSequence, context.recognizer);
    case String2:
      return this.String();
    case Dimension:
      return this.Dimension();
    case Percentage:
      return this.Percentage();
    case Number2:
      return this.Number();
    case Function:
      return this.cmpStr(this.tokenStart, this.tokenEnd, "url(") ? this.Url() : this.Function(this.readSequence, context.recognizer);
    case Url:
      return this.Url();
    case Ident:
      if (this.cmpChar(this.tokenStart, U) && this.cmpChar(this.tokenStart + 1, PLUSSIGN)) {
        return this.UnicodeRange();
      } else {
        return this.Identifier();
      }
    case Delim: {
      const code3 = this.charCodeAt(this.tokenStart);
      if (code3 === SOLIDUS || code3 === ASTERISK || code3 === PLUSSIGN || code3 === HYPHENMINUS) {
        return this.Operator();
      }
      if (code3 === NUMBERSIGN2) {
        this.error("Hex or identifier is expected", this.tokenStart + 1);
      }
      break;
    }
  }
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/scope/atrulePrelude.js
var atrulePrelude_default = {
  getNode: defaultRecognizer
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/scope/selector.js
var NUMBERSIGN3 = 35;
var AMPERSAND = 38;
var ASTERISK2 = 42;
var PLUSSIGN2 = 43;
var SOLIDUS2 = 47;
var FULLSTOP = 46;
var GREATERTHANSIGN = 62;
var VERTICALLINE = 124;
var TILDE = 126;
function onWhiteSpace(next, children) {
  if (children.last !== null && children.last.type !== "Combinator" && next !== null && next.type !== "Combinator") {
    children.push({
      // FIXME: this.Combinator() should be used instead
      type: "Combinator",
      loc: null,
      name: " "
    });
  }
}
function getNode() {
  switch (this.tokenType) {
    case LeftSquareBracket:
      return this.AttributeSelector();
    case Hash:
      return this.IdSelector();
    case Colon:
      if (this.lookupType(1) === Colon) {
        return this.PseudoElementSelector();
      } else {
        return this.PseudoClassSelector();
      }
    case Ident:
      return this.TypeSelector();
    case Number2:
    case Percentage:
      return this.Percentage();
    case Dimension:
      if (this.charCodeAt(this.tokenStart) === FULLSTOP) {
        this.error("Identifier is expected", this.tokenStart + 1);
      }
      break;
    case Delim: {
      const code3 = this.charCodeAt(this.tokenStart);
      switch (code3) {
        case PLUSSIGN2:
        case GREATERTHANSIGN:
        case TILDE:
        case SOLIDUS2:
          return this.Combinator();
        case FULLSTOP:
          return this.ClassSelector();
        case ASTERISK2:
        case VERTICALLINE:
          return this.TypeSelector();
        case NUMBERSIGN3:
          return this.IdSelector();
        case AMPERSAND:
          return this.NestingSelector();
      }
      break;
    }
  }
}
var selector_default = {
  onWhiteSpace,
  getNode
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/function/expression.js
function expression_default() {
  return this.createSingleNodeList(
    this.Raw(null, false)
  );
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/function/var.js
function var_default() {
  const children = this.createList();
  this.skipSC();
  children.push(this.Identifier());
  this.skipSC();
  if (this.tokenType === Comma) {
    children.push(this.Operator());
    const startIndex = this.tokenIndex;
    const value = this.parseCustomProperty ? this.Value(null) : this.Raw(this.consumeUntilExclamationMarkOrSemicolon, false);
    if (value.type === "Value" && value.children.isEmpty) {
      for (let offset = startIndex - this.tokenIndex; offset <= 0; offset++) {
        if (this.lookupType(offset) === WhiteSpace) {
          value.children.appendData({
            type: "WhiteSpace",
            loc: null,
            value: " "
          });
          break;
        }
      }
    }
    children.push(value);
  }
  return children;
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/scope/value.js
function isPlusMinusOperator(node) {
  return node !== null && node.type === "Operator" && (node.value[node.value.length - 1] === "-" || node.value[node.value.length - 1] === "+");
}
var value_default = {
  getNode: defaultRecognizer,
  onWhiteSpace(next, children) {
    if (isPlusMinusOperator(next)) {
      next.value = " " + next.value;
    }
    if (isPlusMinusOperator(children.last)) {
      children.last.value += " ";
    }
  },
  "expression": expression_default,
  "var": var_default
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/atrule/container.js
var nonContainerNameKeywords = /* @__PURE__ */ new Set(["none", "and", "not", "or"]);
var container_default = {
  parse: {
    prelude() {
      const children = this.createList();
      if (this.tokenType === Ident) {
        const name50 = this.substring(this.tokenStart, this.tokenEnd);
        if (!nonContainerNameKeywords.has(name50.toLowerCase())) {
          children.push(this.Identifier());
        }
      }
      children.push(this.Condition("container"));
      return children;
    },
    block(nested = false) {
      return this.Block(nested);
    }
  }
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/atrule/font-face.js
var font_face_default = {
  parse: {
    prelude: null,
    block() {
      return this.Block(true);
    }
  }
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/atrule/import.js
function parseWithFallback(parse52, fallback) {
  return this.parseWithFallback(
    () => {
      try {
        return parse52.call(this);
      } finally {
        this.skipSC();
        if (this.lookupNonWSType(0) !== RightParenthesis) {
          this.error();
        }
      }
    },
    fallback || (() => this.Raw(null, true))
  );
}
var parseFunctions = {
  layer() {
    this.skipSC();
    const children = this.createList();
    const node = parseWithFallback.call(this, this.Layer);
    if (node.type !== "Raw" || node.value !== "") {
      children.push(node);
    }
    return children;
  },
  supports() {
    this.skipSC();
    const children = this.createList();
    const node = parseWithFallback.call(
      this,
      this.Declaration,
      () => parseWithFallback.call(this, () => this.Condition("supports"))
    );
    if (node.type !== "Raw" || node.value !== "") {
      children.push(node);
    }
    return children;
  }
};
var import_default3 = {
  parse: {
    prelude() {
      const children = this.createList();
      switch (this.tokenType) {
        case String2:
          children.push(this.String());
          break;
        case Url:
        case Function:
          children.push(this.Url());
          break;
        default:
          this.error("String or url() is expected");
      }
      this.skipSC();
      if (this.tokenType === Ident && this.cmpStr(this.tokenStart, this.tokenEnd, "layer")) {
        children.push(this.Identifier());
      } else if (this.tokenType === Function && this.cmpStr(this.tokenStart, this.tokenEnd, "layer(")) {
        children.push(this.Function(null, parseFunctions));
      }
      this.skipSC();
      if (this.tokenType === Function && this.cmpStr(this.tokenStart, this.tokenEnd, "supports(")) {
        children.push(this.Function(null, parseFunctions));
      }
      if (this.lookupNonWSType(0) === Ident || this.lookupNonWSType(0) === LeftParenthesis) {
        children.push(this.MediaQueryList());
      }
      return children;
    },
    block: null
  }
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/atrule/layer.js
var layer_default = {
  parse: {
    prelude() {
      return this.createSingleNodeList(
        this.LayerList()
      );
    },
    block() {
      return this.Block(false);
    }
  }
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/atrule/media.js
var media_default = {
  parse: {
    prelude() {
      return this.createSingleNodeList(
        this.MediaQueryList()
      );
    },
    block(nested = false) {
      return this.Block(nested);
    }
  }
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/atrule/nest.js
var nest_default = {
  parse: {
    prelude() {
      return this.createSingleNodeList(
        this.SelectorList()
      );
    },
    block() {
      return this.Block(true);
    }
  }
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/atrule/page.js
var page_default = {
  parse: {
    prelude() {
      return this.createSingleNodeList(
        this.SelectorList()
      );
    },
    block() {
      return this.Block(true);
    }
  }
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/atrule/scope.js
var scope_default = {
  parse: {
    prelude() {
      return this.createSingleNodeList(
        this.Scope()
      );
    },
    block(nested = false) {
      return this.Block(nested);
    }
  }
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/atrule/starting-style.js
var starting_style_default = {
  parse: {
    prelude: null,
    block(nested = false) {
      return this.Block(nested);
    }
  }
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/atrule/supports.js
var supports_default = {
  parse: {
    prelude() {
      return this.createSingleNodeList(
        this.Condition("supports")
      );
    },
    block(nested = false) {
      return this.Block(nested);
    }
  }
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/atrule/index.js
var atrule_default = {
  container: container_default,
  "font-face": font_face_default,
  import: import_default3,
  layer: layer_default,
  media: media_default,
  nest: nest_default,
  page: page_default,
  scope: scope_default,
  "starting-style": starting_style_default,
  supports: supports_default
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/pseudo/lang.js
function parseLanguageRangeList() {
  const children = this.createList();
  this.skipSC();
  loop: while (!this.eof) {
    switch (this.tokenType) {
      case Ident:
        children.push(this.Identifier());
        break;
      case String2:
        children.push(this.String());
        break;
      case Comma:
        children.push(this.Operator());
        break;
      case RightParenthesis:
        break loop;
      default:
        this.error("Identifier, string or comma is expected");
    }
    this.skipSC();
  }
  return children;
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/pseudo/index.js
var selectorList = {
  parse() {
    return this.createSingleNodeList(
      this.SelectorList()
    );
  }
};
var selector = {
  parse() {
    return this.createSingleNodeList(
      this.Selector()
    );
  }
};
var identList = {
  parse() {
    return this.createSingleNodeList(
      this.Identifier()
    );
  }
};
var langList = {
  parse: parseLanguageRangeList
};
var nth = {
  parse() {
    return this.createSingleNodeList(
      this.Nth()
    );
  }
};
var pseudo_default = {
  "dir": identList,
  "has": selectorList,
  "lang": langList,
  "matches": selectorList,
  "is": selectorList,
  "-moz-any": selectorList,
  "-webkit-any": selectorList,
  "where": selectorList,
  "not": selectorList,
  "nth-child": nth,
  "nth-last-child": nth,
  "nth-last-of-type": nth,
  "nth-of-type": nth,
  "slotted": selector,
  "host": selector,
  "host-context": selector
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/index-parse.js
var index_parse_exports = {};
__export(index_parse_exports, {
  AnPlusB: () => parse2,
  Atrule: () => parse3,
  AtrulePrelude: () => parse4,
  AttributeSelector: () => parse5,
  Block: () => parse6,
  Brackets: () => parse7,
  CDC: () => parse8,
  CDO: () => parse9,
  ClassSelector: () => parse10,
  Combinator: () => parse11,
  Comment: () => parse12,
  Condition: () => parse13,
  Declaration: () => parse14,
  DeclarationList: () => parse15,
  Dimension: () => parse16,
  Feature: () => parse17,
  FeatureFunction: () => parse18,
  FeatureRange: () => parse19,
  Function: () => parse20,
  GeneralEnclosed: () => parse21,
  Hash: () => parse22,
  IdSelector: () => parse24,
  Identifier: () => parse23,
  Layer: () => parse25,
  LayerList: () => parse26,
  MediaQuery: () => parse27,
  MediaQueryList: () => parse28,
  NestingSelector: () => parse29,
  Nth: () => parse30,
  Number: () => parse31,
  Operator: () => parse32,
  Parentheses: () => parse33,
  Percentage: () => parse34,
  PseudoClassSelector: () => parse35,
  PseudoElementSelector: () => parse36,
  Ratio: () => parse37,
  Raw: () => parse38,
  Rule: () => parse39,
  Scope: () => parse40,
  Selector: () => parse41,
  SelectorList: () => parse42,
  String: () => parse43,
  StyleSheet: () => parse44,
  SupportsDeclaration: () => parse45,
  TypeSelector: () => parse46,
  UnicodeRange: () => parse47,
  Url: () => parse48,
  Value: () => parse49,
  WhiteSpace: () => parse50
});

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/AnPlusB.js
var AnPlusB_exports = {};
__export(AnPlusB_exports, {
  generate: () => generate,
  name: () => name,
  parse: () => parse2,
  structure: () => structure
});
var PLUSSIGN3 = 43;
var HYPHENMINUS2 = 45;
var N4 = 110;
var DISALLOW_SIGN = true;
var ALLOW_SIGN = false;
function checkInteger(offset, disallowSign) {
  let pos = this.tokenStart + offset;
  const code3 = this.charCodeAt(pos);
  if (code3 === PLUSSIGN3 || code3 === HYPHENMINUS2) {
    if (disallowSign) {
      this.error("Number sign is not allowed");
    }
    pos++;
  }
  for (; pos < this.tokenEnd; pos++) {
    if (!isDigit(this.charCodeAt(pos))) {
      this.error("Integer is expected", pos);
    }
  }
}
function checkTokenIsInteger(disallowSign) {
  return checkInteger.call(this, 0, disallowSign);
}
function expectCharCode(offset, code3) {
  if (!this.cmpChar(this.tokenStart + offset, code3)) {
    let msg = "";
    switch (code3) {
      case N4:
        msg = "N is expected";
        break;
      case HYPHENMINUS2:
        msg = "HyphenMinus is expected";
        break;
    }
    this.error(msg, this.tokenStart + offset);
  }
}
function consumeB() {
  let offset = 0;
  let sign = 0;
  let type = this.tokenType;
  while (type === WhiteSpace || type === Comment) {
    type = this.lookupType(++offset);
  }
  if (type !== Number2) {
    if (this.isDelim(PLUSSIGN3, offset) || this.isDelim(HYPHENMINUS2, offset)) {
      sign = this.isDelim(PLUSSIGN3, offset) ? PLUSSIGN3 : HYPHENMINUS2;
      do {
        type = this.lookupType(++offset);
      } while (type === WhiteSpace || type === Comment);
      if (type !== Number2) {
        this.skip(offset);
        checkTokenIsInteger.call(this, DISALLOW_SIGN);
      }
    } else {
      return null;
    }
  }
  if (offset > 0) {
    this.skip(offset);
  }
  if (sign === 0) {
    type = this.charCodeAt(this.tokenStart);
    if (type !== PLUSSIGN3 && type !== HYPHENMINUS2) {
      this.error("Number sign is expected");
    }
  }
  checkTokenIsInteger.call(this, sign !== 0);
  return sign === HYPHENMINUS2 ? "-" + this.consume(Number2) : this.consume(Number2);
}
var name = "AnPlusB";
var structure = {
  a: [String, null],
  b: [String, null]
};
function parse2() {
  const start = this.tokenStart;
  let a2 = null;
  let b2 = null;
  if (this.tokenType === Number2) {
    checkTokenIsInteger.call(this, ALLOW_SIGN);
    b2 = this.consume(Number2);
  } else if (this.tokenType === Ident && this.cmpChar(this.tokenStart, HYPHENMINUS2)) {
    a2 = "-1";
    expectCharCode.call(this, 1, N4);
    switch (this.tokenEnd - this.tokenStart) {
      // -n
      // -n <signed-integer>
      // -n ['+' | '-'] <signless-integer>
      case 2:
        this.next();
        b2 = consumeB.call(this);
        break;
      // -n- <signless-integer>
      case 3:
        expectCharCode.call(this, 2, HYPHENMINUS2);
        this.next();
        this.skipSC();
        checkTokenIsInteger.call(this, DISALLOW_SIGN);
        b2 = "-" + this.consume(Number2);
        break;
      // <dashndashdigit-ident>
      default:
        expectCharCode.call(this, 2, HYPHENMINUS2);
        checkInteger.call(this, 3, DISALLOW_SIGN);
        this.next();
        b2 = this.substrToCursor(start + 2);
    }
  } else if (this.tokenType === Ident || this.isDelim(PLUSSIGN3) && this.lookupType(1) === Ident) {
    let sign = 0;
    a2 = "1";
    if (this.isDelim(PLUSSIGN3)) {
      sign = 1;
      this.next();
    }
    expectCharCode.call(this, 0, N4);
    switch (this.tokenEnd - this.tokenStart) {
      // '+'? n
      // '+'? n <signed-integer>
      // '+'? n ['+' | '-'] <signless-integer>
      case 1:
        this.next();
        b2 = consumeB.call(this);
        break;
      // '+'? n- <signless-integer>
      case 2:
        expectCharCode.call(this, 1, HYPHENMINUS2);
        this.next();
        this.skipSC();
        checkTokenIsInteger.call(this, DISALLOW_SIGN);
        b2 = "-" + this.consume(Number2);
        break;
      // '+'? <ndashdigit-ident>
      default:
        expectCharCode.call(this, 1, HYPHENMINUS2);
        checkInteger.call(this, 2, DISALLOW_SIGN);
        this.next();
        b2 = this.substrToCursor(start + sign + 1);
    }
  } else if (this.tokenType === Dimension) {
    const code3 = this.charCodeAt(this.tokenStart);
    const sign = code3 === PLUSSIGN3 || code3 === HYPHENMINUS2;
    let i2 = this.tokenStart + sign;
    for (; i2 < this.tokenEnd; i2++) {
      if (!isDigit(this.charCodeAt(i2))) {
        break;
      }
    }
    if (i2 === this.tokenStart + sign) {
      this.error("Integer is expected", this.tokenStart + sign);
    }
    expectCharCode.call(this, i2 - this.tokenStart, N4);
    a2 = this.substring(start, i2);
    if (i2 + 1 === this.tokenEnd) {
      this.next();
      b2 = consumeB.call(this);
    } else {
      expectCharCode.call(this, i2 - this.tokenStart + 1, HYPHENMINUS2);
      if (i2 + 2 === this.tokenEnd) {
        this.next();
        this.skipSC();
        checkTokenIsInteger.call(this, DISALLOW_SIGN);
        b2 = "-" + this.consume(Number2);
      } else {
        checkInteger.call(this, i2 - this.tokenStart + 2, DISALLOW_SIGN);
        this.next();
        b2 = this.substrToCursor(i2 + 1);
      }
    }
  } else {
    this.error();
  }
  if (a2 !== null && a2.charCodeAt(0) === PLUSSIGN3) {
    a2 = a2.substr(1);
  }
  if (b2 !== null && b2.charCodeAt(0) === PLUSSIGN3) {
    b2 = b2.substr(1);
  }
  return {
    type: "AnPlusB",
    loc: this.getLocation(start, this.tokenStart),
    a: a2,
    b: b2
  };
}
function generate(node) {
  if (node.a) {
    const a2 = node.a === "+1" && "n" || node.a === "1" && "n" || node.a === "-1" && "-n" || node.a + "n";
    if (node.b) {
      const b2 = node.b[0] === "-" || node.b[0] === "+" ? node.b : "+" + node.b;
      this.tokenize(a2 + b2);
    } else {
      this.tokenize(a2);
    }
  } else {
    this.tokenize(node.b);
  }
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Atrule.js
var Atrule_exports = {};
__export(Atrule_exports, {
  generate: () => generate2,
  name: () => name2,
  parse: () => parse3,
  structure: () => structure2,
  walkContext: () => walkContext
});
function consumeRaw() {
  return this.Raw(this.consumeUntilLeftCurlyBracketOrSemicolon, true);
}
function isDeclarationBlockAtrule() {
  for (let offset = 1, type; type = this.lookupType(offset); offset++) {
    if (type === RightCurlyBracket) {
      return true;
    }
    if (type === LeftCurlyBracket || type === AtKeyword) {
      return false;
    }
  }
  return false;
}
var name2 = "Atrule";
var walkContext = "atrule";
var structure2 = {
  name: String,
  prelude: ["AtrulePrelude", "Raw", null],
  block: ["Block", null]
};
function parse3(isDeclaration = false) {
  const start = this.tokenStart;
  let name50;
  let nameLowerCase;
  let prelude = null;
  let block = null;
  this.eat(AtKeyword);
  name50 = this.substrToCursor(start + 1);
  nameLowerCase = name50.toLowerCase();
  this.skipSC();
  if (this.eof === false && this.tokenType !== LeftCurlyBracket && this.tokenType !== Semicolon) {
    if (this.parseAtrulePrelude) {
      prelude = this.parseWithFallback(this.AtrulePrelude.bind(this, name50, isDeclaration), consumeRaw);
    } else {
      prelude = consumeRaw.call(this, this.tokenIndex);
    }
    this.skipSC();
  }
  switch (this.tokenType) {
    case Semicolon:
      this.next();
      break;
    case LeftCurlyBracket:
      if (hasOwnProperty.call(this.atrule, nameLowerCase) && typeof this.atrule[nameLowerCase].block === "function") {
        block = this.atrule[nameLowerCase].block.call(this, isDeclaration);
      } else {
        block = this.Block(isDeclarationBlockAtrule.call(this));
      }
      break;
  }
  return {
    type: "Atrule",
    loc: this.getLocation(start, this.tokenStart),
    name: name50,
    prelude,
    block
  };
}
function generate2(node) {
  this.token(AtKeyword, "@" + node.name);
  if (node.prelude !== null) {
    this.node(node.prelude);
  }
  if (node.block) {
    this.node(node.block);
  } else {
    this.token(Semicolon, ";");
  }
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/AtrulePrelude.js
var AtrulePrelude_exports = {};
__export(AtrulePrelude_exports, {
  generate: () => generate3,
  name: () => name3,
  parse: () => parse4,
  structure: () => structure3,
  walkContext: () => walkContext2
});
var name3 = "AtrulePrelude";
var walkContext2 = "atrulePrelude";
var structure3 = {
  children: [[]]
};
function parse4(name50) {
  let children = null;
  if (name50 !== null) {
    name50 = name50.toLowerCase();
  }
  this.skipSC();
  if (hasOwnProperty.call(this.atrule, name50) && typeof this.atrule[name50].prelude === "function") {
    children = this.atrule[name50].prelude.call(this);
  } else {
    children = this.readSequence(this.scope.AtrulePrelude);
  }
  this.skipSC();
  if (this.eof !== true && this.tokenType !== LeftCurlyBracket && this.tokenType !== Semicolon) {
    this.error("Semicolon or block is expected");
  }
  return {
    type: "AtrulePrelude",
    loc: this.getLocationFromList(children),
    children
  };
}
function generate3(node) {
  this.children(node);
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/AttributeSelector.js
var AttributeSelector_exports = {};
__export(AttributeSelector_exports, {
  generate: () => generate4,
  name: () => name4,
  parse: () => parse5,
  structure: () => structure4
});
var DOLLARSIGN = 36;
var ASTERISK3 = 42;
var EQUALSSIGN = 61;
var CIRCUMFLEXACCENT = 94;
var VERTICALLINE2 = 124;
var TILDE2 = 126;
function getAttributeName() {
  if (this.eof) {
    this.error("Unexpected end of input");
  }
  const start = this.tokenStart;
  let expectIdent = false;
  if (this.isDelim(ASTERISK3)) {
    expectIdent = true;
    this.next();
  } else if (!this.isDelim(VERTICALLINE2)) {
    this.eat(Ident);
  }
  if (this.isDelim(VERTICALLINE2)) {
    if (this.charCodeAt(this.tokenStart + 1) !== EQUALSSIGN) {
      this.next();
      this.eat(Ident);
    } else if (expectIdent) {
      this.error("Identifier is expected", this.tokenEnd);
    }
  } else if (expectIdent) {
    this.error("Vertical line is expected");
  }
  return {
    type: "Identifier",
    loc: this.getLocation(start, this.tokenStart),
    name: this.substrToCursor(start)
  };
}
function getOperator() {
  const start = this.tokenStart;
  const code3 = this.charCodeAt(start);
  if (code3 !== EQUALSSIGN && // =
  code3 !== TILDE2 && // ~=
  code3 !== CIRCUMFLEXACCENT && // ^=
  code3 !== DOLLARSIGN && // $=
  code3 !== ASTERISK3 && // *=
  code3 !== VERTICALLINE2) {
    this.error("Attribute selector (=, ~=, ^=, $=, *=, |=) is expected");
  }
  this.next();
  if (code3 !== EQUALSSIGN) {
    if (!this.isDelim(EQUALSSIGN)) {
      this.error("Equal sign is expected");
    }
    this.next();
  }
  return this.substrToCursor(start);
}
var name4 = "AttributeSelector";
var structure4 = {
  name: "Identifier",
  matcher: [String, null],
  value: ["String", "Identifier", null],
  flags: [String, null]
};
function parse5() {
  const start = this.tokenStart;
  let name50;
  let matcher = null;
  let value = null;
  let flags = null;
  this.eat(LeftSquareBracket);
  this.skipSC();
  name50 = getAttributeName.call(this);
  this.skipSC();
  if (this.tokenType !== RightSquareBracket) {
    if (this.tokenType !== Ident) {
      matcher = getOperator.call(this);
      this.skipSC();
      value = this.tokenType === String2 ? this.String() : this.Identifier();
      this.skipSC();
    }
    if (this.tokenType === Ident) {
      flags = this.consume(Ident);
      this.skipSC();
    }
  }
  this.eat(RightSquareBracket);
  return {
    type: "AttributeSelector",
    loc: this.getLocation(start, this.tokenStart),
    name: name50,
    matcher,
    value,
    flags
  };
}
function generate4(node) {
  this.token(Delim, "[");
  this.node(node.name);
  if (node.matcher !== null) {
    this.tokenize(node.matcher);
    this.node(node.value);
  }
  if (node.flags !== null) {
    this.token(Ident, node.flags);
  }
  this.token(Delim, "]");
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Block.js
var Block_exports = {};
__export(Block_exports, {
  generate: () => generate5,
  name: () => name5,
  parse: () => parse6,
  structure: () => structure5,
  walkContext: () => walkContext3
});
var AMPERSAND2 = 38;
function consumeRaw2() {
  return this.Raw(null, true);
}
function consumeRule() {
  return this.parseWithFallback(this.Rule, consumeRaw2);
}
function consumeRawDeclaration() {
  return this.Raw(this.consumeUntilSemicolonIncluded, true);
}
function consumeDeclaration() {
  if (this.tokenType === Semicolon) {
    return consumeRawDeclaration.call(this, this.tokenIndex);
  }
  const node = this.parseWithFallback(this.Declaration, consumeRawDeclaration);
  if (this.tokenType === Semicolon) {
    this.next();
  }
  return node;
}
var name5 = "Block";
var walkContext3 = "block";
var structure5 = {
  children: [[
    "Atrule",
    "Rule",
    "Declaration"
  ]]
};
function parse6(isStyleBlock) {
  const consumer = isStyleBlock ? consumeDeclaration : consumeRule;
  const start = this.tokenStart;
  let children = this.createList();
  this.eat(LeftCurlyBracket);
  scan:
    while (!this.eof) {
      switch (this.tokenType) {
        case RightCurlyBracket:
          break scan;
        case WhiteSpace:
        case Comment:
          this.next();
          break;
        case AtKeyword:
          children.push(this.parseWithFallback(this.Atrule.bind(this, isStyleBlock), consumeRaw2));
          break;
        default:
          if (isStyleBlock && this.isDelim(AMPERSAND2)) {
            children.push(consumeRule.call(this));
          } else {
            children.push(consumer.call(this));
          }
      }
    }
  if (!this.eof) {
    this.eat(RightCurlyBracket);
  }
  return {
    type: "Block",
    loc: this.getLocation(start, this.tokenStart),
    children
  };
}
function generate5(node) {
  this.token(LeftCurlyBracket, "{");
  this.children(node, (prev) => {
    if (prev.type === "Declaration") {
      this.token(Semicolon, ";");
    }
  });
  this.token(RightCurlyBracket, "}");
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Brackets.js
var Brackets_exports = {};
__export(Brackets_exports, {
  generate: () => generate6,
  name: () => name6,
  parse: () => parse7,
  structure: () => structure6
});
var name6 = "Brackets";
var structure6 = {
  children: [[]]
};
function parse7(readSequence2, recognizer) {
  const start = this.tokenStart;
  let children = null;
  this.eat(LeftSquareBracket);
  children = readSequence2.call(this, recognizer);
  if (!this.eof) {
    this.eat(RightSquareBracket);
  }
  return {
    type: "Brackets",
    loc: this.getLocation(start, this.tokenStart),
    children
  };
}
function generate6(node) {
  this.token(Delim, "[");
  this.children(node);
  this.token(Delim, "]");
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/CDC.js
var CDC_exports = {};
__export(CDC_exports, {
  generate: () => generate7,
  name: () => name7,
  parse: () => parse8,
  structure: () => structure7
});
var name7 = "CDC";
var structure7 = [];
function parse8() {
  const start = this.tokenStart;
  this.eat(CDC);
  return {
    type: "CDC",
    loc: this.getLocation(start, this.tokenStart)
  };
}
function generate7() {
  this.token(CDC, "-->");
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/CDO.js
var CDO_exports = {};
__export(CDO_exports, {
  generate: () => generate8,
  name: () => name8,
  parse: () => parse9,
  structure: () => structure8
});
var name8 = "CDO";
var structure8 = [];
function parse9() {
  const start = this.tokenStart;
  this.eat(CDO);
  return {
    type: "CDO",
    loc: this.getLocation(start, this.tokenStart)
  };
}
function generate8() {
  this.token(CDO, "<!--");
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/ClassSelector.js
var ClassSelector_exports = {};
__export(ClassSelector_exports, {
  generate: () => generate9,
  name: () => name9,
  parse: () => parse10,
  structure: () => structure9
});
var FULLSTOP2 = 46;
var name9 = "ClassSelector";
var structure9 = {
  name: String
};
function parse10() {
  this.eatDelim(FULLSTOP2);
  return {
    type: "ClassSelector",
    loc: this.getLocation(this.tokenStart - 1, this.tokenEnd),
    name: this.consume(Ident)
  };
}
function generate9(node) {
  this.token(Delim, ".");
  this.token(Ident, node.name);
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Combinator.js
var Combinator_exports = {};
__export(Combinator_exports, {
  generate: () => generate10,
  name: () => name10,
  parse: () => parse11,
  structure: () => structure10
});
var PLUSSIGN4 = 43;
var SOLIDUS3 = 47;
var GREATERTHANSIGN2 = 62;
var TILDE3 = 126;
var name10 = "Combinator";
var structure10 = {
  name: String
};
function parse11() {
  const start = this.tokenStart;
  let name50;
  switch (this.tokenType) {
    case WhiteSpace:
      name50 = " ";
      break;
    case Delim:
      switch (this.charCodeAt(this.tokenStart)) {
        case GREATERTHANSIGN2:
        case PLUSSIGN4:
        case TILDE3:
          this.next();
          break;
        case SOLIDUS3:
          this.next();
          this.eatIdent("deep");
          this.eatDelim(SOLIDUS3);
          break;
        default:
          this.error("Combinator is expected");
      }
      name50 = this.substrToCursor(start);
      break;
  }
  return {
    type: "Combinator",
    loc: this.getLocation(start, this.tokenStart),
    name: name50
  };
}
function generate10(node) {
  this.tokenize(node.name);
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Comment.js
var Comment_exports = {};
__export(Comment_exports, {
  generate: () => generate11,
  name: () => name11,
  parse: () => parse12,
  structure: () => structure11
});
var ASTERISK4 = 42;
var SOLIDUS4 = 47;
var name11 = "Comment";
var structure11 = {
  value: String
};
function parse12() {
  const start = this.tokenStart;
  let end = this.tokenEnd;
  this.eat(Comment);
  if (end - start + 2 >= 2 && this.charCodeAt(end - 2) === ASTERISK4 && this.charCodeAt(end - 1) === SOLIDUS4) {
    end -= 2;
  }
  return {
    type: "Comment",
    loc: this.getLocation(start, this.tokenStart),
    value: this.substring(start + 2, end)
  };
}
function generate11(node) {
  this.token(Comment, "/*" + node.value + "*/");
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Condition.js
var Condition_exports = {};
__export(Condition_exports, {
  generate: () => generate12,
  name: () => name12,
  parse: () => parse13,
  structure: () => structure12
});
var likelyFeatureToken = /* @__PURE__ */ new Set([Colon, RightParenthesis, EOF]);
var name12 = "Condition";
var structure12 = {
  kind: String,
  children: [[
    "Identifier",
    "Feature",
    "FeatureFunction",
    "FeatureRange",
    "SupportsDeclaration"
  ]]
};
function featureOrRange(kind) {
  if (this.lookupTypeNonSC(1) === Ident && likelyFeatureToken.has(this.lookupTypeNonSC(2))) {
    return this.Feature(kind);
  }
  return this.FeatureRange(kind);
}
var parentheses = {
  media: featureOrRange,
  container: featureOrRange,
  supports() {
    return this.SupportsDeclaration();
  }
};
function parse13(kind = "media") {
  const children = this.createList();
  scan: while (!this.eof) {
    switch (this.tokenType) {
      case Comment:
      case WhiteSpace:
        this.next();
        continue;
      case Ident:
        children.push(this.Identifier());
        break;
      case LeftParenthesis: {
        let term = this.parseWithFallback(
          () => parentheses[kind].call(this, kind),
          () => null
        );
        if (!term) {
          term = this.parseWithFallback(
            () => {
              this.eat(LeftParenthesis);
              const res = this.Condition(kind);
              this.eat(RightParenthesis);
              return res;
            },
            () => {
              return this.GeneralEnclosed(kind);
            }
          );
        }
        children.push(term);
        break;
      }
      case Function: {
        let term = this.parseWithFallback(
          () => this.FeatureFunction(kind),
          () => null
        );
        if (!term) {
          term = this.GeneralEnclosed(kind);
        }
        children.push(term);
        break;
      }
      default:
        break scan;
    }
  }
  if (children.isEmpty) {
    this.error("Condition is expected");
  }
  return {
    type: "Condition",
    loc: this.getLocationFromList(children),
    kind,
    children
  };
}
function generate12(node) {
  node.children.forEach((child2) => {
    if (child2.type === "Condition") {
      this.token(LeftParenthesis, "(");
      this.node(child2);
      this.token(RightParenthesis, ")");
    } else {
      this.node(child2);
    }
  });
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Declaration.js
var Declaration_exports = {};
__export(Declaration_exports, {
  generate: () => generate13,
  name: () => name13,
  parse: () => parse14,
  structure: () => structure13,
  walkContext: () => walkContext4
});

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/utils/names.js
var HYPHENMINUS3 = 45;
function isCustomProperty(str, offset) {
  offset = offset || 0;
  return str.length - offset >= 2 && str.charCodeAt(offset) === HYPHENMINUS3 && str.charCodeAt(offset + 1) === HYPHENMINUS3;
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Declaration.js
var EXCLAMATIONMARK2 = 33;
var NUMBERSIGN4 = 35;
var DOLLARSIGN2 = 36;
var AMPERSAND3 = 38;
var ASTERISK5 = 42;
var PLUSSIGN5 = 43;
var SOLIDUS5 = 47;
function consumeValueRaw() {
  return this.Raw(this.consumeUntilExclamationMarkOrSemicolon, true);
}
function consumeCustomPropertyRaw() {
  return this.Raw(this.consumeUntilExclamationMarkOrSemicolon, false);
}
function consumeValue() {
  const startValueToken = this.tokenIndex;
  const value = this.Value();
  if (value.type !== "Raw" && this.eof === false && this.tokenType !== Semicolon && this.isDelim(EXCLAMATIONMARK2) === false && this.isBalanceEdge(startValueToken) === false) {
    this.error();
  }
  return value;
}
var name13 = "Declaration";
var walkContext4 = "declaration";
var structure13 = {
  important: [Boolean, String],
  property: String,
  value: ["Value", "Raw"]
};
function parse14() {
  const start = this.tokenStart;
  const startToken = this.tokenIndex;
  const property = readProperty.call(this);
  const customProperty = isCustomProperty(property);
  const parseValue = customProperty ? this.parseCustomProperty : this.parseValue;
  const consumeRaw6 = customProperty ? consumeCustomPropertyRaw : consumeValueRaw;
  let important = false;
  let value;
  this.skipSC();
  this.eat(Colon);
  const valueStart = this.tokenIndex;
  if (!customProperty) {
    this.skipSC();
  }
  if (parseValue) {
    value = this.parseWithFallback(consumeValue, consumeRaw6);
  } else {
    value = consumeRaw6.call(this, this.tokenIndex);
  }
  if (customProperty && value.type === "Value" && value.children.isEmpty) {
    for (let offset = valueStart - this.tokenIndex; offset <= 0; offset++) {
      if (this.lookupType(offset) === WhiteSpace) {
        value.children.appendData({
          type: "WhiteSpace",
          loc: null,
          value: " "
        });
        break;
      }
    }
  }
  if (this.isDelim(EXCLAMATIONMARK2)) {
    important = getImportant.call(this);
    this.skipSC();
  }
  if (this.eof === false && this.tokenType !== Semicolon && this.isBalanceEdge(startToken) === false) {
    this.error();
  }
  return {
    type: "Declaration",
    loc: this.getLocation(start, this.tokenStart),
    important,
    property,
    value
  };
}
function generate13(node) {
  this.token(Ident, node.property);
  this.token(Colon, ":");
  this.node(node.value);
  if (node.important) {
    this.token(Delim, "!");
    this.token(Ident, node.important === true ? "important" : node.important);
  }
}
function readProperty() {
  const start = this.tokenStart;
  if (this.tokenType === Delim) {
    switch (this.charCodeAt(this.tokenStart)) {
      case ASTERISK5:
      case DOLLARSIGN2:
      case PLUSSIGN5:
      case NUMBERSIGN4:
      case AMPERSAND3:
        this.next();
        break;
      // TODO: not sure we should support this hack
      case SOLIDUS5:
        this.next();
        if (this.isDelim(SOLIDUS5)) {
          this.next();
        }
        break;
    }
  }
  if (this.tokenType === Hash) {
    this.eat(Hash);
  } else {
    this.eat(Ident);
  }
  return this.substrToCursor(start);
}
function getImportant() {
  this.eat(Delim);
  this.skipSC();
  const important = this.consume(Ident);
  return important === "important" ? true : important;
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/DeclarationList.js
var DeclarationList_exports = {};
__export(DeclarationList_exports, {
  generate: () => generate14,
  name: () => name14,
  parse: () => parse15,
  structure: () => structure14
});
var AMPERSAND4 = 38;
function consumeRaw3() {
  return this.Raw(this.consumeUntilSemicolonIncluded, true);
}
var name14 = "DeclarationList";
var structure14 = {
  children: [[
    "Declaration",
    "Atrule",
    "Rule"
  ]]
};
function parse15() {
  const children = this.createList();
  scan:
    while (!this.eof) {
      switch (this.tokenType) {
        case WhiteSpace:
        case Comment:
        case Semicolon:
          this.next();
          break;
        case AtKeyword:
          children.push(this.parseWithFallback(this.Atrule.bind(this, true), consumeRaw3));
          break;
        default:
          if (this.isDelim(AMPERSAND4)) {
            children.push(this.parseWithFallback(this.Rule, consumeRaw3));
          } else {
            children.push(this.parseWithFallback(this.Declaration, consumeRaw3));
          }
      }
    }
  return {
    type: "DeclarationList",
    loc: this.getLocationFromList(children),
    children
  };
}
function generate14(node) {
  this.children(node, (prev) => {
    if (prev.type === "Declaration") {
      this.token(Semicolon, ";");
    }
  });
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Dimension.js
var Dimension_exports = {};
__export(Dimension_exports, {
  generate: () => generate15,
  name: () => name15,
  parse: () => parse16,
  structure: () => structure15
});
var name15 = "Dimension";
var structure15 = {
  value: String,
  unit: String
};
function parse16() {
  const start = this.tokenStart;
  const value = this.consumeNumber(Dimension);
  return {
    type: "Dimension",
    loc: this.getLocation(start, this.tokenStart),
    value,
    unit: this.substring(start + value.length, this.tokenStart)
  };
}
function generate15(node) {
  this.token(Dimension, node.value + node.unit);
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Feature.js
var Feature_exports = {};
__export(Feature_exports, {
  generate: () => generate16,
  name: () => name16,
  parse: () => parse17,
  structure: () => structure16
});
var SOLIDUS6 = 47;
var name16 = "Feature";
var structure16 = {
  kind: String,
  name: String,
  value: ["Identifier", "Number", "Dimension", "Ratio", "Function", null]
};
function parse17(kind) {
  const start = this.tokenStart;
  let name50;
  let value = null;
  this.eat(LeftParenthesis);
  this.skipSC();
  name50 = this.consume(Ident);
  this.skipSC();
  if (this.tokenType !== RightParenthesis) {
    this.eat(Colon);
    this.skipSC();
    switch (this.tokenType) {
      case Number2:
        if (this.lookupNonWSType(1) === Delim) {
          value = this.Ratio();
        } else {
          value = this.Number();
        }
        break;
      case Dimension:
        value = this.Dimension();
        break;
      case Ident:
        value = this.Identifier();
        break;
      case Function:
        value = this.parseWithFallback(
          () => {
            const res = this.Function(this.readSequence, this.scope.Value);
            this.skipSC();
            if (this.isDelim(SOLIDUS6)) {
              this.error();
            }
            return res;
          },
          () => {
            return this.Ratio();
          }
        );
        break;
      default:
        this.error("Number, dimension, ratio or identifier is expected");
    }
    this.skipSC();
  }
  if (!this.eof) {
    this.eat(RightParenthesis);
  }
  return {
    type: "Feature",
    loc: this.getLocation(start, this.tokenStart),
    kind,
    name: name50,
    value
  };
}
function generate16(node) {
  this.token(LeftParenthesis, "(");
  this.token(Ident, node.name);
  if (node.value !== null) {
    this.token(Colon, ":");
    this.node(node.value);
  }
  this.token(RightParenthesis, ")");
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/FeatureFunction.js
var FeatureFunction_exports = {};
__export(FeatureFunction_exports, {
  generate: () => generate17,
  name: () => name17,
  parse: () => parse18,
  structure: () => structure17
});
var name17 = "FeatureFunction";
var structure17 = {
  kind: String,
  feature: String,
  value: ["Declaration", "Selector"]
};
function getFeatureParser(kind, name50) {
  const featuresOfKind = this.features[kind] || {};
  const parser = featuresOfKind[name50];
  if (typeof parser !== "function") {
    this.error(`Unknown feature ${name50}()`);
  }
  return parser;
}
function parse18(kind = "unknown") {
  const start = this.tokenStart;
  const functionName = this.consumeFunctionName();
  const valueParser = getFeatureParser.call(this, kind, functionName.toLowerCase());
  this.skipSC();
  const value = this.parseWithFallback(
    () => {
      const startValueToken = this.tokenIndex;
      const value2 = valueParser.call(this);
      if (this.eof === false && this.isBalanceEdge(startValueToken) === false) {
        this.error();
      }
      return value2;
    },
    () => this.Raw(null, false)
  );
  if (!this.eof) {
    this.eat(RightParenthesis);
  }
  return {
    type: "FeatureFunction",
    loc: this.getLocation(start, this.tokenStart),
    kind,
    feature: functionName,
    value
  };
}
function generate17(node) {
  this.token(Function, node.feature + "(");
  this.node(node.value);
  this.token(RightParenthesis, ")");
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/FeatureRange.js
var FeatureRange_exports = {};
__export(FeatureRange_exports, {
  generate: () => generate18,
  name: () => name18,
  parse: () => parse19,
  structure: () => structure18
});
var SOLIDUS7 = 47;
var LESSTHANSIGN = 60;
var EQUALSSIGN2 = 61;
var GREATERTHANSIGN3 = 62;
var name18 = "FeatureRange";
var structure18 = {
  kind: String,
  left: ["Identifier", "Number", "Dimension", "Ratio", "Function"],
  leftComparison: String,
  middle: ["Identifier", "Number", "Dimension", "Ratio", "Function"],
  rightComparison: [String, null],
  right: ["Identifier", "Number", "Dimension", "Ratio", "Function", null]
};
function readTerm() {
  this.skipSC();
  switch (this.tokenType) {
    case Number2:
      if (this.isDelim(SOLIDUS7, this.lookupOffsetNonSC(1))) {
        return this.Ratio();
      } else {
        return this.Number();
      }
    case Dimension:
      return this.Dimension();
    case Ident:
      return this.Identifier();
    case Function:
      return this.parseWithFallback(
        () => {
          const res = this.Function(this.readSequence, this.scope.Value);
          this.skipSC();
          if (this.isDelim(SOLIDUS7)) {
            this.error();
          }
          return res;
        },
        () => {
          return this.Ratio();
        }
      );
    default:
      this.error("Number, dimension, ratio or identifier is expected");
  }
}
function readComparison(expectColon) {
  this.skipSC();
  if (this.isDelim(LESSTHANSIGN) || this.isDelim(GREATERTHANSIGN3)) {
    const value = this.source[this.tokenStart];
    this.next();
    if (this.isDelim(EQUALSSIGN2)) {
      this.next();
      return value + "=";
    }
    return value;
  }
  if (this.isDelim(EQUALSSIGN2)) {
    return "=";
  }
  this.error(`Expected ${expectColon ? '":", ' : ""}"<", ">", "=" or ")"`);
}
function parse19(kind = "unknown") {
  const start = this.tokenStart;
  this.skipSC();
  this.eat(LeftParenthesis);
  const left = readTerm.call(this);
  const leftComparison = readComparison.call(this, left.type === "Identifier");
  const middle = readTerm.call(this);
  let rightComparison = null;
  let right = null;
  if (this.lookupNonWSType(0) !== RightParenthesis) {
    rightComparison = readComparison.call(this);
    right = readTerm.call(this);
  }
  this.skipSC();
  this.eat(RightParenthesis);
  return {
    type: "FeatureRange",
    loc: this.getLocation(start, this.tokenStart),
    kind,
    left,
    leftComparison,
    middle,
    rightComparison,
    right
  };
}
function generate18(node) {
  this.token(LeftParenthesis, "(");
  this.node(node.left);
  this.tokenize(node.leftComparison);
  this.node(node.middle);
  if (node.right) {
    this.tokenize(node.rightComparison);
    this.node(node.right);
  }
  this.token(RightParenthesis, ")");
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Function.js
var Function_exports = {};
__export(Function_exports, {
  generate: () => generate19,
  name: () => name19,
  parse: () => parse20,
  structure: () => structure19,
  walkContext: () => walkContext5
});
var name19 = "Function";
var walkContext5 = "function";
var structure19 = {
  name: String,
  children: [[]]
};
function parse20(readSequence2, recognizer) {
  const start = this.tokenStart;
  const name50 = this.consumeFunctionName();
  const nameLowerCase = name50.toLowerCase();
  let children;
  children = recognizer.hasOwnProperty(nameLowerCase) ? recognizer[nameLowerCase].call(this, recognizer) : readSequence2.call(this, recognizer);
  if (!this.eof) {
    this.eat(RightParenthesis);
  }
  return {
    type: "Function",
    loc: this.getLocation(start, this.tokenStart),
    name: name50,
    children
  };
}
function generate19(node) {
  this.token(Function, node.name + "(");
  this.children(node);
  this.token(RightParenthesis, ")");
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/GeneralEnclosed.js
var GeneralEnclosed_exports = {};
__export(GeneralEnclosed_exports, {
  generate: () => generate20,
  name: () => name20,
  parse: () => parse21,
  structure: () => structure20
});
var name20 = "GeneralEnclosed";
var structure20 = {
  kind: String,
  function: [String, null],
  children: [[]]
};
function parse21(kind) {
  const start = this.tokenStart;
  let functionName = null;
  if (this.tokenType === Function) {
    functionName = this.consumeFunctionName();
  } else {
    this.eat(LeftParenthesis);
  }
  const children = this.parseWithFallback(
    () => {
      const startValueToken = this.tokenIndex;
      const children2 = this.readSequence(this.scope.Value);
      if (this.eof === false && this.isBalanceEdge(startValueToken) === false) {
        this.error();
      }
      return children2;
    },
    () => this.createSingleNodeList(
      this.Raw(null, false)
    )
  );
  if (!this.eof) {
    this.eat(RightParenthesis);
  }
  return {
    type: "GeneralEnclosed",
    loc: this.getLocation(start, this.tokenStart),
    kind,
    function: functionName,
    children
  };
}
function generate20(node) {
  if (node.function) {
    this.token(Function, node.function + "(");
  } else {
    this.token(LeftParenthesis, "(");
  }
  this.children(node);
  this.token(RightParenthesis, ")");
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Hash.js
var Hash_exports = {};
__export(Hash_exports, {
  generate: () => generate21,
  name: () => name21,
  parse: () => parse22,
  structure: () => structure21,
  xxx: () => xxx
});
var xxx = "XXX";
var name21 = "Hash";
var structure21 = {
  value: String
};
function parse22() {
  const start = this.tokenStart;
  this.eat(Hash);
  return {
    type: "Hash",
    loc: this.getLocation(start, this.tokenStart),
    value: this.substrToCursor(start + 1)
  };
}
function generate21(node) {
  this.token(Hash, "#" + node.value);
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Identifier.js
var Identifier_exports = {};
__export(Identifier_exports, {
  generate: () => generate22,
  name: () => name22,
  parse: () => parse23,
  structure: () => structure22
});
var name22 = "Identifier";
var structure22 = {
  name: String
};
function parse23() {
  return {
    type: "Identifier",
    loc: this.getLocation(this.tokenStart, this.tokenEnd),
    name: this.consume(Ident)
  };
}
function generate22(node) {
  this.token(Ident, node.name);
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/IdSelector.js
var IdSelector_exports = {};
__export(IdSelector_exports, {
  generate: () => generate23,
  name: () => name23,
  parse: () => parse24,
  structure: () => structure23
});
var name23 = "IdSelector";
var structure23 = {
  name: String
};
function parse24() {
  const start = this.tokenStart;
  this.eat(Hash);
  return {
    type: "IdSelector",
    loc: this.getLocation(start, this.tokenStart),
    name: this.substrToCursor(start + 1)
  };
}
function generate23(node) {
  this.token(Delim, "#" + node.name);
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Layer.js
var Layer_exports = {};
__export(Layer_exports, {
  generate: () => generate24,
  name: () => name24,
  parse: () => parse25,
  structure: () => structure24
});
var FULLSTOP3 = 46;
var name24 = "Layer";
var structure24 = {
  name: String
};
function parse25() {
  let tokenStart = this.tokenStart;
  let name50 = this.consume(Ident);
  while (this.isDelim(FULLSTOP3)) {
    this.eat(Delim);
    name50 += "." + this.consume(Ident);
  }
  return {
    type: "Layer",
    loc: this.getLocation(tokenStart, this.tokenStart),
    name: name50
  };
}
function generate24(node) {
  this.tokenize(node.name);
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/LayerList.js
var LayerList_exports = {};
__export(LayerList_exports, {
  generate: () => generate25,
  name: () => name25,
  parse: () => parse26,
  structure: () => structure25
});
var name25 = "LayerList";
var structure25 = {
  children: [[
    "Layer"
  ]]
};
function parse26() {
  const children = this.createList();
  this.skipSC();
  while (!this.eof) {
    children.push(this.Layer());
    if (this.lookupTypeNonSC(0) !== Comma) {
      break;
    }
    this.skipSC();
    this.next();
    this.skipSC();
  }
  return {
    type: "LayerList",
    loc: this.getLocationFromList(children),
    children
  };
}
function generate25(node) {
  this.children(node, () => this.token(Comma, ","));
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/MediaQuery.js
var MediaQuery_exports = {};
__export(MediaQuery_exports, {
  generate: () => generate26,
  name: () => name26,
  parse: () => parse27,
  structure: () => structure26
});
var name26 = "MediaQuery";
var structure26 = {
  modifier: [String, null],
  mediaType: [String, null],
  condition: ["Condition", null]
};
function parse27() {
  const start = this.tokenStart;
  let modifier = null;
  let mediaType = null;
  let condition = null;
  this.skipSC();
  if (this.tokenType === Ident && this.lookupTypeNonSC(1) !== LeftParenthesis) {
    const ident = this.consume(Ident);
    const identLowerCase = ident.toLowerCase();
    if (identLowerCase === "not" || identLowerCase === "only") {
      this.skipSC();
      modifier = identLowerCase;
      mediaType = this.consume(Ident);
    } else {
      mediaType = ident;
    }
    switch (this.lookupTypeNonSC(0)) {
      case Ident: {
        this.skipSC();
        this.eatIdent("and");
        condition = this.Condition("media");
        break;
      }
      case LeftCurlyBracket:
      case Semicolon:
      case Comma:
      case EOF:
        break;
      default:
        this.error("Identifier or parenthesis is expected");
    }
  } else {
    switch (this.tokenType) {
      case Ident:
      case LeftParenthesis:
      case Function: {
        condition = this.Condition("media");
        break;
      }
      case LeftCurlyBracket:
      case Semicolon:
      case EOF:
        break;
      default:
        this.error("Identifier or parenthesis is expected");
    }
  }
  return {
    type: "MediaQuery",
    loc: this.getLocation(start, this.tokenStart),
    modifier,
    mediaType,
    condition
  };
}
function generate26(node) {
  if (node.mediaType) {
    if (node.modifier) {
      this.token(Ident, node.modifier);
    }
    this.token(Ident, node.mediaType);
    if (node.condition) {
      this.token(Ident, "and");
      this.node(node.condition);
    }
  } else if (node.condition) {
    this.node(node.condition);
  }
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/MediaQueryList.js
var MediaQueryList_exports = {};
__export(MediaQueryList_exports, {
  generate: () => generate27,
  name: () => name27,
  parse: () => parse28,
  structure: () => structure27
});
var name27 = "MediaQueryList";
var structure27 = {
  children: [[
    "MediaQuery"
  ]]
};
function parse28() {
  const children = this.createList();
  this.skipSC();
  while (!this.eof) {
    children.push(this.MediaQuery());
    if (this.tokenType !== Comma) {
      break;
    }
    this.next();
  }
  return {
    type: "MediaQueryList",
    loc: this.getLocationFromList(children),
    children
  };
}
function generate27(node) {
  this.children(node, () => this.token(Comma, ","));
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/NestingSelector.js
var NestingSelector_exports = {};
__export(NestingSelector_exports, {
  generate: () => generate28,
  name: () => name28,
  parse: () => parse29,
  structure: () => structure28
});
var AMPERSAND5 = 38;
var name28 = "NestingSelector";
var structure28 = {};
function parse29() {
  const start = this.tokenStart;
  this.eatDelim(AMPERSAND5);
  return {
    type: "NestingSelector",
    loc: this.getLocation(start, this.tokenStart)
  };
}
function generate28() {
  this.token(Delim, "&");
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Nth.js
var Nth_exports = {};
__export(Nth_exports, {
  generate: () => generate29,
  name: () => name29,
  parse: () => parse30,
  structure: () => structure29
});
var name29 = "Nth";
var structure29 = {
  nth: ["AnPlusB", "Identifier"],
  selector: ["SelectorList", null]
};
function parse30() {
  this.skipSC();
  const start = this.tokenStart;
  let end = start;
  let selector2 = null;
  let nth2;
  if (this.lookupValue(0, "odd") || this.lookupValue(0, "even")) {
    nth2 = this.Identifier();
  } else {
    nth2 = this.AnPlusB();
  }
  end = this.tokenStart;
  this.skipSC();
  if (this.lookupValue(0, "of")) {
    this.next();
    selector2 = this.SelectorList();
    end = this.tokenStart;
  }
  return {
    type: "Nth",
    loc: this.getLocation(start, end),
    nth: nth2,
    selector: selector2
  };
}
function generate29(node) {
  this.node(node.nth);
  if (node.selector !== null) {
    this.token(Ident, "of");
    this.node(node.selector);
  }
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Number.js
var Number_exports = {};
__export(Number_exports, {
  generate: () => generate30,
  name: () => name30,
  parse: () => parse31,
  structure: () => structure30
});
var name30 = "Number";
var structure30 = {
  value: String
};
function parse31() {
  return {
    type: "Number",
    loc: this.getLocation(this.tokenStart, this.tokenEnd),
    value: this.consume(Number2)
  };
}
function generate30(node) {
  this.token(Number2, node.value);
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Operator.js
var Operator_exports = {};
__export(Operator_exports, {
  generate: () => generate31,
  name: () => name31,
  parse: () => parse32,
  structure: () => structure31
});
var name31 = "Operator";
var structure31 = {
  value: String
};
function parse32() {
  const start = this.tokenStart;
  this.next();
  return {
    type: "Operator",
    loc: this.getLocation(start, this.tokenStart),
    value: this.substrToCursor(start)
  };
}
function generate31(node) {
  this.tokenize(node.value);
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Parentheses.js
var Parentheses_exports = {};
__export(Parentheses_exports, {
  generate: () => generate32,
  name: () => name32,
  parse: () => parse33,
  structure: () => structure32
});
var name32 = "Parentheses";
var structure32 = {
  children: [[]]
};
function parse33(readSequence2, recognizer) {
  const start = this.tokenStart;
  let children = null;
  this.eat(LeftParenthesis);
  children = readSequence2.call(this, recognizer);
  if (!this.eof) {
    this.eat(RightParenthesis);
  }
  return {
    type: "Parentheses",
    loc: this.getLocation(start, this.tokenStart),
    children
  };
}
function generate32(node) {
  this.token(LeftParenthesis, "(");
  this.children(node);
  this.token(RightParenthesis, ")");
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Percentage.js
var Percentage_exports = {};
__export(Percentage_exports, {
  generate: () => generate33,
  name: () => name33,
  parse: () => parse34,
  structure: () => structure33
});
var name33 = "Percentage";
var structure33 = {
  value: String
};
function parse34() {
  return {
    type: "Percentage",
    loc: this.getLocation(this.tokenStart, this.tokenEnd),
    value: this.consumeNumber(Percentage)
  };
}
function generate33(node) {
  this.token(Percentage, node.value + "%");
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/PseudoClassSelector.js
var PseudoClassSelector_exports = {};
__export(PseudoClassSelector_exports, {
  generate: () => generate34,
  name: () => name34,
  parse: () => parse35,
  structure: () => structure34,
  walkContext: () => walkContext6
});
var name34 = "PseudoClassSelector";
var walkContext6 = "function";
var structure34 = {
  name: String,
  children: [["Raw"], null]
};
function parse35() {
  const start = this.tokenStart;
  let children = null;
  let name50;
  let nameLowerCase;
  this.eat(Colon);
  if (this.tokenType === Function) {
    name50 = this.consumeFunctionName();
    nameLowerCase = name50.toLowerCase();
    if (this.lookupNonWSType(0) == RightParenthesis) {
      children = this.createList();
    } else if (hasOwnProperty.call(this.pseudo, nameLowerCase)) {
      this.skipSC();
      children = this.pseudo[nameLowerCase].call(this);
      this.skipSC();
    } else {
      children = this.createList();
      children.push(
        this.Raw(null, false)
      );
    }
    this.eat(RightParenthesis);
  } else {
    name50 = this.consume(Ident);
  }
  return {
    type: "PseudoClassSelector",
    loc: this.getLocation(start, this.tokenStart),
    name: name50,
    children
  };
}
function generate34(node) {
  this.token(Colon, ":");
  if (node.children === null) {
    this.token(Ident, node.name);
  } else {
    this.token(Function, node.name + "(");
    this.children(node);
    this.token(RightParenthesis, ")");
  }
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/PseudoElementSelector.js
var PseudoElementSelector_exports = {};
__export(PseudoElementSelector_exports, {
  generate: () => generate35,
  name: () => name35,
  parse: () => parse36,
  structure: () => structure35,
  walkContext: () => walkContext7
});
var name35 = "PseudoElementSelector";
var walkContext7 = "function";
var structure35 = {
  name: String,
  children: [["Raw"], null]
};
function parse36() {
  const start = this.tokenStart;
  let children = null;
  let name50;
  let nameLowerCase;
  this.eat(Colon);
  this.eat(Colon);
  if (this.tokenType === Function) {
    name50 = this.consumeFunctionName();
    nameLowerCase = name50.toLowerCase();
    if (this.lookupNonWSType(0) == RightParenthesis) {
      children = this.createList();
    } else if (hasOwnProperty.call(this.pseudo, nameLowerCase)) {
      this.skipSC();
      children = this.pseudo[nameLowerCase].call(this);
      this.skipSC();
    } else {
      children = this.createList();
      children.push(
        this.Raw(null, false)
      );
    }
    this.eat(RightParenthesis);
  } else {
    name50 = this.consume(Ident);
  }
  return {
    type: "PseudoElementSelector",
    loc: this.getLocation(start, this.tokenStart),
    name: name50,
    children
  };
}
function generate35(node) {
  this.token(Colon, ":");
  this.token(Colon, ":");
  if (node.children === null) {
    this.token(Ident, node.name);
  } else {
    this.token(Function, node.name + "(");
    this.children(node);
    this.token(RightParenthesis, ")");
  }
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Ratio.js
var Ratio_exports = {};
__export(Ratio_exports, {
  generate: () => generate36,
  name: () => name36,
  parse: () => parse37,
  structure: () => structure36
});
var SOLIDUS8 = 47;
function consumeTerm() {
  this.skipSC();
  switch (this.tokenType) {
    case Number2:
      return this.Number();
    case Function:
      return this.Function(this.readSequence, this.scope.Value);
    default:
      this.error("Number of function is expected");
  }
}
var name36 = "Ratio";
var structure36 = {
  left: ["Number", "Function"],
  right: ["Number", "Function", null]
};
function parse37() {
  const start = this.tokenStart;
  const left = consumeTerm.call(this);
  let right = null;
  this.skipSC();
  if (this.isDelim(SOLIDUS8)) {
    this.eatDelim(SOLIDUS8);
    right = consumeTerm.call(this);
  }
  return {
    type: "Ratio",
    loc: this.getLocation(start, this.tokenStart),
    left,
    right
  };
}
function generate36(node) {
  this.node(node.left);
  this.token(Delim, "/");
  if (node.right) {
    this.node(node.right);
  } else {
    this.node(Number2, 1);
  }
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Raw.js
var Raw_exports = {};
__export(Raw_exports, {
  generate: () => generate37,
  name: () => name37,
  parse: () => parse38,
  structure: () => structure37
});
function getOffsetExcludeWS() {
  if (this.tokenIndex > 0) {
    if (this.lookupType(-1) === WhiteSpace) {
      return this.tokenIndex > 1 ? this.getTokenStart(this.tokenIndex - 1) : this.firstCharOffset;
    }
  }
  return this.tokenStart;
}
var name37 = "Raw";
var structure37 = {
  value: String
};
function parse38(consumeUntil, excludeWhiteSpace) {
  const startOffset = this.getTokenStart(this.tokenIndex);
  let endOffset;
  this.skipUntilBalanced(this.tokenIndex, consumeUntil || this.consumeUntilBalanceEnd);
  if (excludeWhiteSpace && this.tokenStart > startOffset) {
    endOffset = getOffsetExcludeWS.call(this);
  } else {
    endOffset = this.tokenStart;
  }
  return {
    type: "Raw",
    loc: this.getLocation(startOffset, endOffset),
    value: this.substring(startOffset, endOffset)
  };
}
function generate37(node) {
  this.tokenize(node.value);
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Rule.js
var Rule_exports = {};
__export(Rule_exports, {
  generate: () => generate38,
  name: () => name38,
  parse: () => parse39,
  structure: () => structure38,
  walkContext: () => walkContext8
});
function consumeRaw4() {
  return this.Raw(this.consumeUntilLeftCurlyBracket, true);
}
function consumePrelude() {
  const prelude = this.SelectorList();
  if (prelude.type !== "Raw" && this.eof === false && this.tokenType !== LeftCurlyBracket) {
    this.error();
  }
  return prelude;
}
var name38 = "Rule";
var walkContext8 = "rule";
var structure38 = {
  prelude: ["SelectorList", "Raw"],
  block: ["Block"]
};
function parse39() {
  const startToken = this.tokenIndex;
  const startOffset = this.tokenStart;
  let prelude;
  let block;
  if (this.parseRulePrelude) {
    prelude = this.parseWithFallback(consumePrelude, consumeRaw4);
  } else {
    prelude = consumeRaw4.call(this, startToken);
  }
  block = this.Block(true);
  return {
    type: "Rule",
    loc: this.getLocation(startOffset, this.tokenStart),
    prelude,
    block
  };
}
function generate38(node) {
  this.node(node.prelude);
  this.node(node.block);
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Scope.js
var Scope_exports = {};
__export(Scope_exports, {
  generate: () => generate39,
  name: () => name39,
  parse: () => parse40,
  structure: () => structure39
});
var name39 = "Scope";
var structure39 = {
  root: ["SelectorList", "Raw", null],
  limit: ["SelectorList", "Raw", null]
};
function parse40() {
  let root = null;
  let limit = null;
  this.skipSC();
  const startOffset = this.tokenStart;
  if (this.tokenType === LeftParenthesis) {
    this.next();
    this.skipSC();
    root = this.parseWithFallback(
      this.SelectorList,
      () => this.Raw(false, true)
    );
    this.skipSC();
    this.eat(RightParenthesis);
  }
  if (this.lookupNonWSType(0) === Ident) {
    this.skipSC();
    this.eatIdent("to");
    this.skipSC();
    this.eat(LeftParenthesis);
    this.skipSC();
    limit = this.parseWithFallback(
      this.SelectorList,
      () => this.Raw(false, true)
    );
    this.skipSC();
    this.eat(RightParenthesis);
  }
  return {
    type: "Scope",
    loc: this.getLocation(startOffset, this.tokenStart),
    root,
    limit
  };
}
function generate39(node) {
  if (node.root) {
    this.token(LeftParenthesis, "(");
    this.node(node.root);
    this.token(RightParenthesis, ")");
  }
  if (node.limit) {
    this.token(Ident, "to");
    this.token(LeftParenthesis, "(");
    this.node(node.limit);
    this.token(RightParenthesis, ")");
  }
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Selector.js
var Selector_exports = {};
__export(Selector_exports, {
  generate: () => generate40,
  name: () => name40,
  parse: () => parse41,
  structure: () => structure40
});
var name40 = "Selector";
var structure40 = {
  children: [[
    "TypeSelector",
    "IdSelector",
    "ClassSelector",
    "AttributeSelector",
    "PseudoClassSelector",
    "PseudoElementSelector",
    "Combinator"
  ]]
};
function parse41() {
  const children = this.readSequence(this.scope.Selector);
  if (this.getFirstListNode(children) === null) {
    this.error("Selector is expected");
  }
  return {
    type: "Selector",
    loc: this.getLocationFromList(children),
    children
  };
}
function generate40(node) {
  this.children(node);
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/SelectorList.js
var SelectorList_exports = {};
__export(SelectorList_exports, {
  generate: () => generate41,
  name: () => name41,
  parse: () => parse42,
  structure: () => structure41,
  walkContext: () => walkContext9
});
var name41 = "SelectorList";
var walkContext9 = "selector";
var structure41 = {
  children: [[
    "Selector",
    "Raw"
  ]]
};
function parse42() {
  const children = this.createList();
  while (!this.eof) {
    children.push(this.Selector());
    if (this.tokenType === Comma) {
      this.next();
      continue;
    }
    break;
  }
  return {
    type: "SelectorList",
    loc: this.getLocationFromList(children),
    children
  };
}
function generate41(node) {
  this.children(node, () => this.token(Comma, ","));
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/String.js
var String_exports = {};
__export(String_exports, {
  generate: () => generate42,
  name: () => name42,
  parse: () => parse43,
  structure: () => structure42
});

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/utils/string.js
var string_exports = {};
__export(string_exports, {
  decode: () => decode,
  encode: () => encode
});
var REVERSE_SOLIDUS = 92;
var QUOTATION_MARK = 34;
var APOSTROPHE = 39;
function decode(str) {
  const len = str.length;
  const firstChar = str.charCodeAt(0);
  const start = firstChar === QUOTATION_MARK || firstChar === APOSTROPHE ? 1 : 0;
  const end = start === 1 && len > 1 && str.charCodeAt(len - 1) === firstChar ? len - 2 : len - 1;
  let decoded = "";
  for (let i2 = start; i2 <= end; i2++) {
    let code3 = str.charCodeAt(i2);
    if (code3 === REVERSE_SOLIDUS) {
      if (i2 === end) {
        if (i2 !== len - 1) {
          decoded = str.substr(i2 + 1);
        }
        break;
      }
      code3 = str.charCodeAt(++i2);
      if (isValidEscape(REVERSE_SOLIDUS, code3)) {
        const escapeStart = i2 - 1;
        const escapeEnd = consumeEscaped(str, escapeStart);
        i2 = escapeEnd - 1;
        decoded += decodeEscaped(str.substring(escapeStart + 1, escapeEnd));
      } else {
        if (code3 === 13 && str.charCodeAt(i2 + 1) === 10) {
          i2++;
        }
      }
    } else {
      decoded += str[i2];
    }
  }
  return decoded;
}
function encode(str, apostrophe) {
  const quote = apostrophe ? "'" : '"';
  const quoteCode = apostrophe ? APOSTROPHE : QUOTATION_MARK;
  let encoded = "";
  let wsBeforeHexIsNeeded = false;
  for (let i2 = 0; i2 < str.length; i2++) {
    const code3 = str.charCodeAt(i2);
    if (code3 === 0) {
      encoded += "\uFFFD";
      continue;
    }
    if (code3 <= 31 || code3 === 127) {
      encoded += "\\" + code3.toString(16);
      wsBeforeHexIsNeeded = true;
      continue;
    }
    if (code3 === quoteCode || code3 === REVERSE_SOLIDUS) {
      encoded += "\\" + str.charAt(i2);
      wsBeforeHexIsNeeded = false;
    } else {
      if (wsBeforeHexIsNeeded && (isHexDigit(code3) || isWhiteSpace(code3))) {
        encoded += " ";
      }
      encoded += str.charAt(i2);
      wsBeforeHexIsNeeded = false;
    }
  }
  return quote + encoded + quote;
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/String.js
var name42 = "String";
var structure42 = {
  value: String
};
function parse43() {
  return {
    type: "String",
    loc: this.getLocation(this.tokenStart, this.tokenEnd),
    value: decode(this.consume(String2))
  };
}
function generate42(node) {
  this.token(String2, encode(node.value));
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/StyleSheet.js
var StyleSheet_exports = {};
__export(StyleSheet_exports, {
  generate: () => generate43,
  name: () => name43,
  parse: () => parse44,
  structure: () => structure43,
  walkContext: () => walkContext10
});
var EXCLAMATIONMARK3 = 33;
function consumeRaw5() {
  return this.Raw(null, false);
}
var name43 = "StyleSheet";
var walkContext10 = "stylesheet";
var structure43 = {
  children: [[
    "Comment",
    "CDO",
    "CDC",
    "Atrule",
    "Rule",
    "Raw"
  ]]
};
function parse44() {
  const start = this.tokenStart;
  const children = this.createList();
  let child2;
  scan:
    while (!this.eof) {
      switch (this.tokenType) {
        case WhiteSpace:
          this.next();
          continue;
        case Comment:
          if (this.charCodeAt(this.tokenStart + 2) !== EXCLAMATIONMARK3) {
            this.next();
            continue;
          }
          child2 = this.Comment();
          break;
        case CDO:
          child2 = this.CDO();
          break;
        case CDC:
          child2 = this.CDC();
          break;
        // CSS Syntax Module Level 3
        // §2.2 Error handling
        // At the "top level" of a stylesheet, an <at-keyword-token> starts an at-rule.
        case AtKeyword:
          child2 = this.parseWithFallback(this.Atrule, consumeRaw5);
          break;
        // Anything else starts a qualified rule ...
        default:
          child2 = this.parseWithFallback(this.Rule, consumeRaw5);
      }
      children.push(child2);
    }
  return {
    type: "StyleSheet",
    loc: this.getLocation(start, this.tokenStart),
    children
  };
}
function generate43(node) {
  this.children(node);
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/SupportsDeclaration.js
var SupportsDeclaration_exports = {};
__export(SupportsDeclaration_exports, {
  generate: () => generate44,
  name: () => name44,
  parse: () => parse45,
  structure: () => structure44
});
var name44 = "SupportsDeclaration";
var structure44 = {
  declaration: "Declaration"
};
function parse45() {
  const start = this.tokenStart;
  this.eat(LeftParenthesis);
  this.skipSC();
  const declaration = this.Declaration();
  if (!this.eof) {
    this.eat(RightParenthesis);
  }
  return {
    type: "SupportsDeclaration",
    loc: this.getLocation(start, this.tokenStart),
    declaration
  };
}
function generate44(node) {
  this.token(LeftParenthesis, "(");
  this.node(node.declaration);
  this.token(RightParenthesis, ")");
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/TypeSelector.js
var TypeSelector_exports = {};
__export(TypeSelector_exports, {
  generate: () => generate45,
  name: () => name45,
  parse: () => parse46,
  structure: () => structure45
});
var ASTERISK6 = 42;
var VERTICALLINE3 = 124;
function eatIdentifierOrAsterisk() {
  if (this.tokenType !== Ident && this.isDelim(ASTERISK6) === false) {
    this.error("Identifier or asterisk is expected");
  }
  this.next();
}
var name45 = "TypeSelector";
var structure45 = {
  name: String
};
function parse46() {
  const start = this.tokenStart;
  if (this.isDelim(VERTICALLINE3)) {
    this.next();
    eatIdentifierOrAsterisk.call(this);
  } else {
    eatIdentifierOrAsterisk.call(this);
    if (this.isDelim(VERTICALLINE3)) {
      this.next();
      eatIdentifierOrAsterisk.call(this);
    }
  }
  return {
    type: "TypeSelector",
    loc: this.getLocation(start, this.tokenStart),
    name: this.substrToCursor(start)
  };
}
function generate45(node) {
  this.tokenize(node.name);
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/UnicodeRange.js
var UnicodeRange_exports = {};
__export(UnicodeRange_exports, {
  generate: () => generate46,
  name: () => name46,
  parse: () => parse47,
  structure: () => structure46
});
var PLUSSIGN6 = 43;
var HYPHENMINUS4 = 45;
var QUESTIONMARK = 63;
function eatHexSequence(offset, allowDash) {
  let len = 0;
  for (let pos = this.tokenStart + offset; pos < this.tokenEnd; pos++) {
    const code3 = this.charCodeAt(pos);
    if (code3 === HYPHENMINUS4 && allowDash && len !== 0) {
      eatHexSequence.call(this, offset + len + 1, false);
      return -1;
    }
    if (!isHexDigit(code3)) {
      this.error(
        allowDash && len !== 0 ? "Hyphen minus" + (len < 6 ? " or hex digit" : "") + " is expected" : len < 6 ? "Hex digit is expected" : "Unexpected input",
        pos
      );
    }
    if (++len > 6) {
      this.error("Too many hex digits", pos);
    }
    ;
  }
  this.next();
  return len;
}
function eatQuestionMarkSequence(max) {
  let count = 0;
  while (this.isDelim(QUESTIONMARK)) {
    if (++count > max) {
      this.error("Too many question marks");
    }
    this.next();
  }
}
function startsWith(code3) {
  if (this.charCodeAt(this.tokenStart) !== code3) {
    this.error((code3 === PLUSSIGN6 ? "Plus sign" : "Hyphen minus") + " is expected");
  }
}
function scanUnicodeRange() {
  let hexLength = 0;
  switch (this.tokenType) {
    case Number2:
      hexLength = eatHexSequence.call(this, 1, true);
      if (this.isDelim(QUESTIONMARK)) {
        eatQuestionMarkSequence.call(this, 6 - hexLength);
        break;
      }
      if (this.tokenType === Dimension || this.tokenType === Number2) {
        startsWith.call(this, HYPHENMINUS4);
        eatHexSequence.call(this, 1, false);
        break;
      }
      break;
    case Dimension:
      hexLength = eatHexSequence.call(this, 1, true);
      if (hexLength > 0) {
        eatQuestionMarkSequence.call(this, 6 - hexLength);
      }
      break;
    default:
      this.eatDelim(PLUSSIGN6);
      if (this.tokenType === Ident) {
        hexLength = eatHexSequence.call(this, 0, true);
        if (hexLength > 0) {
          eatQuestionMarkSequence.call(this, 6 - hexLength);
        }
        break;
      }
      if (this.isDelim(QUESTIONMARK)) {
        this.next();
        eatQuestionMarkSequence.call(this, 5);
        break;
      }
      this.error("Hex digit or question mark is expected");
  }
}
var name46 = "UnicodeRange";
var structure46 = {
  value: String
};
function parse47() {
  const start = this.tokenStart;
  this.eatIdent("u");
  scanUnicodeRange.call(this);
  return {
    type: "UnicodeRange",
    loc: this.getLocation(start, this.tokenStart),
    value: this.substrToCursor(start)
  };
}
function generate46(node) {
  this.tokenize(node.value);
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Url.js
var Url_exports = {};
__export(Url_exports, {
  generate: () => generate47,
  name: () => name47,
  parse: () => parse48,
  structure: () => structure47
});

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/utils/url.js
var url_exports = {};
__export(url_exports, {
  decode: () => decode2,
  encode: () => encode2
});
var SPACE = 32;
var REVERSE_SOLIDUS2 = 92;
var QUOTATION_MARK2 = 34;
var APOSTROPHE2 = 39;
var LEFTPARENTHESIS = 40;
var RIGHTPARENTHESIS = 41;
function decode2(str) {
  const len = str.length;
  let start = 4;
  let end = str.charCodeAt(len - 1) === RIGHTPARENTHESIS ? len - 2 : len - 1;
  let decoded = "";
  while (start < end && isWhiteSpace(str.charCodeAt(start))) {
    start++;
  }
  while (start < end && isWhiteSpace(str.charCodeAt(end))) {
    end--;
  }
  for (let i2 = start; i2 <= end; i2++) {
    let code3 = str.charCodeAt(i2);
    if (code3 === REVERSE_SOLIDUS2) {
      if (i2 === end) {
        if (i2 !== len - 1) {
          decoded = str.substr(i2 + 1);
        }
        break;
      }
      code3 = str.charCodeAt(++i2);
      if (isValidEscape(REVERSE_SOLIDUS2, code3)) {
        const escapeStart = i2 - 1;
        const escapeEnd = consumeEscaped(str, escapeStart);
        i2 = escapeEnd - 1;
        decoded += decodeEscaped(str.substring(escapeStart + 1, escapeEnd));
      } else {
        if (code3 === 13 && str.charCodeAt(i2 + 1) === 10) {
          i2++;
        }
      }
    } else {
      decoded += str[i2];
    }
  }
  return decoded;
}
function encode2(str) {
  let encoded = "";
  let wsBeforeHexIsNeeded = false;
  for (let i2 = 0; i2 < str.length; i2++) {
    const code3 = str.charCodeAt(i2);
    if (code3 === 0) {
      encoded += "\uFFFD";
      continue;
    }
    if (code3 <= 31 || code3 === 127) {
      encoded += "\\" + code3.toString(16);
      wsBeforeHexIsNeeded = true;
      continue;
    }
    if (code3 === SPACE || code3 === REVERSE_SOLIDUS2 || code3 === QUOTATION_MARK2 || code3 === APOSTROPHE2 || code3 === LEFTPARENTHESIS || code3 === RIGHTPARENTHESIS) {
      encoded += "\\" + str.charAt(i2);
      wsBeforeHexIsNeeded = false;
    } else {
      if (wsBeforeHexIsNeeded && isHexDigit(code3)) {
        encoded += " ";
      }
      encoded += str.charAt(i2);
      wsBeforeHexIsNeeded = false;
    }
  }
  return "url(" + encoded + ")";
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Url.js
var name47 = "Url";
var structure47 = {
  value: String
};
function parse48() {
  const start = this.tokenStart;
  let value;
  switch (this.tokenType) {
    case Url:
      value = decode2(this.consume(Url));
      break;
    case Function:
      if (!this.cmpStr(this.tokenStart, this.tokenEnd, "url(")) {
        this.error("Function name must be `url`");
      }
      this.eat(Function);
      this.skipSC();
      value = decode(this.consume(String2));
      this.skipSC();
      if (!this.eof) {
        this.eat(RightParenthesis);
      }
      break;
    default:
      this.error("Url or Function is expected");
  }
  return {
    type: "Url",
    loc: this.getLocation(start, this.tokenStart),
    value
  };
}
function generate47(node) {
  this.token(Url, encode2(node.value));
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/Value.js
var Value_exports = {};
__export(Value_exports, {
  generate: () => generate48,
  name: () => name48,
  parse: () => parse49,
  structure: () => structure48
});
var name48 = "Value";
var structure48 = {
  children: [[]]
};
function parse49() {
  const start = this.tokenStart;
  const children = this.readSequence(this.scope.Value);
  return {
    type: "Value",
    loc: this.getLocation(start, this.tokenStart),
    children
  };
}
function generate48(node) {
  this.children(node);
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/WhiteSpace.js
var WhiteSpace_exports = {};
__export(WhiteSpace_exports, {
  generate: () => generate49,
  name: () => name49,
  parse: () => parse50,
  structure: () => structure49
});
var SPACE2 = Object.freeze({
  type: "WhiteSpace",
  loc: null,
  value: " "
});
var name49 = "WhiteSpace";
var structure49 = {
  value: String
};
function parse50() {
  this.eat(WhiteSpace);
  return SPACE2;
}
function generate49(node) {
  this.token(WhiteSpace, node.value);
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/config/parser.js
var parser_default = {
  parseContext: {
    default: "StyleSheet",
    stylesheet: "StyleSheet",
    atrule: "Atrule",
    atrulePrelude(options) {
      return this.AtrulePrelude(options.atrule ? String(options.atrule) : null);
    },
    mediaQueryList: "MediaQueryList",
    mediaQuery: "MediaQuery",
    condition(options) {
      return this.Condition(options.kind);
    },
    rule: "Rule",
    selectorList: "SelectorList",
    selector: "Selector",
    block() {
      return this.Block(true);
    },
    declarationList: "DeclarationList",
    declaration: "Declaration",
    value: "Value"
  },
  features: {
    supports: {
      selector() {
        return this.Selector();
      }
    },
    container: {
      style() {
        return this.Declaration();
      }
    }
  },
  scope: scope_exports,
  atrule: atrule_default,
  pseudo: pseudo_default,
  node: index_parse_exports
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/parser/index.js
var parser_default2 = createParser(parser_default);

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/generator/sourceMap.js
var import_source_map_generator = __toESM(require_source_map_generator(), 1);
var trackNodes = /* @__PURE__ */ new Set(["Atrule", "Selector", "Declaration"]);
function generateSourceMap(handlers) {
  const map = new import_source_map_generator.SourceMapGenerator();
  const generated = {
    line: 1,
    column: 0
  };
  const original = {
    line: 0,
    // should be zero to add first mapping
    column: 0
  };
  const activatedGenerated = {
    line: 1,
    column: 0
  };
  const activatedMapping = {
    generated: activatedGenerated
  };
  let line = 1;
  let column = 0;
  let sourceMappingActive = false;
  const origHandlersNode = handlers.node;
  handlers.node = function(node) {
    if (node.loc && node.loc.start && trackNodes.has(node.type)) {
      const nodeLine = node.loc.start.line;
      const nodeColumn = node.loc.start.column - 1;
      if (original.line !== nodeLine || original.column !== nodeColumn) {
        original.line = nodeLine;
        original.column = nodeColumn;
        generated.line = line;
        generated.column = column;
        if (sourceMappingActive) {
          sourceMappingActive = false;
          if (generated.line !== activatedGenerated.line || generated.column !== activatedGenerated.column) {
            map.addMapping(activatedMapping);
          }
        }
        sourceMappingActive = true;
        map.addMapping({
          source: node.loc.source,
          original,
          generated
        });
      }
    }
    origHandlersNode.call(this, node);
    if (sourceMappingActive && trackNodes.has(node.type)) {
      activatedGenerated.line = line;
      activatedGenerated.column = column;
    }
  };
  const origHandlersEmit = handlers.emit;
  handlers.emit = function(value, type, auto) {
    for (let i2 = 0; i2 < value.length; i2++) {
      if (value.charCodeAt(i2) === 10) {
        line++;
        column = 0;
      } else {
        column++;
      }
    }
    origHandlersEmit(value, type, auto);
  };
  const origHandlersResult = handlers.result;
  handlers.result = function() {
    if (sourceMappingActive) {
      map.addMapping(activatedMapping);
    }
    return {
      css: origHandlersResult(),
      map
    };
  };
  return handlers;
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/generator/token-before.js
var token_before_exports = {};
__export(token_before_exports, {
  safe: () => safe,
  spec: () => spec
});
var PLUSSIGN7 = 43;
var HYPHENMINUS5 = 45;
var code2 = (type, value) => {
  if (type === Delim) {
    type = value;
  }
  if (typeof type === "string") {
    type = Math.min(type.charCodeAt(0), 128) << 6;
  }
  return type << 1;
};
var specPairs = [
  [Ident, Ident],
  [Ident, Function],
  [Ident, Url],
  [Ident, BadUrl],
  [Ident, "-"],
  [Ident, Number2],
  [Ident, Percentage],
  [Ident, Dimension],
  [Ident, CDC],
  [Ident, LeftParenthesis],
  [AtKeyword, Ident],
  [AtKeyword, Function],
  [AtKeyword, Url],
  [AtKeyword, BadUrl],
  [AtKeyword, "-"],
  [AtKeyword, Number2],
  [AtKeyword, Percentage],
  [AtKeyword, Dimension],
  [AtKeyword, CDC],
  [Hash, Ident],
  [Hash, Function],
  [Hash, Url],
  [Hash, BadUrl],
  [Hash, "-"],
  [Hash, Number2],
  [Hash, Percentage],
  [Hash, Dimension],
  [Hash, CDC],
  [Dimension, Ident],
  [Dimension, Function],
  [Dimension, Url],
  [Dimension, BadUrl],
  [Dimension, "-"],
  [Dimension, Number2],
  [Dimension, Percentage],
  [Dimension, Dimension],
  [Dimension, CDC],
  ["#", Ident],
  ["#", Function],
  ["#", Url],
  ["#", BadUrl],
  ["#", "-"],
  ["#", Number2],
  ["#", Percentage],
  ["#", Dimension],
  ["#", CDC],
  // https://github.com/w3c/csswg-drafts/pull/6874
  ["-", Ident],
  ["-", Function],
  ["-", Url],
  ["-", BadUrl],
  ["-", "-"],
  ["-", Number2],
  ["-", Percentage],
  ["-", Dimension],
  ["-", CDC],
  // https://github.com/w3c/csswg-drafts/pull/6874
  [Number2, Ident],
  [Number2, Function],
  [Number2, Url],
  [Number2, BadUrl],
  [Number2, Number2],
  [Number2, Percentage],
  [Number2, Dimension],
  [Number2, "%"],
  [Number2, CDC],
  // https://github.com/w3c/csswg-drafts/pull/6874
  ["@", Ident],
  ["@", Function],
  ["@", Url],
  ["@", BadUrl],
  ["@", "-"],
  ["@", CDC],
  // https://github.com/w3c/csswg-drafts/pull/6874
  [".", Number2],
  [".", Percentage],
  [".", Dimension],
  ["+", Number2],
  ["+", Percentage],
  ["+", Dimension],
  ["/", "*"]
];
var safePairs = specPairs.concat([
  [Ident, Hash],
  [Dimension, Hash],
  [Hash, Hash],
  [AtKeyword, LeftParenthesis],
  [AtKeyword, String2],
  [AtKeyword, Colon],
  [Percentage, Percentage],
  [Percentage, Dimension],
  [Percentage, Function],
  [Percentage, "-"],
  [RightParenthesis, Ident],
  [RightParenthesis, Function],
  [RightParenthesis, Percentage],
  [RightParenthesis, Dimension],
  [RightParenthesis, Hash],
  [RightParenthesis, "-"]
]);
function createMap(pairs) {
  const isWhiteSpaceRequired = new Set(
    pairs.map(([prev, next]) => code2(prev) << 16 | code2(next))
  );
  return function(prevCode, type, value) {
    const nextCode = code2(type, value);
    const nextCharCode = value.charCodeAt(0);
    const emitWs = nextCharCode === HYPHENMINUS5 && type !== Ident && type !== Function && type !== CDC || nextCharCode === PLUSSIGN7 ? isWhiteSpaceRequired.has((prevCode & 65534) << 16 | nextCharCode << 7) : isWhiteSpaceRequired.has((prevCode & 65534) << 16 | nextCode);
    return nextCode | emitWs;
  };
}
var spec = createMap(specPairs);
var safe = createMap(safePairs);

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/generator/create.js
var REVERSESOLIDUS = 92;
function processChildren(node, delimeter) {
  if (typeof delimeter === "function") {
    let prev = null;
    node.children.forEach((node2) => {
      if (prev !== null) {
        delimeter.call(this, prev);
      }
      this.node(node2);
      prev = node2;
    });
    return;
  }
  node.children.forEach(this.node, this);
}
function createGenerator(config) {
  const types = /* @__PURE__ */ new Map();
  for (let [name50, item] of Object.entries(config.node)) {
    const fn = item.generate || item;
    if (typeof fn === "function") {
      types.set(name50, item.generate || item);
    }
  }
  return function(node, options) {
    let buffer = "";
    let prevCode = 0;
    let handlers = {
      node(node2) {
        if (types.has(node2.type)) {
          types.get(node2.type).call(publicApi, node2);
        } else {
          throw new Error("Unknown node type: " + node2.type);
        }
      },
      tokenBefore: safe,
      token(type, value, suppressAutoWhiteSpace) {
        prevCode = this.tokenBefore(prevCode, type, value);
        if (!suppressAutoWhiteSpace && prevCode & 1) {
          this.emit(" ", WhiteSpace, true);
        }
        this.emit(value, type, false);
        if (type === Delim && value.charCodeAt(0) === REVERSESOLIDUS) {
          this.emit("\n", WhiteSpace, true);
        }
      },
      emit(value) {
        buffer += value;
      },
      result() {
        return buffer;
      }
    };
    if (options) {
      if (typeof options.decorator === "function") {
        handlers = options.decorator(handlers);
      }
      if (options.sourceMap) {
        handlers = generateSourceMap(handlers);
      }
      if (options.mode in token_before_exports) {
        handlers.tokenBefore = token_before_exports[options.mode];
      }
    }
    const publicApi = {
      node: (node2) => handlers.node(node2),
      children: processChildren,
      token: (type, value) => handlers.token(type, value),
      tokenize: (raw) => tokenize(raw, (type, start, end) => {
        handlers.token(
          type,
          raw.slice(start, end),
          start !== 0
          // suppress auto whitespace for internal value tokens
        );
      })
    };
    handlers.node(node);
    return handlers.result();
  };
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/index-generate.js
var index_generate_exports = {};
__export(index_generate_exports, {
  AnPlusB: () => generate,
  Atrule: () => generate2,
  AtrulePrelude: () => generate3,
  AttributeSelector: () => generate4,
  Block: () => generate5,
  Brackets: () => generate6,
  CDC: () => generate7,
  CDO: () => generate8,
  ClassSelector: () => generate9,
  Combinator: () => generate10,
  Comment: () => generate11,
  Condition: () => generate12,
  Declaration: () => generate13,
  DeclarationList: () => generate14,
  Dimension: () => generate15,
  Feature: () => generate16,
  FeatureFunction: () => generate17,
  FeatureRange: () => generate18,
  Function: () => generate19,
  GeneralEnclosed: () => generate20,
  Hash: () => generate21,
  IdSelector: () => generate23,
  Identifier: () => generate22,
  Layer: () => generate24,
  LayerList: () => generate25,
  MediaQuery: () => generate26,
  MediaQueryList: () => generate27,
  NestingSelector: () => generate28,
  Nth: () => generate29,
  Number: () => generate30,
  Operator: () => generate31,
  Parentheses: () => generate32,
  Percentage: () => generate33,
  PseudoClassSelector: () => generate34,
  PseudoElementSelector: () => generate35,
  Ratio: () => generate36,
  Raw: () => generate37,
  Rule: () => generate38,
  Scope: () => generate39,
  Selector: () => generate40,
  SelectorList: () => generate41,
  String: () => generate42,
  StyleSheet: () => generate43,
  SupportsDeclaration: () => generate44,
  TypeSelector: () => generate45,
  UnicodeRange: () => generate46,
  Url: () => generate47,
  Value: () => generate48,
  WhiteSpace: () => generate49
});

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/config/generator.js
var generator_default = {
  node: index_generate_exports
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/generator/index.js
var generator_default2 = createGenerator(generator_default);

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/walker/create.js
var { hasOwnProperty: hasOwnProperty2 } = Object.prototype;
var noop2 = function() {
};
function ensureFunction(value) {
  return typeof value === "function" ? value : noop2;
}
function invokeForType(fn, type) {
  return function(node, item, list2) {
    if (node.type === type) {
      fn.call(this, node, item, list2);
    }
  };
}
function getWalkersFromStructure(name50, nodeType) {
  const structure50 = nodeType.structure;
  const walkers = [];
  for (const key in structure50) {
    if (hasOwnProperty2.call(structure50, key) === false) {
      continue;
    }
    let fieldTypes = structure50[key];
    const walker = {
      name: key,
      type: false,
      nullable: false
    };
    if (!Array.isArray(fieldTypes)) {
      fieldTypes = [fieldTypes];
    }
    for (const fieldType of fieldTypes) {
      if (fieldType === null) {
        walker.nullable = true;
      } else if (typeof fieldType === "string") {
        walker.type = "node";
      } else if (Array.isArray(fieldType)) {
        walker.type = "list";
      }
    }
    if (walker.type) {
      walkers.push(walker);
    }
  }
  if (walkers.length) {
    return {
      context: nodeType.walkContext,
      fields: walkers
    };
  }
  return null;
}
function getTypesFromConfig(config) {
  const types = {};
  for (const name50 in config.node) {
    if (hasOwnProperty2.call(config.node, name50)) {
      const nodeType = config.node[name50];
      if (!nodeType.structure) {
        throw new Error("Missed `structure` field in `" + name50 + "` node type definition");
      }
      types[name50] = getWalkersFromStructure(name50, nodeType);
    }
  }
  return types;
}
function createTypeIterator(config, reverse) {
  const fields = config.fields.slice();
  const contextName = config.context;
  const useContext = typeof contextName === "string";
  if (reverse) {
    fields.reverse();
  }
  return function(node, context, walk, walkReducer) {
    let prevContextValue;
    if (useContext) {
      prevContextValue = context[contextName];
      context[contextName] = node;
    }
    for (const field of fields) {
      const ref = node[field.name];
      if (!field.nullable || ref) {
        if (field.type === "list") {
          const breakWalk = reverse ? ref.reduceRight(walkReducer, false) : ref.reduce(walkReducer, false);
          if (breakWalk) {
            return true;
          }
        } else if (walk(ref)) {
          return true;
        }
      }
    }
    if (useContext) {
      context[contextName] = prevContextValue;
    }
  };
}
function createFastTraveralMap({
  StyleSheet,
  Atrule,
  Rule,
  Block,
  DeclarationList
}) {
  return {
    Atrule: {
      StyleSheet,
      Atrule,
      Rule,
      Block
    },
    Rule: {
      StyleSheet,
      Atrule,
      Rule,
      Block
    },
    Declaration: {
      StyleSheet,
      Atrule,
      Rule,
      Block,
      DeclarationList
    }
  };
}
function createWalker(config) {
  const types = getTypesFromConfig(config);
  const iteratorsNatural = {};
  const iteratorsReverse = {};
  const breakWalk = /* @__PURE__ */ Symbol("break-walk");
  const skipNode = /* @__PURE__ */ Symbol("skip-node");
  for (const name50 in types) {
    if (hasOwnProperty2.call(types, name50) && types[name50] !== null) {
      iteratorsNatural[name50] = createTypeIterator(types[name50], false);
      iteratorsReverse[name50] = createTypeIterator(types[name50], true);
    }
  }
  const fastTraversalIteratorsNatural = createFastTraveralMap(iteratorsNatural);
  const fastTraversalIteratorsReverse = createFastTraveralMap(iteratorsReverse);
  const walk = function(root, options) {
    function walkNode(node, item, list2) {
      const enterRet = enter.call(context, node, item, list2);
      if (enterRet === breakWalk) {
        return true;
      }
      if (enterRet === skipNode) {
        return false;
      }
      if (iterators.hasOwnProperty(node.type)) {
        if (iterators[node.type](node, context, walkNode, walkReducer)) {
          return true;
        }
      }
      if (leave.call(context, node, item, list2) === breakWalk) {
        return true;
      }
      return false;
    }
    let enter = noop2;
    let leave = noop2;
    let iterators = iteratorsNatural;
    let walkReducer = (ret, data, item, list2) => ret || walkNode(data, item, list2);
    const context = {
      break: breakWalk,
      skip: skipNode,
      root,
      stylesheet: null,
      atrule: null,
      atrulePrelude: null,
      rule: null,
      selector: null,
      block: null,
      declaration: null,
      function: null
    };
    if (typeof options === "function") {
      enter = options;
    } else if (options) {
      enter = ensureFunction(options.enter);
      leave = ensureFunction(options.leave);
      if (options.reverse) {
        iterators = iteratorsReverse;
      }
      if (options.visit) {
        if (fastTraversalIteratorsNatural.hasOwnProperty(options.visit)) {
          iterators = options.reverse ? fastTraversalIteratorsReverse[options.visit] : fastTraversalIteratorsNatural[options.visit];
        } else if (!types.hasOwnProperty(options.visit)) {
          throw new Error("Bad value `" + options.visit + "` for `visit` option (should be: " + Object.keys(types).sort().join(", ") + ")");
        }
        enter = invokeForType(enter, options.visit);
        leave = invokeForType(leave, options.visit);
      }
    }
    if (enter === noop2 && leave === noop2) {
      throw new Error("Neither `enter` nor `leave` walker handler is set or both aren't a function");
    }
    walkNode(root);
  };
  walk.break = breakWalk;
  walk.skip = skipNode;
  walk.find = function(ast, fn) {
    let found = null;
    walk(ast, function(node, item, list2) {
      if (fn.call(this, node, item, list2)) {
        found = node;
        return breakWalk;
      }
    });
    return found;
  };
  walk.findLast = function(ast, fn) {
    let found = null;
    walk(ast, {
      reverse: true,
      enter(node, item, list2) {
        if (fn.call(this, node, item, list2)) {
          found = node;
          return breakWalk;
        }
      }
    });
    return found;
  };
  walk.findAll = function(ast, fn) {
    const found = [];
    walk(ast, function(node, item, list2) {
      if (fn.call(this, node, item, list2)) {
        found.push(node);
      }
    });
    return found;
  };
  return walk;
}

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/node/index.js
var node_exports = {};
__export(node_exports, {
  AnPlusB: () => AnPlusB_exports,
  Atrule: () => Atrule_exports,
  AtrulePrelude: () => AtrulePrelude_exports,
  AttributeSelector: () => AttributeSelector_exports,
  Block: () => Block_exports,
  Brackets: () => Brackets_exports,
  CDC: () => CDC_exports,
  CDO: () => CDO_exports,
  ClassSelector: () => ClassSelector_exports,
  Combinator: () => Combinator_exports,
  Comment: () => Comment_exports,
  Condition: () => Condition_exports,
  Declaration: () => Declaration_exports,
  DeclarationList: () => DeclarationList_exports,
  Dimension: () => Dimension_exports,
  Feature: () => Feature_exports,
  FeatureFunction: () => FeatureFunction_exports,
  FeatureRange: () => FeatureRange_exports,
  Function: () => Function_exports,
  GeneralEnclosed: () => GeneralEnclosed_exports,
  Hash: () => Hash_exports,
  IdSelector: () => IdSelector_exports,
  Identifier: () => Identifier_exports,
  Layer: () => Layer_exports,
  LayerList: () => LayerList_exports,
  MediaQuery: () => MediaQuery_exports,
  MediaQueryList: () => MediaQueryList_exports,
  NestingSelector: () => NestingSelector_exports,
  Nth: () => Nth_exports,
  Number: () => Number_exports,
  Operator: () => Operator_exports,
  Parentheses: () => Parentheses_exports,
  Percentage: () => Percentage_exports,
  PseudoClassSelector: () => PseudoClassSelector_exports,
  PseudoElementSelector: () => PseudoElementSelector_exports,
  Ratio: () => Ratio_exports,
  Raw: () => Raw_exports,
  Rule: () => Rule_exports,
  Scope: () => Scope_exports,
  Selector: () => Selector_exports,
  SelectorList: () => SelectorList_exports,
  String: () => String_exports,
  StyleSheet: () => StyleSheet_exports,
  SupportsDeclaration: () => SupportsDeclaration_exports,
  TypeSelector: () => TypeSelector_exports,
  UnicodeRange: () => UnicodeRange_exports,
  Url: () => Url_exports,
  Value: () => Value_exports,
  WhiteSpace: () => WhiteSpace_exports
});

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/syntax/config/walker.js
var walker_default = {
  node: node_exports
};

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/walker/index.js
var walker_default2 = createWalker(walker_default);

// ../../node_modules/.bun/css-tree@3.2.1/node_modules/css-tree/lib/utils/ident.js
var ident_exports = {};
__export(ident_exports, {
  decode: () => decode3,
  encode: () => encode3
});
var REVERSE_SOLIDUS3 = 92;
function decode3(str) {
  const end = str.length - 1;
  let decoded = "";
  for (let i2 = 0; i2 < str.length; i2++) {
    let code3 = str.charCodeAt(i2);
    if (code3 === REVERSE_SOLIDUS3) {
      if (i2 === end) {
        break;
      }
      code3 = str.charCodeAt(++i2);
      if (isValidEscape(REVERSE_SOLIDUS3, code3)) {
        const escapeStart = i2 - 1;
        const escapeEnd = consumeEscaped(str, escapeStart);
        i2 = escapeEnd - 1;
        decoded += decodeEscaped(str.substring(escapeStart + 1, escapeEnd));
      } else {
        if (code3 === 13 && str.charCodeAt(i2 + 1) === 10) {
          i2++;
        }
      }
    } else {
      decoded += str[i2];
    }
  }
  return decoded;
}
function encode3(str) {
  let encoded = "";
  if (str.length === 1 && str.charCodeAt(0) === 45) {
    return "\\-";
  }
  for (let i2 = 0; i2 < str.length; i2++) {
    const code3 = str.charCodeAt(i2);
    if (code3 === 0) {
      encoded += "\uFFFD";
      continue;
    }
    if (
      // If the character is in the range [\1-\1f] (U+0001 to U+001F) or is U+007F ...
      // Note: Do not compare with 0x0001 since 0x0000 is precessed before
      code3 <= 31 || code3 === 127 || // [or] ... is in the range [0-9] (U+0030 to U+0039),
      code3 >= 48 && code3 <= 57 && // If the character is the first character ...
      (i2 === 0 || // If the character is the second character ... and the first character is a "-" (U+002D)
      i2 === 1 && str.charCodeAt(0) === 45)
    ) {
      encoded += "\\" + code3.toString(16) + " ";
      continue;
    }
    if (isName(code3)) {
      encoded += str.charAt(i2);
    } else {
      encoded += "\\" + str.charAt(i2);
    }
  }
  return encoded;
}

// ../core/src/runtime/css-syntax.ts
var OPEN = {
  [Function]: RightParenthesis,
  [LeftParenthesis]: RightParenthesis,
  [LeftSquareBracket]: RightSquareBracket,
  [LeftCurlyBracket]: RightCurlyBracket
};
function componentsOf(source, base = 0) {
  const root = [];
  const stack = [{ list: root, close: -1 }];
  const open = [];
  tokenize(source, (type, start, end) => {
    if (type === EOF) return;
    const top = stack[stack.length - 1];
    if (type === top.close && stack.length > 1) {
      stack.pop();
      open.pop().end = base + end;
      return;
    }
    const component = { type, text: source.slice(start, end), at: base + start, end: base + end };
    top.list.push(component);
    const close = OPEN[type];
    if (close !== void 0) {
      component.children = [];
      stack.push({ list: component.children, close });
      open.push(component);
    }
  });
  for (const component of open) component.end = base + source.length;
  return root;
}
var insignificant = (c3) => c3.type === WhiteSpace || c3.type === Comment;
function valueOf(c3) {
  switch (c3.type) {
    case Ident:
      return ident_exports.decode(c3.text);
    case Function:
      return ident_exports.decode(c3.text.slice(0, -1)).toLowerCase();
    case AtKeyword:
      return ident_exports.decode(c3.text.slice(1));
    case Hash:
      return ident_exports.decode(c3.text.slice(1));
    case String2:
      return string_exports.decode(c3.text);
    case Url:
      return url_exports.decode(c3.text);
    default:
      return c3.text;
  }
}
function componentsEqual(a2, b2) {
  const x2 = a2.filter((c3) => !insignificant(c3));
  const y3 = b2.filter((c3) => !insignificant(c3));
  if (x2.length !== y3.length) return false;
  for (let i2 = 0; i2 < x2.length; i2++) {
    if (x2[i2].type !== y3[i2].type || valueOf(x2[i2]) !== valueOf(y3[i2])) return false;
    if (Boolean(x2[i2].children) !== Boolean(y3[i2].children)) return false;
    if (x2[i2].children && !componentsEqual(x2[i2].children, y3[i2].children)) return false;
  }
  return true;
}
function bestQuote(text, url) {
  let none = 0;
  let single = 2;
  let double = 2;
  for (const c3 of text) {
    if (c3 === "'") {
      none++;
      single++;
    } else if (c3 === '"') {
      none++;
      double++;
    } else if (c3 === "(" || c3 === ")" || c3 === " " || c3 === "	") none++;
    else if (c3 === "\\" || c3 === "\n" || c3 === "\r" || c3 === "\f") {
      none++;
      single++;
      double++;
    }
  }
  if (url && none < single && none < double) return "";
  return single < double ? "'" : '"';
}
function quoted(text, quote) {
  let out = quote;
  const chars = [...text];
  chars.forEach((c3, i2) => {
    if (c3 === "\0" || c3 === "\r" || c3 === "\n" || c3 === "\f") {
      out += "\\" + c3.codePointAt(0).toString(16) + (/^[0-9a-fA-F\s]/.test(chars[i2 + 1] ?? "") ? " " : "");
    } else if (c3 === "\\" || c3 === quote || quote === "" && (c3 === "(" || c3 === ")" || c3 === " " || c3 === "	" || c3 === '"' || c3 === "'")) {
      out += "\\" + c3;
    } else {
      out += c3;
    }
  });
  return out + quote;
}
var quoteString = (text) => quoted(text, bestQuote(text, false));
var printUrl = (url, alwaysQuoted) => `url(${quoted(url, bestQuote(url, !alwaysQuoted))})`;
function printComponents(components, minify2) {
  let out = "";
  let pendingSpace = false;
  let afterComma = false;
  for (const c3 of components) {
    if (insignificant(c3)) {
      if (c3.type === WhiteSpace) pendingSpace = true;
      continue;
    }
    if (out && pendingSpace && c3.type !== Comma && !(afterComma && minify2)) out += " ";
    pendingSpace = false;
    afterComma = c3.type === Comma;
    const urlArgument = c3.type === Function && valueOf(c3) === "url" ? trim(c3.children ?? []) : [];
    if (c3.type === String2) out += quoteString(valueOf(c3));
    else if (c3.type === Url) out += printUrl(valueOf(c3), false);
    else if (urlArgument.length === 1 && urlArgument[0].type === String2) out += printUrl(valueOf(urlArgument[0]), false);
    else if (c3.children) out += c3.text + printComponents(trim(c3.children), minify2) + closing(c3);
    else out += c3.text;
  }
  return out;
}
function closing(c3) {
  return c3.type === LeftSquareBracket ? "]" : c3.type === LeftCurlyBracket ? "}" : ")";
}
var trim = (components) => {
  let start = 0;
  let end = components.length;
  while (start < end && insignificant(components[start])) start++;
  while (end > start && insignificant(components[end - 1])) end--;
  return components.slice(start, end);
};
var isNamed = (c3, name50, types) => c3 !== void 0 && types.includes(c3.type) && (c3.type === Function ? valueOf(c3) : valueOf(c3).toLowerCase()) === name50;
function importOf(prelude) {
  const parts = trim(prelude);
  const first = parts[0];
  let path3 = null;
  let at = 0;
  let length = 0;
  if (first?.type === String2) {
    path3 = valueOf(first);
    at = first.at;
    length = first.text.length;
  } else if (first?.type === Url) {
    path3 = valueOf(first);
    at = first.at;
    length = first.text.length;
  } else if (first && isNamed(first, "url", [Function])) {
    const args2 = trim(first.children ?? []);
    if (args2.length === 1 && args2[0].type === String2) {
      path3 = valueOf(args2[0]);
      at = args2[0].at;
      length = args2[0].text.length;
    }
  }
  if (path3 === null) return null;
  let rest = trim(parts.slice(1));
  const conditions = { layers: [], supports: [], media: [] };
  if (isNamed(rest[0], "layer", [Ident, Function])) {
    conditions.layers = [rest[0]];
    rest = trim(rest.slice(1));
  }
  if (isNamed(rest[0], "supports", [Function])) {
    conditions.supports = [rest[0]];
    rest = trim(rest.slice(1));
  }
  conditions.media = rest;
  const any2 = conditions.layers.length || conditions.supports.length || conditions.media.length;
  return { path: path3, at, length, conditions: any2 ? conditions : null };
}
var atRuleName = (node) => ident_exports.decode(node.name ?? "").toLowerCase();
var sourceOf = (source, node) => source.slice(node.loc.start.offset, node.loc.end.offset);
var isLegalComment = (text) => text.startsWith("!") || /@(license|preserve)\b/.test(text);
function layerNames(source, node) {
  if (!node.prelude) return [];
  const names = [];
  let current = [];
  for (const c3 of componentsOf(sourceOf(source, node.prelude))) {
    if (c3.type === Ident) current.push(valueOf(c3));
    else if (c3.type === Comma) {
      if (current.length) names.push(current);
      current = [];
    }
  }
  if (current.length) names.push(current);
  return names;
}
function parseSheet(source) {
  const legal = [];
  const ast = parser_default2(source, {
    positions: true,
    onComment(value) {
      if (isLegalComment(value)) legal.push(`/*${value}*/`);
    }
  });
  const sheet = { source, ast, imports: [], nodes: [], warnings: [], layersPreImport: [], layersPostImport: [], legal, hasCharset: false };
  const record2 = (names, enclosing) => {
    for (const name50 of names) sheet.layersPostImport.push([...enclosing, ...name50]);
  };
  const visitLayers = (nodes2, enclosing, anonymous) => {
    for (const node of nodes2) {
      if (node.type !== "Atrule" && node.type !== "Rule") continue;
      let inner = enclosing;
      let innerAnonymous = anonymous;
      if (node.type === "Atrule" && atRuleName(node) === "layer") {
        const names = layerNames(source, node);
        if (!anonymous && (node.block ? names.length <= 1 : names.length >= 1)) record2(names, enclosing);
        if (node.block) {
          if (names.length === 1) inner = [...enclosing, ...names[0]];
          else innerAnonymous++;
        }
      }
      if (node.type === "Atrule" && atRuleName(node) === "import") continue;
      visitLayers(node.block?.children?.toArray() ?? [], inner, innerAnonymous);
    }
  };
  let importsValid = true;
  ast.children.forEach((node) => {
    if (node.type === "Comment") return;
    const name50 = node.type === "Atrule" ? atRuleName(node) : "";
    if (name50 === "charset") {
      sheet.hasCharset = true;
      sheet.nodes.push({ node, role: "charset" });
      return;
    }
    if (name50 === "import") {
      if (!importsValid) {
        sheet.warnings.push({ text: 'All "@import" rules must come first', at: node.loc.start.offset, length: node.name.length + 1 });
        sheet.nodes.push({ node, role: "rule" });
        return;
      }
      const parts = componentsOf(sourceOf(source, node), node.loc.start.offset).slice(1);
      const block = parts.find((c3) => c3.type === LeftCurlyBracket);
      const prelude = parts.filter((c3) => c3 !== block && c3.type !== Semicolon);
      const rule = block ? null : importOf(prelude);
      if (!rule) {
        const found = block ?? trim(prelude)[0];
        const beforeBlock = trim(prelude).at(-1);
        sheet.warnings.push(block ? { text: 'Expected ";"', at: beforeBlock?.end ?? block.at, length: 0 } : found ? { text: `Expected URL token but found ${JSON.stringify(found.children ? found.text : source.slice(found.at, found.end))}`, at: found.at, length: found.text.length } : { text: "Expected URL token but found end of file", at: node.loc.end.offset, length: 0 });
        sheet.nodes.push({ node, role: "rule" });
        importsValid = false;
        return;
      }
      if (sheet.imports.length === 0) {
        sheet.layersPreImport = sheet.layersPostImport;
        sheet.layersPostImport = [];
      }
      sheet.imports.push(rule);
      sheet.nodes.push({ node, role: "import" });
      return;
    }
    visitLayers([node], [], 0);
    if (name50 === "layer" && !node.block && sheet.imports.length === 0) {
      sheet.nodes.push({ node, role: "pre-import-layer" });
      return;
    }
    importsValid = false;
    sheet.nodes.push({ node, role: "rule" });
  });
  return sheet;
}
function printedNodes(sheet) {
  return sheet.nodes.filter(({ role }) => role === "rule" || role === "pre-import-layer" && sheet.imports.length === 0).map(({ node }) => node);
}
function sheetRules(sheet, rewriteUrl) {
  return printedNodes(sheet).map((node) => print(sheet.source, node, rewriteUrl));
}
function sheetUrls(sheet) {
  return printedNodes(sheet).flatMap((node) => urlSites(sheet.source, node).map(({ site }) => site));
}
function urlSites(source, node) {
  const sites = [];
  walker_default2(node, function(inner) {
    if (inner.type === "Atrule" && atRuleName(inner) === "import") return walker_default2.skip;
    if (this.atrule?.prelude === inner) return walker_default2.skip;
    if (this.atrulePrelude || !inner.loc) return;
    if (inner.type === "Url") {
      const text = sourceOf(source, inner);
      const innerStart = /^url\(\s*/i.exec(text)?.[0].length ?? 0;
      sites.push({
        site: {
          url: inner.value,
          at: inner.loc.start.offset,
          length: text.length,
          innerAt: inner.loc.start.offset + innerStart,
          innerLength: text.replace(/\s*\)$/, "").length - innerStart
        },
        write(printed) {
          inner.type = "Raw";
          inner.value = printed;
        }
      });
    } else if (inner.type === "Raw") {
      const raw = inner;
      const original = raw.value;
      const base = raw.loc.start.offset;
      const replacements = [];
      const visit = (components) => {
        for (const c3 of components) {
          const args2 = c3.type === Function && valueOf(c3) === "url" ? trim(c3.children ?? []) : [];
          const value = c3.type === Url ? c3 : args2.length === 1 && args2[0].type === String2 ? args2[0] : null;
          if (value) {
            sites.push({
              site: { url: valueOf(value), at: c3.at, length: c3.end - c3.at, innerAt: value.at, innerLength: value.end - value.at },
              write(printed) {
                replacements.push({ start: c3.at - base, end: c3.end - base, text: printed });
                let out = original;
                for (const r3 of [...replacements].sort((a2, b2) => b2.start - a2.start)) out = out.slice(0, r3.start) + r3.text + out.slice(r3.end);
                raw.value = out;
              }
            });
          } else if (c3.children) {
            visit(c3.children);
          }
        }
      };
      visit(componentsOf(original, base));
    }
  });
  return sites;
}
function print(source, node, rewriteUrl) {
  if (node.type === "Atrule" && atRuleName(node) === "import") return printUnknownAtRule(source, node);
  for (const { site, write } of urlSites(source, node)) {
    const { url, written } = rewriteUrl ? rewriteUrl(site.url) : { url: site.url, written: false };
    write(printUrl(url, written));
  }
  walker_default2(node, (inner, item, list2) => {
    if (inner.type === "Comment" && item && list2) list2.remove(item);
    else if (inner.type === "Atrule" && inner.prelude?.loc) {
      inner.prelude = { type: "Raw", value: " " + printComponents(componentsOf(sourceOf(source, inner.prelude)), true) };
    }
  });
  return generator_default2(node, { decorator: spaceAfterUrl });
}
function printUnknownAtRule(source, node) {
  const [keyword, ...rest] = componentsOf(sourceOf(source, node), node.loc.start.offset);
  const block = rest.find((c3) => c3.type === LeftCurlyBracket);
  const prelude = printComponents(trim(rest.filter((c3) => c3 !== block && c3.type !== Semicolon)), true);
  return `${keyword.text}${prelude ? " " + prelude : ""}${block ? `{${printComponents(trim(block.children ?? []), true)}}` : ";"}`;
}
var AFTER_URL_SPACED = /* @__PURE__ */ new Set([Ident, Function, Url, String2, Number2, Dimension, Percentage, Hash]);
function spaceAfterUrl(handlers) {
  const tokenBefore = handlers.tokenBefore;
  handlers.tokenBefore = (prevCode, type, value) => {
    const next = tokenBefore(prevCode, type, value);
    return prevCode >> 1 === Url && AFTER_URL_SPACED.has(type) ? next | 1 : next;
  };
  return handlers;
}

// ../core/src/runtime/css-bundle.ts
var CssError = class extends Error {
  constructor(diagnostic) {
    super(diagnostic.text);
    this.diagnostic = diagnostic;
  }
  diagnostic;
};
var isExternalUrl = (url) => /^(data:|https?:|\/\/|#)/i.test(url);
var isRemoteImport = (path3) => /^(https?:)?\/\//i.test(path3);
var isCssLoader = (loader) => loader === "css" || loader === "global-css" || loader === "local-css";
function fileOf(module) {
  return module.namespace === "file" || module.namespace === "" ? module.path : `${module.namespace}:${module.path}`;
}
var utf8Length = (text) => new TextEncoder().encode(text).length;
async function bundleCss(modules, plugin, assets, { minify: minify2 }) {
  const diagnostic = (module, at, length, text, pluginName = "") => {
    const before = module.source.slice(0, at);
    const line = before.split(/\r\n|\r|\n/).length;
    const lineStart = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r")) + 1;
    const lineEnd = module.source.slice(at).search(/\r|\n/);
    return {
      id: "",
      pluginName,
      text,
      notes: [],
      detail: void 0,
      location: {
        file: fileOf(module),
        namespace: "",
        line,
        column: utf8Length(before.slice(lineStart)),
        length: utf8Length(module.source.slice(at, at + length)),
        lineText: module.source.slice(lineStart, lineEnd < 0 ? void 0 : at + lineEnd),
        suggestion: ""
      }
    };
  };
  const fail = (module, at, length, text, pluginName = "") => {
    throw new CssError(diagnostic(module, at, length, text, pluginName));
  };
  const resolved = /* @__PURE__ */ new Map();
  const loadedModules = /* @__PURE__ */ new Map();
  const resolve = async (from, path3, kind, at, length) => {
    const key = `${fileOf(from)}\0${kind}\0${path3}`;
    if (!resolved.has(key)) {
      resolved.set(key, plugin.resolve({ path: path3, importer: from.path, namespace: from.namespace, resolveDir: from.resolveDir, kind, with: {} }));
    }
    const answer = await resolved.get(key);
    if (answer?.errors?.length) fail(from, at, length, answer.errors[0].text ?? "error", plugin.name);
    if (!answer || !answer.path && !answer.external) fail(from, at, length, `Could not resolve ${JSON.stringify(path3)}`);
    return answer;
  };
  const load2 = async (from, module, at, length) => {
    const key = fileOf(module);
    if (!loadedModules.has(key)) loadedModules.set(key, plugin.load({ path: module.path, namespace: module.namespace, suffix: "", with: {} }));
    const answer = await loadedModules.get(key);
    if (answer?.errors?.length) fail(from, at, length, answer.errors[0].text ?? "error", plugin.name);
    if (!answer || answer.contents === void 0) fail(from, at, length, `Could not load ${fileOf(module)}`);
    return answer;
  };
  const files = /* @__PURE__ */ new Map();
  const add = async (module) => {
    const key = fileOf(module);
    const known = files.get(key);
    if (known) return known;
    const file = { key, module, sheet: parseSheet(module.source), targets: [], rules: [] };
    files.set(key, file);
    for (const rule of file.sheet.imports) {
      if (isRemoteImport(rule.path)) {
        file.targets.push({ kind: "external", path: rule.path });
        continue;
      }
      const answer = await resolve(module, rule.path, "import-rule", rule.at, rule.length);
      if (answer.external) {
        file.targets.push({ kind: "external", path: answer.path ?? rule.path });
        continue;
      }
      const child2 = { namespace: answer.namespace ?? "file", path: answer.path };
      const loaded = await load2(module, child2, rule.at, rule.length);
      if (loaded.loader === "empty") {
        file.targets.push({ kind: "empty" });
        continue;
      }
      if (!isCssLoader(loaded.loader ?? "css")) fail(module, rule.at, rule.length, `Cannot import ${JSON.stringify(fileOf(child2))} into a CSS file`);
      const source = typeof loaded.contents === "string" ? loaded.contents : new TextDecoder().decode(loaded.contents);
      const lastSlash = child2.path.lastIndexOf("/");
      const resolveDir = loaded.resolveDir ?? (lastSlash > 0 ? child2.path.slice(0, lastSlash) : "/");
      file.targets.push({ kind: "file", file: await add({ ...child2, source, resolveDir }) });
    }
    return file;
  };
  const roots = [];
  for (const module of modules) roots.push(await add(module));
  for (const file of files.values()) {
    const urls = /* @__PURE__ */ new Map();
    for (const { url, at, length, innerAt, innerLength } of sheetUrls(file.sheet)) {
      if (urls.has(url) || isExternalUrl(url)) continue;
      const answer = await resolve(file.module, url, "url-token", at, length);
      if (answer.external) {
        urls.set(url, { url: answer.path ?? url, written: false });
        continue;
      }
      const target = { namespace: answer.namespace ?? "file", path: answer.path };
      const loaded = await load2(file.module, target, at, length);
      const bytes = typeof loaded.contents === "string" ? new TextEncoder().encode(loaded.contents) : loaded.contents;
      if (loaded.loader === "file") urls.set(url, { url: await assets.emit(target, bytes), written: true });
      else if (loaded.loader === "dataurl") urls.set(url, { url: assets.dataUrl(target.path, bytes), written: false });
      else fail(file.module, innerAt, innerLength, `Cannot use ${JSON.stringify(fileOf(target))} as a URL`);
    }
    file.rules = sheetRules(file.sheet, (url) => urls.get(url) ?? { url, written: false });
  }
  const order = importOrder(roots);
  const warnings = [...files.values()].flatMap((file) => file.sheet.warnings.map((w2) => diagnostic(file.module, w2.at, w2.length, w2.text)));
  return { css: printBundle(order, minify2), warnings };
}
function isConditionalImportRedundant(earlier, later) {
  if (later.length > earlier.length) return false;
  for (let i2 = 0; i2 < later.length; i2++) {
    const a2 = earlier[i2];
    const b2 = later[i2];
    if (componentsEqual(a2.layers, b2.layers)) {
      const sameSupports = componentsEqual(a2.supports, b2.supports);
      const sameMedia = componentsEqual(a2.media, b2.media);
      if (sameSupports && sameMedia) continue;
      if (sameMedia && b2.supports.length === 0) continue;
      if (sameSupports && b2.media.length === 0) continue;
    }
    return false;
  }
  return true;
}
function conditionsAreEqual(a2, b2) {
  return a2.length === b2.length && a2.every((x2, i2) => componentsEqual(x2.layers, b2[i2].layers) && componentsEqual(x2.supports, b2[i2].supports) && componentsEqual(x2.media, b2[i2].media));
}
var layersEqual = (a2, b2) => a2.length === b2.length && a2.every((x2, i2) => x2.length === b2[i2].length && x2.every((y3, j) => y3 === b2[i2][j]));
function importOrder(roots) {
  let order = [];
  let hasExternalImport = false;
  const visit = (file, visited, wrapping) => {
    if (visited.includes(file)) return;
    const stack = [...visited, file];
    if (file.sheet.layersPreImport.length) order.push({ kind: "layers", layers: file.sheet.layersPreImport, conditions: wrapping });
    file.sheet.imports.forEach((rule, i2) => {
      const target = file.targets[i2];
      const conditions = rule.conditions ? [...wrapping, rule.conditions] : wrapping;
      if (target.kind === "file") visit(target.file, stack, conditions);
      else if (target.kind === "external") {
        order.push({ kind: "external", path: target.path, layers: [], conditions });
        hasExternalImport = true;
      }
    });
    order.push({ kind: "file", file, layers: [], conditions: wrapping });
  };
  for (const root of roots) visit(root, [], []);
  if (hasExternalImport) {
    const hoisted = [];
    const rest = [];
    let layerPrefix = true;
    for (const entry of order) {
      if (entry.kind === "layers" && layerPrefix || entry.kind === "external") hoisted.push(entry);
      else rest.push(entry);
      if (entry.kind !== "layers") layerPrefix = false;
    }
    order = [...hoisted, ...rest];
  }
  {
    const fileDuplicates = /* @__PURE__ */ new Map();
    const externalDuplicates = /* @__PURE__ */ new Map();
    for (let i2 = order.length - 1; i2 >= 0; i2--) {
      const entry = order[i2];
      if (entry.kind === "file") {
        const duplicates = fileDuplicates.get(entry.file) ?? [];
        if (duplicates.some((j) => isConditionalImportRedundant(entry.conditions, order[j].conditions))) {
          order[i2] = { kind: "layers", layers: entry.file.sheet.layersPostImport, conditions: entry.conditions };
          continue;
        }
        fileDuplicates.set(entry.file, [...duplicates, i2]);
      } else if (entry.kind === "external") {
        const duplicates = externalDuplicates.get(entry.path) ?? [];
        if (duplicates.some((j) => isConditionalImportRedundant(entry.conditions, order[j].conditions))) {
          order[i2] = { kind: "layers", layers: [], conditions: entry.conditions };
          continue;
        }
        externalDuplicates.set(entry.path, [...duplicates, i2]);
      }
    }
  }
  {
    const kept = [];
    const layerDuplicates = [];
    next: for (const original of order) {
      const entry = { ...original };
      if (entry.kind === "layers") {
        const anonymous = entry.conditions.findIndex((c3) => c3.layers.length === 1 && !c3.layers[0].children);
        if (anonymous >= 0) {
          entry.conditions = entry.conditions.slice(0, anonymous);
          entry.layers = [];
        }
        if (entry.layers.length === 0) {
          let end = entry.conditions.length;
          while (end > 0 && entry.conditions[end - 1].layers.length === 0) end--;
          entry.conditions = entry.conditions.slice(0, end);
        }
        if (entry.conditions.length === 0 && entry.layers.length === 0) continue;
      }
      const layersKey = entry.kind === "file" ? entry.file.sheet.layersPostImport : entry.layers;
      let index = layerDuplicates.findIndex((d2) => layersEqual(d2.layers, layersKey));
      if (index < 0) {
        layerDuplicates.push({ layers: layersKey, indices: [] });
        index = layerDuplicates.length - 1;
      }
      const duplicates = layerDuplicates[index].indices;
      for (let j = duplicates.length - 1; j >= 0; j--) {
        const at = duplicates[j];
        if (!isConditionalImportRedundant(entry.conditions, kept[at].conditions)) continue;
        if (entry.kind !== "layers") {
          if (j === duplicates.length - 1 && at === kept.length - 1) {
            const other = kept[at];
            if (other.kind === "layers" && conditionsAreEqual(entry.conditions, other.conditions)) {
              duplicates.splice(j, 1);
              kept.length = at;
              duplicates.push(kept.length);
              kept.push(entry);
              continue next;
            }
          }
          kept.push(entry);
        }
        continue next;
      }
      duplicates.push(kept.length);
      kept.push(entry);
    }
    order = kept;
  }
  const merged = [];
  for (const entry of order) {
    const prev = merged[merged.length - 1];
    if (entry.kind === "layers" && prev?.kind === "layers" && conditionsAreEqual(prev.conditions, entry.conditions)) {
      merged[merged.length - 1] = { ...prev, layers: [...prev.layers, ...entry.layers] };
      continue;
    }
    merged.push(entry);
  }
  return merged;
}
function wrapRules(rules, conditions, minify2) {
  const block = (prelude, inner) => minify2 ? `${prelude}{${inner.join("")}}` : `${prelude} {
${inner.join("\n")}
}`;
  let out = rules;
  for (let i2 = conditions.length - 1; i2 >= 0; i2--) {
    const item = conditions[i2];
    for (const layer of item.layers) {
      const name50 = layer.children ? printComponents(layer.children, minify2) : "";
      if (out.length === 0) {
        if (!layer.children) continue;
        out = [`@layer ${name50};`];
        continue;
      }
      out = [block(name50 ? `@layer ${name50}` : "@layer", out)];
    }
    if (out.length > 0) {
      for (const supports of item.supports) out = [block(`@supports (${printComponents(supports.children ?? [], minify2)})`, out)];
    }
    if (out.length > 0 && item.media.length > 0) out = [block(`@media ${printComponents(item.media, minify2)}`, out)];
  }
  return out;
}
function printImport(path3, conditions, minify2) {
  const parts = conditions ? [conditions.layers, conditions.supports, conditions.media].filter((p) => p.length) : [];
  const printed = parts.map((p) => printComponents(p, minify2)).join(" ");
  return minify2 ? `@import${quoteString(path3)}${printed};` : `@import ${quoteString(path3)}${printed ? " " + printed : ""};`;
}
function shortestDataUrl(mimeType, text) {
  const bytes = new TextEncoder().encode(text);
  let latin1 = "";
  for (let i2 = 0; i2 < bytes.length; i2 += 32768) latin1 += String.fromCharCode(...bytes.subarray(i2, i2 + 32768));
  const encoded = `data:${mimeType};base64,${btoa(latin1)}`;
  const escaped = percentEscapedDataUrl(mimeType, text);
  return escaped.length < encoded.length ? escaped : encoded;
}
function percentEscapedDataUrl(mimeType, text) {
  let trailing = text.length;
  while (trailing > 0) {
    const c3 = text.charCodeAt(trailing - 1);
    if (c3 > 32 || c3 === 9 || c3 === 10 || c3 === 13) break;
    trailing--;
  }
  let out = `data:${mimeType},`;
  for (let i2 = 0; i2 < text.length; i2++) {
    const c3 = text.charCodeAt(i2);
    const hex = (n5) => "%" + n5.toString(16).toUpperCase().padStart(2, "0");
    if (c3 === 9 || c3 === 10 || c3 === 13 || c3 === 35 || i2 >= trailing || c3 === 37 && /^[0-9a-fA-F]{2}/.test(text.slice(i2 + 1, i2 + 3))) out += hex(c3);
    else out += text[i2];
  }
  return out;
}
function printBundle(order, minify2) {
  const pieces = [];
  const legal = [];
  let charset = false;
  for (const entry of order) {
    if (entry.kind === "layers") {
      const statement = entry.layers.length ? [`@layer ${entry.layers.map((name50) => name50.join(".")).join(minify2 ? "," : ", ")};`] : [];
      pieces.push(wrapRules(statement, entry.conditions, minify2).join(minify2 ? "" : "\n"));
    } else if (entry.kind === "external") {
      let path3 = entry.path;
      for (let i2 = entry.conditions.length - 1; i2 > 0; i2--) path3 = shortestDataUrl("text/css", printImport(path3, entry.conditions[i2], minify2));
      pieces.push(printImport(path3, entry.conditions[0], minify2));
    } else {
      const file = entry.file;
      if (file.sheet.hasCharset) charset = true;
      for (const comment of file.sheet.legal) if (!legal.includes(comment)) legal.push(comment);
      const body = wrapRules(file.rules, entry.conditions, minify2).join(minify2 ? "" : "\n");
      pieces.push(minify2 ? body : `/* ${fileOf(file.module)} */
${body}`);
    }
  }
  const head = charset ? ['@charset "UTF-8";'] : [];
  const sheet = [...head, ...pieces.filter((piece) => piece !== "")].join(minify2 ? "" : "\n");
  return `${sheet}
${legal.map((comment) => comment + "\n").join("")}`;
}

// ../core/src/runtime/jsonc.ts
var LINE_END = {
  tsconfck: /\n/,
  esbuild: /[\n\r\u2028\u2029]/
};
function jsoncToJson(text, dialect) {
  const lineEnd = LINE_END[dialect];
  const blank = dialect === "tsconfck" ? (comment) => comment.replace(/\S/g, " ") : () => " ";
  const source = text.charCodeAt(0) === 65279 ? text.slice(1) : text;
  let out = "";
  for (let i2 = 0; i2 < source.length; i2++) {
    const c3 = source[i2];
    if (c3 === '"') {
      const start = i2;
      for (i2++; i2 < source.length && source[i2] !== '"'; i2++) if (source[i2] === "\\") i2++;
      out += source.slice(start, i2 + 1);
    } else if (c3 === "/" && source[i2 + 1] === "/") {
      let end = i2;
      while (end < source.length && !lineEnd.test(source[end])) end++;
      out += blank(source.slice(i2, end));
      i2 = end - 1;
    } else if (c3 === "/" && source[i2 + 1] === "*") {
      const close = source.indexOf("*/", i2 + 2);
      if (close < 0 && dialect === "esbuild") throw new Error('Expected "*/" to terminate multi-line comment');
      const end = close < 0 ? source.length : close + 2;
      out += blank(source.slice(i2, end));
      i2 = end - 1;
    } else {
      out += dialect === "esbuild" && lineEnd.test(c3) ? "\n" : c3;
    }
  }
  const blanked2 = out.replace(/"(?:[^"\\]|\\.)*"/g, (s2) => '"' + " ".repeat(s2.length - 2) + '"');
  let result = "";
  for (let i2 = 0; i2 < out.length; i2++) {
    if (blanked2[i2] === ",") {
      let next = i2 + 1;
      while (next < blanked2.length && /\s/.test(blanked2[next])) next++;
      if (blanked2[next] === "}" || blanked2[next] === "]") continue;
    }
    result += out[i2];
  }
  return result;
}
function isJsonRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ../core/src/runtime/tsconfig-raw.ts
var TsconfigRefusal = class extends Error {
};
var KEYWORDS = /* @__PURE__ */ new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with"
]);
function jsxExpression(text) {
  const parts = text.split(".");
  const first = parts[0];
  if (parts.every(isIdentifier) && (!KEYWORDS.has(first) || first === "null" || first === "this" || first === "import" && parts[1] === "meta")) {
    return { chain: text };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    const single = /^\s*'((?:[^'\\]|\\.)*)'\s*$/.exec(text);
    if (!single) return null;
    try {
      value = JSON.parse(`"${single[1].replace(/\\'/g, "'").replace(/"/g, '\\"')}"`);
    } catch {
      return null;
    }
  }
  return value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string" ? { constant: value } : null;
}
function isIdentifier(text) {
  return /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u.test(text);
}
function memberExpression(text, warnings) {
  if (text === "") return null;
  if (text.split(".").every(isIdentifier)) return text;
  warnings.push(`Invalid JSX member expression: ${JSON.stringify(text)}`);
  return null;
}
var COMPILER_OPTION_KEYS = [
  "alwaysStrict",
  "baseUrl",
  "experimentalDecorators",
  "importsNotUsedAsValues",
  "jsx",
  "jsxFactory",
  "jsxFragmentFactory",
  "jsxImportSource",
  "paths",
  "preserveValueImports",
  "strict",
  "target",
  "useDefineForClassFields",
  "verbatimModuleSyntax"
];
function resolveTsSettings(inputs, call) {
  const warnings = [];
  const jsxMode = inputs.jsx ?? "transform";
  if (jsxMode !== "transform" && jsxMode !== "automatic" && jsxMode !== "preserve") {
    throw new Error(`Invalid JSX mode: ${JSON.stringify(jsxMode)}`);
  }
  const own = (text, what) => {
    if (text === void 0 || text === "") return null;
    const expression = jsxExpression(text);
    if (!expression || "constant" in expression && what !== "fragment") throw new Error(`Invalid JSX ${what}: ${JSON.stringify(text)}`);
    if (what === "fragment" && "chain" in expression && expression.chain === "null") return { constant: null };
    return expression;
  };
  const ownFactory = own(inputs.jsxFactory, "factory");
  const ownFragment = own(inputs.jsxFragment, "fragment");
  const jsx = {
    preserve: jsxMode === "preserve",
    automatic: jsxMode === "automatic",
    factory: ownFactory && "chain" in ownFactory ? ownFactory.chain : null,
    fragment: ownFragment && "chain" in ownFragment ? ownFragment.chain : null,
    fragmentConstant: ownFragment && "constant" in ownFragment ? { value: ownFragment.constant } : null,
    importSource: inputs.jsxImportSource || null,
    development: inputs.jsxDev === true
  };
  const settings = {
    jsx,
    keepValues: false,
    keepStatements: false,
    alwaysStrict: false,
    experimentalDecorators: false,
    assignClassFields: false,
    warnings
  };
  const raw = inputs.tsconfigRaw;
  if (raw === void 0 || raw === "") return finish(settings);
  let config;
  if (typeof raw === "string") {
    try {
      config = JSON.parse(jsoncToJson(raw, "esbuild"));
    } catch (error2) {
      throw new Error(`tsconfigRaw is not valid JSON: ${error2 instanceof Error ? error2.message : String(error2)}`);
    }
  } else {
    config = raw;
  }
  if (!isJsonRecord(config)) return finish(settings);
  for (const key of Object.keys(config)) {
    if (COMPILER_OPTION_KEYS.includes(key)) {
      warnings.push(`Expected the ${JSON.stringify(key)} option to be nested inside a "compilerOptions" object`);
      break;
    }
  }
  const extendsFiles = typeof config.extends === "string" || Array.isArray(config.extends) && config.extends.some((e3) => typeof e3 === "string");
  if (call === "build" && extendsFiles) {
    throw new TsconfigRefusal('tsconfigRaw "extends" is not supported: a build reads no tsconfig file it names');
  }
  const options = config.compilerOptions;
  if (!isJsonRecord(options)) return finish(settings);
  const string2 = (key) => typeof options[key] === "string" ? options[key] : void 0;
  const boolean2 = (key) => typeof options[key] === "boolean" ? options[key] : void 0;
  switch (string2("jsx")?.toLowerCase()) {
    case "react":
      jsx.automatic = false;
      jsx.development = false;
      break;
    case "react-jsx":
      jsx.automatic = true;
      break;
    case "react-jsxdev":
      jsx.automatic = true;
      jsx.development = true;
      break;
    default:
      break;
  }
  const factory = string2("jsxFactory");
  if (factory !== void 0) jsx.factory = memberExpression(factory, warnings) ?? jsx.factory;
  const fragmentFactory = string2("jsxFragmentFactory");
  const fragment = fragmentFactory === void 0 ? null : memberExpression(fragmentFactory, warnings);
  if (fragment !== null) {
    jsx.fragment = fragment;
    jsx.fragmentConstant = null;
  }
  const importSource = string2("jsxImportSource");
  if (importSource !== void 0) jsx.importSource = importSource;
  settings.experimentalDecorators = boolean2("experimentalDecorators") === true;
  const target = string2("target");
  let targetBelowEs2022;
  if (target !== void 0) {
    const lower = target.toLowerCase();
    if (/^(es3|es5|es6|es2015|es2016|es2017|es2018|es2019|es2020|es2021)$/.test(lower)) targetBelowEs2022 = true;
    else if (/^(es2022|es2023|es2024|esnext)$/.test(lower)) targetBelowEs2022 = false;
    else warnings.push(`Unrecognized target environment ${JSON.stringify(target)}`);
  }
  settings.assignClassFields = (boolean2("useDefineForClassFields") ?? !targetBelowEs2022) === false;
  const notUsed = string2("importsNotUsedAsValues");
  if (notUsed !== void 0 && notUsed !== "remove" && notUsed !== "preserve" && notUsed !== "error") {
    warnings.push(`Invalid value ${JSON.stringify(notUsed)} for "importsNotUsedAsValues"`);
  }
  if (boolean2("verbatimModuleSyntax") === true) {
    settings.keepValues = true;
    settings.keepStatements = true;
  } else {
    settings.keepValues = boolean2("preserveValueImports") === true;
    settings.keepStatements = notUsed === "preserve" || notUsed === "error";
  }
  settings.alwaysStrict = boolean2("alwaysStrict") ?? boolean2("strict") ?? false;
  return finish(settings);
}
function finish(settings) {
  if (!settings.jsx.automatic) {
    settings.jsx.development = false;
    settings.jsx.importSource = null;
  }
  return settings;
}

// ../core/src/runtime/javascript-scope.ts
function isNode(value) {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string" && "start" in value && typeof value.start === "number" && "end" in value && typeof value.end === "number";
}
function child(node, key) {
  const value = node?.[key];
  return isNode(value) ? value : null;
}
function list(node, key) {
  const value = node?.[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
}
function stringOf(node, key) {
  const value = node?.[key];
  return typeof value === "string" ? value : null;
}
function* patternNames(node) {
  switch (node?.type) {
    case "Identifier": {
      const name50 = stringOf(node, "name");
      if (name50 !== null) yield name50;
      return;
    }
    case "ObjectPattern":
      for (const property of list(node, "properties")) yield* patternNames(child(property, property.type === "RestElement" ? "argument" : "value"));
      return;
    case "ArrayPattern":
      for (const element of list(node, "elements")) yield* patternNames(element);
      return;
    case "RestElement":
      yield* patternNames(child(node, "argument"));
      return;
    case "AssignmentPattern":
      yield* patternNames(child(node, "left"));
      return;
    case "TSParameterProperty":
      yield* patternNames(child(node, "parameter"));
      return;
    // `namespace A.B {}` binds A.
    case "TSQualifiedName":
      yield* patternNames(child(node, "left"));
      return;
  }
}
var FUNCTIONS = /* @__PURE__ */ new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
function* lexicalNames(statements) {
  for (const statement of statements) {
    const node = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? child(statement, "declaration") : statement;
    if (node?.type === "VariableDeclaration" && node.kind !== "var") {
      for (const declarator of list(node, "declarations")) yield* patternNames(child(declarator, "id"));
    }
    if (node?.type === "FunctionDeclaration" || node?.type === "ClassDeclaration") yield* patternNames(child(node, "id"));
    if (node?.type === "ImportDeclaration") for (const specifier of list(node, "specifiers")) yield* patternNames(child(specifier, "local"));
  }
}
function* varNames(value, sloppy, top = true) {
  if (Array.isArray(value)) {
    for (const item of value) yield* varNames(item, sloppy, top);
    return;
  }
  if (!isNode(value)) return;
  if (value.type === "FunctionDeclaration" && sloppy && !top) yield* patternNames(child(value, "id"));
  if (FUNCTIONS.has(value.type) || value.type === "StaticBlock") return;
  if (value.type === "VariableDeclaration" && value.kind === "var") {
    for (const declarator of list(value, "declarations")) yield* patternNames(child(declarator, "id"));
  }
  for (const [key, item] of Object.entries(value)) if (key !== "parent") yield* varNames(item, sloppy, false);
}
function scopeOf(node, scope, sloppy, functionBody) {
  const within = (names) => ({ names: new Set(names), parent: scope });
  switch (node.type) {
    case "Program":
    case "StaticBlock":
      return within([...varNames(list(node, "body"), sloppy), ...lexicalNames(list(node, "body"))]);
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return within([
        ...node.type === "FunctionExpression" ? patternNames(child(node, "id")) : [],
        ...node.type === "ArrowFunctionExpression" ? [] : ["arguments"],
        ...list(node, "params").flatMap((parameter) => [...patternNames(parameter)])
      ]);
    case "BlockStatement":
      return within([...functionBody ? varNames(list(node, "body"), sloppy) : [], ...lexicalNames(list(node, "body"))]);
    case "SwitchStatement":
      return within(lexicalNames(list(node, "cases").flatMap((c3) => list(c3, "consequent"))));
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement": {
      const head = child(node, node.type === "ForStatement" ? "init" : "left");
      return within(head?.type === "VariableDeclaration" && head.kind !== "var" ? list(head, "declarations").flatMap((declarator) => [...patternNames(child(declarator, "id"))]) : []);
    }
    case "CatchClause":
      return within(patternNames(child(node, "param")));
    // A class's name is its body's too (an expression's, only its body's).
    case "ClassDeclaration":
    case "ClassExpression":
      return within(patternNames(child(node, "id")));
    default:
      return scope;
  }
}
function* scoped(value, scope, sloppy, functionBody = false, parent = null, key = "") {
  if (Array.isArray(value)) {
    for (const item of value) yield* scoped(item, scope, sloppy, false, parent, key);
    return;
  }
  if (!isNode(value)) return;
  yield [value, scope, parent, key];
  const inner = scopeOf(value, scope, sloppy, functionBody);
  const isFunction = FUNCTIONS.has(value.type);
  for (const [field, item] of Object.entries(value)) {
    if (field !== "parent") yield* scoped(item, inner, sloppy, isFunction && field === "body", value, field);
  }
}
function bindingScope(scope, name50) {
  for (let at = scope; at; at = at.parent) if (at.names.has(name50)) return at;
  return null;
}
function isSloppy(program) {
  if (program.sourceType === "module") return false;
  return !list(program, "body").some((statement) => statement.type === "ExpressionStatement" && statement.directive === "use strict");
}

// ../core/src/runtime/rolldown-compat.ts
function* nodes(value) {
  if (Array.isArray(value)) {
    for (const item of value) yield* nodes(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (isNode(value)) yield value;
  for (const [key, item] of Object.entries(value)) if (key !== "parent") yield* nodes(item);
}
function transformOf(api) {
  if (!api.transformSync) throw new Error("Nimbus's bundler has no transform of rolldown's for this module");
  return api.transformSync;
}
function parseWithComments(api, module, source = module.text, lang = module.loader) {
  if (!api.parseSync) throw new Error("Nimbus's bundler has no parser of rolldown's for this module");
  const typescript = lang === "ts" || lang === "tsx";
  const parsed = api.parseSync(module.path, source, { lang, sourceType: "unambiguous", astType: typescript ? "ts" : "js" });
  if (parsed.errors.length !== 0 || !isNode(parsed.program)) return null;
  return { program: parsed.program, comments: parsed.comments.filter(isNode) };
}
function parse51(api, module, source = module.text, lang = module.loader) {
  return parseWithComments(api, module, source, lang)?.program ?? null;
}
function hasEmptyClause(source, node, comments) {
  if (node.type !== "ImportDeclaration" || list(node, "specifiers").length > 0) return false;
  const from = child(node, "source");
  if (!from) return false;
  for (let at = node.start; at < from.start; at++) {
    const comment = comments.find((c3) => c3.start <= at && at < c3.end);
    if (comment) at = comment.end - 1;
    else if (source[at] === "{") return true;
  }
  return false;
}
function jsxAndTypescriptOf(settings, fragment = settings.jsx.fragment) {
  const { jsx } = settings;
  const classic = !jsx.preserve && !jsx.automatic;
  return {
    jsx: jsx.preserve ? "preserve" : jsx.automatic ? { runtime: "automatic", importSource: jsx.importSource ?? "react", development: jsx.development } : { runtime: "classic", pragma: jsx.factory ?? "React.createElement", pragmaFrag: fragment ?? "React.Fragment" },
    typescript: {
      // The import the classic factory keeps for the JSX that calls it. The
      // automatic runtime and preserved JSX call nothing the file imports,
      // so (as for esbuild) an import of React they leave unused is
      // dropped: an empty pragma names no import.
      jsxPragma: classic ? jsx.factory ?? "React.createElement" : "",
      jsxPragmaFrag: classic ? fragment ?? "React.Fragment" : "",
      // rolldown has one option for esbuild's two unused-import flags, both
      // at once (verbatimModuleSyntax); with either alone a module is
      // compiled keeping every import, then each is made what esbuild keeps
      // of it (ownCompile).
      onlyRemoveTypeImports: settings.keepValues || settings.keepStatements
    }
  };
}
function compileForBuild(api, settings, module) {
  return ownCompile(api, settings, module);
}
function applyEdits(code3, edits) {
  let out = "";
  let at = 0;
  for (const { start, end, replacement } of [...edits].sort((a2, b2) => a2.start - b2.start)) {
    if (start < at) continue;
    if (replacement.length !== end - start) throw new Error("rolldown-compat: an edit must keep its length");
    out += code3.slice(at, start) + replacement;
    at = end;
  }
  return out + code3.slice(at);
}
var blanked = (code3, start, end) => ({
  start,
  end,
  replacement: code3.slice(start, end).replace(/[^\n\r\u2028\u2029]/g, " ")
});
function ownCompile(api, settings, module) {
  const { jsx } = settings;
  const jsxModule = module.loader === "jsx" || module.loader === "tsx";
  const typescript = module.loader === "ts" || module.loader === "tsx";
  const classic = !jsx.preserve && !jsx.automatic;
  const constant = jsxModule && classic && jsx.fragmentConstant ? jsx.fragmentConstant.value : void 0;
  const development = jsxModule && jsx.automatic && jsx.development;
  const decorators = typescript && settings.experimentalDecorators;
  const assign = typescript && settings.assignClassFields;
  const parameterProperties = typescript && !assign && PARAMETER_PROPERTY.test(module.text);
  const oneFlag = settings.keepValues !== settings.keepStatements;
  const imports = typescript && /\bimport\b/.test(module.text) && (oneFlag || !settings.keepStatements && EMPTY_CLAUSE.test(module.text));
  if (!development && constant === void 0 && !imports && !decorators && !assign && !parameterProperties) return null;
  const parsed = parseWithComments(api, module);
  if (!parsed) return null;
  const sourceImports = list(parsed.program, "body").filter((node) => node.type === "ImportDeclaration" && node.importKind !== "type").map((node) => {
    const specifiers = list(node, "specifiers");
    return {
      from: stringOf(child(node, "source"), "value"),
      empty: hasEmptyClause(module.text, node, parsed.comments),
      typesOnly: specifiers.length > 0 && specifiers.every((s2) => s2.type === "ImportSpecifier" && s2.importKind === "type"),
      locals: localsOf(node)
    };
  });
  const fixImports = imports && (oneFlag || !settings.keepStatements && sourceImports.some((i2) => i2.empty));
  const classes = parameterProperties ? parameterPropertiesOf(parsed.program) : null;
  if (!development && constant === void 0 && !fixImports && !decorators && !assign && !classes) return null;
  let placeholder;
  let constantText = "";
  if (constant !== void 0) {
    const program = parsed.program;
    const taken = /* @__PURE__ */ new Set();
    for (const node of nodes(program)) {
      const name50 = stringOf(node, "name");
      if (name50 !== null) taken.add(name50);
    }
    constantText = typeof constant === "string" ? JSON.stringify(constant).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029") : Object.is(constant, -0) ? "-0" : String(constant);
    placeholder = "__nimbusJsxFragment".padEnd(constantText.length, "_");
    while (taken.has(placeholder)) placeholder += "_";
  }
  const out = transformOf(api)(module.path, module.text, { ...transformOptions(settings, module, placeholder), sourcemap: module.sourcemap });
  if (out.errors.length) return null;
  const output = parse51(api, module, out.code, outputLang(settings, module));
  if (!output) throw new Error(`Nimbus's bundler could not read back its own compilation of ${module.path}`);
  const edits = [];
  if (placeholder) {
    for (const node of nodes(output)) {
      if (node.type === "Identifier" && node.name === placeholder) {
        edits.push({ start: node.start, end: node.end, replacement: constantText.padEnd(node.end - node.start) });
      }
    }
  }
  if (development) {
    for (const [start, end] of devFallbackProps(output, jsx.importSource ?? "react")) edits.push(blanked(out.code, start, end));
  }
  if (fixImports) {
    const importEdits = esbuildImports(api, settings, module, sourceImports, out.code, output);
    if (!importEdits) return null;
    edits.push(...importEdits);
  }
  if (classes) {
    for (const [start, end] of parameterPropertyDeclarations(output, classes)) edits.push(blanked(out.code, start, end));
  }
  if (assign) shadowedLowering(module, parsed.program, output);
  const code3 = applyEdits(out.code, edits);
  const map = module.sourcemap ? out.map : void 0;
  const moduleType2 = outputLang(settings, module);
  if (!decorators) return { code: code3, map, moduleType: moduleType2 };
  const edited = parse51(api, module, code3, moduleType2);
  if (!edited) throw new Error(`Nimbus's bundler could not read back its own compilation of ${module.path}`);
  return { ...decorateInTscOrder(edited, code3, map, new Set(sourceImports.flatMap((i2) => i2.locals))), moduleType: moduleType2 };
}
function outputLang(settings, module) {
  return settings.jsx.preserve && (module.loader === "jsx" || module.loader === "tsx") ? "jsx" : "js";
}
function transformOptions(settings, module, fragment) {
  const typescriptModule = module.loader === "ts" || module.loader === "tsx";
  const assign = typescriptModule && settings.assignClassFields;
  const { jsx, typescript } = jsxAndTypescriptOf(settings, fragment);
  return {
    lang: module.loader,
    sourceType: "unambiguous",
    jsx,
    typescript: assign ? { ...typescript, removeClassFieldsWithoutInitializer: true } : typescript,
    ...typescriptModule && settings.experimentalDecorators ? { decorator: { legacy: true } } : {},
    ...assign ? { target: "es2021", assumptions: { setPublicClassFields: true } } : {}
  };
}
var EMPTY_CLAUSE = /\bimport(?:\s|\/\*[^]*?\*\/|\/\/[^\n\r\u2028\u2029]*)*\{(?:\s|\/\*[^]*?\*\/|\/\/[^\n\r\u2028\u2029]*)*\}/;
var importsOf = (program) => list(program, "body").filter((node) => node.type === "ImportDeclaration");
function esbuildImports(api, settings, module, sourceImports, code3, output) {
  const blanks = (i2) => !settings.keepStatements && (i2.empty || settings.keepValues && i2.typesOnly);
  const keptTypes = settings.keepValues || settings.keepStatements;
  const matched = matchImports(module, sourceImports, importsOf(output), keptTypes, (a2, b2) => blanks(a2) === blanks(b2));
  const edits = [];
  if (!settings.keepStatements) {
    for (const [node, index] of matched) {
      if (sourceImports[index].empty || settings.keepValues && sourceImports[index].typesOnly) edits.push(blanked(code3, node.start, node.end));
    }
    return edits;
  }
  if (settings.keepValues) return edits;
  const plain = { ...settings, keepValues: false, keepStatements: false };
  const out = transformOf(api)(module.path, module.text, transformOptions(plain, module));
  if (out.errors.length) return null;
  const plainOutput = parse51(api, module, out.code, outputLang(settings, module));
  if (!plainOutput) throw new Error(`Nimbus's bundler could not read back its own compilation of ${module.path}`);
  const plainMatched = matchImports(module, sourceImports, importsOf(plainOutput), false, () => true);
  const kept = new Map(plainMatched.map(([node, index]) => [index, out.code.slice(node.start, node.end)]));
  for (const [node, index] of matched) {
    const current = code3.slice(node.start, node.end);
    const replacement = kept.get(index) ?? `import ${JSON.stringify(sourceImports[index].from)};`;
    if (replacement === current) continue;
    const firstLine = current.search(/[\n\r\u2028\u2029]/);
    if (/[\n\r\u2028\u2029]/.test(replacement) || replacement.length > (firstLine < 0 ? current.length : firstLine)) {
      throw new Error(`Nimbus's bundler cannot fit esbuild's import of ${JSON.stringify(sourceImports[index].from)} in ${module.path} where it compiled one`);
    }
    edits.push({ start: node.start, end: node.end, replacement: replacement + blanked(code3, node.start + replacement.length, node.end).replacement });
  }
  return edits;
}
function localsOf(node) {
  return list(node, "specifiers").map((specifier) => stringOf(child(specifier, "local"), "name")).filter((name50) => name50 !== null);
}
function matchImports(module, sourceImports, outputImports, keptTypes, alike) {
  const ambiguous = (from) => new Error(`Nimbus's bundler cannot tell which import of ${JSON.stringify(from)} in ${module.path} its compilation kept, to keep it as esbuild would`);
  const paired = [];
  const taken = /* @__PURE__ */ new Set();
  const bare2 = [];
  for (const node of outputImports) {
    const locals = localsOf(node);
    if (locals.length === 0) {
      bare2.push(node);
      continue;
    }
    const owners = new Set(locals.map((name50) => sourceImports.findIndex((i2) => i2.locals.includes(name50))).filter((index) => index >= 0));
    if (owners.size === 0) continue;
    const [owner] = owners;
    if (owners.size > 1 || taken.has(owner) || sourceImports[owner].from !== stringOf(child(node, "source"), "value")) {
      throw ambiguous(stringOf(child(node, "source"), "value"));
    }
    taken.add(owner);
    paired.push([node, owner]);
  }
  const byModule = /* @__PURE__ */ new Map();
  for (const node of bare2) {
    const from = stringOf(child(node, "source"), "value");
    byModule.set(from, [...byModule.get(from) ?? [], node]);
  }
  for (const [from, nodes2] of byModule) {
    const candidates = sourceImports.map((i2, index) => index).filter((index) => !taken.has(index) && sourceImports[index].from === from && (sourceImports[index].locals.length === 0 || keptTypes && sourceImports[index].typesOnly));
    if (nodes2.length > candidates.length) throw ambiguous(from);
    if (nodes2.length < candidates.length && !candidates.every((index) => alike(sourceImports[index], sourceImports[candidates[0]]))) throw ambiguous(from);
    nodes2.forEach((node, k2) => paired.push([node, candidates[k2]]));
  }
  return paired;
}
function devFallbackProps(program, importSource) {
  let local = null;
  for (const node of list(program, "body")) {
    if (node.type !== "ImportDeclaration" || stringOf(child(node, "source"), "value") !== importSource) continue;
    for (const specifier of list(node, "specifiers")) {
      if (specifier.type === "ImportSpecifier" && stringOf(child(specifier, "imported"), "name") === "createElement") {
        local = stringOf(child(specifier, "local"), "name");
      }
    }
  }
  if (!local) return [];
  const ranges = [];
  for (const node of nodes(program)) {
    const callee = child(node, "callee");
    const props = list(node, "arguments")[1];
    if (node.type !== "CallExpression" || callee?.type !== "Identifier" || callee.name !== local || props?.type !== "ObjectExpression") continue;
    const properties = list(props, "properties");
    properties.forEach((property, i2) => {
      const key = stringOf(child(property, "key"), "name");
      if (property.type !== "Property" || key !== "__self" && key !== "__source") return;
      if (i2 + 1 < properties.length) ranges.push([property.start, properties[i2 + 1].start]);
      else if (i2 > 0) ranges.push([properties[i2 - 1].end, property.end]);
      else ranges.push([property.start, property.end]);
    });
  }
  ranges.sort((a2, b2) => a2[0] - b2[0]);
  const merged = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
var PARAMETER_PROPERTY = /\bconstructor\s*\([^]*?\b(public|private|protected|readonly|override)\s+[A-Za-z_$]/;
var classesOf = (program) => [...nodes(program)].filter((node) => node.type === "ClassDeclaration" || node.type === "ClassExpression");
function parameterPropertiesOf(program) {
  const classes = classesOf(program).map((node) => {
    const constructor = list(child(node, "body"), "body").find((member) => member.type === "MethodDefinition" && member.kind === "constructor");
    const written = new Set(list(child(node, "body"), "body").filter((member) => member.type === "PropertyDefinition" && member.declare !== true && member.static !== true).map((member) => stringOf(child(member, "key"), "name")));
    const properties = list(child(constructor ?? null, "value"), "params").filter((param) => param.type === "TSParameterProperty").map((param) => {
      const parameter = child(param, "parameter");
      return stringOf(parameter?.type === "AssignmentPattern" ? child(parameter, "left") : parameter, "name");
    }).filter((name50) => name50 !== null && !written.has(name50));
    return { name: stringOf(child(node, "id"), "name"), properties };
  });
  return classes.some((c3) => c3.properties.length) ? classes : null;
}
function parameterPropertyDeclarations(output, classes) {
  const compiled = classesOf(output);
  if (compiled.length !== classes.length) return [];
  const ranges = [];
  for (let i2 = 0; i2 < compiled.length; i2++) {
    const name50 = stringOf(child(compiled[i2], "id"), "name");
    if (name50 !== null && classes[i2].name !== null && name50 !== classes[i2].name) return [];
    for (const member of list(child(compiled[i2], "body"), "body")) {
      const key = stringOf(child(member, "key"), "name");
      if (member.type === "PropertyDefinition" && member.value === null && member.static !== true && member.computed !== true && key !== null && classes[i2].properties.includes(key)) {
        ranges.push([member.start, member.end]);
      }
    }
  }
  return ranges;
}
var BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function decodeMappings(mappings) {
  const state = [0, 0, 0, 0];
  return mappings.split(";").map((line) => {
    let column = 0;
    return line.split(",").filter(Boolean).map((segment) => {
      const fields = [];
      let value = 0;
      let shift = 0;
      for (const char of segment) {
        const digit = BASE64.indexOf(char);
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
        } else {
          fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      column += fields[0];
      const out = [column];
      for (let i2 = 1; i2 < fields.length; i2++) out.push(state[i2 - 1] += fields[i2]);
      return out;
    });
  });
}
function encodeMappings(lines) {
  const state = [0, 0, 0, 0];
  const vlq = (n5) => {
    let value = n5 < 0 ? -n5 << 1 | 1 : n5 << 1;
    let out = "";
    do {
      let digit = value & 31;
      value >>>= 5;
      if (value) digit |= 32;
      out += BASE64[digit];
    } while (value);
    return out;
  };
  return lines.map((segments) => {
    let column = 0;
    return segments.map((segment) => {
      let out = vlq(segment[0] - column);
      column = segment[0];
      for (let i2 = 1; i2 < segment.length; i2++) {
        out += vlq(segment[i2] - state[i2 - 1]);
        state[i2 - 1] = segment[i2];
      }
      return out;
    }).join(",");
  }).join(";");
}
function decorateKind(statement, decorate) {
  const isDecorate = (node) => node?.type === "CallExpression" && stringOf(child(node, "callee"), "name") === decorate;
  if (statement.type !== "ExpressionStatement") return null;
  const expression = child(statement, "expression");
  if (expression && isDecorate(expression)) {
    const target = list(expression, "arguments")[1];
    if (target?.type === "Identifier") {
      const name50 = stringOf(target, "name");
      return name50 === null ? null : [1, name50];
    }
    const object2 = child(target ?? null, "object");
    if (target?.type === "MemberExpression" && target.computed !== true && stringOf(child(target, "property"), "name") === "prototype" && object2?.type === "Identifier") {
      const name50 = stringOf(object2, "name");
      return name50 === null ? null : [0, name50];
    }
    return null;
  }
  const left = child(expression, "left");
  if (expression?.type === "AssignmentExpression" && left?.type === "Identifier" && isDecorate(child(expression, "right"))) {
    const name50 = stringOf(left, "name");
    return name50 === null ? null : [2, name50];
  }
  return null;
}
function decorateInTscOrder(program, code3, map, written) {
  let decorate = null;
  for (const node of list(program, "body")) {
    if (node.type !== "ImportDeclaration" || stringOf(child(node, "source"), "value") !== "@oxc-project/runtime/helpers/decorate") continue;
    const specifier = list(node, "specifiers")[0];
    const local = specifier?.type === "ImportDefaultSpecifier" ? stringOf(child(specifier, "local"), "name") : null;
    if (local !== null && !written.has(local)) decorate = local;
  }
  if (decorate === null) return { code: code3, map };
  const lineStarts = [0];
  for (let i2 = 0; i2 < code3.length; i2++) if (code3[i2] === "\n") lineStarts.push(i2 + 1);
  const lineOf = (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = low + high + 1 >> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  const lineEnd = (line) => line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : code3.length;
  const moves = [];
  const runs = (statements) => {
    for (let i2 = 0; i2 < statements.length; ) {
      const head = decorateKind(statements[i2], decorate);
      if (!head) {
        i2++;
        continue;
      }
      const run = [];
      let kind = head;
      while (kind && kind[1] === head[1]) {
        run.push({ statement: statements[i2], rank: kind[0], first: lineOf(statements[i2].start), last: lineOf(statements[i2].end - 1) });
        i2++;
        kind = i2 < statements.length ? decorateKind(statements[i2], decorate) : null;
      }
      const alone = run.every(({ statement, first, last }, k2) => code3.slice(lineStarts[first], statement.start).trim() === "" && code3.slice(statement.end, lineEnd(last)).trim() === "" && (k2 === 0 || run[k2 - 1].last + 1 === first));
      const sorted = [...run].sort((a2, b2) => a2.rank - b2.rank);
      if (!alone || sorted.every((entry, k2) => entry === run[k2])) continue;
      moves.push({ first: run[0].first, last: run[run.length - 1].last, order: sorted.map(({ first, last }) => [first, last]) });
    }
  };
  for (const node of nodes(program)) {
    if (node.type === "Program" || node.type === "BlockStatement" || node.type === "StaticBlock") runs(list(node, "body"));
    if (node.type === "SwitchCase") runs(list(node, "consequent"));
  }
  if (!moves.length) return { code: code3, map };
  const lines = code3.split("\n");
  const mappingsText = typeof map === "object" && map !== null && "mappings" in map && typeof map.mappings === "string" ? map.mappings : null;
  const mappings = mappingsText === null ? null : decodeMappings(mappingsText);
  while (mappings && mappings.length < lines.length) mappings.push([]);
  moves.sort((a2, b2) => a2.last - a2.first - (b2.last - b2.first));
  for (const { first, last, order } of moves) {
    lines.splice(first, last - first + 1, ...order.flatMap(([from, to]) => lines.slice(from, to + 1)));
    if (mappings) mappings.splice(first, last - first + 1, ...order.flatMap(([from, to]) => mappings.slice(from, to + 1)));
  }
  return { code: lines.join("\n"), map: mappings ? Object.assign({}, map, { mappings: encodeMappings(mappings) }) : map };
}
var LOWERING_GLOBALS = ["WeakMap", "WeakSet"];
var TYPE_KEYS = /* @__PURE__ */ new Set(["typeAnnotation", "typeParameters", "returnType", "typeArguments", "superTypeArguments", "implements", "parent"]);
var TYPE_LEVEL = /* @__PURE__ */ new Set(["TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSDeclareFunction", "TSEmptyBodyFunctionExpression", "TSIndexSignature"]);
function* boundNames(value) {
  if (Array.isArray(value)) {
    for (const item of value) yield* boundNames(item);
    return;
  }
  if (!isNode(value) || value.declare === true || value.importKind === "type" || TYPE_LEVEL.has(value.type)) return;
  switch (value.type) {
    case "VariableDeclarator":
      yield* patternNames(child(value, "id"));
      break;
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      yield* patternNames(child(value, "id"));
      for (const parameter of list(value, "params")) yield* patternNames(parameter);
      break;
    case "ClassDeclaration":
    case "ClassExpression":
    case "TSEnumDeclaration":
    case "TSModuleDeclaration":
    case "TSImportEqualsDeclaration":
      yield* patternNames(child(value, "id"));
      break;
    case "CatchClause":
      yield* patternNames(child(value, "param"));
      break;
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
      yield* patternNames(child(value, "local"));
      break;
  }
  for (const [key, item] of Object.entries(value)) if (!TYPE_KEYS.has(key)) yield* boundNames(item);
}
function loweringStore(node, sourceNames, outputNames) {
  const [store, value] = node.type === "VariableDeclarator" ? [child(node, "id"), child(node, "init")] : node.type === "AssignmentExpression" && node.operator === "=" ? [child(node, "left"), child(node, "right")] : [null, null];
  const callee = child(value, "callee");
  const global2 = callee?.type === "Identifier" ? stringOf(callee, "name") : null;
  const name50 = store?.type === "Identifier" ? stringOf(store, "name") : null;
  if (value?.type !== "NewExpression" || list(value, "arguments").length !== 0 || global2 === null || !LOWERING_GLOBALS.includes(global2)) return null;
  return name50 !== null && !sourceNames.has(name50) && outputNames.has(name50) ? global2 : null;
}
function shadowedLowering(module, source, output) {
  const sourceNames = new Set(boundNames(source));
  if (!LOWERING_GLOBALS.some((name50) => sourceNames.has(name50))) return;
  const outputNames = new Set(boundNames(output));
  const made = /* @__PURE__ */ new Map();
  for (const [node, scope] of scoped(output, { names: /* @__PURE__ */ new Set(), parent: null }, isSloppy(output))) {
    const name50 = loweringStore(node, sourceNames, outputNames);
    if (name50 === null) continue;
    made.set(name50, (made.get(name50) ?? 0) + 1);
    if (bindingScope(scope, name50) !== null) {
      throw new Error(`Nimbus's bundler does not support a TypeScript module that declares its own ${name50} where a class with private members sees it and useDefineForClassFields is false (${module.path}): lowering them reads the global ${name50}, which the module's binding shadows there`);
    }
  }
  const created = (program, name50) => [...nodes(program)].filter((node) => node.type === "NewExpression" && stringOf(child(node, "callee"), "name") === name50).length;
  for (const name50 of LOWERING_GLOBALS) {
    if (created(output, name50) - created(source, name50) > (made.get(name50) ?? 0)) {
      throw new Error(`Nimbus's bundler cannot tell the ${name50} the lowering of private members creates from the module's own (${module.path}), which declares its own ${name50}, with useDefineForClassFields false`);
    }
  }
}

// ../core/src/runtime/rolldown-build.ts
var SUPPORTED = /* @__PURE__ */ new Set([
  "entryPoints",
  "bundle",
  "format",
  "target",
  "platform",
  "outdir",
  "outfile",
  "sourcemap",
  "minify",
  "external",
  "define",
  "globalName",
  "tsconfigRaw",
  "alias",
  "keepNames",
  "entryNames",
  "chunkNames",
  "assetNames",
  "metafile",
  "conditions",
  "mainFields",
  "logLevel",
  "jsx",
  "jsxFactory",
  "jsxFragment",
  "jsxImportSource",
  "jsxDev"
]);
var LOADER_MODULE_TYPES = {
  js: "js",
  jsx: "jsx",
  ts: "ts",
  tsx: "tsx",
  json: "json",
  text: "text",
  empty: "empty"
};
var MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".xhtml": "application/xhtml+xml; charset=utf-8",
  ".xml": "text/xml; charset=utf-8",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".eot": "application/vnd.ms-fontobject",
  ".otf": "font/otf",
  ".sfnt": "font/sfnt",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json"
};
var bytesOfText = (text) => Uint8Array.from(text, (c3) => c3.charCodeAt(0));
var exactSig = (sig, ct) => {
  const pat = bytesOfText(sig);
  return (data) => data.length >= pat.length && pat.every((b2, i2) => data[i2] === b2) ? ct : "";
};
var maskedSig = (mask, pat, ct, skipWS = false) => {
  const m2 = bytesOfText(mask);
  const p = bytesOfText(pat);
  return (data, firstNonWS) => {
    const d2 = skipWS ? data.subarray(firstNonWS) : data;
    return d2.length >= p.length && p.every((b2, i2) => (d2[i2] & m2[i2]) === b2) ? ct : "";
  };
};
var htmlSig = (sig) => (data, firstNonWS) => {
  const d2 = data.subarray(firstNonWS);
  if (d2.length < sig.length + 1) return "";
  for (let i2 = 0; i2 < sig.length; i2++) {
    const b2 = sig.charCodeAt(i2);
    const db = b2 >= 65 && b2 <= 90 ? d2[i2] & 223 : d2[i2];
    if (b2 !== db) return "";
  }
  return d2[sig.length] === 32 || d2[sig.length] === 62 ? "text/html; charset=utf-8" : "";
};
var mp4Sig = (data) => {
  if (data.length < 12) return "";
  const boxSize = (data[0] << 24 | data[1] << 16 | data[2] << 8 | data[3]) >>> 0;
  if (data.length < boxSize || boxSize % 4 !== 0) return "";
  if (String.fromCharCode(...data.subarray(4, 8)) !== "ftyp") return "";
  for (let st = 8; st < boxSize; st += 4) {
    if (st === 12) continue;
    if (String.fromCharCode(...data.subarray(st, st + 3)) === "mp4") return "video/mp4";
  }
  return "";
};
var textSig = (data, firstNonWS) => {
  for (const b2 of data.subarray(firstNonWS)) {
    if (b2 <= 8 || b2 === 11 || b2 >= 14 && b2 <= 26 || b2 >= 28 && b2 <= 31) return "";
  }
  return "text/plain; charset=utf-8";
};
var SNIFF_SIGNATURES = [
  ...["<!DOCTYPE HTML", "<HTML", "<HEAD", "<SCRIPT", "<IFRAME", "<H1", "<DIV", "<FONT", "<TABLE", "<A", "<STYLE", "<TITLE", "<B", "<BODY", "<BR", "<P", "<!--"].map(htmlSig),
  maskedSig("\xFF\xFF\xFF\xFF\xFF", "<?xml", "text/xml; charset=utf-8", true),
  exactSig("%PDF-", "application/pdf"),
  exactSig("%!PS-Adobe-", "application/postscript"),
  maskedSig("\xFF\xFF\0\0", "\xFE\xFF\0\0", "text/plain; charset=utf-16be"),
  maskedSig("\xFF\xFF\0\0", "\xFF\xFE\0\0", "text/plain; charset=utf-16le"),
  maskedSig("\xFF\xFF\xFF\0", "\xEF\xBB\xBF\0", "text/plain; charset=utf-8"),
  exactSig("\0\0\0", "image/x-icon"),
  exactSig("\0\0\0", "image/x-icon"),
  exactSig("BM", "image/bmp"),
  exactSig("GIF87a", "image/gif"),
  exactSig("GIF89a", "image/gif"),
  maskedSig("\xFF\xFF\xFF\xFF\0\0\0\0\xFF\xFF\xFF\xFF\xFF\xFF", "RIFF\0\0\0\0WEBPVP", "image/webp"),
  exactSig("\x89PNG\r\n\n", "image/png"),
  exactSig("\xFF\xD8\xFF", "image/jpeg"),
  maskedSig("\xFF\xFF\xFF\xFF\0\0\0\0\xFF\xFF\xFF\xFF", "FORM\0\0\0\0AIFF", "audio/aiff"),
  maskedSig("\xFF\xFF\xFF", "ID3", "audio/mpeg"),
  maskedSig("\xFF\xFF\xFF\xFF\xFF", "OggS\0", "application/ogg"),
  maskedSig("\xFF\xFF\xFF\xFF\xFF\xFF\xFF\xFF", "MThd\0\0\0", "audio/midi"),
  maskedSig("\xFF\xFF\xFF\xFF\0\0\0\0\xFF\xFF\xFF\xFF", "RIFF\0\0\0\0AVI ", "video/avi"),
  maskedSig("\xFF\xFF\xFF\xFF\0\0\0\0\xFF\xFF\xFF\xFF", "RIFF\0\0\0\0WAVE", "audio/wave"),
  mp4Sig,
  exactSig("E\xDF\xA3", "video/webm"),
  maskedSig("\0".repeat(34) + "\xFF\xFF", "\0".repeat(34) + "LP", "application/vnd.ms-fontobject"),
  exactSig("\0\0\0", "font/ttf"),
  exactSig("OTTO", "font/otf"),
  exactSig("ttcf", "font/collection"),
  exactSig("wOFF", "font/woff"),
  exactSig("wOF2", "font/woff2"),
  exactSig("\x8B\b", "application/x-gzip"),
  exactSig("PK", "application/zip"),
  exactSig("Rar!\x07\0", "application/x-rar-compressed"),
  exactSig("Rar!\x07\0", "application/x-rar-compressed"),
  exactSig("\0asm", "application/wasm"),
  textSig
];
function detectContentType(bytes) {
  const data = bytes.subarray(0, 512);
  let firstNonWS = 0;
  while (firstNonWS < data.length && [9, 10, 12, 13, 32].includes(data[firstNonWS])) firstNonWS++;
  for (const sig of SNIFF_SIGNATURES) {
    const ct = sig(data, firstNonWS);
    if (ct) return ct;
  }
  return "application/octet-stream";
}
function guessMimeType(ext, bytes) {
  return (MIME_TYPES[ext] ?? MIME_TYPES[ext.toLowerCase()] ?? detectContentType(bytes)).replaceAll("; ", ";");
}
function extensionOf(path3) {
  const bare2 = path3.replace(/[?#].*$/, "");
  const base = bare2.slice(bare2.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}
function base64Of(bytes) {
  let latin1 = "";
  for (let i2 = 0; i2 < bytes.length; i2 += 32768) latin1 += String.fromCharCode(...bytes.subarray(i2, i2 + 32768));
  return btoa(latin1);
}
function dataUrlOf(path3, bytes) {
  const mime = guessMimeType(extensionOf(path3), bytes);
  const encoded = `data:${mime};base64,${base64Of(bytes)}`;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return encoded;
  }
  const escaped = percentEscapedDataUrl(mime, text);
  return escaped.length < encoded.length ? escaped : encoded;
}
async function contentHash(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest) {
    value = value << 8 | byte;
    bits += 8;
    while (bits >= 5 && out.length < 8) {
      out += alphabet[value >>> bits - 5 & 31];
      bits -= 5;
    }
    if (out.length >= 8) break;
  }
  return out;
}
function fill(template, { name: name50, hash, ext }) {
  return template.replace(/\[name\]/g, name50).replace(/\[hash\]/g, hash).replace(/\[ext\]/g, ext);
}
function sameBytes(a2, b2) {
  return a2.length === b2.length && a2.every((byte, i2) => byte === b2[i2]);
}
function relativeUrl(from, to) {
  const fromParts = from.split("/").slice(0, -1);
  const toParts = to.split("/");
  let common = 0;
  while (common < fromParts.length && common < toParts.length - 1 && fromParts[common] === toParts[common]) common++;
  const up = fromParts.length - common;
  return (up === 0 ? "./" : "../".repeat(up)) + toParts.slice(common).join("/");
}
function stringLiteralAt(source, start) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let value = "";
  for (let i2 = start + 1; i2 < source.length; i2++) {
    const c3 = source[i2];
    if (c3 === quote) return { end: i2 + 1, value };
    if (quote === "`" && c3 === "$" && source[i2 + 1] === "{") return null;
    if (c3 !== "\\") {
      value += c3;
      continue;
    }
    const e3 = source[++i2];
    const hex = (from, to) => String.fromCodePoint(parseInt(source.slice(from, to), 16));
    if (e3 === "u" && source[i2 + 1] === "{") {
      const close = source.indexOf("}", i2);
      value += hex(i2 + 2, close);
      i2 = close;
    } else if (e3 === "u") {
      value += hex(i2 + 1, i2 + 5);
      i2 += 4;
    } else if (e3 === "x") {
      value += hex(i2 + 1, i2 + 3);
      i2 += 2;
    } else if (e3 === "\r") {
      if (source[i2 + 1] === "\n") i2++;
    } else if (e3 !== "\n" && e3 !== "\u2028" && e3 !== "\u2029") {
      value += { n: "\n", r: "\r", t: "	", b: "\b", f: "\f", v: "\v", 0: "\0" }[e3] ?? e3;
    }
  }
  return null;
}
var PLACEMENT_IMPORTER_BYTES = 256 * 1024;
var PLACEMENT_BUILD_BYTES = 1024 * 1024;
var isBare = (specifier) => !/^(\.{1,2}(\/|$)|\/)/.test(specifier);
async function locateUnresolved(api, options, records, loaded) {
  const byImporter = /* @__PURE__ */ new Map();
  for (const record2 of records) if (record2.importer) byImporter.set(record2.importer, [...byImporter.get(record2.importer) ?? [], record2]);
  const placed = /* @__PURE__ */ new Map();
  let spent = 0;
  for (const [importer, mine] of byImporter) {
    const module = loaded.get(importer);
    if (!module) continue;
    const fileOnly = { file: fileOf2(module), namespace: "", line: 0, column: 0, length: 0, lineText: "", suggestion: "" };
    const bytes = utf8Length2(module.source);
    if (!module.lang || bytes > PLACEMENT_IMPORTER_BYTES || spent + bytes > PLACEMENT_BUILD_BYTES) {
      for (const r3 of mine) placed.set(r3, fileOnly);
      continue;
    }
    spent += bytes;
    const groups = /* @__PURE__ */ new Map();
    for (const r3 of mine) {
      const group = `${r3.kind}\0${isBare(r3.source)}`;
      groups.set(group, [...groups.get(group) ?? [], r3]);
    }
    const lineStarts = [0];
    for (const m2 of module.source.matchAll(/\r\n|\r|\n/g)) lineStarts.push(m2.index + m2[0].length);
    const first = /* @__PURE__ */ new Map();
    for (const group of groups.values()) {
      const kind = group[0].kind;
      const wanted = new Set(group.map((r3) => r3.source));
      const places = [];
      const record2 = (log) => {
        if (log.code === "UNRESOLVED_IMPORT" && log.loc) places.push(log.loc);
      };
      try {
        const bundle = await api.rolldown({
          ...inputOptionsOf(options),
          input: "nimbus-locate",
          logLevel: "warn",
          onLog: (_level, log) => record2(log),
          plugins: [{
            name: "nimbus-locate",
            resolveId(source, from, extra) {
              if (!from) return "nimbus-locate";
              return (extra.kind ?? "import-statement") === kind && wanted.has(source) ? null : { id: source, external: true };
            },
            load(id2) {
              return id2 === "nimbus-locate" ? { code: module.source, moduleType: module.lang } : null;
            }
          }]
        });
        try {
          await bundle.generate({ format: "es" });
        } finally {
          await bundle.close();
        }
      } catch (error2) {
        for (const log of Reflect.get(Object(error2), "errors") ?? []) record2(log);
      }
      for (const { line, column } of places) {
        const start = (lineStarts[line - 1] ?? 0) + column;
        const literal2 = stringLiteralAt(module.source, start);
        if (!literal2) continue;
        const key = `${kind}\0${literal2.value}`;
        const known = first.get(key);
        if (!known || start < known.start) first.set(key, { start, end: literal2.end });
      }
    }
    for (const r3 of mine) {
      const span = first.get(`${r3.kind}\0${r3.source}`);
      if (!span) {
        placed.set(r3, fileOnly);
        continue;
      }
      const before = module.source.slice(0, span.start);
      const line = before.split(/\r\n|\r|\n/).length;
      const lineStart = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r")) + 1;
      placed.set(r3, locate2(fileOf2(module), module.source, line, utf8Length2(before.slice(lineStart)), utf8Length2(module.source.slice(span.start, span.end))));
    }
  }
  return records.map((r3) => message(r3.text, placed.get(r3) ?? null, r3.pluginName));
}
var utf8Length2 = (text) => new TextEncoder().encode(text).length;
var BuildError = class extends Error {
  constructor(messages) {
    super(messages.map((m2) => m2.text).join("\n"));
    this.messages = messages;
  }
  messages;
};
function message(text, location = null, pluginName = "") {
  return { id: "", pluginName, text, location, notes: [], detail: void 0 };
}
function locate2(file, source, line, column, length = 0) {
  const lines = source.split(/\r\n|\r|\n/);
  const lineText = lines[line - 1] ?? "";
  return { file, namespace: "", line, column, length, lineText, suggestion: "" };
}
function esbuildFailureText(errors) {
  const lines = errors.map((e3) => {
    const text = e3.pluginName ? `[plugin: ${e3.pluginName}] ${e3.text}` : e3.text;
    if (!e3.location) return `error: ${text}`;
    return e3.location.line > 0 ? `${e3.location.file}:${e3.location.line}:${e3.location.column}: ERROR: ${text}` : `${e3.location.file}: ERROR: ${text}`;
  });
  return `Build failed with ${errors.length} error${errors.length === 1 ? "" : "s"}:
${lines.join("\n")}`;
}
function refuse(text) {
  throw new BuildError([message(text)]);
}
var UnresolvedImports = class extends Error {
};
function inputOptionsOf(options, settings = resolveTsSettings(options, "build")) {
  return {
    cwd: "/",
    platform: options.platform ?? "browser",
    tsconfig: false,
    transform: {
      target: typeof options.target === "string" ? options.target : "esnext",
      define: options.define,
      ...jsxAndTypescriptOf(settings)
    },
    checks: { pluginTimings: false },
    // esbuild keeps an imported constant a reference: inlining its value
    // changes what a cycle sees before the constant's module has run.
    optimization: { inlineConst: false }
  };
}
async function buildWithRolldown(api, options, plugin) {
  const state = { raised: [], unresolved: [], loaded: /* @__PURE__ */ new Map() };
  try {
    return await build(api, options, plugin, state);
  } catch (error2) {
    const errors = error2 instanceof BuildError ? error2.messages : error2 instanceof UnresolvedImports ? sortedMessages(await locateUnresolved(api, options, state.unresolved, state.loaded)) : sortedMessages([...await locateUnresolved(api, options, state.unresolved, state.loaded), ...messagesOf(error2, state.raised, state.loaded)]);
    return { outputFiles: [], errors, warnings: [], failure: esbuildFailureText(errors) };
  }
}
function sortedMessages(messages) {
  const key = (m2) => m2.location;
  return messages.map((m2, i2) => [m2, i2]).sort(([a2, i2], [b2, j]) => {
    const la = key(a2);
    const lb = key(b2);
    if (!la || !lb) return la ? 1 : lb ? -1 : i2 - j;
    if (la.file !== lb.file) return la.file < lb.file ? -1 : 1;
    return la.line - lb.line || la.column - lb.column || i2 - j;
  }).map(([m2]) => m2);
}
function messagesOf(error2, raised, loaded) {
  const logs = error2 instanceof Error ? Reflect.get(error2, "errors") : void 0;
  if (!Array.isArray(logs) || !logs.length) return [message(error2 instanceof Error ? error2.message : String(error2))];
  const unclaimed = [...raised];
  return logs.map((log) => {
    const i2 = unclaimed.findIndex((m2) => log.message.includes(m2.text));
    return i2 >= 0 ? unclaimed.splice(i2, 1)[0] : fromLog(log, loaded);
  });
}
function fromLog(log, modules) {
  const plain = log.message.replace(/\u001b\[[0-9;]*m/g, "");
  const firstLine = plain.split("\n")[0].replace(/^\[[A-Z_]+\]\s*/, "").replace(/^(Error|Warning):\s*/, "");
  const loaded = log.id ? modules.get(log.id) : void 0;
  const location = log.loc && loaded ? locate2(fileOf2(loaded), loaded.source, log.loc.line, log.loc.column) : null;
  const result = message(firstLine, location, log.plugin ?? "");
  if (loaded) {
    let sourceLine = 0;
    let gutter = 0;
    for (const line of plain.split("\n")) {
      const source = /^\s*(\d+) │ /.exec(line);
      if (source) {
        sourceLine = Number(source[1]);
        gutter = source[0].length;
        continue;
      }
      const label = /[╰├]── (.*)$/.exec(line);
      if (!label || !sourceLine) continue;
      const column = line.search(/[╰├]/) - gutter;
      if (location && sourceLine === location.line && column === location.column) continue;
      result.notes.push({ text: label[1].trim(), location: locate2(fileOf2(loaded), loaded.source, sourceLine, column) });
    }
  }
  return result;
}
function fileOf2(module) {
  return module.namespace === "file" || module.namespace === "" ? module.path : `${module.namespace}:${module.path}`;
}
async function build(api, options, plugin, { raised, unresolved, loaded }) {
  for (const [key, value] of Object.entries(options)) {
    if (value !== void 0 && !SUPPORTED.has(key)) refuse(`Nimbus's bundler does not support the esbuild option "${key}"`);
  }
  if (options.bundle === false) refuse("Nimbus's bundler only bundles (bundle: false is not supported)");
  let settings;
  try {
    settings = resolveTsSettings(options, "build");
  } catch (error2) {
    refuse(error2 instanceof Error ? error2.message : String(error2));
  }
  const entryPoints = Array.isArray(options.entryPoints) ? options.entryPoints : null;
  if (!entryPoints || entryPoints.some((e3) => typeof e3 !== "string")) refuse("Nimbus's bundler takes entryPoints as a list of paths");
  if (options.outfile && entryPoints.length !== 1) refuse("outfile needs exactly one entry point");
  const format = options.format ?? "esm";
  if (format !== "esm" && format !== "cjs" && format !== "iife") refuse(`Nimbus's bundler does not support format "${format}"`);
  const target = typeof options.target === "string" ? options.target : "esnext";
  if (!/^(esnext|es20\d\d)$/.test(target)) refuse(`Nimbus's bundler does not support target "${String(options.target)}"`);
  const alias = Object.entries(options.alias ?? {});
  const aliased = (path3) => {
    for (const [from, to] of alias) {
      if (path3 === from) return to;
      if (path3.startsWith(from + "/")) return to + path3.slice(from.length);
    }
    return path3;
  };
  let mainNamespace = null;
  const idOf = (namespace, path3) => namespace === mainNamespace ? path3 : `\0${namespace}:${path3}`;
  const decode4 = (id2) => {
    const known = loaded.get(id2);
    if (known) return known;
    const m2 = /^\0([^:]*):([\s\S]*)$/.exec(id2);
    return m2 ? { namespace: m2[1], path: m2[2] } : { namespace: mainNamespace ?? "file", path: id2 };
  };
  const pending = /* @__PURE__ */ new Map();
  const inputBytes = /* @__PURE__ */ new Map();
  const importsOf2 = /* @__PURE__ */ new Map();
  const graph = /* @__PURE__ */ new Map();
  const importedBy = (importer, id2, record2) => {
    if (importer === void 0) return;
    const list2 = importsOf2.get(importer) ?? [];
    list2.push({ id: id2, record: record2 });
    importsOf2.set(importer, list2);
  };
  const importsInOrder = (importer) => {
    const info = graph.get(importer);
    const order = info ? [...info.importedIds, ...info.dynamicallyImportedIds] : [];
    const at = (id2) => {
      const i2 = order.indexOf(id2);
      return i2 < 0 ? order.length : i2;
    };
    return (importsOf2.get(importer) ?? []).map((entry, i2) => ({ ...entry, i: i2 })).sort((a2, b2) => at(a2.id) - at(b2.id) || a2.record.kind.localeCompare(b2.record.kind) || a2.i - b2.i).map((entry) => entry.record);
  };
  const css = /* @__PURE__ */ new Map();
  const warnings = settings.warnings.map((text) => message(text));
  const template = (names, fallback) => (names ?? fallback).replace(/\[ext\]/g, "[extname]");
  const assetFiles = /* @__PURE__ */ new Map();
  const assetNames = /* @__PURE__ */ new Map();
  const collisions = /* @__PURE__ */ new Set();
  const emitAsset = (module, bytes) => {
    const key = fileOf2(module);
    if (!assetNames.has(key)) {
      assetNames.set(key, (async () => {
        const base = module.path.slice(module.path.lastIndexOf("/") + 1);
        const ext = extensionOf(base);
        const name50 = ext ? base.slice(0, -ext.length) : base;
        const fileName = fill(options.assetNames ?? "[name]-[hash]", { name: name50, hash: await contentHash(bytes), ext: ext.slice(1) }) + ext;
        const known = assetFiles.get(fileName);
        if (known && !sameBytes(known, bytes)) collisions.add(fileName);
        else assetFiles.set(fileName, bytes);
        return fileName;
      })());
    }
    return assetNames.get(key);
  };
  const entryDir = (() => {
    if (options.outfile) return "";
    const names = options.entryNames ?? "[name]";
    const dir = names.slice(0, names.lastIndexOf("/") + 1);
    return dir.includes("[") ? null : dir;
  })();
  const raise = (text, pluginName = "", location = null) => {
    raised.push(message(text, location, pluginName));
    throw new Error(text);
  };
  const unresolvedImport = (text, importer, source, kind, pluginName) => {
    unresolved.push({ importer, source, kind, text, pluginName });
    return { id: source, external: true };
  };
  const vfs = {
    name: plugin.name,
    moduleParsed(info) {
      graph.set(info.id, { importedIds: [...info.importedIds], dynamicallyImportedIds: [...info.dynamicallyImportedIds] });
    },
    async resolveId(source, importer, extra) {
      if (source.startsWith("\0")) return null;
      const from = importer ? decode4(importer) : null;
      const kind = extra.isEntry && !importer ? "entry-point" : extra.kind ?? "import-statement";
      const path3 = kind === "entry-point" ? source : aliased(source);
      const answer = await plugin.resolve({
        path: path3,
        importer: from ? from.path : "",
        namespace: from ? from.namespace : "file",
        resolveDir: from ? loaded.get(importer)?.resolveDir ?? "" : "",
        kind,
        with: extra.attributes ?? {}
      });
      if (answer?.errors?.length) return unresolvedImport(answer.errors[0].text ?? "error", importer, source, kind, plugin.name);
      if (answer?.warnings?.length) for (const w2 of answer.warnings) warnings.push(message(w2.text ?? ""));
      if (!answer || !answer.path && !answer.external) return unresolvedImport(`Could not resolve ${JSON.stringify(source)}`, importer, source, kind, "");
      if (answer.external) {
        importedBy(importer, answer.path ?? path3, { path: answer.path ?? path3, kind, external: true });
        return { id: answer.path ?? path3, external: true };
      }
      const namespace = answer.namespace ?? "file";
      if (mainNamespace === null) mainNamespace = namespace;
      const id2 = idOf(namespace, answer.path);
      pending.set(id2, { namespace, path: answer.path });
      importedBy(importer, id2, {
        path: fileOf2({ namespace, path: answer.path }),
        kind,
        // esbuild records what the importer wrote for every internal import,
        // a path spelled as it resolves included.
        original: source
      });
      return id2;
    },
    async load(id2) {
      const { namespace, path: path3 } = pending.get(id2) ?? decode4(id2);
      const answer = await plugin.load({ path: path3, namespace, suffix: "", with: {} });
      if (answer?.errors?.length) raise(answer.errors[0].text ?? "error", plugin.name);
      if (answer?.warnings?.length) for (const w2 of answer.warnings) warnings.push(message(w2.text ?? ""));
      if (!answer || answer.contents === void 0) raise(`No loader produced ${fileOf2({ namespace, path: path3 })}`);
      const loader = answer.loader ?? "js";
      const contents = answer.contents;
      inputBytes.set(id2, typeof contents === "string" ? new TextEncoder().encode(contents).length : contents.length);
      const text = typeof contents === "string" ? contents : loader === "binary" || loader === "base64" || loader === "dataurl" || loader === "file" ? "" : new TextDecoder().decode(contents);
      const lastSlash = path3.lastIndexOf("/");
      loaded.set(id2, {
        namespace,
        path: path3,
        resolveDir: answer.resolveDir ?? (namespace === "file" || namespace === mainNamespace ? lastSlash > 0 ? path3.slice(0, lastSlash) : "/" : ""),
        source: text,
        lang: loader === "js" || loader === "jsx" || loader === "ts" || loader === "tsx" ? loader : void 0
      });
      if (loader === "css") {
        if (!options.outdir && !options.outfile) raise(`Cannot import ${JSON.stringify(fileOf2({ namespace, path: path3 }))} into a JavaScript file without an output path configured`);
        css.set(id2, { namespace, path: path3, resolveDir: loaded.get(id2).resolveDir, source: text });
        return { code: "", moduleType: "js", moduleSideEffects: true };
      }
      const bytesOf = () => typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
      const value = (string2) => ({ code: JSON.stringify(string2), moduleType: "json" });
      if (loader === "file") {
        if (entryDir === null) raise(`Nimbus's bundler does not support a placeholder in the directory of entryNames with the "file" loader (${fileOf2({ namespace, path: path3 })})`);
        return value(relativeUrl(`${entryDir}entry.js`, await emitAsset({ namespace, path: path3 }, bytesOf())));
      }
      if (loader === "dataurl") return value(dataUrlOf(path3, bytesOf()));
      if (loader === "base64") return value(base64Of(bytesOf()));
      if (loader === "binary") {
        return { code: `module.exports = Uint8Array.from(atob(${JSON.stringify(base64Of(bytesOf()))}), (c) => c.charCodeAt(0));`, moduleType: "js" };
      }
      let compiled = null;
      try {
        compiled = compileForBuild(api, settings, { path: path3, text, loader, sourcemap: options.sourcemap !== void 0 && options.sourcemap !== false });
      } catch (error2) {
        raise(error2 instanceof Error ? error2.message : String(error2));
      }
      if (compiled) return { code: compiled.code, map: compiled.map, moduleType: compiled.moduleType };
      const moduleType2 = LOADER_MODULE_TYPES[loader];
      if (!moduleType2) raise(`Nimbus's bundler does not support the "${loader}" loader (${fileOf2({ namespace, path: path3 })})`);
      return { code: text, moduleType: moduleType2 };
    }
  };
  const bundle = await api.rolldown({
    ...inputOptionsOf(options, settings),
    input: entryPoints,
    plugins: [vfs],
    onLog(level, log) {
      if (level === "warn") warnings.push(fromLog(log, loaded));
    }
  });
  try {
    const { output } = await bundle.generate({
      format: format === "esm" ? "es" : format,
      name: options.globalName,
      minify: options.minify === true,
      keepNames: options.keepNames === true,
      // tsconfig's alwaysStrict (else strict): "use strict" first in CommonJS and IIFE output, as esbuild puts it.
      ...settings.alwaysStrict ? { strict: true } : {},
      sourcemap: options.sourcemap === true || options.sourcemap === "external" ? true : options.sourcemap === "inline" ? "inline" : false,
      entryFileNames: options.outfile ? options.outfile.slice(options.outfile.lastIndexOf("/") + 1) : `${template(options.entryNames, "[name]")}.js`,
      chunkFileNames: `${template(options.chunkNames, "[name]-[hash]")}.js`,
      assetFileNames: `${template(options.assetNames, "[name]-[hash]")}[extname]`,
      codeSplitting: false
    });
    if (unresolved.length) throw new UnresolvedImports();
    const cssOrder = /* @__PURE__ */ new Map();
    for (const out of output) {
      if (out.type !== "chunk" || !out.facadeModuleId) continue;
      const order = [];
      const seen = /* @__PURE__ */ new Set();
      const visit = (id2) => {
        if (seen.has(id2)) return;
        seen.add(id2);
        const info = graph.get(id2);
        for (const child2 of info?.importedIds ?? []) visit(child2);
        if (css.has(id2)) order.push(id2);
        for (const child2 of info?.dynamicallyImportedIds ?? []) visit(child2);
      };
      visit(out.facadeModuleId);
      cssOrder.set(out.fileName, order);
    }
    const outdir = options.outfile ? options.outfile.slice(0, options.outfile.lastIndexOf("/")) || "/" : options.outdir ?? "/dist";
    const at = (fileName) => `${outdir.replace(/\/+$/, "")}/${fileName}`;
    const encoder = new TextEncoder();
    const outputFiles = [];
    const outputs = {};
    const relative = (path3) => path3.replace(/^\/+/, "");
    for (const out of output) {
      if (out.type === "chunk") {
        const contents = encoder.encode(out.code);
        const path3 = at(out.fileName);
        outputFiles.push({ path: path3, contents });
        const entry = out.isEntry && out.facadeModuleId ? decode4(out.facadeModuleId) : null;
        const cssOfChunk = (cssOrder.get(out.fileName) ?? []).map((id2) => css.get(id2));
        let cssBundle;
        if (cssOfChunk.length) {
          const cssDir = out.fileName.slice(0, out.fileName.lastIndexOf("/") + 1);
          const sheetAssets = {
            emit: async (module, bytes) => relativeUrl(`${cssDir}sheet.css`, await emitAsset(module, bytes)),
            dataUrl: dataUrlOf
          };
          let bundled;
          try {
            const sheet = await bundleCss(cssOfChunk, plugin, sheetAssets, { minify: options.minify === true });
            warnings.push(...sheet.warnings);
            bundled = encoder.encode(sheet.css);
          } catch (error2) {
            if (error2 instanceof CssError) throw new BuildError([error2.diagnostic]);
            throw error2;
          }
          const cssFileName = options.outfile ? out.fileName.replace(/\.js$/, "") + ".css" : fill(options.entryNames ?? "[name]", { name: out.name, hash: await contentHash(bundled), ext: "css" }) + ".css";
          const cssPath = at(cssFileName);
          outputFiles.push({ path: cssPath, contents: bundled });
          outputs[relative(cssPath)] = { imports: [], exports: [], inputs: {}, bytes: bundled.length };
          cssBundle = relative(cssPath);
        }
        outputs[relative(path3)] = {
          imports: [],
          exports: out.exports,
          inputs: {},
          bytes: contents.length,
          ...entry ? { entryPoint: fileOf2(entry) } : {},
          ...cssBundle ? { cssBundle } : {}
        };
      } else {
        const contents = typeof out.source === "string" ? encoder.encode(out.source) : out.source;
        const path3 = at(out.fileName);
        outputFiles.push({ path: path3, contents });
        outputs[relative(path3)] = { imports: [], exports: [], inputs: {}, bytes: contents.length };
      }
    }
    if (collisions.size) {
      throw new BuildError([...collisions].map((fileName) => message(`Two output files share the same path but have different contents: ${at(fileName).replace(/^\/+/, "")}`)));
    }
    for (const [fileName, contents] of assetFiles) {
      const path3 = at(fileName);
      outputFiles.push({ path: path3, contents });
      outputs[relative(path3)] = { imports: [], exports: [], inputs: {}, bytes: contents.length };
    }
    const inputs = {};
    for (const [id2, bytes] of inputBytes) inputs[fileOf2(decode4(id2))] = { bytes, imports: importsInOrder(id2) };
    return { outputFiles, errors: [], warnings, metafile: { inputs, outputs } };
  } finally {
    await bundle.close();
  }
}

// ../core/src/_shared/exports-resolver.ts
var DEFAULT_ESM_CONDITIONS = ["import", "module", "browser", "default"];
function resolveExports(exportsField, subpath = ".", conditions = DEFAULT_ESM_CONDITIONS) {
  if (exportsField === void 0 || exportsField === null) return null;
  if (typeof exportsField === "string") {
    return subpath === "." ? exportsField : null;
  }
  if (Array.isArray(exportsField)) {
    for (const item of exportsField) {
      const r3 = resolveExports(item, subpath, conditions);
      if (r3) return r3;
    }
    return null;
  }
  if (typeof exportsField !== "object") return null;
  const keys = Object.keys(exportsField);
  if (keys.length === 0) return null;
  const isSubpathMap = keys[0].startsWith(".") || keys[0].startsWith("#");
  if (isSubpathMap) {
    if (subpath in exportsField) {
      const target = exportsField[subpath];
      if (target === null) return null;
      return resolveConditionValue(target, conditions);
    }
    const wildcardKeys = keys.filter((k2) => k2.includes("*")).sort((a2, b2) => b2.length - a2.length);
    for (const pattern of wildcardKeys) {
      const target = exportsField[pattern];
      const starIdx = pattern.indexOf("*");
      const prefix = pattern.slice(0, starIdx);
      const suffix = pattern.slice(starIdx + 1);
      if (subpath.startsWith(prefix) && (suffix ? subpath.endsWith(suffix) : true) && subpath.length >= prefix.length + suffix.length) {
        if (target === null) return null;
        const matched = subpath.slice(
          prefix.length,
          suffix ? subpath.length - suffix.length : void 0
        );
        const resolved = resolveConditionValue(target, conditions);
        if (resolved) return resolved.split("*").join(matched);
      }
    }
    return null;
  }
  if (subpath !== ".") return null;
  return resolveConditionValue(exportsField, conditions);
}
function resolveConditionValue(target, conditions) {
  if (target === null || target === void 0) return null;
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const r3 = resolveConditionValue(item, conditions);
      if (r3) return r3;
    }
    return null;
  }
  if (typeof target !== "object") return null;
  for (const cond of conditions) {
    if (cond in target) {
      const r3 = resolveConditionValue(target[cond], conditions);
      if (r3) return r3;
    }
  }
  if (!conditions.includes("default") && "default" in target) {
    return resolveConditionValue(target.default, conditions);
  }
  return null;
}
function resolvePackageEntry(pkg, subpath = ".", conditions = DEFAULT_ESM_CONDITIONS) {
  if (pkg.exports !== void 0 && pkg.exports !== null) {
    const entry = resolveExports(pkg.exports, subpath, conditions);
    if (entry) return entry;
    return null;
  }
  if (subpath === ".") {
    if (conditions.includes("module") && pkg.module) return pkg.module;
    if (pkg.main) return pkg.main;
    return null;
  }
  return subpath;
}

// ../core/src/vfs/path.ts
var NOT_NORMAL = /\/$|\/\/|(?:^|\/)\.\.?(?:\/|$)/;
function normalizeVfsPath(p) {
  const text = String(p ?? "");
  if (!NOT_NORMAL.test(text)) return text.charCodeAt(0) === 47 ? text.slice(1) : text;
  const segments = text.split("/");
  const out = [];
  for (const seg of segments) {
    if (seg === "..") out.pop();
    else if (seg !== "." && seg !== "") out.push(seg);
  }
  return out.join("/");
}

// ../core/src/runtime/barrel-detect.ts
function splitBareSpecifier(specifier) {
  const parts = specifier.split("/");
  const nameLength = specifier.startsWith("@") ? 2 : 1;
  return { name: parts.slice(0, nameLength).join("/"), subpath: parts.slice(nameLength).join("/") };
}

// ../core/src/runtime/bundler-resolution.ts
var BUNDLER_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cjs", ".json", ".css"];
var INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs"];
var TYPESCRIPT_TWINS = { js: [".ts", ".tsx"], jsx: [".tsx", ".ts"], mjs: [".mts", ".ts"], cjs: [".cts", ".ts"] };
function bundlerConditions(kind) {
  return kind === "require-call" || kind === "require-resolve" ? BUNDLER_REQUIRE_CONDITIONS : BUNDLER_IMPORT_CONDITIONS;
}
var BUNDLER_IMPORT_CONDITIONS = ["import", "module", "browser", "default"];
var BUNDLER_REQUIRE_CONDITIONS = ["require", "node", "browser", "default"];
function createBundlerResolver(fs) {
  const packageJson = async (path3) => {
    if (!await fs.isFile(path3)) return null;
    const text = await fs.readText(path3);
    if (text === null) return null;
    try {
      const parsed = JSON.parse(text);
      return parsed !== null && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  };
  const resolveFile = async (base) => {
    const path3 = "/" + normalizeVfsPath(base);
    for (const ext of BUNDLER_EXTENSIONS) if (await fs.isFile(path3 + ext)) return path3 + ext;
    const named = /\.(js|mjs|cjs|jsx)$/.exec(path3);
    if (named) {
      const stem = path3.slice(0, path3.length - named[0].length);
      for (const ext of TYPESCRIPT_TWINS[named[1]]) if (await fs.isFile(stem + ext)) return stem + ext;
    }
    if (await fs.isDirectory(path3)) {
      for (const index of INDEX_FILES) if (await fs.isFile(path3 + "/" + index)) return path3 + "/" + index;
    }
    return null;
  };
  const ancestors = function* (dir) {
    for (let at = normalizeVfsPath(dir); at; at = at.slice(0, Math.max(0, at.lastIndexOf("/")))) yield "/" + at;
  };
  return {
    resolveFile,
    async resolvePackageImport(specifier, fromDir) {
      for (const dir of ancestors(fromDir)) {
        if (!await fs.isFile(dir + "/package.json")) continue;
        const pkg = await packageJson(dir + "/package.json");
        const target = pkg?.imports ? resolveExports(pkg.imports, specifier) : null;
        return target ? resolveFile(dir + "/" + target.replace(/^\.\//, "")) : null;
      }
      return null;
    },
    async resolveBarePackage(specifier, fromDir, conditions) {
      const { name: name50, subpath } = splitBareSpecifier(specifier);
      for (const dir of ancestors(fromDir)) {
        const packageDir = dir + "/node_modules/" + name50;
        if (!await fs.isDirectory(packageDir)) continue;
        const pkg = await packageJson(packageDir + "/package.json");
        const entry = pkg ? resolvePackageEntry(pkg, subpath ? "./" + subpath : ".", conditions) : null;
        const resolved = entry && await resolveFile(packageDir + "/" + entry.replace(/^\.\//, "")) || subpath && await resolveFile(packageDir + "/" + subpath) || await resolveFile(packageDir + "/index");
        if (resolved) return resolved;
      }
      return null;
    }
  };
}

// ../core/src/runtime/prebundle-slice.ts
var VITE_DEV_DEFINE = Object.freeze({
  "import.meta.env.DEV": "true",
  "import.meta.env.PROD": "false",
  "import.meta.env.MODE": '"development"',
  "import.meta.env.SSR": "false",
  "process.env.NODE_ENV": '"development"',
  "global": "globalThis"
});
var PREBUNDLE_DEFINE = Object.freeze({
  ...VITE_DEV_DEFINE,
  "import.meta.env.BASE_URL": '"/"'
});
function prebundleBuildOptions(define) {
  return {
    bundle: true,
    format: "esm",
    target: "esnext",
    platform: "browser",
    conditions: BUNDLER_IMPORT_CONDITIONS,
    mainFields: ["module", "browser", "main"],
    define: define && Object.keys(define).length > 0 ? { ...define } : void 0
  };
}
function loaderOf(path3) {
  if (path3.endsWith(".ts") || path3.endsWith(".mts") || path3.endsWith(".cts")) return "ts";
  if (path3.endsWith(".tsx")) return "tsx";
  if (path3.endsWith(".jsx")) return "jsx";
  if (path3.endsWith(".json")) return "json";
  if (path3.endsWith(".css")) return "css";
  if (path3.endsWith(".wasm") || path3.endsWith(".node")) return "binary";
  return "js";
}
var bare = (path3) => !path3.startsWith("/") && !path3.startsWith(".") && !path3.startsWith("#");
async function prebundleSlice(spec2, build3) {
  const t0 = Date.now();
  const warnings = [];
  const failed = (errorText) => ({ specifier: spec2.specifier, ok: false, esmCode: "", errorText, elapsed: Date.now() - t0, warnings });
  if (!spec2 || typeof spec2 !== "object" || !Array.isArray(spec2.slice)) throw new Error("prebundleSlice: the spec has no slice");
  const norm = (p) => p.startsWith("/") ? p : "/" + p;
  const files = /* @__PURE__ */ new Map();
  const dirs = /* @__PURE__ */ new Set();
  for (const entry of spec2.slice) {
    if (entry.isDir) dirs.add(norm(entry.path));
    else files.set(norm(entry.path), entry.bytes);
  }
  for (const p of files.keys()) {
    for (let slash = p.lastIndexOf("/"); slash > 0; slash = p.lastIndexOf("/", slash - 1)) dirs.add(p.slice(0, slash));
  }
  const resolver = createBundlerResolver({
    isFile: (p) => files.has(norm(p)),
    isDirectory: (p) => dirs.has(norm(p)),
    readText: (p) => {
      const bytes = files.get(norm(p));
      return bytes ? new TextDecoder().decode(bytes) : null;
    }
  });
  const externalExact = /* @__PURE__ */ new Set();
  const externalPrefixes = [];
  for (const pattern of spec2.externals) {
    if (pattern.endsWith("/*")) externalPrefixes.push(pattern.slice(0, -1));
    else externalExact.add(pattern);
  }
  const isExternal = (s2) => externalExact.has(s2) || externalPrefixes.some((prefix) => s2.startsWith(prefix));
  const plugin = {
    name: "nimbus-pre-bundle-slice",
    async resolve(args2) {
      const at = (path3) => path3 ? { path: path3, namespace: "nimbus-slice" } : null;
      if (args2.path.startsWith("#") && args2.resolveDir) {
        const resolved = at(await resolver.resolvePackageImport(args2.path, args2.resolveDir));
        if (resolved) return resolved;
        warnings.push(`unresolved subpath import "${args2.path}" from ${args2.importer || "?"} (no owning package.json#imports entry); marked external`);
        return { external: true };
      }
      if (bare(args2.path) && isExternal(args2.path)) return { external: true };
      if (args2.path.startsWith("/")) {
        const resolved = at(await resolver.resolveFile(args2.path));
        if (resolved) return resolved;
      }
      if (args2.path.startsWith(".") && args2.resolveDir) {
        const resolved = at(await resolver.resolveFile(args2.resolveDir + "/" + args2.path));
        if (resolved) return resolved;
      }
      if (bare(args2.path)) {
        const resolved = at(await resolver.resolveBarePackage(args2.path, args2.resolveDir || "/home/user", bundlerConditions(args2.kind)));
        if (resolved) return resolved;
        warnings.push(`unresolved bare import "${args2.path}" from ${args2.importer || "?"} \u2192 marked external`);
      }
      return { external: true };
    },
    async load(args2) {
      const bytes = files.get(norm(args2.path));
      if (!bytes) return { errors: [{ text: "pre-bundle slice miss: " + args2.path }] };
      const loader = loaderOf(args2.path);
      const lastSlash = args2.path.lastIndexOf("/");
      const resolveDir = lastSlash > 0 ? args2.path.slice(0, lastSlash) : "/";
      return { contents: loader === "binary" ? bytes : new TextDecoder().decode(bytes), loader, resolveDir };
    }
  };
  if (!await resolver.resolveFile(spec2.entryPath)) {
    return failed(`its entry module ${norm(spec2.entryPath)} is not in its slice (${files.size} files): the package's files were not there to walk`);
  }
  const outcome = await build3({ entryPoints: [norm(spec2.entryPath)], ...prebundleBuildOptions(spec2.define) }, plugin);
  if (outcome.failure) return failed(outcome.errors[0]?.text || outcome.failure);
  const script = outcome.outputFiles.find((file) => !file.path.endsWith(".css")) ?? outcome.outputFiles[0];
  if (!script) return failed("no output produced");
  return { specifier: spec2.specifier, ok: true, esmCode: new TextDecoder().decode(script.contents), elapsed: Date.now() - t0, warnings };
}

// scripts/rolldown-facet/entry.mjs
function build2(options, plugin) {
  return buildWithRolldown({ rolldown, transformSync: transformSync2, parseSync: parseSync2 }, options, plugin);
}
function prebundle(spec2) {
  return prebundleSlice(spec2, build2);
}
export {
  build2 as build,
  prebundle
};
