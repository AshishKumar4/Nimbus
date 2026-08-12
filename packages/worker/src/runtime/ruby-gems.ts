import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { extractTarball } from '../npm/tarball.js';
import { normalizeVfsPath, parentVfsPath, resolveVfsPath } from '@nimbus-sh/core/vfs/path.js';

const RUBYGEMS_API = 'https://rubygems.org';
const DEFAULT_GEM_HOME = 'home/user/.gem';

export interface RubyGemRequest {
  name: string;
  requirements: string[];
}

export interface RubyGemInstallReport {
  installed: string[];
  alreadyInstalled: string[];
}

interface RubyGemsMetadata {
  name: string;
  version: string;
  platform?: string;
  gem_uri?: string;
  dependencies?: {
    runtime?: Array<{ name: string; requirements: string }>;
  };
}

interface RubyGemsVersionEntry {
  number?: string;
  platform?: string;
  prerelease?: boolean;
  ruby_version?: string;
}

interface InstalledGemRecord {
  name: string;
  version: string;
  platform: string;
  installedAt: number;
  dependencies: Array<{ name: string; requirements: string }>;
  executables?: string[];
}

export interface InstalledRubyGemBin {
  name: string;
  path: string;
}

export function defaultGemHome(): string {
  return DEFAULT_GEM_HOME;
}

export function installedGemLibRoots(vfs: CredentialedVfs, gemHome = DEFAULT_GEM_HOME): string[] {
  const gemsRoot = `${gemHome}/gems`;
  if (!vfs.exists(gemsRoot)) return [];
  const out: string[] = [];
  for (const entry of vfs.readdir(gemsRoot)) {
    if (entry.type !== 'directory') continue;
    const lib = `${gemsRoot}/${entry.name}/lib`;
    if (vfs.exists(lib) && vfs.isDirectory(lib)) out.push('/' + lib);
  }
  return out.sort();
}

