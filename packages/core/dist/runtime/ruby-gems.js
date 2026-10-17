import { direntTypeIn } from '../vfs/dirent-type.js';
import { extractTarball } from '../_shared/tarball.js';
import { toArrayBuffer } from '../_shared/bytes.js';
import { normalizeVfsPath, parentVfsPath, resolveVfsPath } from '../vfs/path.js';
import { isVfsError } from '../vfs/vfs-error.js';
const RUBYGEMS_API = 'https://rubygems.org';
/** Where `gem install` puts gems for the user whose home is `home`, as `gem --user-install` does. */
export function gemHomeFor(home) {
    return `${normalizeVfsPath(home)}/.gem`;
}
/**
 * The installed gems' lib directories Ruby's load path is given ahead of
 * RubyGems: each version the specifications name (`gems/<name>-<version>/lib`,
 * where that is a directory), the one inventory, so a gem whose install was
 * interrupted has none. A gem whose version RubyGems must choose is left out,
 * for `require` to activate it as RubyGems does: one with two versions
 * installed, and one whose runtime dependencies reach such a gem at any depth
 * (its requirements choose the version). A home with no version to choose
 * costs no activation, and RubyGems does not read it at all.
 */
export async function installedGemLoadPath(vfs, gemHome) {
    const home = normalizeVfsPath(gemHome);
    const installed = await Promise.all((await gemSpecFiles(vfs, home)).map(async (path) => ({ path, spec: await readGemSpec(vfs, path) })));
    const specs = installed.flatMap(({ spec }) => (spec === null ? [] : [spec]));
    const versions = new Map();
    for (const spec of specs)
        versions.set(spec.name, (versions.get(spec.name) ?? 0) + 1);
    const chosen = new Set([...versions].filter(([, count]) => count > 1).map(([name]) => name));
    for (let grew = chosen.size > 0; grew;) {
        grew = false;
        for (const spec of specs) {
            if (!chosen.has(spec.name) && spec.dependencies.some((dep) => chosen.has(dep.name))) {
                chosen.add(spec.name);
                grew = true;
            }
        }
    }
    const libs = [];
    for (const { path, spec } of installed) {
        if (spec !== null && chosen.has(spec.name))
            continue;
        const lib = `${home}/gems/${path.slice(path.lastIndexOf('/') + 1, -'.gemspec'.length)}/lib`;
        if ((await vfs.exists(lib)) && (await vfs.isDirectory(lib)))
            libs.push('/' + lib);
    }
    return { libs: libs.sort(), activates: chosen.size > 0 };
}
/** The wrapper an earlier Nimbus wrote for a gem executable: one version's, loaded whatever RubyGems would choose. */
const LEGACY_GEM_WRAPPER = /^#!\/usr\/bin\/env ruby\nload "\/(.+)\/gems\/([^/"]+)\/bin\/([^/"]+)"\n$/;
/**
 * Every gem-bin wrapper in `gemHome` that an earlier Nimbus wrote, written
 * again as writeGemExecutableWrapper writes one now, so that RubyGems chooses
 * its executable where it chooses its version. Its gem is named by its
 * specification (readGemSpec). Run before the bins are registered; a wrapper
 * already current is read and left alone.
 */
