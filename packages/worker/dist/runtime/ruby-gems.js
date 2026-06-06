import { extractTarball } from '../npm/tarball.js';
import { normalizeVfsPath, parentVfsPath, resolveVfsPath } from '../vfs/path.js';
const RUBYGEMS_API = 'https://rubygems.org';
const DEFAULT_GEM_HOME = 'home/user/.gem';
export function defaultGemHome() {
    return DEFAULT_GEM_HOME;
}
export function installedGemLibRoots(vfs, gemHome = DEFAULT_GEM_HOME) {
    const gemsRoot = `${gemHome}/gems`;
    if (!vfs.exists(gemsRoot))
        return [];
    const out = [];
    for (const entry of vfs.readdir(gemsRoot)) {
        if (entry.type !== 'directory')
            continue;
        const lib = `${gemsRoot}/${entry.name}/lib`;
        if (vfs.exists(lib) && vfs.isDirectory(lib))
            out.push('/' + lib);
    }
    return out.sort();
}
export async function installRubyGems(vfs, requests, opts = {}) {
    const gemHome = normalizeVfsPath(opts.gemHome || DEFAULT_GEM_HOME);
    const includeDependencies = opts.includeDependencies !== false;
    const report = { installed: [], alreadyInstalled: [] };
    const visiting = new Set();
    ensureDir(vfs, `${gemHome}/gems`);
    ensureDir(vfs, `${gemHome}/specifications`);
    ensureDir(vfs, `${gemHome}/cache`);
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
export async function installRubyBundle(vfs, cwd, opts = {}) {
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
export function parseGemfile(text) {
    const out = [];
    for (const raw of text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
        const line = trimRubyComment(raw).trim();
        if (!line)
            continue;
        const parsed = parseGemDslLine(line);
        if (parsed)
            out.push(parsed);
    }
    return out;
}
function parseGemDslLine(line) {
    const argsText = gemCallArgsText(line);
    if (argsText == null)
        return null;
    const args = splitTopLevelRubyArgs(argsText);
    if (args.length === 0)
        return null;
    const first = parseRubyStringLiteral(args[0]);
    if (!first || first.includes('/'))
        return null;
    const requirements = [];
    for (let i = 1; i < args.length; i++) {
        const arg = args[i].trim();
        if (!arg)
            continue;
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
function gemCallArgsText(line) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('gem'))
        return null;
    const next = trimmed[3] || '';
    if (next !== ' ' && next !== '\t' && next !== '(')
        return null;
    if (next === '(')
        return stripSingleOuterCallParens(trimmed.slice(3));
    return trimmed.slice(3).trim();
}
function stripSingleOuterCallParens(input) {
    const text = input.trim();
    if (!text.startsWith('('))
        return text;
    let quote = '';
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote)
                quote = '';
            if (ch === '\\')
                i++;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '(')
            depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0)
                return text.slice(1, i).trim();
        }
    }
    return text.slice(1).trim();
}
function splitTopLevelRubyArgs(input) {
    const args = [];
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
            }
            else {
                cur += ch;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            cur += ch;
            continue;
        }
        if (ch === '(')
            paren++;
        else if (ch === ')' && paren > 0)
            paren--;
        else if (ch === '[')
            bracket++;
        else if (ch === ']' && bracket > 0)
            bracket--;
        else if (ch === '{')
            brace++;
        else if (ch === '}' && brace > 0)
            brace--;
        if (ch === ',' && paren === 0 && bracket === 0 && brace === 0) {
            if (cur.trim())
                args.push(cur.trim());
            cur = '';
            continue;
        }
        cur += ch;
    }
    if (cur.trim())
        args.push(cur.trim());
    return args;
}
function parseRubyStringLiteral(input) {
    const parsed = readRubyStringLiteral(input);
    if (!parsed)
        return null;
    return input.slice(parsed.end).trim() === '' ? parsed.value : null;
}
function readRubyStringLiteral(input) {
    const leading = input.length - input.trimStart().length;
    const text = input.trimStart();
    const quote = text[0];
    if ((quote !== '"' && quote !== "'") || text.length < 2)
        return null;
    let out = '';
    for (let i = 1; i < text.length; i++) {
        const ch = text[i];
        if (ch === quote) {
            return { value: out, end: leading + i + 1 };
        }
        if (ch === '\\' && i + 1 < text.length) {
            out += text[++i];
        }
        else {
            out += ch;
        }
    }
    return null;
}
function isRubyKeywordArg(input) {
    return rubyKeywordName(input) !== null;
}
function rubyKeywordName(input) {
    const text = input.trim();
    if (!text)
        return null;
    const symbolRocket = parseRubySymbolHashRocketKey(text);
    if (symbolRocket)
        return symbolRocket;
    const stringRocket = parseRubyStringHashRocketKey(text);
    if (stringRocket)
        return stringRocket;
    const idx = text.indexOf(':');
    if (idx <= 0)
        return null;
    for (let i = 0; i < idx; i++) {
        const ch = text[i];
        const ok = ch === '_' ||
            (ch >= 'a' && ch <= 'z') ||
            (ch >= 'A' && ch <= 'Z') ||
            (i > 0 && ch >= '0' && ch <= '9');
        if (!ok)
            return null;
    }
    return text.slice(0, idx);
}
function parseRubySymbolHashRocketKey(input) {
    if (!input.startsWith(':'))
        return null;
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
function parseRubyStringHashRocketKey(input) {
    const parsed = readRubyStringLiteral(input);
    if (!parsed)
        return null;
    return input.slice(parsed.end).trimStart().startsWith('=>') ? parsed.value : null;
}
function trimRubyComment(line) {
    let quote = '';
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
            if (ch === quote)
                quote = '';
            if (ch === '\\')
                i++;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '#')
            return line.slice(0, i);
    }
    return line;
}
async function installOneGem(vfs, req, ctx) {
    const normalizedName = normalizeGemName(req.name);
    const visitKey = `${normalizedName}:${req.requirements.join(',')}`;
    if (ctx.visiting.has(visitKey))
        return;
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
        throw new Error(`${metadata.name}-${metadata.version} contains native extension '${nativePath}', ` +
            'which is not compatible with ruby.wasm in Nimbus');
    }
    ensureDir(vfs, gemRoot);
    for (const [rel, bytes] of dataFiles) {
        const cleanRel = normalizeVfsPath(rel);
        if (!cleanRel || cleanRel.startsWith('..'))
            continue;
        const target = `${gemRoot}/${cleanRel}`;
        ensureDir(vfs, parentVfsPath(target));
        vfs.writeFile(target, bytes);
    }
    const specPath = `${ctx.gemHome}/specifications/${installedKey}.gemspec`;
    vfs.writeFile(specPath, buildSyntheticGemspec(metadata));
    vfs.writeFile(`${ctx.gemHome}/cache/${installedKey}.gem`, gemBytes);
    writeInstalledGemRecord(vfs, ctx.gemHome, {
        name: metadata.name,
        version: metadata.version,
        platform: metadata.platform || 'ruby',
        installedAt: Date.now(),
        dependencies: metadata.dependencies?.runtime || [],
    });
    ctx.report.installed.push(installedKey);
    ctx.visiting.delete(visitKey);
}
async function resolveGemMetadata(name, requirements) {
    const exact = exactVersionRequirement(requirements);
    if (exact)
        return fetchGemMetadata(name, exact);
    const versions = await fetchGemVersions(name);
    const selected = versions
        .filter((v) => !v.prerelease)
        .filter((v) => !v.platform || v.platform === 'ruby')
        .filter((v) => typeof v.number === 'string' && satisfiesRequirements(v.number, requirements))
        .sort((a, b) => -compareVersions(a.number || '0', b.number || '0'))[0];
    if (!selected?.number) {
        throw new Error(`no ruby platform version of ${name} satisfies ${requirements.join(', ') || '>= 0'}`);
    }
    return fetchGemMetadata(name, selected.number);
}
async function fetchGemMetadata(name, version) {
    const url = version
        ? `${RUBYGEMS_API}/api/v2/rubygems/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}.json`
        : `${RUBYGEMS_API}/api/v1/gems/${encodeURIComponent(name)}.json`;
    const resp = await fetch(url);
    if (!resp.ok)
        throw new Error(`RubyGems metadata fetch failed for ${name}${version ? '-' + version : ''}: HTTP ${resp.status}`);
    return await resp.json();
}
async function fetchGemVersions(name) {
    const resp = await fetch(`${RUBYGEMS_API}/api/v1/versions/${encodeURIComponent(name)}.json`);
    if (!resp.ok)
        throw new Error(`RubyGems versions fetch failed for ${name}: HTTP ${resp.status}`);
    return await resp.json();
}
async function fetchGemBytes(url) {
    const resp = await fetch(url);
    if (!resp.ok)
        throw new Error(`RubyGems download failed: HTTP ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
}
async function extractGemData(gemBytes) {
    const outer = await extractTarball(toArrayBuffer(gemBytes));
    const data = outer.get('data.tar.gz');
    if (!data)
        throw new Error('RubyGems archive missing data.tar.gz');
    return await extractTarball(toArrayBuffer(data));
}
function toArrayBuffer(bytes) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
function findNativeExtensionPath(paths) {
    for (const path of paths) {
        const clean = normalizeVfsPath(path);
        const parts = clean.split('/').filter(Boolean);
        if (parts[0] === 'ext')
            return clean;
        const leaf = parts[parts.length - 1] || '';
        if (leaf.endsWith('.so') || leaf.endsWith('.bundle') || leaf.endsWith('.dll') || leaf.endsWith('.dylib')) {
            return clean;
        }
    }
    return null;
}
function buildSyntheticGemspec(metadata) {
    return [
        '# Synthetic gemspec written by Nimbus RubyGems.',
        `Gem::Specification.new do |s|`,
        `  s.name = ${JSON.stringify(metadata.name)}`,
        `  s.version = ${JSON.stringify(metadata.version)}`,
        `  s.platform = ${JSON.stringify(metadata.platform || 'ruby')}`,
        `  s.summary = ${JSON.stringify('Installed by Nimbus')}`,
        `  s.files = []`,
        `end`,
        '',
    ].join('\n');
}
function writeInstalledGemRecord(vfs, gemHome, record) {
    const path = `${gemHome}/.nimbus-gems.json`;
    const records = readInstalledGemRecords(vfs, gemHome)
        .filter((r) => !(r.name === record.name && r.version === record.version));
    records.push(record);
    vfs.writeFile(path, JSON.stringify({ gems: records }, null, 2) + '\n');
}
function readInstalledGemRecords(vfs, gemHome) {
    const path = `${gemHome}/.nimbus-gems.json`;
    if (!vfs.exists(path))
        return [];
    try {
        const parsed = JSON.parse(new TextDecoder('utf-8').decode(vfs.readFile(path)));
        return Array.isArray(parsed?.gems) ? parsed.gems : [];
    }
    catch {
        return [];
    }
}
export function parseRubyGemRequirements(input) {
    if (!input || input.trim() === '' || input.trim() === '>= 0')
        return [];
    return input
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
}
function exactVersionRequirement(requirements) {
    for (const req of requirements) {
        const parsed = parseRequirement(req);
        if (parsed && parsed.op === '=')
            return parsed.version;
    }
    return null;
}
function satisfiesRequirements(version, requirements) {
    if (requirements.length === 0)
        return true;
    return requirements.every((req) => {
        const parsed = parseRequirement(req);
        if (!parsed)
            return true;
        const cmp = compareVersions(version, parsed.version);
        if (parsed.op === '=')
            return cmp === 0;
        if (parsed.op === '!=')
            return cmp !== 0;
        if (parsed.op === '>')
            return cmp > 0;
        if (parsed.op === '>=')
            return cmp >= 0;
        if (parsed.op === '<')
            return cmp < 0;
        if (parsed.op === '<=')
            return cmp <= 0;
        if (parsed.op === '~>')
            return cmp >= 0 && compareVersions(version, pessimisticUpperBound(parsed.version)) < 0;
        return true;
    });
}
function parseRequirement(req) {
    const trimmed = req.trim();
    if (!trimmed)
        return null;
    const ops = ['>=', '<=', '!=', '~>', '=', '>', '<'];
    for (const op of ops) {
        if (trimmed.startsWith(op)) {
            const version = trimmed.slice(op.length).trim();
            return version ? { op, version } : null;
        }
    }
    return { op: '=', version: trimmed };
}
function pessimisticUpperBound(version) {
    const parts = version.split('.').map((p) => Number.parseInt(p, 10)).filter((n) => Number.isFinite(n));
    if (parts.length <= 1)
        return String((parts[0] || 0) + 1);
    const bumpIndex = parts.length === 2 ? 0 : parts.length - 2;
    const out = parts.slice(0, bumpIndex + 1);
    out[bumpIndex] = (out[bumpIndex] || 0) + 1;
    return out.join('.');
}
function compareVersions(a, b) {
    const aa = splitVersion(a);
    const bb = splitVersion(b);
    const len = Math.max(aa.length, bb.length);
    for (let i = 0; i < len; i++) {
        const av = aa[i] ?? 0;
        const bv = bb[i] ?? 0;
        if (typeof av === 'number' && typeof bv === 'number') {
            if (av !== bv)
                return av - bv;
            continue;
        }
        const as = String(av);
        const bs = String(bv);
        if (as !== bs)
            return as < bs ? -1 : 1;
    }
    return 0;
}
function splitVersion(version) {
    const out = [];
    let cur = '';
    let numeric = false;
    const push = () => {
        if (!cur)
            return;
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
        if (!cur)
            numeric = isDigit;
        if (cur && numeric !== isDigit) {
            push();
            numeric = isDigit;
        }
        cur += ch;
    }
    push();
    return out;
}
function normalizeGemName(name) {
    const clean = name.trim();
    if (!clean)
        throw new Error('empty gem name');
    for (const ch of clean) {
        const ok = ch === '-' || ch === '_' || ch === '.' ||
            ch >= '0' && ch <= '9' ||
            ch >= 'a' && ch <= 'z' ||
            ch >= 'A' && ch <= 'Z';
        if (!ok)
            throw new Error(`unsupported gem name '${name}'`);
    }
    return clean;
}
function ensureDir(vfs, path) {
    const clean = normalizeVfsPath(path);
    if (!clean)
        return;
    if (!vfs.exists(clean))
        vfs.mkdir(clean, { recursive: true });
}
