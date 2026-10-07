/**
 * npm-init.ts — `npm init`, `npm create` and `npm innit` as npm 10.9.8 runs
 * them (lib/commands/init.js): with an initializer, the package it names
 * (npmInitializerPackage); without, the package.json init-package-json 7.0.2
 * writes (npmInitTemplate).
 *
 * The template is init-package-json's: the package.json that is there, read
 * and normalized (@npmcli/package-json 6.2.0's default steps), then each of
 * lib/default-input.js's fields in its order, asked as promzard asks it
 * (npm's `read`: `name: (default) `, an invalid answer told and asked again)
 * or, under `yes` or `force`, its default; npm's configuration (npm-config.ts)
 * gives the defaults it reads (init-author-*, init-license, init-version,
 * scope, save-exact, save-prefix). The answers are assigned over the
 * package.json, normalized with init's extra steps and normalize-package-data,
 * shown, confirmed unless under `yes`, and written in the file's own indent
 * and line ending. Repository URLs are npm's own hosted-git-info's, names and
 * licenses npm's own validators', versions npm's own semver's.
 *
 * Named limits: a directory's entries are read in sorted order (npm reads the
 * main and bin candidates in the operating system's order), and an
 * `init-module` (~/.npm-init.js) is not run.
 */
import hostedGitInfo from 'hosted-git-info';
import npa from 'npm-package-arg';
import semver from 'semver';
import validateLicense from 'validate-npm-package-license';
import validateName from 'validate-npm-package-name';
import { normalizePackageJsonBin } from '../../../../runtime/npm-bin-map.js';
import { join } from '../../utils/path.js';
import { loadNpmConfig, parseNpmArgv } from './npm-config.js';
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const NO_TEST = 'echo "Error: no test specified" && exit 1';
const NO_README = 'ERROR: No README data found!';
/** What lib/commands/init.js prints before the questions. */
const INTRO = [
    'This utility will walk you through creating a package.json file.',
    'It only covers the most common items, and tries to guess sensible defaults.',
    '',
    'See `npm help init` for definitive documentation on these fields',
    'and exactly what they do.',
    '',
    'Use `npm install <pkg>` afterwards to install a package and',
    'save it as a dependency in the package.json file.',
    '',
    'Press ^C at any time to quit.',
].join('\n');
/** An npm error: its code, and its message's lines, each printed `npm error <line>`. */
export class NpmError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}
/**
 * The package `npm init <initializer>` runs (init.js execCreate): `@scope`
 * is `@scope/create`, a hosted git repository `user/project` is
 * `user/create-project`, a registry package `name@spec` is
 * `create-name@spec` (`@scope/create-name@spec` for a scoped one); anything
 * else is not an initializer.
 */
export function npmInitializerPackage(initializer) {
    if (/^@[^/]+$/.test(initializer)) {
        const [, scope, version] = initializer.split('@');
        return `@${scope}/create` + (version ? `@${version}` : '');
    }
    let spec;
    try {
        spec = npa(initializer);
    }
    catch (error) {
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
        throw new NpmError(error instanceof Error ? error.message : String(error), code);
    }
    if (spec.type === 'git' && spec.hosted) {
        const { user, project } = spec.hosted;
        return initializer.replace(`${user}/${project}`, `${user}/create-${project}`);
    }
    if (spec.registry && spec.name !== null)
        return `${spec.name.replace(/^(@[^/]+\/)?/, '$1create-')}@${spec.rawSpec}`;
    throw new NpmError(`Unrecognized initializer: ${initializer}\nFor more package binary executing power check out \`npx\`:\nhttps://docs.npmjs.com/cli/commands/npx`, 'EUNSUPPORTED');
}
/**
 * `npm init`, `npm create` and `npm innit` (npm.ts loads this module for
 * them): with an initializer, npm exec's run of the package it names (npx);
 * without, npm's own package.json, asked for on the command's input unless
 * under `yes`.
 */
