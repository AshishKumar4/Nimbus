/**
 * npm-init.ts — the package.json `npm init` writes: npm 10.9.8's, as its
 * init-package-json 7.0.2 builds it with every prompt at its default
 * (lib/default-input.js under `yes`, which npm also takes when stdin is not a
 * terminal), assigned over the package.json that is there, then the
 * @npmcli/package-json normalize steps init asks for (bin, gypfile, serverjs,
 * scriptpath, fillTypes) and the normalize-package-data fixes a new
 * package's fields reach (keywords, name, version, repository with the
 * bugs and homepage a hosted one has). It is written in the file's own
 * indent and line ending (json-parse-even-better-errors), and npm's message
 * says so.
 *
 * Named limits: npm's init.* and scope configs are at their defaults (none is
 * read), and normalize-package-data's other fixes of a package.json that was
 * already there are not made.
 */
import type { ProcessView as VFS } from '../../../../runtime/process-files.js';
import { parseSemver } from '../../../../_shared/npm-semver.js';
import { join } from '../../utils/path.js';

const NO_TEST = 'echo "Error: no test specified" && exit 1';
/** default-input.js isTestPkg: a dependency that is a test framework is a dev one. */
const TEST_PACKAGES = new Set(['expresso', 'mocha', 'tap', 'coffee-script', 'coco', 'streamline']);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** What `npm init` writes in `dir`: the file, its text, and what npm prints. */
export async function npmInitPackage(vfs: VFS, dir: string): Promise<{ path: string; text: string; message: string }> {
  const path = join(dir, 'package.json');
  const base = dir.split('/').filter(Boolean).pop() ?? '';
  const read = async (file: string): Promise<string | null> => {
    try { return await vfs.readFileString(file); } catch { return null; }
  };
  const list = async (at: string): Promise<string[]> => {
    try { return (await vfs.readdir(at)).map((entry) => entry.name).sort(); } catch { return []; }
  };
  const exists = async (file: string) => (await read(file)) !== null;

  // The package.json there, and the indent and line ending it was written in.
  const existing = await read(path);
  let content: Record<string, unknown> = {};
  let indent = '  ';
  let newline = '\n';
  if (existing !== null) {
    const parsed: unknown = JSON.parse(existing);
    if (isObject(parsed)) content = parsed;
    const format = /^(?:\{\}|\[\])((?:\r?\n)+)?$/.exec(existing) ?? /^\s*[{[]((?:\r?\n)+)([\s\t]*)/.exec(existing) ?? [null, '', ''];
    newline = format[1] ?? '\n';
    indent = format[2] ?? '  ';
  }
  if (typeof content.version === 'string' ? parseSemver(content.version) === null : content.version !== undefined) delete content.version;
  const had = { ...content };

  const files = await list(dir);
  const modules = await list(join(dir, 'node_modules'));
  const readDeps = async (test: boolean, excluded: unknown): Promise<Record<string, string> | undefined> => {
    if (!(await vfs.exists(join(dir, 'node_modules')))) return undefined;
    const deps: Record<string, string> = {};
    for (const name of modules) {
      if (name.startsWith('.') || test !== TEST_PACKAGES.has(name) || (isObject(excluded) && excluded[name])) continue;
      const text = await read(join(dir, 'node_modules', name, 'package.json'));
      let pkg: unknown = null;
      try { pkg = text === null ? null : JSON.parse(text); } catch { pkg = null; }
      if (!isObject(pkg) || !pkg.version) continue;
      if (Array.isArray(pkg._requiredBy) && pkg._requiredBy.includes('#USER')) continue;
      deps[name] = '^' + String(pkg.version);
    }
    return deps;
  };

  // default-input.js, in its order, each answer its default.
  const answers: Array<[string, unknown]> = [];
  answers.push(['name', String(had.name || base).replace(/^node-|[.-]js$/g, '').replace(/\s+/g, ' ').replace(/ /g, '-').toLowerCase()]);
  answers.push(['version', had.version || '1.0.0']);
  if (!had.description) answers.push(['description', '']);
  if (!had.main) {
    const scripts = files.filter((file) => /\.js$/.test(file));
    answers.push(['main', ['index.js', 'main.js', base + '.js'].find((file) => scripts.includes(file)) ?? scripts[0] ?? 'index.js']);
  }
  if (!had.bin) {
    const bin = (await list(join(dir, 'bin'))).find((file) => /\.js$/.test(file));
    answers.push(['bin', bin === undefined ? undefined : 'bin/' + bin]);
  }
  const directories: Record<string, string> = {};
  for (const name of files) {
    if (/^examples?$/.test(name)) directories.example = name;
    else if (/^tests?$/.test(name)) directories.test = name;
    else if (/^docs?$/.test(name)) directories.doc = name;
    else if (name === 'man' || name === 'lib') directories[name] = name;
  }
  answers.push(['directories', Object.keys(directories).length === 0 ? undefined : directories]);
  if (!had.dependencies) answers.push(['dependencies', await readDeps(false, had.devDependencies)]);
  if (!had.devDependencies) answers.push(['devDependencies', await readDeps(true, had.dependencies)]);
  if (!had.scripts) {
    let test: string | undefined;
    for (const [framework, command] of [['tap', 'tap test/*.js'], ['expresso', 'expresso test'], ['mocha', 'mocha']]) {
      if (modules.includes(framework)) test = command;
    }
    answers.push(['scripts', { test: test ?? NO_TEST }]);
  }
  if (!had.repository) {
    const lines = (await read(join(dir, '.git', 'config')) ?? '').split(/\r?\n/);
    const at = lines.indexOf('[remote "origin"]');
    let url: string | null = null;
    if (at !== -1) {
      const line = /^\s*url =/.test(lines[at + 1] ?? '') ? lines[at + 1]! : lines[at + 2] ?? '';
      url = /^\s*url =/.test(line) ? line.replace(/^\s*url = /, '') : null;
    }
    if (url !== null && /^git@github.com:/.test(url)) url = url.replace(/^git@github.com:/, 'https://github.com/');
    answers.push(['repository', url ?? '']);
  }
  if (!had.keywords) answers.push(['keywords', []]);
  if (!had.author) answers.push(['author', '']);
  answers.push(['license', had.license || 'ISC']);
  for (const [key, value] of answers) if (value !== undefined && value !== null) content[key] = value;

  // @npmcli/package-json normalize, the steps init asks for.
  const name = String(content.name);
  if (typeof content.bin === 'string') content.bin = { [name.split('/').pop()!]: content.bin };
  if (isObject(content.bin)) {
    for (const [command, target] of Object.entries(content.bin)) {
      content.bin[command] = join('/', String(target)).slice(1);
    }
  }
  const scripts = isObject(content.scripts) ? content.scripts : undefined;
  if (files.includes('binding.gyp') && content.gypfile !== false && !scripts?.install && !scripts?.preinstall) {
    content.scripts = { ...scripts, install: 'node-gyp rebuild' };
    content.gypfile = true;
  }
  if (files.includes('server.js') && !(isObject(content.scripts) && content.scripts.start)) {
    content.scripts = { ...(isObject(content.scripts) ? content.scripts : {}), start: 'node server.js' };
  }
  if (isObject(content.scripts)) {
    for (const [script, command] of Object.entries(content.scripts)) {
      if (typeof command !== 'string') delete content.scripts[script];
      else content.scripts[script] = command.replace(/^(\.[/\\])?node_modules[/\\].bin[\\/]/, '');
    }
  }
  if (!('types' in content) && !('typings' in content)) {
    const main = typeof content.main === 'string' ? content.main : 'index.js';
    const slash = main.lastIndexOf('/');
    const file = main.slice(slash + 1);
    const stem = file.lastIndexOf('.') > 0 ? file.slice(0, file.lastIndexOf('.')) : file;
    const extless = slash === -1 ? stem : join(main.slice(0, slash), stem).replace(/^\/+/, '');
    if (await exists(join(dir, extless + '.d.ts'))) content.types = './' + extless + '.d.ts';
  }
  // The readme step: a README.md (or README), whose first paragraph is the description below.
  const readmeFile = files.find((file) => /^readme(\..*)?$/i.test(file) && /\.m?a?r?k?d?o?w?n?$/i.test(file))
    ?? files.find((file) => /^readme$/i.test(file));
  const readme = readmeFile === undefined ? null : await read(join(dir, readmeFile));
  // normalize-package-data's fixes these fields reach.
  if (typeof content.name === 'string') content.name = content.name.trim();
  if (!content.description && readme !== null) content.description = readmeDescription(readme);
  if (typeof content.version === 'string') {
    const version = parseSemver(content.version);
    if (version !== null) content.version = version.slice(0, 3).join('.') + (version[3].length > 0 ? '-' + version[3].join('.') : '');
  }
  if (typeof content.keywords === 'string') content.keywords = content.keywords.split(/,\s+/);
  if (Array.isArray(content.keywords)) content.keywords = content.keywords.filter((keyword) => typeof keyword === 'string' && keyword !== '');
  if (typeof content.repository === 'string' && content.repository !== '') content.repository = { type: 'git', url: content.repository };
  const repository = isObject(content.repository) && typeof content.repository.url === 'string' ? hostedRepository(content.repository.url) : null;
  if (repository !== null && isObject(content.repository)) {
    content.repository.url = repository.url;
    if (!content.bugs) content.bugs = { url: repository.bugs };
    if (!content.homepage) content.homepage = repository.homepage;
  }

  // init-package-json's own last steps.
  delete content.readme;
  delete content.readmeFilename;
  delete content._id;
  delete content.gitHead;
  if (!content.repository) delete content.repository;
  if (!content.description) content.description = had.description || '';
  if (isObject(content.dependencies)) {
    if (isObject(content.optionalDependencies)) for (const dep of Object.keys(content.optionalDependencies)) delete content.dependencies[dep];
    if (Object.keys(content.dependencies).length === 0) delete content.dependencies;
  }

  const text = (JSON.stringify(content, null, indent) + '\n').replace(/\n/g, newline);
  const shown = JSON.stringify(content, null, 2) + '\n';
  // init-package-json's console.log of `${path}:\n\n${shown}\n`, and npm's display's line after.
  return { path, text, message: `Wrote to ${path}:\n\n${shown}\n\n\n` };
}

/** normalize-package-data's extractDescription: the first paragraph after any heading lines. */
function readmeDescription(readme: string): string {
  const lines = readme.trim().split('\n');
  let start = 0;
  while (lines[start] !== undefined && /^(#|$)/.test(lines[start]!.trim())) start++;
  let end = start + 1;
  while (end < lines.length && lines[end]!.trim()) end++;
  return lines.slice(start, end).join(' ').trim();
}

/** hosted-git-info's https form of a GitHub, GitLab or Bitbucket repository URL, its issues and readme. */
function hostedRepository(url: string): { url: string; bugs: string; homepage: string } | null {
  const match = /^(?:git\+)?(?:https?:\/\/|git:\/\/|ssh:\/\/git@|git@)(github\.com|gitlab\.com|bitbucket\.org)[/:]([^/]+)\/([^/#]+?)(?:\.git)?\/?(?:#.*)?$/.exec(url);
  if (match === null) return null;
  const [, domain, user, project] = match;
  return {
    url: `git+https://${domain}/${user}/${project}.git`,
    bugs: `https://${domain}/${user}/${project}/issues`,
    homepage: `https://${domain}/${user}/${project}#readme`,
  };
}