export async function reconcileGemBinWrappers(vfs, gemHome) {
    const home = normalizeVfsPath(gemHome);
    for (const bin of await installedGemBins(vfs, home)) {
        let text;
        try {
            text = new TextDecoder('utf-8').decode(await vfs.readFile(bin.path));
        }
        catch {
            continue;
        }
        const [, root, key, executable] = LEGACY_GEM_WRAPPER.exec(text) ?? [];
        if (root !== home || executable !== bin.name || key === undefined)
            continue;
        const spec = await readGemSpec(vfs, `${home}/specifications/${key}.gemspec`);
        if (spec !== null)
            await writeGemExecutableWrapper(vfs, home, spec.name, key, bin.name);
    }
}
export async function installedGemBins(vfs, gemHome) {
    const binRoot = `${normalizeVfsPath(gemHome)}/bin`;
    if (!(await vfs.exists(binRoot)) || !(await vfs.isDirectory(binRoot)))
        return [];
    const bins = [];
    for (const entry of await vfs.readdir(binRoot)) {
        if (!isValidGemExecutableName(entry.name) || (await direntTypeIn(vfs, binRoot, entry)) !== 'file')
            continue;
        bins.push({ name: entry.name, path: `${binRoot}/${entry.name}` });
    }
    return bins.sort((a, b) => a.name.localeCompare(b.name));
}
export async function installRubyGems(vfs, requests, 
/** `network`: the workspace's; RubyGems is reached through its egress, when it has one. */
opts) {
    return (await installGemSet(vfs, requests, opts)).report;
}
/** installRubyGems, and each gem it settled on, by name: what it installed, or found installed. */
async function installGemSet(vfs, requests, opts) {
    const gemHome = normalizeVfsPath(opts.gemHome);
    const includeDependencies = opts.includeDependencies !== false;
    const report = { installed: [], alreadyInstalled: [] };
    const visiting = new Set();
    const chosen = new Map();
    (await ensureDir(vfs, `${gemHome}/gems`));
    (await ensureDir(vfs, `${gemHome}/specifications`));
    (await ensureDir(vfs, `${gemHome}/cache`));
    (await ensureDir(vfs, `${gemHome}/bin`));
    for (const req of requests) {
        await installOneGem(vfs, req, {
            gemHome,
            includeDependencies,
            report,
            visiting,
            chosen,
            network: opts.network,
        });
    }
    return { report, chosen };
}
export async function installRubyBundle(vfs, cwd, opts) {
    const gemfilePath = resolveVfsPath('Gemfile', cwd);
    if (!(await vfs.exists(gemfilePath))) {
        throw new Error('Gemfile not found');
    }
    const text = new TextDecoder('utf-8').decode((await vfs.readFile(gemfilePath)));
    const requests = parseGemfile(text);
    if (requests.length === 0) {
        throw new Error('Gemfile has no supported gem declarations');
    }
    const { chosen, report } = await installGemSet(vfs, requests, {
        gemHome: opts.gemHome,
        includeDependencies: true,
        network: opts.network,
    });
    const lockfilePath = resolveVfsPath('Gemfile.lock', cwd);
    const graph = await bundleGraph(vfs, normalizeVfsPath(opts.gemHome), requests, chosen);
    const specs = graph
        .sort((a, b) => a.name.localeCompare(b.name) || compareVersions(a.version, b.version))
        .map((g) => `    ${g.name} (${g.version})`)
        .join('\n');
    (await vfs.writeFile(lockfilePath, [
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
    ].join('\n')));
    return { requests, report, lockfilePath };
}
/**
 * The gems a bundle locks, as Bundler's resolution names them: each Gemfile
 * request and, transitively, each runtime dependency, at the version this
 * install settled on (`chosen`); a dependency of a gem found installed, at
 * the highest installed version satisfying it. Nothing else installed
 * enters the lock.
 */
async function bundleGraph(vfs, gemHome, requests, chosen) {
    const files = await gemSpecFiles(vfs, gemHome);
    const pick = async (name, requirements) => chosen.get(name)
        ?? (await installedGemSpecs(vfs, gemHome, name, files))
            .filter((spec) => satisfiesRequirements(spec.version, [...requirements]))
            .sort((a, b) => -compareVersions(a.version, b.version))[0];
    const locked = new Map();
    const walk = async (name, requirements) => {
        if (locked.has(name))
            return;
        const spec = await pick(name, requirements);
        if (spec === undefined)
            return;
        locked.set(name, spec);
        for (const dep of spec.dependencies)
            await walk(dep.name, dep.requirements);
    };
    for (const request of requests)
        await walk(normalizeGemName(request.name), request.requirements);
    return [...locked.values()];
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
    const metadata = await resolveGemMetadata(ctx.network, normalizedName, req.requirements);
    const installedKey = `${metadata.name}-${metadata.version}`;
    const gemRoot = `${ctx.gemHome}/gems/${installedKey}`;
    const specPath = `${ctx.gemHome}/specifications/${installedKey}.gemspec`;
    const dependencies = (metadata.dependencies?.runtime || []).map((dep) => ({ name: dep.name, requirements: parseRubyGemRequirements(dep.requirements) }));
    ctx.chosen.set(metadata.name, { name: metadata.name, version: metadata.version, dependencies });
    // Installed is what its specification says is (RubyGems' own test): written last, after everything else.
    if ((await gemSpecText(vfs, specPath)) !== null) {
        ctx.report.alreadyInstalled.push(installedKey);
        ctx.visiting.delete(visitKey);
        return;
    }
    if (ctx.includeDependencies) {
        for (const dep of dependencies)
            await installOneGem(vfs, dep, ctx);
    }
    if (!metadata.gem_uri) {
        throw new Error(`RubyGems metadata for ${metadata.name}-${metadata.version} did not include gem_uri`);
    }
    const gemBytes = await fetchGemBytes(ctx.network, metadata.gem_uri);
    const dataFiles = await extractGemData(gemBytes);
    const nativePath = findNativeExtensionPath(Array.from(dataFiles.keys()));
    if (nativePath) {
        throw new Error(`${metadata.name}-${metadata.version} contains native extension '${nativePath}', ` +
            'which is not compatible with ruby.wasm in Nimbus');
    }
    (await ensureDir(vfs, gemRoot));
    const executables = gemExecutableNames(dataFiles);
    for (const [rel, bytes] of dataFiles) {
        const cleanRel = normalizeVfsPath(rel);
        if (!cleanRel || cleanRel.startsWith('..'))
            continue;
        const target = `${gemRoot}/${cleanRel}`;
        (await ensureDir(vfs, parentVfsPath(target)));
        (await vfs.writeFile(target, bytes));
    }
    (await vfs.writeFile(`${ctx.gemHome}/cache/${installedKey}.gem`, gemBytes));
    for (const executable of executables) {
        (await writeGemExecutableWrapper(vfs, ctx.gemHome, metadata.name, installedKey, executable));
    }
    (await vfs.writeFile(specPath, buildSyntheticGemspec(metadata, executables, dependencies)));
    ctx.report.installed.push(installedKey);
    ctx.visiting.delete(visitKey);
}
/**
 * The version of `name` a request with `requirements` installs: a pure-Ruby
 * build that holds every requirement. An exact requirement names the
 * version to fetch, and is held to the rest like any other; otherwise the
 * newest release that holds them.
 */