export async function npmInitCommand(ctx) {
    const fail = async (error) => {
        if (!(error instanceof NpmError))
            throw error;
        if (error.code)
            await ctx.stderr.write(`npm error code ${error.code}\n`);
        for (const line of error.message.split('\n'))
            await ctx.stderr.write(`npm error ${line}\n`);
        return 1;
    };
    const argv = parseNpmArgv(ctx.args.slice(1));
    const config = await loadNpmConfig(ctx.vfs, ctx.cwd, ctx.env, argv);
    for (const warning of config.warnings)
        await ctx.stderr.write(`npm warn ${warning}\n`);
    if (config.get('force'))
        await ctx.stderr.write('npm warn using --force Recommended protections disabled.\n');
    const [initializer, ...rest] = argv.positionals;
    if (initializer !== undefined) {
        let initializerPackage;
        try {
            initializerPackage = npmInitializerPackage(initializer);
        }
        catch (error) {
            return fail(error);
        }
        return (await ctx.runAs(ctx.cred, ['npx', '--yes', initializerPackage, ...rest])).status;
    }
    const input = answerReader(ctx);
    let outcome;
    try {
        outcome = await npmInitTemplate(ctx.vfs, ctx.cwd, config, {
            print: async (text) => { await ctx.stdout.write(text); },
            ask: async (question) => {
                await ctx.stdout.write(question);
                return input();
            },
        });
    }
    catch (error) {
        if (!(error instanceof NpmInitCanceled))
            return fail(error);
        await ctx.stderr.write('npm warn init canceled\n');
        outcome = 'aborted';
    }
    // Input that ends mid-question ends npm with nothing more said.
    if (outcome === 'ended')
        return 1;
    await ctx.stdout.write('\n');
    return 0;
}
/** One line of the command's input per call (null at its end); ^C (the command's signal) cancels. */
function answerReader(ctx) {
    let buffered = '';
    let ended = false;
    const line = async () => {
        const stdin = ctx.stdin;
        if (!stdin)
            return null;
        if (stdin.readLine && buffered === '')
            return stdin.readLine();
        while (!ended && !buffered.includes('\n')) {
            const chunk = await stdin.read();
            if (chunk === null)
                ended = true;
            else
                buffered += chunk;
        }
        if (buffered === '' && ended)
            return null;
        const end = buffered.indexOf('\n');
        const answer = end === -1 ? buffered : buffered.slice(0, end);
        buffered = end === -1 ? '' : buffered.slice(end + 1);
        return answer;
    };
    return () => new Promise((resolve, reject) => {
        if (ctx.signal.aborted) {
            reject(new NpmInitCanceled());
            return;
        }
        const cancel = () => reject(new NpmInitCanceled());
        ctx.signal.addEventListener('abort', cancel, { once: true });
        line().then(resolve, reject).finally(() => ctx.signal.removeEventListener('abort', cancel));
    });
}
/** ^C at a question: npm warns `init canceled`. */
export class NpmInitCanceled extends Error {
}
/** An answer promzard's transform refused: told, and the question asked again. */
class NotValid extends Error {
}
/** `npm init` without an initializer in `dir` (init.js template, init-package-json). */
export async function npmInitTemplate(vfs, dir, config, io) {
    const yes = Boolean(config.get('yes') || config.get('force'));
    if (!yes)
        await io.print(INTRO + '\n');
    const path = join(dir, 'package.json');
    const read = async (file) => {
        try {
            return await vfs.readFileString(file);
        }
        catch {
            return null;
        }
    };
    const list = async (at) => {
        try {
            return (await vfs.readdir(at)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        }
        catch {
            return null;
        }
    };
    const exists = async (file) => {
        try {
            return await vfs.exists(file);
        }
        catch {
            return false;
        }
    };
    const base = dir.split('/').filter(Boolean).pop() ?? '';
    // PackageJson.load(dir, { create: true }), in the file's indent and line ending.
    const existing = await read(path);
    let content = {};
    let indent = '  ';
    let newline = '\n';
    if (existing !== null) {
        let parsed;
        try {
            parsed = JSON.parse(existing);
        }
        catch (error) {
            throw new NpmError(`JSON.parse ${error instanceof Error ? error.message : String(error)} while parsing ${path}`, 'EJSONPARSE');
        }
        if (isObject(parsed))
            content = parsed;
        const format = /^(?:\{\}|\[\])((?:\r?\n)+)?$/.exec(existing) ?? /^\s*[{[]((?:\r?\n)+)([\s\t]*)/.exec(existing) ?? [null, '', ''];
        newline = format[1] ?? '\n';
        indent = format[2] ?? '  ';
    }
    await normalize(content, ['_id', '_attributes', 'bundledDependencies', 'bundleDependencies', 'optionalDedupe', 'scripts', 'funding', 'bin'], { dir, list, read, exists });
    if (!semver.valid(content.version))
        delete content.version;
    // lib/default-input.js, its fields in its order, asked unless under yes.
    const pkg = content;
    const getConfig = (key) => {
        const dotted = config.get(`init.${key}`);
        return dotted !== DOTTED_DEFAULTS[key] && dotted ? dotted : config.get(`init-${key.replace(/\./g, '-')}`);
    };
    const ask = async (prompt, def, transform) => {
        for (;;) {
            const line = await io.ask(`${prompt}: ` + (def ? `(${def}) ` : ''));
            if (line === null)
                throw new EndOfInput();
            const answer = line.replace(/\r?\n?$/, '') || def || '';
            const value = transform ? transform(answer) : answer;
            if (!(value instanceof NotValid))
                return value;
            await io.print(value.message + '\n');
        }
    };
    const answers = [];
    try {
        let name = String(pkg.name || base).replace(/^node-|[.-]js$/g, '').replace(/\s+/g, ' ').replace(/ /g, '-').toLowerCase();
        let spec = {};
        try {
            spec = npa(name);
        }
        catch {
            spec = {};
        }
        let scope = config.get('scope');
        if (scope) {
            if (String(scope).charAt(0) !== '@')
                scope = '@' + String(scope);
            name = spec.scope ? `${String(scope)}/${String(spec.name).split('/')[1]}` : `${String(scope)}/${name}`;
        }
        answers.push(['name', yes ? name : await ask('package name', name, (data) => {
                const its = validateName(data);
                if (its.validForNewPackages)
                    return data;
                return new NotValid(`Sorry, ${[...(its.errors ?? []), ...(its.warnings ?? [])].join(' and ')}.`);
            })]);
        const version = String(pkg.version || getConfig('version') || '1.0.0');
        answers.push(['version', yes ? version : await ask('version', version, (v) => (semver.valid(v) ? v : new NotValid(`Invalid version: "${v}"`)))]);
        if (!pkg.description)
            answers.push(['description', yes ? '' : await ask('description', undefined)]);
        const entries = await list(dir) ?? [];
        if (!pkg.main) {
            const scripts = entries.map((entry) => entry.name).filter((file) => /\.js$/.test(file));
            const index = ['index.js', 'main.js', base + '.js'].find((file) => scripts.includes(file)) ?? scripts[0] ?? 'index.js';
            answers.push(['main', yes ? index : await ask('entry point', index)]);
        }
        if (!pkg.bin) {
            const bin = (await list(join(dir, 'bin')))?.find((entry) => /\.js$/.test(entry.name));
            answers.push(['bin', bin === undefined ? undefined : `bin/${bin.name}`]);
        }
        const directories = {};
        for (const { name: entry } of entries) {
            if (/^examples?$/.test(entry))
                directories.example = entry;
            else if (/^tests?$/.test(entry))
                directories.test = entry;
            else if (/^docs?$/.test(entry))
                directories.doc = entry;
            else if (entry === 'man' || entry === 'lib')
                directories[entry] = entry;
        }
        answers.push(['directories', Object.keys(directories).length === 0 ? undefined : directories]);
        const modules = await list(join(dir, 'node_modules'));
        const readDeps = async (test, excluded) => {
            if (modules === null)
                return undefined;
            const deps = {};
            for (const { name: module } of modules) {
                if (/^\./.test(module) || test !== /^(expresso|mocha|tap|coffee-script|coco|streamline)$/.test(module) || (isObject(excluded) && excluded[module]))
                    continue;
                let p = null;
                try {
                    p = JSON.parse((await read(join(dir, 'node_modules', module, 'package.json'))) ?? 'null');
                }
                catch {
                    p = null;
                }
                if (!isObject(p) || !p.version || (Array.isArray(p._requiredBy) && p._requiredBy.some((r) => r === '#USER')))
                    continue;
                deps[module] = config.get('save-exact') ? String(p.version) : String(config.get('save-prefix')) + String(p.version);
            }
            return deps;
        };
        if (!pkg.dependencies)
            answers.push(['dependencies', await readDeps(false, pkg.devDependencies || {})]);
        if (!pkg.devDependencies)
            answers.push(['devDependencies', await readDeps(true, pkg.dependencies || {})]);
        if (!pkg.scripts) {
            const names = (modules ?? []).map((entry) => entry.name);
            let command;
            for (const [framework, run] of [['tap', 'tap test/*.js'], ['expresso', 'expresso test'], ['mocha', 'mocha']]) {
                if (names.includes(framework))
                    command = run;
            }
            answers.push(['scripts', { test: yes ? command || NO_TEST : await ask('test command', command, (t) => t || NO_TEST) }]);
        }
        if (!pkg.repository) {
            const lines = ((await read(join(dir, '.git', 'config'))) ?? '').split(/\r?\n/);
            let url;
            const at = lines.indexOf('[remote "origin"]');
            if (at !== -1) {
                url = lines[at + 1];
                if (!url?.match(/^\s*url =/))
                    url = lines[at + 2];
                url = url?.match(/^\s*url =/) ? url.replace(/^\s*url = /, '') : null;
            }
            if (url && /^git@github.com:/.test(url))
                url = url.replace(/^git@github.com:/, 'https://github.com/');
            answers.push(['repository', yes ? url || '' : await ask('git repository', url || undefined)]);
        }
        if (!pkg.keywords) {
            answers.push(['keywords', yes ? '' : await ask('keywords', undefined, (data) => (data ? data.split(/[\s,]+/) : undefined))]);
        }
        if (!pkg.author) {
            const authorName = getConfig('author.name');
            answers.push(['author', authorName
                    ? { name: authorName, email: getConfig('author.email'), url: getConfig('author.url') }
                    : yes ? '' : await ask('author', undefined)]);
        }
        const license = String(pkg.license || getConfig('license') || 'ISC');
        answers.push(['license', yes ? license : await ask('license', license, (data) => {
                const its = validateLicense(data);
                if (its.validForNewPackages)
                    return data;
                return new NotValid(`Sorry, ${(its.warnings ?? []).join(' and ')}.`);
            })]);
    }
    catch (error) {
        if (error instanceof EndOfInput)
            return 'ended';
        throw error;
    }
    const description = answers.find(([key]) => key === 'description')?.[1];
    for (const [key, value] of answers)
        if (value != null)
            content[key] = value;
    await normalize(content, ['bundleDependencies', 'gypfile', 'serverjs', 'scriptpath', 'readme', 'bin', 'githead', 'fillTypes', 'normalizeData'], { dir, list, read, exists });
    // init-package-json's own last steps.
    if (isObject(content.author))
        content.author = initPerson(content.author);
    delete content.readme;
    delete content.readmeFilename;
    delete content._id;
    delete content.gitHead;
    if (!content.repository)
        delete content.repository;
    if (!content.description)
        content.description = description;
    const dependencies = content.dependencies;
    if (isObject(dependencies)) {
        if (isObject(content.optionalDependencies)) {
            for (const dep of Object.keys(content.optionalDependencies))
                delete dependencies[dep];
        }
        if (Object.keys(dependencies).length === 0)
            delete content.dependencies;
    }
    const shown = JSON.stringify(content, null, 2) + '\n';
    const message = `${path}:\n\n${shown}\n`;
    const save = async () => {
        const text = (JSON.stringify(content, null, indent) + '\n').replace(/\n/g, newline);
        if (existing === null || text.trim() !== existing.trim())
            await vfs.writeFile(path, text);
    };
    if (yes) {
        await save();
        await io.print(`Wrote to ${message}\n`);
        return 'written';
    }
    await io.print(`About to write to ${message}\n`);
    const ok = await io.ask('Is this OK? (yes) ');
    if (ok === null)
        return 'ended';
    if (!(ok.replace(/\r?\n?$/, '') || 'yes').toLowerCase().startsWith('y')) {
        await io.print('Aborted.\n');
        return 'aborted';
    }
    await save();
    return 'written';
}
/** The defaults of the deprecated `init.*` keys, which a set dashed key yields to only when they differ. */
const DOTTED_DEFAULTS = {
    'author.name': '', 'author.email': '', 'author.url': '', license: 'ISC', version: '1.0.0',
};
class EndOfInput extends Error {
}
/** init-package-json stringifyPerson: an author object back as `name <email> (url)`. */
function initPerson(person) {
    const { name, url, web, email, mail } = person;
    const u = url || web;
    const e = email || mail;
    return `${String(name)}${e ? ` <${String(e)}>` : ''}${u ? ` (${String(u)})` : ''}`;
}
/** @npmcli/package-json normalize, for the steps init runs, in its order. */
async function normalize(data, steps, { dir, list, read, exists }) {
    const has = (step) => steps.includes(step);
    const scripts = isObject(data.scripts) ? data.scripts : {};
    if (has('normalizeData')) {
        if (!data.name) {
            data.name = '';
        }
        else {
            if (typeof data.name !== 'string')
                throw new NpmError('name field must be a string.');
            const name = data.name.trim();
            data.name = name;
            if (name.startsWith('.') || !(isValidScopedPackageName(name) || isCorrectlyEncodedName(name))
                || name.toLowerCase() === 'node_modules' || name.toLowerCase() === 'favicon.ico') {
                throw new NpmError('Invalid name: ' + JSON.stringify(name));
            }
        }
        if (!data.version) {
            data.version = '';
        }
        else {
            if (!semver.valid(data.version, true))
                throw new NpmError(`Invalid version: "${String(data.version)}"`);
            data.version = semver.clean(String(data.version), true);
        }
    }
    if (has('_attributes')) {
        for (const key in data)
            if (key.startsWith('_'))
                delete data[key];
    }
    if (has('_id') && data.name && data.version)
        data._id = `${String(data.name)}@${String(data.version)}`;
    if (has('bundledDependencies')) {
        if (data.bundleDependencies === undefined && data.bundledDependencies !== undefined)
            data.bundleDependencies = data.bundledDependencies;
        delete data.bundledDependencies;
    }
    if (has('bundleDependencies')) {
        const bd = data.bundleDependencies;
        if (bd === false)
            data.bundleDependencies = [];
        else if (bd === true)
            data.bundleDependencies = Object.keys(isObject(data.dependencies) ? data.dependencies : {});
        else if (bd && typeof bd === 'object') {
            if (!Array.isArray(bd))
                data.bundleDependencies = Object.keys(bd);
        }
        else if ('bundleDependencies' in data)
            delete data.bundleDependencies;
    }
    const dependencies = data.dependencies;
    if (has('optionalDedupe') && isObject(dependencies) && isObject(data.optionalDependencies)) {
        for (const name in data.optionalDependencies)
            delete dependencies[name];
        if (!Object.keys(dependencies).length)
            delete data.dependencies;
    }
    const entries = has('gypfile') || has('readme') ? (await list(dir)) ?? [] : [];
    if (has('gypfile') && !scripts.install && !scripts.preinstall && data.gypfile !== false) {
        if (entries.some((entry) => /^[^.].*\.gyp$/.test(entry.name))) {
            scripts.install = 'node-gyp rebuild';
            data.scripts = scripts;
            data.gypfile = true;
        }
    }
    if (has('serverjs') && !scripts.start && await exists(join(dir, 'server.js'))) {
        scripts.start = 'node server.js';
        data.scripts = scripts;
    }
    if ((has('scripts') || has('scriptpath')) && data.scripts !== undefined) {
        const spre = /^(\.[/\\])?node_modules[/\\].bin[\\/]/;
        const all = data.scripts;
        if (typeof all === 'object' && all !== null) {
            for (const name in all) {
                const script = Reflect.get(all, name);
                if (typeof script !== 'string')
                    Reflect.deleteProperty(all, name);
                else if (has('scriptpath') && spre.test(script))
                    Reflect.set(all, name, script.replace(spre, ''));
            }
        }
        else {
            delete data.scripts;
        }
    }
    if (has('funding') && data.funding && typeof data.funding === 'string')
        data.funding = { url: data.funding };
    if (has('readme') && !data.readme) {
        let readmeFile;
        for (const entry of entries) {
            if (!/^readme(\..*)?$/i.test(entry.name) || entry.type === 'directory')
                continue;
            if (/\.m?a?r?k?d?o?w?n?$/i.test(entry.name)) {
                readmeFile = entry.name;
                break;
            }
            if (entry.name.endsWith('README'))
                readmeFile = entry.name;
        }
        if (readmeFile !== undefined) {
            data.readme = (await read(join(dir, readmeFile))) ?? '';
            data.readmeFilename = readmeFile;
        }
        if (!data.readme)
            data.readme = NO_README;
    }
    if (has('bin'))
        normalizePackageJsonBin(data);
    if (has('fillTypes')) {
        const index = data.main || 'index.js';
        if (typeof index !== 'string')
            throw new NpmError('The "main" attribute must be of type string.');
        const slash = index.lastIndexOf('/');
        const file = index.slice(slash + 1);
        const dot = file.lastIndexOf('.');
        const extless = join(slash === -1 ? '.' : index.slice(0, slash) || '/', dot > 0 ? file.slice(0, dot) : file);
        const dts = `./${extless}.d.ts`;
        if (!('types' in data || 'typings' in data) && await exists(join(dir, dts)))
            data.types = dts;
    }
    if (has('normalizeData')) {
        if (data.repositories)
            data.repository = Reflect.get(Object(data.repositories), 0);
        if (data.repository) {
            if (typeof data.repository === 'string')
                data.repository = { type: 'git', url: data.repository };
            const repository = data.repository;
            if (isObject(repository) && repository.url) {
                const hosted = hostedGitInfo.fromUrl(String(repository.url));
                if (hosted)
                    repository.url = hosted.getDefaultRepresentation() === 'shortcut' ? hosted.https() : hosted.toString();
            }
        }
        for (const type of ['dependencies', 'devDependencies', 'optionalDependencies']) {
            let list = data[type];
            if (!list)
                continue;
            if (typeof list === 'string')
                list = data[type] = list.trim().split(/[\n\r\s\t ,]+/);
            if (Array.isArray(list)) {
                const o = {};
                for (const d of list) {
                    if (typeof d !== 'string')
                        continue;
                    const dep = d.trim().split(/(:?[@\s><=])/);
                    const dn = dep.shift();
                    o[dn] = dep.join('').replace(/^@/, '').trim();
                }
                data[type] = o;
            }
        }
        for (const deps of ['dependencies', 'devDependencies']) {
            if (!(deps in data))
                continue;
            const all = data[deps];
            if (!all || typeof all !== 'object') {
                delete data[deps];
                continue;
            }
            for (const d in all) {
                if (typeof Reflect.get(all, d) !== 'string')
                    Reflect.deleteProperty(all, d);
                const spec = Reflect.get(all, d);
                const hosted = typeof spec === 'string' ? hostedGitInfo.fromUrl(spec)?.toString() : undefined;
                if (hosted && hosted !== spec)
                    Reflect.set(all, d, hosted);
            }
        }
        normalizeData(data);
    }
}
/** @npmcli/package-json normalize-data.js (normalize-package-data's fixers), for the fields a package.json written here has. */
function normalizeData(data) {
    if (data.description && typeof data.description !== 'string')
        delete data.description;
    if (data.readme && !data.description && data.readme !== NO_README)
        data.description = extractDescription(String(data.readme));
    if (data.description === undefined)
        delete data.description;
    if (data.modules)
        delete data.modules;
    if (data.files && !Array.isArray(data.files))
        delete data.files;
    else if (Array.isArray(data.files))
        data.files = data.files.filter((file) => file && typeof file === 'string');
    if (data.man && typeof data.man === 'string')
        data.man = [data.man];
    const repositoryUrl = isObject(data.repository) ? data.repository.url : undefined;
    if (!data.bugs && repositoryUrl) {
        const bugs = hostedGitInfo.fromUrl(String(repositoryUrl))?.bugs();
        if (bugs)
            data.bugs = { url: bugs };
    }
    else if (data.bugs) {
        if (typeof data.bugs === 'string') {
            if (isEmail(data.bugs))
                data.bugs = { email: data.bugs };
            else if (hasProtocol(data.bugs))
                data.bugs = { url: data.bugs };
        }
        else if (isObject(data.bugs)) {
            const old = data.bugs;
            for (const k in old) {
                if (k === 'web' || k === 'name') {
                    old.url = old[k];
                    delete old[k];
                }
            }
            const bugs = {};
            if (old.url && typeof old.url === 'string' && hasProtocol(old.url))
                bugs.url = old.url;
            if (old.email && typeof old.email === 'string' && isEmail(old.email))
                bugs.email = old.email;
            data.bugs = bugs;
        }
        if (isObject(data.bugs) && !data.bugs.email && !data.bugs.url)
            delete data.bugs;
    }
    if (typeof data.keywords === 'string')
        data.keywords = data.keywords.split(/,\s+/);
    if (data.keywords && !Array.isArray(data.keywords))
        delete data.keywords;
    else if (Array.isArray(data.keywords))
        data.keywords = data.keywords.filter((kw) => typeof kw === 'string' && kw);
    if (data.bundledDependencies && !data.bundleDependencies) {
        data.bundleDependencies = data.bundledDependencies;
        delete data.bundledDependencies;
    }
    if (data.bundleDependencies && !Array.isArray(data.bundleDependencies))
        delete data.bundleDependencies;
    else if (Array.isArray(data.bundleDependencies)) {
        data.bundleDependencies = data.bundleDependencies.filter((dep) => {
            if (!dep || typeof dep !== 'string')
                return false;
            if (!data.dependencies)
                data.dependencies = {};
            if (!Object.prototype.hasOwnProperty.call(data.dependencies, dep))
                Reflect.set(Object(data.dependencies), dep, '*');
            return true;
        });
    }
    if (!data.homepage && isObject(data.repository) && data.repository.url) {
        const hosted = hostedGitInfo.fromUrl(String(data.repository.url));
        if (hosted)
            data.homepage = hosted.docs();
    }
    if (data.homepage) {
        if (typeof data.homepage !== 'string')
            delete data.homepage;
        else if (!hasProtocol(data.homepage))
            data.homepage = 'http://' + data.homepage;
    }
    if (!data.readme)
        data.readme = NO_README;
    if (data.author)
        data.author = parsePerson(data.author);
    for (const set of ['maintainers', 'contributors']) {
        const people = data[set];
        if (Array.isArray(people))
            data[set] = people.map(parsePerson);
    }
}
/** normalize-data.js extractDescription: a readme's first paragraph, after its headings. */
function extractDescription(readme) {
    const lines = readme.trim().split('\n');
    let start = 0;
    while (lines[start]?.trim().match(/^(#|$)/))
        start++;
    let end = start + 1;
    while (end < lines.length && lines[end].trim())
        end++;
    return lines.slice(start, end).join(' ').trim();
}
/** normalize-data.js stringifyPerson: a person as `{ name, email, url }`. */
function parsePerson(value) {
    let person;
    if (typeof value !== 'string') {
        const p = isObject(value) ? value : {};
        const u = p.url || p.web;
        const e = p.email || p.mail;
        person = String(p.name || '') + (e ? ` <${String(e)}>` : '') + (u ? ` (${String(u)})` : '');
    }
    else {
        person = value;
    }
    const parsed = {};
    const name = person.match(/^([^(<]+)/);
    const url = person.match(/\(([^()]+)\)/);
    const email = person.match(/<([^<>]+)>/);
    if (name?.[0].trim())
        parsed.name = name[0].trim();
    if (email)
        parsed.email = email[1];
    if (url)
        parsed.url = url[1];
    return parsed;
}
const isEmail = (text) => text.includes('@') && text.indexOf('@') < text.lastIndexOf('.');
/** Whether Node's legacy url.parse finds a protocol: a scheme and a colon at the start. */
const hasProtocol = (text) => /^[a-z0-9.+-]+:/i.test(text.trim());
function isCorrectlyEncodedName(spec) {
    return !spec.match(/[/@\s+%:]/) && spec === encodeURIComponent(spec);
}
function isValidScopedPackageName(spec) {
    if (spec.charAt(0) !== '@')
        return false;
    const rest = spec.slice(1).split('/');
    if (rest.length !== 2)
        return false;
    return Boolean(rest[0] && rest[1] && rest[0] === encodeURIComponent(rest[0]) && rest[1] === encodeURIComponent(rest[1]));
}