export function installedGemBins(vfs: CredentialedVfs, gemHome = DEFAULT_GEM_HOME): InstalledRubyGemBin[] {
  const binRoot = `${normalizeVfsPath(gemHome)}/bin`;
  if (!vfs.exists(binRoot) || !vfs.isDirectory(binRoot)) return [];
  return vfs.readdir(binRoot)
    .filter((entry) => entry.type === 'file' && isValidGemExecutableName(entry.name))
    .map((entry) => ({ name: entry.name, path: `${binRoot}/${entry.name}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function installRubyGems(
  vfs: CredentialedVfs,
  requests: RubyGemRequest[],
  opts: { gemHome?: string; includeDependencies?: boolean } = {},
): Promise<RubyGemInstallReport> {
  const gemHome = normalizeVfsPath(opts.gemHome || DEFAULT_GEM_HOME);
  const includeDependencies = opts.includeDependencies !== false;
  const report: RubyGemInstallReport = { installed: [], alreadyInstalled: [] };
  const visiting = new Set<string>();

  ensureDir(vfs, `${gemHome}/gems`);
  ensureDir(vfs, `${gemHome}/specifications`);
  ensureDir(vfs, `${gemHome}/cache`);
  ensureDir(vfs, `${gemHome}/bin`);

  for (const req of requests) {
    await installOneGem(vfs, req, {
      gemHome,
      includeDependencies,
      report,
      visiting,
    });
  }

  return report;
}

export async function installRubyBundle(
  vfs: CredentialedVfs,
  cwd: string,
  opts: { gemHome?: string } = {},
): Promise<{ requests: RubyGemRequest[]; report: RubyGemInstallReport; lockfilePath: string }> {
  const gemfilePath = resolveVfsPath('Gemfile', cwd);
  if (!vfs.exists(gemfilePath)) {
    throw new Error('Gemfile not found');
  }
  const text = new TextDecoder('utf-8').decode(vfs.readFile(gemfilePath));
  const requests = parseGemfile(text);
  if (requests.length === 0) {
    throw new Error('Gemfile has no supported gem declarations');
  }
  const report = await installRubyGems(vfs, requests, {
    gemHome: opts.gemHome,
    includeDependencies: true,
  });
  const lockfilePath = resolveVfsPath('Gemfile.lock', cwd);
  const all = readInstalledGemRecords(vfs, normalizeVfsPath(opts.gemHome || DEFAULT_GEM_HOME));
  const specs = all
    .sort((a, b) => a.name.localeCompare(b.name) || compareVersions(a.version, b.version))
    .map((g) => `    ${g.name} (${g.version})`)
    .join('\n');
  vfs.writeFile(lockfilePath, [
    'GEM',
    '  remote: https://rubygems.org/',
    '  specs:',
    specs || '    (none)',
    '',
    'DEPENDENCIES',
    ...requests.map((r) => `  ${r.name}${r.requirements.length ? ' (' + r.requirements.join(', ') + ')' : ''}`),
    '',
    'BUNDLED WITH',
    '   Nimbus RubyGems',
    '',
  ].join('\n'));
  return { requests, report, lockfilePath };
}

export function parseGemfile(text: string): RubyGemRequest[] {
  const out: RubyGemRequest[] = [];
  for (const raw of text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
    const line = trimRubyComment(raw).trim();
    if (!line) continue;
    const parsed = parseGemDslLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseGemDslLine(line: string): RubyGemRequest | null {
  const argsText = gemCallArgsText(line);
  if (argsText == null) return null;
  const args = splitTopLevelRubyArgs(argsText);
  if (args.length === 0) return null;

  const first = parseRubyStringLiteral(args[0]);
  if (!first || first.includes('/')) return null;

  const requirements: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i].trim();
    if (!arg) continue;
    if (isRubyKeywordArg(arg)) {
      const key = rubyKeywordName(arg);
      if (key === 'git' || key === 'github' || key === 'path') {
        throw new Error(`Gemfile entry for ${first} uses unsupported '${key}' source; Nimbus bundle install supports RubyGems.org gems only`);
      }
      continue;
    }
    const req = parseRubyStringLiteral(arg);
    if (!req) {
      throw new Error(`Gemfile entry for ${first} has an unsupported argument: ${arg}`);
    }
    requirements.push(req);
  }

  return { name: first, requirements };
}

function gemCallArgsText(line: string): string | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('gem')) return null;
  const next = trimmed[3] || '';
  if (next !== ' ' && next !== '\t' && next !== '(') return null;
  if (next === '(') return stripSingleOuterCallParens(trimmed.slice(3));
  return trimmed.slice(3).trim();
}

function stripSingleOuterCallParens(input: string): string {
  const text = input.trim();
  if (!text.startsWith('(')) return text;
  let quote = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
      if (ch === '\\') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return text.slice(1, i).trim();
    }
  }
  return text.slice(1).trim();
}

function splitTopLevelRubyArgs(input: string): string[] {
  const args: string[] = [];
  let cur = '';
  let quote = '';
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = '';
        cur += ch;
        continue;
      }
      if (ch === '\\' && i + 1 < input.length) {
        cur += ch + input[++i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') paren++;
    else if (ch === ')' && paren > 0) paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']' && bracket > 0) bracket--;
    else if (ch === '{') brace++;
    else if (ch === '}' && brace > 0) brace--;
    if (ch === ',' && paren === 0 && bracket === 0 && brace === 0) {
      if (cur.trim()) args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

function parseRubyStringLiteral(input: string): string | null {
  const parsed = readRubyStringLiteral(input);
  if (!parsed) return null;
  return input.slice(parsed.end).trim() === '' ? parsed.value : null;
}

function readRubyStringLiteral(input: string): { value: string; end: number } | null {
  const leading = input.length - input.trimStart().length;
  const text = input.trimStart();
  const quote = text[0];
  if ((quote !== '"' && quote !== "'") || text.length < 2) return null;
  let out = '';
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === quote) {
      return { value: out, end: leading + i + 1 };
    }
    if (ch === '\\' && i + 1 < text.length) {
      out += text[++i];
    } else {
      out += ch;
    }
  }
  return null;
}

function isRubyKeywordArg(input: string): boolean {
  return rubyKeywordName(input) !== null;
}

function rubyKeywordName(input: string): string | null {
  const text = input.trim();
  if (!text) return null;

  const symbolRocket = parseRubySymbolHashRocketKey(text);
  if (symbolRocket) return symbolRocket;

  const stringRocket = parseRubyStringHashRocketKey(text);
  if (stringRocket) return stringRocket;

  const idx = text.indexOf(':');
  if (idx <= 0) return null;
  for (let i = 0; i < idx; i++) {
    const ch = text[i];
    const ok = ch === '_' ||
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      (i > 0 && ch >= '0' && ch <= '9');
    if (!ok) return null;
  }
  return text.slice(0, idx);
}

function parseRubySymbolHashRocketKey(input: string): string | null {
  if (!input.startsWith(':')) return null;
  let key = '';
  for (let i = 1; i < input.length; i++) {
    const ch = input[i];
    const ok = ch === '_' ||
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      (key.length > 0 && ch >= '0' && ch <= '9');
    if (!ok) {
      const rest = input.slice(i).trimStart();
      return key && rest.startsWith('=>') ? key : null;
    }
    key += ch;
  }
  return null;
}

function parseRubyStringHashRocketKey(input: string): string | null {
  const parsed = readRubyStringLiteral(input);
  if (!parsed) return null;
  return input.slice(parsed.end).trimStart().startsWith('=>') ? parsed.value : null;
}

function trimRubyComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = '';
      if (ch === '\\') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#') return line.slice(0, i);
  }
  return line;
}

async function installOneGem(
  vfs: CredentialedVfs,
  req: RubyGemRequest,
  ctx: {
    gemHome: string;
    includeDependencies: boolean;
    report: RubyGemInstallReport;
    visiting: Set<string>;
  },
): Promise<void> {
  const normalizedName = normalizeGemName(req.name);
  const visitKey = `${normalizedName}:${req.requirements.join(',')}`;
  if (ctx.visiting.has(visitKey)) return;
  ctx.visiting.add(visitKey);

  const metadata = await resolveGemMetadata(normalizedName, req.requirements);
  const installedKey = `${metadata.name}-${metadata.version}`;
  const gemRoot = `${ctx.gemHome}/gems/${installedKey}`;
  if (vfs.exists(`${gemRoot}/lib`) || vfs.exists(`${ctx.gemHome}/specifications/${installedKey}.gemspec`)) {
    ctx.report.alreadyInstalled.push(installedKey);
    ctx.visiting.delete(visitKey);
    return;
  }

  if (ctx.includeDependencies) {
    for (const dep of metadata.dependencies?.runtime || []) {
      await installOneGem(vfs, {
        name: dep.name,
        requirements: parseRubyGemRequirements(dep.requirements),
      }, ctx);
    }
  }

  if (!metadata.gem_uri) {
    throw new Error(`RubyGems metadata for ${metadata.name}-${metadata.version} did not include gem_uri`);
  }
  const gemBytes = await fetchGemBytes(metadata.gem_uri);
  const dataFiles = await extractGemData(gemBytes);
  const nativePath = findNativeExtensionPath(Array.from(dataFiles.keys()));
  if (nativePath) {
    throw new Error(
      `${metadata.name}-${metadata.version} contains native extension '${nativePath}', ` +
      'which is not compatible with ruby.wasm in Nimbus',
    );
  }

  ensureDir(vfs, gemRoot);
  const executables = gemExecutableNames(dataFiles);
  for (const [rel, bytes] of dataFiles) {
    const cleanRel = normalizeVfsPath(rel);
    if (!cleanRel || cleanRel.startsWith('..')) continue;
    const target = `${gemRoot}/${cleanRel}`;
    ensureDir(vfs, parentVfsPath(target));
    vfs.writeFile(target, bytes);
  }

  const specPath = `${ctx.gemHome}/specifications/${installedKey}.gemspec`;
  vfs.writeFile(specPath, buildSyntheticGemspec(metadata, executables));
  vfs.writeFile(`${ctx.gemHome}/cache/${installedKey}.gem`, gemBytes);
  for (const executable of executables) {
    writeGemExecutableWrapper(vfs, ctx.gemHome, installedKey, executable);
  }
  writeInstalledGemRecord(vfs, ctx.gemHome, {
    name: metadata.name,
    version: metadata.version,
    platform: metadata.platform || 'ruby',
    installedAt: Date.now(),
    dependencies: metadata.dependencies?.runtime || [],
    executables,
  });
  ctx.report.installed.push(installedKey);
  ctx.visiting.delete(visitKey);
}

async function resolveGemMetadata(name: string, requirements: string[]): Promise<RubyGemsMetadata> {
  const exact = exactVersionRequirement(requirements);
  if (exact) return fetchGemMetadata(name, exact);
  const versions = await fetchGemVersions(name);
  const selected = versions
    .filter((v) => !v.prerelease)
    .filter((v) => !v.platform || v.platform === 'ruby')
    .filter((v) => typeof v.number === 'string' && satisfiesRequirements(v.number!, requirements))
    .sort((a, b) => -compareVersions(a.number || '0', b.number || '0'))[0];
  if (!selected?.number) {
    throw new Error(`no ruby platform version of ${name} satisfies ${requirements.join(', ') || '>= 0'}`);
  }
  return fetchGemMetadata(name, selected.number);
}

async function fetchGemMetadata(name: string, version?: string): Promise<RubyGemsMetadata> {
  const url = version
    ? `${RUBYGEMS_API}/api/v2/rubygems/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}.json`
    : `${RUBYGEMS_API}/api/v1/gems/${encodeURIComponent(name)}.json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`RubyGems metadata fetch failed for ${name}${version ? '-' + version : ''}: HTTP ${resp.status}`);
  return await resp.json() as RubyGemsMetadata;
}

async function fetchGemVersions(name: string): Promise<RubyGemsVersionEntry[]> {
  const resp = await fetch(`${RUBYGEMS_API}/api/v1/versions/${encodeURIComponent(name)}.json`);
  if (!resp.ok) throw new Error(`RubyGems versions fetch failed for ${name}: HTTP ${resp.status}`);
  return await resp.json() as RubyGemsVersionEntry[];
}

async function fetchGemBytes(url: string): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`RubyGems download failed: HTTP ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

async function extractGemData(gemBytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const outer = await extractTarball(toArrayBuffer(gemBytes));
  const data = outer.get('data.tar.gz');
  if (!data) throw new Error('RubyGems archive missing data.tar.gz');
  return await extractTarball(toArrayBuffer(data));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function findNativeExtensionPath(paths: string[]): string | null {
  for (const path of paths) {
    const clean = normalizeVfsPath(path);
    const parts = clean.split('/').filter(Boolean);
    if (parts[0] === 'ext') return clean;
    const leaf = parts[parts.length - 1] || '';
    if (leaf.endsWith('.so') || leaf.endsWith('.bundle') || leaf.endsWith('.dll') || leaf.endsWith('.dylib')) {
      return clean;
    }
  }
  return null;
}

function buildSyntheticGemspec(metadata: RubyGemsMetadata, executables: string[]): string {
  return [
    '# Synthetic gemspec written by Nimbus RubyGems.',
    `Gem::Specification.new do |s|`,
    `  s.name = ${JSON.stringify(metadata.name)}`,
    `  s.version = ${JSON.stringify(metadata.version)}`,
    `  s.platform = ${JSON.stringify(metadata.platform || 'ruby')}`,
    `  s.summary = ${JSON.stringify('Installed by Nimbus')}`,
    `  s.files = []`,
    `  s.executables = ${JSON.stringify(executables)}`,
    `end`,
    '',
  ].join('\n');
}

function gemExecutableNames(files: Map<string, Uint8Array>): string[] {
  const names = new Set<string>();
  for (const path of files.keys()) {
    const clean = normalizeVfsPath(path);
    const parts = clean.split('/').filter(Boolean);
    if (parts.length !== 2 || parts[0] !== 'bin') continue;
    const name = parts[1];
    if (isValidGemExecutableName(name)) names.add(name);
  }
  return Array.from(names).sort();
}

function writeGemExecutableWrapper(
  vfs: CredentialedVfs,
  gemHome: string,
  installedKey: string,
  executable: string,
): void {
  const binRoot = `${gemHome}/bin`;
  ensureDir(vfs, binRoot);
  const scriptPath = `/${gemHome}/gems/${installedKey}/bin/${executable}`;
  vfs.writeFile(`${binRoot}/${executable}`, [
    '#!/usr/bin/env ruby',
    `load ${JSON.stringify(scriptPath)}`,
    '',
  ].join('\n'));
}

function writeInstalledGemRecord(vfs: CredentialedVfs, gemHome: string, record: InstalledGemRecord): void {
  const path = `${gemHome}/.nimbus-gems.json`;
  const records = readInstalledGemRecords(vfs, gemHome)
    .filter((r) => !(r.name === record.name && r.version === record.version));
  records.push(record);
  vfs.writeFile(path, JSON.stringify({ gems: records }, null, 2) + '\n');
}

function readInstalledGemRecords(vfs: CredentialedVfs, gemHome: string): InstalledGemRecord[] {
  const path = `${gemHome}/.nimbus-gems.json`;
  if (!vfs.exists(path)) return [];
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8').decode(vfs.readFile(path)));
    return Array.isArray(parsed?.gems) ? parsed.gems : [];
  } catch {
    return [];
  }
}

export function parseRubyGemRequirements(input: string | undefined): string[] {
  if (!input || input.trim() === '' || input.trim() === '>= 0') return [];
  return input
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function exactVersionRequirement(requirements: string[]): string | null {
  for (const req of requirements) {
    const parsed = parseRequirement(req);
    if (parsed && parsed.op === '=') return parsed.version;
  }
  return null;
}

function satisfiesRequirements(version: string, requirements: string[]): boolean {
  if (requirements.length === 0) return true;
  return requirements.every((req) => {
    const parsed = parseRequirement(req);
    if (!parsed) return true;
    const cmp = compareVersions(version, parsed.version);
    if (parsed.op === '=') return cmp === 0;
    if (parsed.op === '!=') return cmp !== 0;
    if (parsed.op === '>') return cmp > 0;
    if (parsed.op === '>=') return cmp >= 0;
    if (parsed.op === '<') return cmp < 0;
    if (parsed.op === '<=') return cmp <= 0;
    if (parsed.op === '~>') return cmp >= 0 && compareVersions(version, pessimisticUpperBound(parsed.version)) < 0;
    return true;
  });
}

function parseRequirement(req: string): { op: string; version: string } | null {
  const trimmed = req.trim();
  if (!trimmed) return null;
  const ops = ['>=', '<=', '!=', '~>', '=', '>', '<'];
  for (const op of ops) {
    if (trimmed.startsWith(op)) {
      const version = trimmed.slice(op.length).trim();
      return version ? { op, version } : null;
    }
  }
  return { op: '=', version: trimmed };
}

function pessimisticUpperBound(version: string): string {
  const parts = version.split('.').map((p) => Number.parseInt(p, 10)).filter((n) => Number.isFinite(n));
  if (parts.length <= 1) return String((parts[0] || 0) + 1);
  const bumpIndex = parts.length === 2 ? 0 : parts.length - 2;
  const out = parts.slice(0, bumpIndex + 1);
  out[bumpIndex] = (out[bumpIndex] || 0) + 1;
  return out.join('.');
}

function compareVersions(a: string, b: string): number {
  const aa = splitVersion(a);
  const bb = splitVersion(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const av = aa[i] ?? 0;
    const bv = bb[i] ?? 0;
    if (typeof av === 'number' && typeof bv === 'number') {
      if (av !== bv) return av - bv;
      continue;
    }
    const as = String(av);
    const bs = String(bv);
    if (as !== bs) return as < bs ? -1 : 1;
  }
  return 0;
}

function splitVersion(version: string): Array<number | string> {
  const out: Array<number | string> = [];
  let cur = '';
  let numeric = false;
  const push = () => {
    if (!cur) return;
    out.push(numeric ? Number.parseInt(cur, 10) : cur);
    cur = '';
  };
  for (const ch of version) {
    const isDigit = ch >= '0' && ch <= '9';
    if (ch === '.' || ch === '-' || ch === '_') {
      push();
      numeric = false;
      continue;
    }
    if (!cur) numeric = isDigit;
    if (cur && numeric !== isDigit) {
      push();
      numeric = isDigit;
    }
    cur += ch;
  }
  push();
  return out;
}

function normalizeGemName(name: string): string {
  const clean = name.trim();
  if (!clean) throw new Error('empty gem name');
  for (const ch of clean) {
    const ok = ch === '-' || ch === '_' || ch === '.' ||
      ch >= '0' && ch <= '9' ||
      ch >= 'a' && ch <= 'z' ||
      ch >= 'A' && ch <= 'Z';
    if (!ok) throw new Error(`unsupported gem name '${name}'`);
  }
  return clean;
}

function isValidGemExecutableName(name: string): boolean {
  if (!name || name === '.' || name === '..' || name.includes('/')) return false;
  for (const ch of name) {
    const ok = ch === '-' || ch === '_' || ch === '.' ||
      ch >= '0' && ch <= '9' ||
      ch >= 'a' && ch <= 'z' ||
      ch >= 'A' && ch <= 'Z';
    if (!ok) return false;
  }
  return true;
}

function ensureDir(vfs: CredentialedVfs, path: string): void {
  const clean = normalizeVfsPath(path);
  if (!clean) return;
  if (!vfs.exists(clean)) vfs.mkdir(clean, { recursive: true });
}