async function resolveGemMetadata(network, name, requirements) {
    const installable = (version, platform) => (!platform || platform === 'ruby') && satisfiesRequirements(version, requirements);
    const version = exactVersionRequirement(requirements) ?? (await fetchGemVersions(network, name))
        .flatMap((v) => (!v.prerelease && typeof v.number === 'string' && installable(v.number, v.platform) ? [v.number] : []))
        .sort((a, b) => -compareVersions(a, b))[0];
    if (version !== undefined && satisfiesRequirements(version, requirements)) {
        const metadata = await fetchGemMetadata(network, name, version);
        if (installable(metadata.version, metadata.platform))
            return metadata;
    }
    throw new Error(`no ruby platform version of ${name} satisfies ${requirements.join(', ') || '>= 0'}`);
}
async function fetchGemMetadata(network, name, version) {
    const resp = await network.fetch(`${RUBYGEMS_API}/api/v2/rubygems/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}.json`);
    if (!resp.ok)
        throw new Error(`RubyGems metadata fetch failed for ${name}-${version}: HTTP ${resp.status}`);
    return await resp.json();
}
async function fetchGemVersions(network, name) {
    const resp = await network.fetch(`${RUBYGEMS_API}/api/v1/versions/${encodeURIComponent(name)}.json`);
    if (!resp.ok)
        throw new Error(`RubyGems versions fetch failed for ${name}: HTTP ${resp.status}`);
    return await resp.json();
}
async function fetchGemBytes(network, url) {
    const resp = await network.fetch(url);
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
/** The first line of a specification this installer writes, its runtime dependencies recorded (readGemSpec). */
const GEMSPEC_HEADER = '# Gem::Specification written by Nimbus RubyGems, its runtime dependencies recorded.';
function buildSyntheticGemspec(metadata, executables, dependencies) {
    return [
        GEMSPEC_HEADER,
        // RubyGems' stub line (StubSpecification): it lists a gem without evaluating its specification.
        `# stub: ${metadata.name} ${metadata.version} ${metadata.platform || 'ruby'} lib`,
        `Gem::Specification.new do |s|`,
        `  s.name = ${JSON.stringify(metadata.name)}`,
        `  s.version = ${JSON.stringify(metadata.version)}`,
        `  s.platform = ${JSON.stringify(metadata.platform || 'ruby')}`,
        `  s.summary = ${JSON.stringify('Installed by Nimbus')}`,
        `  s.files = []`,
        `  s.executables = ${JSON.stringify(executables)}`,
        ...dependencies.map((dep) => `  s.add_runtime_dependency ${JSON.stringify(dep.name)}, ${JSON.stringify(dep.requirements)}`),
        `end`,
        '',
    ].join('\n');
}
/**
 * The installed gem a specification at `path` records: its name, version
 * and runtime dependencies; null where there is none, or one this installer
 * did not finish (one written before it recorded dependencies is installed
 * again).
 */
async function readGemSpec(vfs, path) {
    const text = await gemSpecText(vfs, path);
    if (text === null)
        return null;
    const field = (name) => {
        const match = new RegExp(`^  s\\.${name} = ("(?:[^"\\\\]|\\\\.)*")$`, 'm').exec(text);
        return match === null ? null : JSON.parse(match[1]);
    };
    const name = field('name');
    const version = field('version');
    if (name === null || version === null)
        return null;
    const dependencies = [];
    for (const match of text.matchAll(/^  s\.add_runtime_dependency ("(?:[^"\\]|\\.)*"), (\[.*\])$/gm)) {
        dependencies.push({ name: JSON.parse(match[1]), requirements: JSON.parse(match[2]) });
    }
    return { name, version, dependencies };
}
/** A specification's text, where it is one this installer finished (readGemSpec); null otherwise. */
async function gemSpecText(vfs, path) {
    let text;
    try {
        text = new TextDecoder('utf-8').decode(await vfs.readFile(path));
    }
    catch (error) {
        if (isVfsError(error, 'ENOENT') || isVfsError(error, 'EISDIR'))
            return null;
        throw error;
    }
    return text.startsWith(GEMSPEC_HEADER + '\n') ? text : null;
}
/** The specifications in `gemHome`: each file's path, read when asked for (installedGemSpecs). */
async function gemSpecFiles(vfs, gemHome) {
    const root = `${gemHome}/specifications`;
    if (!(await vfs.exists(root)))
        return [];
    return (await vfs.readdir(root)).filter((entry) => entry.name.endsWith('.gemspec')).map((entry) => `${root}/${entry.name}`);
}
/** Every gem installed in `gemHome` (`named`: of that name only; `files`: its specifications, gemSpecFiles'). */
async function installedGemSpecs(vfs, gemHome, named, files) {
    const specs = [];
    for (const path of files ?? await gemSpecFiles(vfs, gemHome)) {
        if (named !== undefined && !path.slice(path.lastIndexOf('/') + 1).startsWith(`${named}-`))
            continue;
        const spec = await readGemSpec(vfs, path);
        if (spec !== null && (named === undefined || spec.name === named))
            specs.push(spec);
    }
    return specs;
}
function gemExecutableNames(files) {
    const names = new Set();
    for (const path of files.keys()) {
        const clean = normalizeVfsPath(path);
        const parts = clean.split('/').filter(Boolean);
        if (parts.length !== 2 || parts[0] !== 'bin')
            continue;
        const name = parts[1];
        if (isValidGemExecutableName(name))
            names.add(name);
    }
    return Array.from(names).sort();
}
async function writeGemExecutableWrapper(vfs, gemHome, name, installedKey, executable) {
    const binRoot = `${gemHome}/bin`;
    (await ensureDir(vfs, binRoot));
    const scriptPath = `/${gemHome}/gems/${installedKey}/bin/${executable}`;
    // An executable on PATH, as RubyGems writes it: a prior wrapper removed,
    // then the new one created 0755 (less the umask).
    const wrapperPath = `${binRoot}/${executable}`;
    try {
        await vfs.unlink(wrapperPath);
    }
    catch (error) {
        if (!isVfsError(error, 'ENOENT'))
            throw error;
    }
    // Where RubyGems chooses the gem's version (installedGemLoadPath left its
    // lib to it), it chooses the executable too, as its own binstubs do; else
    // this version's runs, with its lib on the load path.
    const lib = `/${gemHome}/gems/${installedKey}/lib`;
    (await vfs.writeFile(wrapperPath, [
        '#!/usr/bin/env ruby',
        `if ENV["NIMBUS_GEM_ACTIVATE"] == "1" && !ENV["NIMBUS_GEM_LIBS"].to_s.split(":").include?(${JSON.stringify(lib)})`,
        `  load Gem.activate_bin_path(${JSON.stringify(name)}, ${JSON.stringify(executable)}, ">= 0.a")`,
        'else',
        `  load ${JSON.stringify(scriptPath)}`,
        'end',
        '',
    ].join('\n'), { mode: 0o755 }));
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
/** Every character is one a gem or gem executable name may hold: `[-_.0-9A-Za-z]`. */
function isGemNameCharset(name) {
    for (const ch of name) {
        const ok = ch === '-' || ch === '_' || ch === '.' ||
            ch >= '0' && ch <= '9' ||
            ch >= 'a' && ch <= 'z' ||
            ch >= 'A' && ch <= 'Z';
        if (!ok)
            return false;
    }
    return true;
}
function normalizeGemName(name) {
    const clean = name.trim();
    if (!clean)
        throw new Error('empty gem name');
    if (!isGemNameCharset(clean))
        throw new Error(`unsupported gem name '${name}'`);
    return clean;
}
function isValidGemExecutableName(name) {
    if (!name || name === '.' || name === '..' || name.includes('/'))
        return false;
    return isGemNameCharset(name);
}
async function ensureDir(vfs, path) {
    const clean = normalizeVfsPath(path);
    if (!clean)
        return;
    if (!(await vfs.exists(clean)))
        (await vfs.mkdir(clean, { recursive: true }));
}
