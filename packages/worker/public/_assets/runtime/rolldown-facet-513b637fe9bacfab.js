var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

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
  const F3 = ["[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?(?:\\u0007|\\u001B\\u005C|\\u009C))", "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))"].join("|");
  return new RegExp(F3, t5 ? void 0 : "g");
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
  const F3 = u3.ambiguousIsNarrow ? 1 : 2;
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
        e3 += F3;
        break;
      default:
        e3 += 1;
    }
  }
  return e3;
}
function sD() {
  const t5 = /* @__PURE__ */ new Map();
  for (const [u3, F3] of Object.entries(r)) {
    for (const [e3, s2] of Object.entries(F3)) r[e3] = {
      open: `\x1B[${s2[0]}m`,
      close: `\x1B[${s2[1]}m`
    }, F3[e3] = r[e3], t5.set(s2[0], s2[1]);
    Object.defineProperty(r, u3, {
      value: F3,
      enumerable: false
    });
  }
  return Object.defineProperty(r, "codes", {
    value: t5,
    enumerable: false
  }), r.color.close = "\x1B[39m", r.bgColor.close = "\x1B[49m", r.color.ansi = L$1(), r.color.ansi256 = N(), r.color.ansi16m = I(), r.bgColor.ansi = L$1(m), r.bgColor.ansi256 = N(m), r.bgColor.ansi16m = I(m), Object.defineProperties(r, {
    rgbToAnsi256: {
      value: (u3, F3, e3) => u3 === F3 && F3 === e3 ? u3 < 8 ? 16 : u3 > 248 ? 231 : Math.round((u3 - 8) / 247 * 24) + 232 : 16 + 36 * Math.round(u3 / 255 * 5) + 6 * Math.round(F3 / 255 * 5) + Math.round(e3 / 255 * 5),
      enumerable: false
    },
    hexToRgb: {
      value: (u3) => {
        const F3 = /[a-f\d]{6}|[a-f\d]{3}/i.exec(u3.toString(16));
        if (!F3) return [
          0,
          0,
          0
        ];
        let [e3] = F3;
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
        let F3, e3, s2;
        if (u3 >= 232) F3 = ((u3 - 232) * 10 + 8) / 255, e3 = F3, s2 = F3;
        else {
          u3 -= 16;
          const C3 = u3 % 36;
          F3 = Math.floor(u3 / 36) / 5, e3 = Math.floor(C3 / 6) / 5, s2 = C3 % 6 / 5;
        }
        const i2 = Math.max(F3, e3, s2) * 2;
        if (i2 === 0) return 30;
        let D2 = 30 + (Math.round(s2) << 2 | Math.round(e3) << 1 | Math.round(F3));
        return i2 === 2 && (D2 += 60), D2;
      },
      enumerable: false
    },
    rgbToAnsi: {
      value: (u3, F3, e3) => r.ansi256ToAnsi(r.rgbToAnsi256(u3, F3, e3)),
      enumerable: false
    },
    hexToAnsi: {
      value: (u3) => r.ansi256ToAnsi(r.hexToAnsi256(u3)),
      enumerable: false
    }
  }), r;
}
function G(t5, u3, F3) {
  return String(t5).normalize().replace(/\r\n/g, `
`).split(`
`).map((e3) => oD(e3, u3, F3)).join(`
`);
}
function k$1(t5, u3) {
  if (typeof t5 == "string") return c.aliases.get(t5) === u3;
  for (const F3 of t5) if (F3 !== void 0 && k$1(F3, u3)) return true;
  return false;
}
function lD(t5, u3) {
  if (t5 === u3) return;
  const F3 = t5.split(`
`), e3 = u3.split(`
`), s2 = [];
  for (let i2 = 0; i2 < Math.max(F3.length, e3.length); i2++) F3[i2] !== e3[i2] && s2.push(i2);
  return s2;
}
function d$1(t5, u3) {
  const F3 = t5;
  F3.isTTY && F3.setRawMode(u3);
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
      function F3(e3) {
        return e3.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[^\uD800-\uDFFF]/g) || [];
      }
      u3.length = function(e3) {
        for (var s2 = F3(e3), i2 = 0, D2 = 0; D2 < s2.length; D2++) i2 = i2 + this.characterLength(s2[D2]);
        return i2;
      }, u3.slice = function(e3, s2, i2) {
        textLen = u3.length(e3), s2 = s2 || 0, i2 = i2 || 1, s2 < 0 && (s2 = textLen + s2), i2 < 0 && (i2 = textLen + i2);
        for (var D2 = "", C3 = 0, o3 = F3(e3), E = 0; E < o3.length; E++) {
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
    I = (t5 = 0) => (u3, F3, e3) => `\x1B[${38 + t5};2;${u3};${F3};${e3}m`;
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
    _ = (t5, u3, F3) => {
      const e3 = [...u3];
      let s2 = false, i2 = false, D2 = A$1(T$1(t5[t5.length - 1]));
      for (const [C3, o3] of e3.entries()) {
        const E = A$1(o3);
        if (D2 + E <= F3 ? t5[t5.length - 1] += o3 : (t5.push(o3), D2 = 0), v.has(o3) && (s2 = true, i2 = e3.slice(C3 + 1).join("").startsWith(y)), s2) {
          i2 ? o3 === w$1 && (s2 = false, i2 = false) : o3 === R && (s2 = false);
          continue;
        }
        D2 += E, D2 === F3 && C3 < e3.length - 1 && (t5.push(""), D2 = 0);
      }
      !D2 && t5[t5.length - 1].length > 0 && t5.length > 1 && (t5[t5.length - 2] += t5.pop());
    };
    nD = (t5) => {
      const u3 = t5.split(" ");
      let F3 = u3.length;
      for (; F3 > 0 && !(A$1(u3[F3 - 1]) > 0); ) F3--;
      return F3 === u3.length ? t5 : u3.slice(0, F3).join(" ") + u3.slice(F3).join("");
    };
    oD = (t5, u3, F3 = {}) => {
      if (F3.trim !== false && t5.trim() === "") return "";
      let e3 = "", s2, i2;
      const D2 = ED(t5);
      let C3 = [""];
      for (const [E, a2] of t5.split(" ").entries()) {
        F3.trim !== false && (C3[C3.length - 1] = C3[C3.length - 1].trimStart());
        let n5 = A$1(C3[C3.length - 1]);
        if (E !== 0 && (n5 >= u3 && (F3.wordWrap === false || F3.trim === false) && (C3.push(""), n5 = 0), (n5 > 0 || F3.trim === false) && (C3[C3.length - 1] += " ", n5++)), F3.hard && D2[E] > u3) {
          const B2 = u3 - n5, p = 1 + Math.floor((D2[E] - B2 - 1) / u3);
          Math.floor((D2[E] - 1) / u3) < p && C3.push(""), _(C3, a2, u3);
          continue;
        }
        if (n5 + D2[E] > u3 && n5 > 0 && D2[E] > 0) {
          if (F3.wordWrap === false && n5 < u3) {
            _(C3, a2, u3);
            continue;
          }
          C3.push("");
        }
        if (n5 + D2[E] > u3 && F3.wordWrap === false) {
          _(C3, a2, u3);
          continue;
        }
        C3[C3.length - 1] += a2;
      }
      F3.trim !== false && (C3 = C3.map((E) => nD(E)));
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
    pD = (t5, u3, F3) => u3 in t5 ? AD(t5, u3, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: F3
    }) : t5[u3] = F3;
    h = (t5, u3, F3) => (pD(t5, typeof u3 != "symbol" ? u3 + "" : u3, F3), F3);
    x = class {
      constructor(u3, F3 = true) {
        h(this, "input"), h(this, "output"), h(this, "_abortSignal"), h(this, "rl"), h(this, "opts"), h(this, "_render"), h(this, "_track", false), h(this, "_prevFrame", ""), h(this, "_subscribers", /* @__PURE__ */ new Map()), h(this, "_cursor", 0), h(this, "state", "initial"), h(this, "error", ""), h(this, "value");
        const { input: e3 = stdin, output: s2 = stdout, render: i2, signal: D2, ...C3 } = u3;
        this.opts = C3, this.onKeypress = this.onKeypress.bind(this), this.close = this.close.bind(this), this.render = this.render.bind(this), this._render = i2.bind(this), this._track = F3, this._abortSignal = D2, this.input = e3, this.output = s2;
      }
      unsubscribe() {
        this._subscribers.clear();
      }
      setSubscriber(u3, F3) {
        const e3 = this._subscribers.get(u3) ?? [];
        e3.push(F3), this._subscribers.set(u3, e3);
      }
      on(u3, F3) {
        this.setSubscriber(u3, { cb: F3 });
      }
      once(u3, F3) {
        this.setSubscriber(u3, {
          cb: F3,
          once: true
        });
      }
      emit(u3, ...F3) {
        const e3 = this._subscribers.get(u3) ?? [], s2 = [];
        for (const i2 of e3) i2.cb(...F3), i2.once && s2.push(() => e3.splice(e3.indexOf(i2), 1));
        for (const i2 of s2) i2();
      }
      prompt() {
        return new Promise((u3, F3) => {
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
      onKeypress(u3, F3) {
        if (this.state === "error" && (this.state = "active"), F3?.name && (!this._track && c.aliases.has(F3.name) && this.emit("cursor", c.aliases.get(F3.name)), c.actions.has(F3.name) && this.emit("cursor", F3.name)), u3 && (u3.toLowerCase() === "y" || u3.toLowerCase() === "n") && this.emit("confirm", u3.toLowerCase() === "y"), u3 === "	" && this.opts.placeholder && (this.value || (this.rl?.write(this.opts.placeholder), this.emit("value", this.opts.placeholder))), u3 && this.emit("key", u3.toLowerCase()), F3?.name === "return") {
          if (this.opts.validate) {
            const e3 = this.opts.validate(this.value);
            e3 && (this.error = e3 instanceof Error ? e3.message : e3, this.state = "error", this.rl?.write(this.value));
          }
          this.state !== "error" && (this.state = "submit");
        }
        k$1([
          u3,
          F3?.name,
          F3?.sequence
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
            const F3 = lD(this._prevFrame, u3);
            if (this.restoreCursor(), F3 && F3?.length === 1) {
              const e3 = F3[0];
              this.output.write(srcExports.cursor.move(0, e3)), this.output.write(srcExports.erase.lines(1));
              const s2 = u3.split(`
`);
              this.output.write(s2[e3]), this._prevFrame = u3, this.output.write(srcExports.cursor.move(0, s2.length - e3 - 1));
              return;
            }
            if (F3 && F3?.length > 1) {
              const e3 = F3[0];
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
        }), this.on("confirm", (F3) => {
          this.output.write(srcExports.cursor.move(0, -1)), this.value = F3, this.state = "submit", this.close();
        }), this.on("cursor", () => {
          this.value = !this.value;
        });
      }
    };
    bD = Object.defineProperty;
    mD = (t5, u3, F3) => u3 in t5 ? bD(t5, u3, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: F3
    }) : t5[u3] = F3;
    Y = (t5, u3, F3) => (mD(t5, typeof u3 != "symbol" ? u3 + "" : u3, F3), F3);
    wD = class extends x {
      constructor(u3) {
        super(u3, false), Y(this, "options"), Y(this, "cursor", 0), this.options = u3.options, this.value = [...u3.initialValues ?? []], this.cursor = Math.max(this.options.findIndex(({ value: F3 }) => F3 === u3.cursorAt), 0), this.on("key", (F3) => {
          F3 === "a" && this.toggleAll();
        }), this.on("cursor", (F3) => {
          switch (F3) {
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
        this.value = u3 ? [] : this.options.map((F3) => F3.value);
      }
      toggleValue() {
        const u3 = this.value.includes(this._value);
        this.value = u3 ? this.value.filter((F3) => F3 !== this._value) : [...this.value, this._value];
      }
    };
    SD = Object.defineProperty;
    $D = (t5, u3, F3) => u3 in t5 ? SD(t5, u3, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: F3
    }) : t5[u3] = F3;
    q = (t5, u3, F3) => ($D(t5, typeof u3 != "symbol" ? u3 + "" : u3, F3), F3);
    jD = class extends x {
      constructor(u3) {
        super(u3, false), q(this, "options"), q(this, "cursor", 0), this.options = u3.options, this.cursor = this.options.findIndex(({ value: F3 }) => F3 === u3.initialValue), this.cursor === -1 && (this.cursor = 0), this.changeValue(), this.on("cursor", (F3) => {
          switch (F3) {
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
        const u3 = this.value.slice(0, this.cursor), [F3, ...e$1] = this.value.slice(this.cursor);
        return `${u3}${e2.inverse(F3)}${e$1.join("")}`;
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
    const code2 = error2.code;
    if (!error2.pluginCode && code2 != null && (typeof code2 !== "string" || !code2.startsWith("PLUGIN_"))) error2.pluginCode = code2;
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
  constructor(name, _options) {
    this.name = name;
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
function isPathFragment(name) {
  return name[0] === "/" || name[0] === "." && (name[1] === "/" || name[1] === ".") || ABSOLUTE_PATH_REGEX.test(name);
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
function getLogHandler(level, code2, logger2, pluginName, logLevel) {
  if (logLevelPriority[level] < logLevelPriority[logLevel]) return noop;
  return (log, pos) => {
    if (pos != null) logger2(LOG_LEVEL_WARN, logInvalidLogPosition(pluginName));
    log = normalizeLog(log);
    if (log.code && !log.pluginCode) log.pluginCode = log.code;
    log.code = code2;
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
  const { id: id2, code: code2, moduleType: moduleType2 } = filterOption;
  let ret = [];
  let idIncludes = [];
  let idExcludes = [];
  let codeIncludes = [];
  let codeExcludes = [];
  if (id2) [idIncludes, idExcludes] = t3(generalHookFilterMatcherToFilterExprs(id2, "id") ?? [], (m2) => m2.kind === "include");
  if (code2) [codeIncludes, codeExcludes] = t3(generalHookFilterMatcherToFilterExprs(code2, "code") ?? [], (m2) => m2.kind === "include");
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
  let list = [];
  bindingifyFilterExprImpl(expr, list);
  return list;
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
function bindingifyFilterExprImpl(expr, list) {
  switch (expr.kind) {
    case "and": {
      let args2 = expr.args;
      for (let i2 = args2.length - 1; i2 >= 0; i2--) bindingifyFilterExprImpl(args2[i2], list);
      list.push({
        kind: "And",
        payload: args2.length
      });
      break;
    }
    case "or": {
      let args2 = expr.args;
      for (let i2 = args2.length - 1; i2 >= 0; i2--) bindingifyFilterExprImpl(args2[i2], list);
      list.push({
        kind: "Or",
        payload: args2.length
      });
      break;
    }
    case "not":
      bindingifyFilterExprImpl(expr.expr, list);
      list.push({ kind: "Not" });
      break;
    case "id":
      list.push({
        kind: "Id",
        payload: expr.pattern
      });
      if (expr.params.cleanUrl) list.push({ kind: "CleanUrl" });
      break;
    case "importerId":
      list.push({
        kind: "ImporterId",
        payload: expr.pattern
      });
      if (expr.params.cleanUrl) list.push({ kind: "CleanUrl" });
      break;
    case "moduleType":
      list.push({
        kind: "ModuleType",
        payload: expr.pattern
      });
      break;
    case "code":
      list.push({
        kind: "Code",
        payload: expr.pattern
      });
      break;
    case "include":
      bindingifyFilterExprImpl(expr.expr, list);
      list.push({ kind: "Include" });
      break;
    case "exclude":
      bindingifyFilterExprImpl(expr.expr, list);
      list.push({ kind: "Exclude" });
      break;
    case "query":
      list.push({
        kind: "QueryKey",
        payload: expr.key
      });
      list.push({
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
    plugin: async (ctx, code2, id2, meta) => {
      let magicStringInstance, astInstance;
      Object.defineProperties(meta, {
        magicString: { get() {
          if (magicStringInstance) return magicStringInstance;
          magicStringInstance = new RolldownMagicString(code2);
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
          astInstance = parseAst(code2, {
            astType: meta.moduleType.includes("ts") ? "ts" : "js",
            lang
          });
          return astInstance;
        } }
      });
      const transformCtx = new TransformPluginContextImpl(args2.outputOptions, ctx.inner(), args2.plugin, args2.pluginContextData, ctx, id2, code2, args2.onLog, args2.logLevel, args2.watchMode);
      const ret = await handler.call(transformCtx, code2, id2, meta);
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
        map: bindingifySourcemap(normalizeTransformHookSourcemap(id2, code2, map)) ?? (mapHandledByNativeChannel || ret.map === null ? null : void 0),
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
    plugin: async (ctx, code2, chunk, opts, meta) => {
      if (args2.pluginContextData.getRenderChunkMeta() == null) args2.pluginContextData.setRenderChunkMeta({ chunks: Object.fromEntries(Object.entries(meta.chunks).map(([key, value]) => [key, transformRenderedChunk(value)])) });
      const renderChunkMeta = args2.pluginContextData.getRenderChunkMeta();
      let magicStringInstance;
      if (args2.options.experimental?.nativeMagicString) Object.defineProperty(renderChunkMeta, "magicString", {
        get() {
          if (magicStringInstance) return magicStringInstance;
          magicStringInstance = new RolldownMagicString(code2);
          return magicStringInstance;
        },
        configurable: true
      });
      const ret = await handler.call(createPluginContext(args2, ctx), code2, transformRenderedChunk(chunk), args2.pluginContextData.getOutputOptions(opts), renderChunkMeta);
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
function bindingifyAddonHook(args2, name) {
  return bindingifyHook(args2.plugin[name], ({ handler }) => ({ plugin: async (ctx, chunk) => {
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
  const { plugin: transform, meta: transformMeta, filter: transformFilter } = bindingifyTransform(args2);
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
    transform,
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
  const transform = inputOptions.transform;
  const define = transform?.define ? Object.entries(transform.define) : void 0;
  const inject = transform?.inject;
  const dropLabels = transform?.dropLabels;
  let oxcTransformOptions;
  if (transform) {
    const { define: _define, inject: _inject, dropLabels: _dropLabels, ...rest } = transform;
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
  const yarnPnp = typeof process === "object" && !!process.versions?.pnp;
  if (resolve) {
    const { alias, extensionAlias, ...rest } = resolve;
    return {
      alias: alias ? Object.entries(alias).map(([name, replacement]) => ({
        find: name,
        replacements: replacement === false ? [void 0] : arraify(replacement)
      })) : void 0,
      extensionAlias: extensionAlias ? Object.entries(extensionAlias).map(([name, value]) => ({
        target: name,
        replacements: value
      })) : void 0,
      yarnPnp,
      ...rest
    };
  } else return { yarnPnp };
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
  return Object.entries(input).map(([name, import_path]) => {
    return {
      name,
      import: import_path
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
      const name = plugin.name || "unknown";
      const options = plugin.options;
      if (options) {
        const { handler } = normalizeHook(options);
        const result = await handler.call(new MinimalPluginContextImpl(logger2, logLevel, name, watchMode, "onLog"), inputOptions);
        if (result) inputOptions = result;
      }
    }
    return inputOptions;
  }
  static callOutputOptionsHook(rawPlugins, outputOptions, onLog, logLevel, watchMode) {
    const sortedPlugins = getSortedPlugins("outputOptions", getObjectPlugins(rawPlugins));
    for (const plugin of sortedPlugins) {
      const name = plugin.name || "unknown";
      const options = plugin.outputOptions;
      if (options) {
        const { handler } = normalizeHook(options);
        const result = handler.call(new MinimalPluginContextImpl(onLog, logLevel, name, watchMode), outputOptions);
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
  const list = [...new Set(values$1)];
  if (list.length > 1) return `(${list.join(` ${separator} `)})`;
  return list[0] ?? "never";
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
  const { dir, format, exports, hashCharacters, sourcemap, sourcemapBaseUrl, sourcemapDebugIds, sourcemapFileNames, sourcemapExcludeSources, sourcemapIgnoreList, sourcemapPathTransform, name, assetFileNames, entryFileNames, chunkFileNames, banner, footer, postBanner, postFooter, intro, outro, esModule, globals, paths, generatedCode, file, sanitizeFileName, preserveModules, virtualDirname, legalComments, comments, preserveModulesRoot, manualChunks, topLevelVar, cleanDir, strictExecutionOrder } = outputOptions;
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
    name,
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
function bindingifyAddon(configAddon, name, timings) {
  if (configAddon == null || configAddon === "") return;
  if (typeof configAddon === "function") {
    const measured = measureHookCost(timings, OUTPUT_OPTIONS_OWNER, name, configAddon);
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
        const { debugName, name, test, ...restGroup } = group;
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
            const label = debugName ?? (typeof name === "string" ? name : void 0);
            if (label === void 0) {
              if (typeof name === "function" && !timings.warnedMissingGroupLabels.has(timingKey)) {
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
          name: typeof name === "function" ? batchName(measureHookCost(timings, timingOwner, nameTimingName, name), getChunkingContext) : name
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
function batchName(name, getChunkingContext) {
  return (ids, bindingContext) => {
    const context = getChunkingContext(bindingContext);
    const results = [];
    for (let index = 0; index < ids.length; index++) {
      const result = name(ids[index], context);
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
    const list = this.listeners[ev];
    const i2 = list.indexOf(fn);
    if (i2 === -1) return;
    if (i2 === 0 && list.length === 1) list.length = 0;
    else list.splice(i2, 1);
  }
  emit(ev, code2, signal) {
    if (this.emitted[ev]) return false;
    this.emitted[ev] = true;
    let ret = false;
    for (const fn of this.listeners[ev]) ret = fn(code2, signal) === true || ret;
    if (ev === "exit") ret = this.emit("afterExit", code2, signal) || ret;
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
    this.#process.reallyExit = (code2) => {
      return this.#processReallyExit(code2);
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
  #processReallyExit(code2) {
    if (!processOk(this.#process)) return 0;
    this.#process.exitCode = code2 || 0;
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
    process.on("exit", (code2) => {
      args2[0](code2, null);
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

// ../core/src/runtime/css-bundle.ts
async function bundleCss(modules, _plugin, { minify }) {
  if (minify) throw new Error("minified CSS is not supported by Nimbus's bundler yet");
  const parts = [];
  for (const module of modules) {
    const body = stripComments(module.source);
    if (/@import\b/i.test(body)) throw new Error(`${module.path}: CSS @import is not supported by Nimbus's bundler yet`);
    if (/\burl\(/i.test(body)) throw new Error(`${module.path}: CSS url() is not supported by Nimbus's bundler yet`);
    parts.push(`/* ${module.path} */
${module.source.trim()}
`);
  }
  return parts.join("\n");
}
function stripComments(css) {
  let out = "";
  for (let i2 = 0; i2 < css.length; ) {
    const c3 = css[i2];
    if (c3 === '"' || c3 === "'") {
      const end = endOfString(css, i2);
      out += css.slice(i2, end);
      i2 = end;
    } else if (c3 === "/" && css[i2 + 1] === "*") {
      const end = css.indexOf("*/", i2 + 2);
      i2 = end < 0 ? css.length : end + 2;
    } else {
      out += c3;
      i2++;
    }
  }
  return out;
}
function endOfString(css, start) {
  const quote = css[start];
  let i2 = start + 1;
  while (i2 < css.length && css[i2] !== quote && css[i2] !== "\n") i2 += css[i2] === "\\" ? 2 : 1;
  return Math.min(i2 + 1, css.length);
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
  "logLevel"
]);
var LOADER_MODULE_TYPES = {
  js: "js",
  jsx: "jsx",
  ts: "ts",
  tsx: "tsx",
  json: "json",
  text: "text",
  base64: "base64",
  dataurl: "dataurl",
  empty: "empty"
};
function importSpans(module, parse2) {
  const spans = /* @__PURE__ */ new Map();
  let program;
  try {
    program = parse2(module.source, { lang: module.lang });
  } catch {
    return spans;
  }
  const literal2 = (kind, node) => {
    const n5 = node;
    if (n5?.type !== "Literal" || typeof n5.value !== "string" || typeof n5.start !== "number" || typeof n5.end !== "number") return;
    const key = `${kind}\0${n5.value}`;
    const known = spans.get(key);
    if (!known || n5.start < known[0]) spans.set(key, [n5.start, n5.end]);
  };
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const n5 = node;
    switch (n5.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        literal2("import-statement", n5.source);
        break;
      case "ImportExpression":
        literal2("dynamic-import", n5.source);
        break;
      case "TSExternalModuleReference":
        literal2("require-call", n5.expression);
        break;
      case "CallExpression": {
        const callee = n5.callee;
        if (callee?.type === "Identifier" && callee.name === "require") literal2("require-call", n5.arguments?.[0]);
        break;
      }
    }
    for (const [key, child] of Object.entries(n5)) if (key !== "parent") visit(child);
  };
  visit(program);
  return spans;
}
var utf8Length = (text) => new TextEncoder().encode(text).length;
function base64Of(bytes) {
  let latin1 = "";
  for (let i2 = 0; i2 < bytes.length; i2 += 32768) latin1 += String.fromCharCode(...bytes.subarray(i2, i2 + 32768));
  return btoa(latin1);
}
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
  const lines = errors.map((e3) => e3.location ? `${e3.location.file}:${e3.location.line}:${e3.location.column}: ERROR: ${e3.text}` : `error: ${e3.text}`);
  return `Build failed with ${errors.length} error${errors.length === 1 ? "" : "s"}:
${lines.join("\n")}`;
}
function refuse(text) {
  throw new BuildError([message(text)]);
}
async function buildWithRolldown(api, options, plugin) {
  const state = { raised: [], unresolved: [], loaded: /* @__PURE__ */ new Map() };
  try {
    return await build(api, options, plugin, state);
  } catch (error2) {
    const errors = error2 instanceof BuildError ? error2.messages : sortedMessages([...state.unresolved, ...messagesOf(error2, state.raised, state.loaded)]);
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
  const location = log.loc && loaded ? locate2(fileOf(loaded), loaded.source, log.loc.line, log.loc.column) : null;
  return message(firstLine, location, log.plugin ?? "");
}
function fileOf(module) {
  return module.namespace === "file" || module.namespace === "" ? module.path : `${module.namespace}:${module.path}`;
}
async function build(api, options, plugin, { raised, unresolved, loaded }) {
  for (const [key, value] of Object.entries(options)) {
    if (value !== void 0 && !SUPPORTED.has(key)) refuse(`Nimbus's bundler does not support the esbuild option "${key}"`);
  }
  if (options.bundle === false) refuse("Nimbus's bundler only bundles (bundle: false is not supported)");
  if (options.tsconfigRaw !== void 0 && options.tsconfigRaw !== "" && JSON.stringify(options.tsconfigRaw) !== "{}") {
    refuse("Nimbus's bundler does not support tsconfigRaw");
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
  const decode = (id2) => {
    const known = loaded.get(id2);
    if (known) return known;
    const m2 = /^\0([^:]*):([\s\S]*)$/.exec(id2);
    return m2 ? { namespace: m2[1], path: m2[2] } : { namespace: mainNamespace ?? "file", path: id2 };
  };
  const pending = /* @__PURE__ */ new Map();
  const css = [];
  const warnings = [];
  const raise = (text, pluginName = "") => {
    raised.push(message(text, null, pluginName));
    throw new Error(text);
  };
  const spansOf = /* @__PURE__ */ new Map();
  const unresolvedImport = (text, importer, source, kind, pluginName, parse2) => {
    const from = importer ? loaded.get(importer) : void 0;
    let location = null;
    let spans = importer ? spansOf.get(importer) : void 0;
    if (!spans && importer && from?.lang) spansOf.set(importer, spans = importSpans(from, parse2));
    const span = spans?.get(`${kind}\0${source}`);
    if (from && span) {
      const before = from.source.slice(0, span[0]);
      const line = before.split(/\r\n|\r|\n/).length;
      const lineStart = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r")) + 1;
      location = locate2(fileOf(from), from.source, line, utf8Length(before.slice(lineStart)), utf8Length(from.source.slice(span[0], span[1])));
    }
    unresolved.push(message(text, location, pluginName));
    return { id: source, external: true };
  };
  const vfs = {
    name: plugin.name,
    async resolveId(source, importer, extra) {
      const parse2 = this.parse.bind(this);
      if (source.startsWith("\0")) return null;
      const from = importer ? decode(importer) : null;
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
      if (answer?.errors?.length) return unresolvedImport(answer.errors[0].text ?? "error", importer, source, kind, plugin.name, parse2);
      if (answer?.warnings?.length) for (const w2 of answer.warnings) warnings.push(message(w2.text ?? ""));
      if (!answer || !answer.path && !answer.external) return unresolvedImport(`Could not resolve ${JSON.stringify(source)}`, importer, source, kind, "", parse2);
      if (answer.external) return { id: answer.path ?? path3, external: true };
      const namespace = answer.namespace ?? "file";
      if (mainNamespace === null) mainNamespace = namespace;
      const id2 = idOf(namespace, answer.path);
      pending.set(id2, { namespace, path: answer.path });
      return id2;
    },
    async load(id2) {
      const { namespace, path: path3 } = pending.get(id2) ?? decode(id2);
      const answer = await plugin.load({ path: path3, namespace, suffix: "", with: {} });
      if (answer?.errors?.length) raise(answer.errors[0].text ?? "error", plugin.name);
      if (answer?.warnings?.length) for (const w2 of answer.warnings) warnings.push(message(w2.text ?? ""));
      if (!answer || answer.contents === void 0) raise(`No loader produced ${fileOf({ namespace, path: path3 })}`);
      const loader = answer.loader ?? "js";
      const contents = answer.contents;
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
        if (!options.outdir && !options.outfile) raise(`Cannot import ${JSON.stringify(fileOf({ namespace, path: path3 }))} into a JavaScript file without an output path configured`);
        css.push({ id: id2, path: path3, source: text });
        return { code: "", moduleType: "js", moduleSideEffects: true };
      }
      if (loader === "binary") {
        const bytes = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
        return { code: `module.exports = Uint8Array.from(atob(${JSON.stringify(base64Of(bytes))}), (c) => c.charCodeAt(0));`, moduleType: "js" };
      }
      const moduleType2 = LOADER_MODULE_TYPES[loader];
      if (!moduleType2) raise(`Nimbus's bundler does not support the "${loader}" loader (${fileOf({ namespace, path: path3 })})`);
      if (typeof contents === "string") return { code: contents, moduleType: moduleType2 };
      let latin1 = "";
      for (let i2 = 0; i2 < contents.length; i2 += 32768) latin1 += String.fromCharCode(...contents.subarray(i2, i2 + 32768));
      return { code: moduleType2 === "base64" || moduleType2 === "dataurl" ? latin1 : text, moduleType: moduleType2 };
    }
  };
  const bundle = await api.rolldown({
    input: entryPoints,
    cwd: "/",
    platform: options.platform ?? "browser",
    plugins: [vfs],
    tsconfig: false,
    transform: {
      target,
      define: options.define,
      // esbuild's default for JSX without a tsconfig: React.createElement.
      jsx: { runtime: "classic", pragma: "React.createElement", pragmaFrag: "React.Fragment" }
    },
    checks: { pluginTimings: false },
    // esbuild keeps an imported constant a reference: inlining its value
    // changes what a cycle sees before the constant's module has run.
    optimization: { inlineConst: false },
    onLog(level, log) {
      if (level === "warn") warnings.push(fromLog(log, loaded));
    }
  });
  try {
    const template = (names, fallback) => (names ?? fallback).replace(/\[ext\]/g, "[extname]");
    const { output } = await bundle.generate({
      format: format === "esm" ? "es" : format,
      name: options.globalName,
      minify: options.minify === true,
      keepNames: options.keepNames === true,
      sourcemap: options.sourcemap === true || options.sourcemap === "external" ? true : options.sourcemap === "inline" ? "inline" : false,
      entryFileNames: options.outfile ? options.outfile.slice(options.outfile.lastIndexOf("/") + 1) : `${template(options.entryNames, "[name]")}.js`,
      chunkFileNames: `${template(options.chunkNames, "[name]-[hash]")}.js`,
      assetFileNames: `${template(options.assetNames, "[name]-[hash]")}[extname]`,
      codeSplitting: false
    });
    if (unresolved.length) throw new BuildError(sortedMessages(unresolved));
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
        const entry = out.isEntry && out.facadeModuleId ? decode(out.facadeModuleId) : null;
        const cssOfChunk = css.filter((m2) => out.moduleIds.includes(m2.id));
        let cssBundle;
        if (cssOfChunk.length) {
          const cssPath = path3.replace(/\.js$/, ".css");
          const bundled = await bundleCss(cssOfChunk, plugin, { minify: options.minify === true });
          outputFiles.push({ path: cssPath, contents: encoder.encode(bundled) });
          outputs[relative(cssPath)] = { imports: [], exports: [], inputs: {}, bytes: bundled.length };
          cssBundle = relative(cssPath);
        }
        outputs[relative(path3)] = {
          imports: [],
          exports: out.exports,
          inputs: {},
          bytes: contents.length,
          ...entry ? { entryPoint: fileOf(entry) } : {},
          ...cssBundle ? { cssBundle } : {}
        };
      } else {
        const contents = typeof out.source === "string" ? encoder.encode(out.source) : out.source;
        const path3 = at(out.fileName);
        outputFiles.push({ path: path3, contents });
        outputs[relative(path3)] = { imports: [], exports: [], inputs: {}, bytes: contents.length };
      }
    }
    return { outputFiles, errors: [], warnings, metafile: { inputs: {}, outputs } };
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

// ../core/src/runtime/prebundle-slice.ts
var EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cjs", ".json", ".css"];
var INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs"];
var SWAPS = { js: [".ts", ".tsx"], jsx: [".tsx", ".ts"], mjs: [".mts", ".ts"], cjs: [".cts", ".ts"] };
var ESM_CONDITIONS = ["import", "module", "browser", "default"];
var CJS_CONDITIONS = ["require", "node", "browser", "default"];
function loaderOf(path3) {
  if (path3.endsWith(".ts") || path3.endsWith(".mts") || path3.endsWith(".cts")) return "ts";
  if (path3.endsWith(".tsx")) return "tsx";
  if (path3.endsWith(".jsx")) return "jsx";
  if (path3.endsWith(".json")) return "json";
  if (path3.endsWith(".css")) return "css";
  if (path3.endsWith(".wasm") || path3.endsWith(".node")) return "binary";
  return "js";
}
function normalizePath(p) {
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }
  return (p.startsWith("/") ? "/" : "") + out.join("/");
}
var bare = (path3) => !path3.startsWith("/") && !path3.startsWith(".") && !path3.startsWith("#");
async function prebundleSlice(spec, build3) {
  const t0 = Date.now();
  const warnings = [];
  const failed = (errorText) => ({ specifier: spec.specifier, ok: false, esmCode: "", errorText, elapsed: Date.now() - t0, warnings });
  if (!spec || typeof spec !== "object" || !Array.isArray(spec.slice)) throw new Error("prebundleSlice: the spec has no slice");
  const norm = (p) => p.startsWith("/") ? p : "/" + p;
  const files = /* @__PURE__ */ new Map();
  const dirs = /* @__PURE__ */ new Set();
  for (const entry of spec.slice) {
    if (entry.isDir) dirs.add(norm(entry.path));
    else files.set(norm(entry.path), entry.bytes);
  }
  for (const p of files.keys()) {
    for (let slash = p.lastIndexOf("/"); slash > 0; slash = p.lastIndexOf("/", slash - 1)) dirs.add(p.slice(0, slash));
  }
  const fileExists = (p) => files.has(norm(p));
  const dirExists = (p) => dirs.has(norm(p));
  const packageJson = (path3) => {
    try {
      return JSON.parse(new TextDecoder().decode(files.get(norm(path3))));
    } catch {
      return null;
    }
  };
  const tryResolve = (base) => {
    const n5 = normalizePath(base);
    for (const ext of EXTS) if (fileExists(n5 + ext)) return n5 + ext;
    const swap = /\.(js|mjs|cjs|jsx)$/.exec(n5);
    if (swap) {
      const without = n5.slice(0, n5.length - swap[0].length);
      for (const ext of SWAPS[swap[1]] ?? []) if (fileExists(without + ext)) return without + ext;
    }
    if (dirExists(n5)) {
      for (const index of INDEX_FILES) if (fileExists(n5 + "/" + index)) return n5 + "/" + index;
    }
    return null;
  };
  const resolvePackageImport = (specifier, fromDir) => {
    for (let dir = fromDir.replace(/^\/+/, ""); dir; dir = dir.slice(0, Math.max(0, dir.lastIndexOf("/")))) {
      const pkgJsonPath = "/" + dir + "/package.json";
      if (!fileExists(pkgJsonPath)) continue;
      const pkg = packageJson(pkgJsonPath);
      const target = pkg?.imports ? resolveExports(pkg.imports, specifier) : null;
      return target ? tryResolve("/" + dir + "/" + target.replace(/^\.\//, "")) : null;
    }
    return null;
  };
  const resolveBarePkg = (specifier, fromDir, conditions) => {
    const parts = specifier.split("/");
    const scoped = specifier.startsWith("@");
    const pkgName = parts.slice(0, scoped ? 2 : 1).join("/");
    const subpath = parts.slice(scoped ? 2 : 1).join("/");
    for (let dir = fromDir.replace(/^\/+/, ""); dir; dir = dir.slice(0, Math.max(0, dir.lastIndexOf("/")))) {
      const nm = "/" + dir + "/node_modules/" + pkgName;
      if (!dirExists(nm)) continue;
      const pkg = fileExists(nm + "/package.json") ? packageJson(nm + "/package.json") : null;
      const entry = pkg ? resolvePackageEntry(pkg, subpath ? "./" + subpath : ".", conditions) : null;
      const resolved = entry && tryResolve(nm + "/" + entry.replace(/^\.\//, "")) || subpath && tryResolve(nm + "/" + subpath) || tryResolve(nm + "/index");
      if (resolved) return resolved;
    }
    return null;
  };
  const externalExact = /* @__PURE__ */ new Set();
  const externalPrefixes = [];
  for (const pattern of spec.externals) {
    if (pattern.endsWith("/*")) externalPrefixes.push(pattern.slice(0, -1));
    else externalExact.add(pattern);
  }
  const isExternal = (s2) => externalExact.has(s2) || externalPrefixes.some((prefix) => s2.startsWith(prefix));
  const plugin = {
    name: "nimbus-pre-bundle-slice",
    async resolve(args2) {
      const at = (path3) => path3 ? { path: path3, namespace: "nimbus-slice" } : null;
      if (args2.path.startsWith("#") && args2.resolveDir) {
        const resolved = at(resolvePackageImport(args2.path, args2.resolveDir));
        if (resolved) return resolved;
        warnings.push(`unresolved subpath import "${args2.path}" from ${args2.importer || "?"} (no owning package.json#imports entry); marked external`);
        return { external: true };
      }
      if (bare(args2.path) && isExternal(args2.path)) return { external: true };
      if (args2.path.startsWith("/")) {
        const resolved = at(tryResolve(args2.path));
        if (resolved) return resolved;
      }
      if (args2.path.startsWith(".") && args2.resolveDir) {
        const resolved = at(tryResolve(args2.resolveDir + "/" + args2.path));
        if (resolved) return resolved;
      }
      if (bare(args2.path)) {
        const conditions = args2.kind === "require-call" || args2.kind === "require-resolve" ? CJS_CONDITIONS : ESM_CONDITIONS;
        const resolved = at(resolveBarePkg(args2.path, args2.resolveDir || "/home/user", conditions));
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
  const outcome = await build3({
    entryPoints: [norm(spec.entryPath)],
    bundle: true,
    format: "esm",
    target: "esnext",
    platform: "browser",
    conditions: ESM_CONDITIONS,
    mainFields: ["module", "browser", "main"],
    define: spec.define && Object.keys(spec.define).length > 0 ? spec.define : void 0
  }, plugin);
  if (outcome.failure) return failed(outcome.errors[0]?.text || outcome.failure);
  const script = outcome.outputFiles.find((file) => !file.path.endsWith(".css")) ?? outcome.outputFiles[0];
  if (!script) return failed("no output produced");
  return { specifier: spec.specifier, ok: true, esmCode: new TextDecoder().decode(script.contents), elapsed: Date.now() - t0, warnings };
}

// scripts/rolldown-facet/entry.mjs
function build2(options, plugin) {
  return buildWithRolldown({ rolldown }, options, plugin);
}
function prebundle(spec) {
  return prebundleSlice(spec, build2);
}
export {
  build2 as build,
  prebundle
};
