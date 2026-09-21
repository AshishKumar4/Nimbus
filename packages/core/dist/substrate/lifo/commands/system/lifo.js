/**
 * lifo -- lifo package manager command.
 *
 * Subcommands:
 *   install|add <name>   install a lifo-pkg-* package (sugar over npm -g)
 *   remove  <name>       remove a lifo package
 *   list                 list installed lifo packages + dev links
 *   search  <term>       search npm for lifo-pkg-* packages
 *   init    <name>       scaffold a new lifo package template
 *   link    <path>       dev-link a local package directory
 *   unlink  <name>       remove a dev link
 */
import { ExecutionFs } from '../../../../shell/execution-fs.js';
import { npmInstallGlobal, getBinEntries, registerBinCommand } from './npm.js';
import { RegistrySearchResponseSchema } from './registry-schemas.js';
import { resolve, join } from '../../utils/path.js';
import { linkPackage, unlinkPackage, readDevLinks, loadDevLinks, } from '../../pkg/lifo-dev.js';
import { readLifoManifest, createLifoCommand, } from '../../pkg/lifo-runtime.js';
const GLOBAL_MODULES = '/usr/lib/node_modules';
// ─── Helpers ───
async function printHelp(stdout) {
    (await stdout.write('Usage: lifo <command> [args]\n\n'));
    (await stdout.write('Commands:\n'));
    (await stdout.write('  install|add <name>     install lifo-pkg-<name> from npm\n'));
    (await stdout.write('  remove <name>          remove a lifo package\n'));
    (await stdout.write('  list                   list lifo packages & dev links\n'));
    (await stdout.write('  search <term>          search npm for lifo-pkg-* packages\n'));
    (await stdout.write('  init <name>            scaffold a new lifo package\n'));
    (await stdout.write('  link [path]            dev-link a local package\n'));
    (await stdout.write('  unlink <name>          remove a dev link\n'));
    (await stdout.write('\nEnvironment:\n'));
    (await stdout.write('  LIFO_CDN               CDN for ESM imports (default: https://esm.sh)\n'));
}
// ─── install ───
async function lifoInstall(ctx, registry, kernel) {
    const name = ctx.args[1];
    if (!name) {
        await ctx.stderr.write('lifo install: package name required\n');
        return 1;
    }
    // Resolve: if user types "ffmpeg", install "lifo-pkg-ffmpeg"
    const npmName = name.startsWith('lifo-pkg-') ? name : `lifo-pkg-${name}`;
    await ctx.stdout.write(`Installing ${npmName} globally...\n`);
    // Install directly (no shell.execute round-trip)
    const exitCode = await npmInstallGlobal(npmName, ctx, registry, kernel);
    if (exitCode !== 0)
        return exitCode;
    // After npm install, check for lifo manifest and re-register with lifo runtime
    const pkgDir = join(GLOBAL_MODULES, npmName);
    const manifest = (await readLifoManifest(ctx.vfs, pkgDir));
    if (manifest) {
        for (const [cmdName, entryRelPath] of Object.entries(manifest.commands)) {
            const entryPath = join(pkgDir, entryRelPath);
            if ((await ctx.vfs.exists(entryPath))) {
                registry.register(cmdName, createLifoCommand(entryPath, ctx.vfs));
                await ctx.stdout.write(`  registered command: ${cmdName}\n`);
            }
        }
    }
    else {
        await ctx.stdout.write(`  (no lifo manifest found -- installed as plain npm package)\n`);
    }
    return 0;
}
// ─── remove ───
async function lifoRemove(ctx, registry) {
    const name = ctx.args[1];
    if (!name) {
        await ctx.stderr.write('lifo remove: package name required\n');
        return 1;
    }
    const npmName = name.startsWith('lifo-pkg-') ? name : `lifo-pkg-${name}`;
    const pkgDir = join(GLOBAL_MODULES, npmName);
    if (!(await ctx.vfs.exists(pkgDir))) {
        await ctx.stderr.write(`lifo: ${npmName} is not installed\n`);
        return 1;
    }
    // Unregister commands from manifest before removing
    const manifest = (await readLifoManifest(ctx.vfs, pkgDir));
    if (manifest) {
        for (const cmdName of Object.keys(manifest.commands)) {
            registry.unregister(cmdName);
        }
    }
    try {
        (await ctx.vfs.rmdirRecursive(pkgDir));
    }
    catch (e) {
        await ctx.stderr.write(`lifo: could not remove ${npmName}: ${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
    }
    await ctx.stdout.write(`removed ${npmName}\n`);
    return 0;
}
// ─── list ───
async function lifoList(ctx) {
    const { vfs, stdout } = ctx;
    // 1. Installed lifo packages (global node_modules with lifo field)
    const installed = [];
    if ((await vfs.exists(GLOBAL_MODULES))) {
        for (const entry of (await vfs.readdir(GLOBAL_MODULES))) {
            if (entry.type !== 'directory')
                continue;
            const dirs = entry.name.startsWith('@')
                ? (await (async () => {
                    try {
                        return (await vfs.readdir(join(GLOBAL_MODULES, entry.name)))
                            .filter(e => e.type === 'directory')
                            .map(e => join(entry.name, e.name));
                    }
                    catch {
                        return [];
                    }
                })())
                : [entry.name];
            for (const dirName of dirs) {
                const pkgDir = join(GLOBAL_MODULES, dirName);
                const manifest = (await readLifoManifest(vfs, pkgDir));
                if (!manifest)
                    continue;
                let version = '?';
                try {
                    const pkg = JSON.parse((await vfs.readFileString(join(pkgDir, 'package.json'))));
                    version = pkg.version || '?';
                }
                catch { /* ignore */ }
                installed.push({
                    name: dirName,
                    version,
                    commands: Object.keys(manifest.commands),
                });
            }
        }
    }
    // 2. Dev-linked packages
    const devLinks = (await readDevLinks(vfs));
    const devEntries = Object.entries(devLinks);
    if (installed.length === 0 && devEntries.length === 0) {
        (await stdout.write('No lifo packages installed\n'));
        return 0;
    }
    if (installed.length > 0) {
        (await stdout.write('Installed:\n'));
        for (const pkg of installed) {
            (await stdout.write(`  ${pkg.name}@${pkg.version}  [${pkg.commands.join(', ')}]\n`));
        }
    }
    if (devEntries.length > 0) {
        if (installed.length > 0)
            (await stdout.write('\n'));
        (await stdout.write('Dev-linked:\n'));
        for (const [name, link] of devEntries) {
            const cmds = Object.keys(link.commands).join(', ');
            (await stdout.write(`  ${name}  ${link.path}  [${cmds}]\n`));
        }
    }
    return 0;
}
// ─── search ───
async function lifoSearch(ctx) {
    const term = ctx.args.slice(1).join(' ');
    if (!term) {
        await ctx.stderr.write('Usage: lifo search <term>\n');
        return 1;
    }
    const registry = ctx.env.NPM_REGISTRY || 'https://registry.npmjs.org';
    const query = `lifo-pkg-${term}`;
    const url = `${registry}/-/v1/search?text=${encodeURIComponent(query)}&size=20`;
    try {
        const response = await fetch(url, { signal: ctx.signal });
        if (!response.ok)
            throw new Error(`Registry returned ${response.status}`);
        const data = RegistrySearchResponseSchema.parse(await response.json());
        const results = data.objects;
        // Filter to only lifo-pkg-* packages
        const lifoResults = results.filter(r => r.package.name.startsWith('lifo-pkg-'));
        if (lifoResults.length === 0) {
            await ctx.stdout.write('No lifo packages found\n');
            return 0;
        }
        await ctx.stdout.write('NAME'.padEnd(30) + 'VERSION'.padEnd(12) + 'DESCRIPTION\n');
        await ctx.stdout.write('-'.repeat(70) + '\n');
        for (const r of lifoResults) {
            const p = r.package;
            const displayName = p.name.replace(/^lifo-pkg-/, '');
            const name = displayName.length > 28 ? displayName.slice(0, 28) + '..' : displayName;
            const desc = (p.description || '').slice(0, 40);
            await ctx.stdout.write(`${name.padEnd(30)}${p.version.padEnd(12)}${desc}\n`);
        }
    }
    catch (e) {
        await ctx.stderr.write(`lifo search: ${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
    }
    return 0;
}
// ─── init ───
async function lifoInit(ctx) {
    const name = ctx.args[1];
    if (!name) {
        await ctx.stderr.write('Usage: lifo init <name>\n');
        return 1;
    }
    const pkgDir = resolve(ctx.cwd, name);
    const npmName = name.startsWith('lifo-pkg-') ? name : `lifo-pkg-${name}`;
    const cmdName = name.replace(/^lifo-pkg-/, '');
    // Check if directory already exists
    if ((await ctx.vfs.exists(pkgDir))) {
        await ctx.stderr.write(`lifo init: ${pkgDir} already exists\n`);
        return 1;
    }
    // Create directory structure
    (await ctx.vfs.mkdir(pkgDir, { recursive: true }));
    (await ctx.vfs.mkdir(join(pkgDir, 'commands'), { recursive: true }));
    // package.json
    const packageJson = {
        name: npmName,
        version: '0.1.0',
        description: `${cmdName} command for Lifo`,
        lifo: {
            commands: {
                [cmdName]: `./commands/${cmdName}.js`,
            },
        },
        keywords: ['lifo-pkg', cmdName],
        license: 'MIT',
    };
    (await ctx.vfs.writeFile(join(pkgDir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n'));
    // Command entry template
    const commandTemplate = `/**
 * ${cmdName} -- lifo command
 *
 * This function receives:
 *   ctx  - CommandContext { args, env, cwd, vfs, stdout, stderr, signal, stdin }
 *   lifo - LifoAPI { import(), loadWasm(), resolve(), cdn }
 */
module.exports = async function(ctx, lifo) {
const args = ctx.args;

if (args.includes('--help') || args.includes('-h')) {
  ctx.stdout.write('Usage: ${cmdName} [options]\\n');
  ctx.stdout.write('\\nA lifo package command.\\n');
  return 0;
}

// Example: import an ESM module from CDN
// const { default: lib } = await lifo.import('some-npm-package');

// Example: load a startup-registered WASM module
// const wasmModule = await lifo.loadWasm('example/module.wasm');
// const instance = await WebAssembly.instantiate(wasmModule);

// Example: read/write files via VFS
// const data = ctx.vfs.readFile(lifo.resolve('input.txt'));
// ctx.vfs.writeFile(lifo.resolve('output.txt'), result);

ctx.stdout.write('Hello from ${cmdName}!\\n');
return 0;
};
`;
    (await ctx.vfs.writeFile(join(pkgDir, 'commands', `${cmdName}.js`), commandTemplate));
    // README
    const readme = `# ${npmName}

A lifo package providing the \`${cmdName}\` command.

## Quick start (inside Lifo)

\`\`\`bash
lifo link ./${name}
${cmdName} --help
\`\`\`

## Publish to npm

For a full TypeScript project with a Vite example app and CLI test harness,
use \`npm create lifo-pkg ${cmdName}\` on your host machine. Then:

\`\`\`bash
npm publish
\`\`\`

Users install with: \`lifo install ${cmdName}\`
`;
    (await ctx.vfs.writeFile(join(pkgDir, 'README.md'), readme));
    await ctx.stdout.write(`Created ${pkgDir}/\n`);
    await ctx.stdout.write(`  package.json\n`);
    await ctx.stdout.write(`  commands/${cmdName}.js\n`);
    await ctx.stdout.write(`  README.md\n`);
    await ctx.stdout.write(`\nNext steps:\n`);
    await ctx.stdout.write(`  lifo link ./${name}    # register for development\n`);
    await ctx.stdout.write(`  ${cmdName} --help      # test it\n`);
    await ctx.stdout.write(`\nFor a full TypeScript project, run on your host:\n`);
    await ctx.stdout.write(`  npm create lifo-pkg ${cmdName}\n`);
    return 0;
}
// ─── link ───
async function lifoLink(ctx, registry) {
    const pathArg = ctx.args[1] || '.';
    const pkgDir = resolve(ctx.cwd, pathArg);
    if (!(await ctx.vfs.exists(join(pkgDir, 'package.json')))) {
        await ctx.stderr.write(`lifo link: no package.json found in ${pkgDir}\n`);
        return 1;
    }
    try {
        const commands = (await linkPackage(ctx.vfs, registry, pkgDir));
        await ctx.stdout.write(`Linked ${pkgDir}\n`);
        for (const cmd of commands) {
            await ctx.stdout.write(`  registered command: ${cmd}\n`);
        }
    }
    catch (e) {
        await ctx.stderr.write(`lifo link: ${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
    }
    return 0;
}
// ─── unlink ───
async function lifoUnlink(ctx) {
    const name = ctx.args[1];
    if (!name) {
        await ctx.stderr.write('Usage: lifo unlink <name>\n');
        return 1;
    }
    const commands = (await unlinkPackage(ctx.vfs, name));
    if (!commands) {
        await ctx.stderr.write(`lifo unlink: '${name}' is not dev-linked\n`);
        return 1;
    }
    await ctx.stdout.write(`Unlinked ${name}\n`);
    for (const cmd of commands) {
        await ctx.stdout.write(`  removed command: ${cmd}\n`);
    }
    return 0;
}
// ─── Factory ───
export function createLifoPkgCommand(registry, _shellExecute, kernel) {
    return async (ctx) => {
        const subcommand = ctx.args[0];
        if (!subcommand || subcommand === '--help' || subcommand === '-h') {
            await printHelp(ctx.stdout);
            return subcommand ? 0 : 1;
        }
        switch (subcommand) {
            case 'install':
            case 'i':
            case 'add':
                return (await lifoInstall(ctx, registry, kernel));
            case 'remove':
            case 'rm':
            case 'uninstall':
                return (await lifoRemove(ctx, registry));
            case 'list':
            case 'ls':
                return (await lifoList(ctx));
            case 'search':
                return (await lifoSearch(ctx));
            case 'init':
                return await lifoInit(ctx);
            case 'link':
                return await lifoLink(ctx, registry);
            case 'unlink':
                return (await lifoUnlink(ctx));
            default:
                await ctx.stderr.write(`lifo: unknown command '${subcommand}'\n`);
                await ctx.stderr.write('Run lifo --help for usage\n');
                return 1;
        }
    };
}
/**
 * Boot-time loader: restores dev-linked commands + re-registers
 * installed lifo packages with the lifo runtime.
 */
/**
 * Re-register all globally installed packages into the command registry.
 *
 * Handles two kinds of packages:
 *   - lifo packages (have a lifo.json manifest) → registered via the lifo runtime
 *   - regular npm packages (have a "bin" field in package.json) → registered via node runner
 *
 * Called on every daemon boot so that packages installed via `npm install -g`
 * or `lifo install` are available as shell commands, including after a snapshot
 * restore where the VFS has the files but the registry is freshly created.
 *
 * Also restores dev-linked packages.
 *
 * Safe to call on a fresh VM — it is a no-op when /usr/lib/node_modules is empty.
 */
export async function rehydrateGlobalPackages(storage, registry) {
    const vfs = new ExecutionFs(storage);
    // 1. Restore dev links
    (await loadDevLinks(vfs, registry));
    if (!await vfs.exists(GLOBAL_MODULES))
        return;
    // 2. Scan every package in /usr/lib/node_modules
    for (const entry of await vfs.readdir(GLOBAL_MODULES)) {
        if (entry.type !== 'directory')
            continue;
        const dirs = entry.name.startsWith('@')
            ? (await vfs.readdir(join(GLOBAL_MODULES, entry.name)))
                .filter(entry => entry.type === 'directory')
                .map(child => join(entry.name, child.name))
            : [entry.name];
        for (const dirName of dirs) {
            const pkgDir = join(GLOBAL_MODULES, dirName);
            // lifo package: has a lifo manifest → use the lifo runtime
            const manifest = (await readLifoManifest(vfs, pkgDir));
            if (manifest) {
                for (const [cmdName, entryRelPath] of Object.entries(manifest.commands)) {
                    const entryPath = join(pkgDir, entryRelPath);
                    if (await vfs.exists(entryPath)) {
                        registry.register(cmdName, createLifoCommand(entryPath, vfs));
                    }
                }
                continue; // lifo manifest takes priority — skip npm bin check
            }
            // regular npm package: has "bin" in package.json → use node runner
            const pkgJsonPath = join(pkgDir, 'package.json');
            if (!await vfs.exists(pkgJsonPath))
                continue;
            let pkg;
            try {
                pkg = JSON.parse(await vfs.readFileString(pkgJsonPath));
            }
            catch {
                continue;
            }
            for (const [binName, binPath] of Object.entries(getBinEntries(pkg))) {
                const scriptPath = resolve(pkgDir, binPath);
                if (await vfs.exists(scriptPath)) {
                    registerBinCommand(registry, binName, scriptPath);
                }
            }
        }
    }
}
/** @deprecated Use rehydrateGlobalPackages() instead. */
export async function bootLifoPackages(vfs, registry) {
    (await rehydrateGlobalPackages(vfs, registry));
}
