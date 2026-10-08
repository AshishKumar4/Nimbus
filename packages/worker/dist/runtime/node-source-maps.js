/**
 * Node's --enable-source-maps (lib/internal/source_map), which
 * --experimental-transform-types sets: a frame in a module with a source map
 * reads its original place, and so does the fatal report's arrow; and the
 * API over it (module.SourceMap, findSourceMap, get/setSourceMapsSupport,
 * process.sourceMapsEnabled, setSourceMapsEnabled). Inserted into the
 * generated node shims, after the process and fatal report it extends; its
 * stack formatter is the cell runtime's (commonjs-cell.ts __nimbusUseStackFormatter).
 */
import { NODE_SOURCE_MAP_SOURCE } from './node-inspect-source.js';
export const NODE_SOURCE_MAPS_SOURCE = `
const __NimbusSourceMap = (() => {
  const uncurryThis = (fn) => Function.prototype.call.bind(fn);
  const primordials = {
    ArrayIsArray: Array.isArray,
    ArrayPrototypePush: uncurryThis(Array.prototype.push),
    ArrayPrototypeSlice: uncurryThis(Array.prototype.slice),
    ArrayPrototypeSort: uncurryThis(Array.prototype.sort),
    ObjectPrototypeHasOwnProperty: uncurryThis(Object.prototype.hasOwnProperty),
    StringPrototypeCharAt: uncurryThis(String.prototype.charAt),
    Symbol,
  };
  const validators = {
    validateObject(value, name) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidArgType(name, "object", value);
    },
  };
  const module = { exports: {} };
  (function (exports, require, module, primordials) {
${NODE_SOURCE_MAP_SOURCE}
  })(module.exports, () => validators, module, primordials);
  return module.exports.SourceMap;
})();
const __nimbusSourceMapsAtLaunch = __nimbusNodeCommandLine?.enableSourceMaps === true;
let __nimbusSourceMapsSupport = Object.freeze({
  __proto__: null, enabled: __nimbusSourceMapsAtLaunch, nodeModules: __nimbusSourceMapsAtLaunch, generatedCode: __nimbusSourceMapsAtLaunch,
});
function __nimbusSetSourceMapsSupport(enabled, options = {}) {
  if (typeof enabled !== "boolean") throw invalidArgType("enabled", "boolean", enabled);
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw invalidArgType("options", "object", options);
  const { nodeModules = false, generatedCode = false } = options;
  if (typeof nodeModules !== "boolean") throw invalidArgType("options.nodeModules", "boolean", nodeModules);
  if (typeof generatedCode !== "boolean") throw invalidArgType("options.generatedCode", "boolean", generatedCode);
  __nimbusSourceMapsSupport = Object.freeze({ __proto__: null, enabled, nodeModules, generatedCode });
}
Object.defineProperty(__processMod, "sourceMapsEnabled", {
  get() { return __nimbusSourceMapsSupport.enabled; }, enumerable: true, configurable: true,
});
__processMod.setSourceMapsEnabled = function setSourceMapsEnabled(val) {
  __nimbusSetSourceMapsSupport(val, { nodeModules: val, generatedCode: val });
};
function __nimbusUnderNodeModules(file) {
  return /[\\\\/]node_modules[\\\\/]/.test(file);
}
// Node's source map cache (source_map_cache.js maybeCacheSourceMap): a
// module's map is read when the module compiles while source maps are on,
// kept by its file's URL and by its sourceURL, and only looked up after.
const __nimbusSourceMapEntries = new Map();
function __nimbusReferrerUrl(name) {
  if (typeof name !== "string") return undefined;
  if (__pathMod.isAbsolute(name)) return __urlMod.pathToFileURL(name).href;
  return name.startsWith("file://") || URL.canParse(name) ? name : undefined;
}
function __nimbusMagicComment(content, name) {
  const magic = new RegExp("\\/[*/]#\\s+" + name + "=(?<value>[^\\s]+)", "g");
  let last = null;
  for (let match; (match = magic.exec(content)) !== null;) last = match;
  return last === null ? null : last.groups.value;
}
// A module compiling: \`file\` its path or URL, \`source\` a function of its text.
function __nimbusCompiling(file, source) {
  const support = __nimbusSourceMapsSupport;
  if (!support.enabled) return;
  const filename = __nimbusReferrerUrl(file);
  if (filename === undefined || (!support.nodeModules && __nimbusUnderNodeModules(filename))) return;
  const content = source();
  if (typeof content !== "string") return;
  const sourceMappingURL = __nimbusMagicComment(content, "sourceMappingURL");
  if (sourceMappingURL === null) return;
  let sourceURL = __nimbusMagicComment(content, "sourceURL");
  if (sourceURL !== null && !/^\\w+:\\/\\//.test(sourceURL)) sourceURL = __urlMod.pathToFileURL(sourceURL).href;
  const entry = { data: __nimbusSourceMapData(filename, sourceMappingURL), lineLengths: __nimbusLineLengths(content), sourceMap: undefined };
  __nimbusSourceMapEntries.set(filename, entry);
  const alias = __nimbusReferrerUrl(sourceURL);
  if (alias !== undefined) __nimbusSourceMapEntries.set(alias, entry);
}
function __nimbusFindSourceMap(sourceURL) {
  if (typeof sourceURL !== "string" || sourceURL.startsWith("node:")) return undefined;
  if (!__nimbusSourceMapsSupport.nodeModules && __nimbusUnderNodeModules(sourceURL)) return undefined;
  try {
    const entry = __nimbusSourceMapEntries.get(/^\\w+:\\/\\//.test(sourceURL) ? sourceURL : __urlMod.pathToFileURL(sourceURL).href);
    if (entry?.data == null) return undefined;
    entry.sourceMap ??= new __NimbusSourceMap(entry.data, { lineLengths: entry.lineLengths });
    return entry.sourceMap;
  } catch {
    return undefined;
  }
}
function __nimbusSourceMapData(sourceURL, sourceMappingURL) {
  let url = null;
  try { url = new URL(sourceMappingURL); } catch {}
  if (url !== null) return url.protocol === "data:" ? __nimbusSourceMapFromDataUrl(sourceURL, url.pathname) : null;
  try {
    const mapURL = new URL(sourceMappingURL, sourceURL);
    const text = __readFileOr(builtins.url.fileURLToPath(mapURL), null);
    return text === null ? null : __nimbusSourcesToAbsolute(mapURL, JSON.parse(text));
  } catch {
    return null;
  }
}
function __nimbusSourceMapFromDataUrl(sourceURL, url) {
  const [format, data] = url.split(",", 2);
  const parts = format.split(";");
  if (parts[0] !== "application/json") return null;
  try {
    const text = parts[parts.length - 1] === "base64" ? __BufferMod.from(data, "base64").toString("utf8") : data;
    return __nimbusSourcesToAbsolute(sourceURL, JSON.parse(text));
  } catch {
    return null;
  }
}
function __nimbusSourcesToAbsolute(baseURL, data) {
  data.sources = data.sources.map((source) => {
    source = (data.sourceRoot || "") + source;
    return __pathMod.isAbsolute(source) ? __urlMod.pathToFileURL(source).href : new URL(source, baseURL).href;
  });
  data.sourceRoot = "";
  return data;
}
function __nimbusLineLengths(content) {
  const output = [];
  let lineLength = 0;
  for (let i = 0; i < content.length; i++, lineLength++) {
    const codePoint = content.codePointAt(i);
    if (codePoint === 10 || codePoint === 0x2028 || codePoint === 0x2029) {
      output.push(lineLength);
      lineLength = -1;
    }
  }
  output.push(lineLength);
  return output;
}
// Generated places of an error's frames, where its stack reads original ones: the fatal report's.
const __nimbusGeneratedFrames = new WeakMap();
// Node's prepareStackTraceWithSourceMaps, over the cell runtime's call sites; null when source maps are off.
function __nimbusSourceMappedStack(error, header, callSites) {
  if (!__nimbusSourceMapsSupport.enabled) return null;
  const sites = callSites.map(__NimbusCallSite.of);
  let stack = header;
  let lastFileName;
  let lastSourceMap;
  let mapped = false;
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    let frame = null;
    try {
      let fileName = site.getFileName();
      if (fileName === undefined) fileName = site.getEvalOrigin();
      const sm = fileName === lastFileName ? lastSourceMap : __nimbusFindSourceMap(fileName);
      if (sm) {
        lastSourceMap = sm;
        lastFileName = fileName;
        frame = __nimbusSourceMappedFrame(sm, site, sites[i + 1]);
        mapped = true;
      }
    } catch {}
    stack += "\\n    at " + (frame ?? String(site));
  }
  if (mapped) __nimbusGeneratedFrames.set(error, sites.map((site) => [site.getFileName(), site.getLineNumber(), site.getColumnNumber()]));
  return stack;
}
if (typeof __nimbusUseStackFormatter === "function") __nimbusUseStackFormatter(__nimbusSourceMappedStack);
function __nimbusSourceMappedFrame(sm, site, caller) {
  const { originalLine, originalColumn, originalSource } = sm.findEntry(site.getLineNumber() - 1, site.getColumnNumber() - 1);
  if (originalSource === undefined || originalLine === undefined || originalColumn === undefined) return String(site);
  const name = __nimbusOriginalSymbolName(sm, site, caller);
  const source = originalSource.startsWith("file://") ? builtins.url.fileURLToPath(originalSource) : originalSource;
  const fnName = site.getFunctionName() ?? site.getMethodName();
  const prefix = site.isAsync() ? "async " : site.isConstructor() ? "new " : "";
  const typeName = site.getTypeName();
  const namePrefix = typeName !== null && typeName !== "global" ? typeName + "." : "";
  const mappedName = namePrefix + (name || (fnName || "<anonymous>")) || "";
  return prefix + mappedName + " (" + source + ":" + (originalLine + 1) + ":" + (originalColumn + 1) + ")";
}
function __nimbusOriginalSymbolName(sm, site, caller) {
  const enclosing = sm.findEntry(site.getEnclosingLineNumber() - 1, site.getEnclosingColumnNumber() - 1);
  if (enclosing.name) return enclosing.name;
  if (caller && site.getFileName() === caller.getFileName()) return sm.findEntry(caller.getLineNumber() - 1, caller.getColumnNumber() - 1).name;
  return undefined;
}
// Node's getSourceMapErrorSource: the fatal report's arrow at the original
// place of \`offset\` in a module's text, or null where the map has none.
function __nimbusSourceMappedArrow(module, text, offset) {
  if (!__nimbusSourceMapsSupport.enabled) return null;
  const sm = __nimbusFindSourceMap(__nimbusFrameFile(module));
  if (sm === undefined) return null;
  try {
    const lines = text.slice(0, offset).split(/\\r\\n|[\\n\\r\\u2028\\u2029]/);
    const emittedLine = lines.length;
    const emitted = lines[emittedLine - 1].length - (emittedLine === 1 ? module.head : 0);
    const { originalLine, originalColumn, originalSource } = sm.findEntry(emittedLine - 1, __nimbusSourceColumn(module, emittedLine, emitted + 1) - 1);
    const { sources, sourcesContent } = sm.payload;
    const index = sources.indexOf(originalSource);
    const source = sourcesContent?.[index]
      || (originalSource.startsWith("file://") ? __readFileOr(builtins.url.fileURLToPath(originalSource), undefined) : undefined);
    if (typeof source !== "string") return null;
    const line = source.split(/\\r?\\n/, originalLine + 1)[originalLine];
    if (!line) return null;
    const getStringWidth = __nimbusNodeInspect().getStringWidth;
    let prefix = "";
    for (const character of line.slice(0, originalColumn + 1)) prefix += character === "\\t" ? "\\t" : " ".repeat(getStringWidth(character));
    const path = originalSource.startsWith("file://") ? builtins.url.fileURLToPath(originalSource) : originalSource;
    return path + ":" + (originalLine + 1) + "\\n" + line + "\\n" + prefix.slice(0, -1) + "^\\n";
  } catch {
    return null;
  }
}
`;
