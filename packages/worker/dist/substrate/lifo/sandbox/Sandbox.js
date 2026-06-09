import { Kernel } from '../kernel/index.js';
import { Shell } from '../shell/Shell.js';
import { createDefaultRegistry, } from '../commands/registry.js';
import { createPsCommand } from '../commands/system/ps.js';
import { createTopCommand } from '../commands/system/top.js';
import { createKillCommand } from '../commands/system/kill.js';
import { createWatchCommand } from '../commands/system/watch.js';
import { createHelpCommand } from '../commands/system/help.js';
import { createNodeCommand } from '../commands/system/node.js';
import { createCurlCommand } from '../commands/net/curl.js';
import { createTunnelCommandV2 } from '../commands/net/tunnel-v2.js';
import { createIfconfigCommand } from '../commands/net/ifconfig.js';
import { createRouteCommand } from '../commands/net/route.js';
import { createNetstatCommand } from '../commands/net/netstat.js';
import { createHostCommand } from '../commands/net/host.js';
import { createIPCommand } from '../commands/net/ip.js';
import { createNpmCommand, createNpxCommand } from '../commands/system/npm.js';
import { createLifoPkgCommand, bootLifoPackages } from '../commands/system/lifo.js';
import { createSystemctlCommand } from '../commands/system/systemctl.js';
import { NativeFsProvider } from '../kernel/vfs/providers/NativeFsProvider.js';
import { SandboxFsImpl } from './SandboxFs.js';
import { SandboxCommandsImpl } from './SandboxCommands.js';
import { HeadlessTerminal } from './HeadlessTerminal.js';
export class Sandbox {
    /** Programmatic command execution */
    commands;
    /** Filesystem operations */
    fs;
    /** Environment variables */
    env;
    // Power-user escape hatches
    kernel;
    shell;
    _destroyed = false;
    constructor(kernel, shell, commands, fs, env) {
        this.kernel = kernel;
        this.shell = shell;
        this.commands = commands;
        this.fs = fs;
        this.env = env;
    }
    /** Current working directory */
    get cwd() {
        return this.shell.getCwd();
    }
    set cwd(path) {
        this.shell.setCwd(path);
    }
    /**
     * Create a new Sandbox instance.
     * Orchestrates all boot steps: Kernel, VFS, Registry, Shell, config sourcing.
     */
    static async create(options) {
        // 1. Create and boot kernel
        const kernel = new Kernel();
        await kernel.boot({ persist: options?.persist ?? false });
        // 2. Create command registry
        const registry = createDefaultRegistry();
        bootLifoPackages(kernel.vfs, registry);
        // 3. Pre-populate files if provided
        if (options?.files) {
            for (const [path, content] of Object.entries(options.files)) {
                ensureParentDirs(kernel.vfs, path);
                kernel.vfs.writeFile(path, content);
            }
        }
        // 4. Set up environment
        const defaultEnv = kernel.getDefaultEnv();
        const env = { ...defaultEnv, ...options?.env };
        if (options?.cwd) {
            env.PWD = options.cwd;
        }
        // 5. Create terminal
        let shellTerminal;
        let isVisual = false;
        if (options?.terminal) {
            shellTerminal = options.terminal;
            isVisual = true;
        }
        else {
            shellTerminal = new HeadlessTerminal();
        }
        // 6. Create shell
        const shell = new Shell(shellTerminal, kernel.vfs, registry, env, kernel.processRegistry);
        // 7. Register factory commands
        const processRegistry = shell.getProcessRegistry();
        registry.register('ps', createPsCommand(processRegistry));
        registry.register('top', createTopCommand(processRegistry));
        registry.register('kill', createKillCommand(processRegistry));
        registry.register('watch', createWatchCommand(registry));
        registry.register('help', createHelpCommand(registry));
        registry.register('node', createNodeCommand(kernel));
        registry.register('curl', createCurlCommand(kernel));
        registry.register('tunnel', createTunnelCommandV2(kernel));
        // Register network commands
        registry.register('ifconfig', createIfconfigCommand(kernel));
        registry.register('route', createRouteCommand(kernel));
        registry.register('netstat', createNetstatCommand(kernel));
        registry.register('host', createHostCommand(kernel));
        registry.register('ip', createIPCommand(kernel));
        // Register npm with shell execution support
        const npmShellExecute = async (cmd, cmdCtx) => {
            const result = await shell.execute(cmd, {
                cwd: cmdCtx.cwd,
                env: cmdCtx.env,
                onStdout: (data) => cmdCtx.stdout.write(data),
                onStderr: (data) => cmdCtx.stderr.write(data),
            });
            return result.exitCode;
        };
        registry.register('npm', createNpmCommand(registry, npmShellExecute, kernel));
        registry.register('npx', createNpxCommand(registry, npmShellExecute));
        registry.register('lifo', createLifoPkgCommand(registry, npmShellExecute, kernel));
        // 7b. Service manager & systemctl
        kernel.initServiceManager(registry, env);
        registry.register('systemctl', createSystemctlCommand(kernel));
        // 8. Source config files
        await shell.sourceFile('/etc/profile');
        await shell.sourceFile(env.HOME + '/.bashrc');
        // 9. Set initial cwd if provided
        if (options?.cwd) {
            shell.setCwd(options.cwd);
        }
        // 9b. Boot enabled services
        await kernel.bootServices();
        // 10. Start shell (for visual mode, enables interactive input)
        if (isVisual) {
            shell.start();
            shellTerminal.focus();
        }
        // 11. Build the Sandbox
        const getCwd = () => shell.getCwd();
        const sandboxFs = new SandboxFsImpl(kernel.vfs, getCwd);
        const sandboxCommands = new SandboxCommandsImpl(shell, registry);
        const sandbox = new Sandbox(kernel, shell, sandboxCommands, sandboxFs, env);
        // 12. Mount native filesystems if specified in options
        if (options?.mounts) {
            for (const mount of options.mounts) {
                sandbox.mountNative(mount.virtualPath, mount.hostPath, {
                    readOnly: mount.readOnly,
                    fsModule: mount.fsModule,
                });
            }
        }
        return sandbox;
    }
    /**
     * Mount a native filesystem directory into the virtual filesystem.
     * Only works in Node.js environments (or when a custom fsModule is provided).
     *
     * Once mounted, all VFS operations (and therefore the node-compat fs shim)
     * on paths under `virtualPath` will be delegated through the VFS mount system
     * to the NativeFsProvider, which in turn delegates to the real node:fs module.
     *
     * @param virtualPath - Path inside the virtual filesystem (e.g. "/mnt/project")
     * @param hostPath - Host filesystem path to mount (e.g. "/home/user/my-project")
     * @param options - Optional settings: readOnly, fsModule
     */
    mountNative(virtualPath, hostPath, options) {
        if (this._destroyed)
            throw new Error('Sandbox is destroyed');
        let fsModule = options?.fsModule;
        if (!fsModule) {
            // Try to get the native fs module. This only works in Node.js environments.
            // We use a dynamic require pattern that works at runtime but avoids
            // static analysis by bundlers.
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const mod = 'node:fs';
                fsModule = globalThis.require?.(mod);
            }
            catch {
                // globalThis.require may not exist
            }
            if (!fsModule) {
                throw new Error('mountNative requires a Node.js environment or a custom fsModule. ' +
                    'Pass { fsModule: require("node:fs") } in a Node.js environment, ' +
                    'or provide a compatible NativeFsModule implementation.');
            }
        }
        const provider = new NativeFsProvider(hostPath, fsModule, {
            readOnly: options?.readOnly ?? false,
        });
        this.kernel.vfs.mount(virtualPath, provider);
    }
    /**
     * Unmount a previously mounted filesystem.
     *
     * @param virtualPath - The virtual path that was passed to mountNative()
     */
    unmountNative(virtualPath) {
        if (this._destroyed)
            throw new Error('Sandbox is destroyed');
        this.kernel.vfs.unmount(virtualPath);
    }
    /**
     * Export the entire VFS as a tar.gz snapshot.
     */
    async exportSnapshot() {
        return this.fs.exportSnapshot();
    }
    /**
     * Restore VFS from a tar.gz snapshot.
     */
    async importSnapshot(data) {
        return this.fs.importSnapshot(data);
    }
    /**
     * Destroy the sandbox, releasing all resources.
     */
    destroy() {
        this._destroyed = true;
    }
}
// ─── Helpers ───
function ensureParentDirs(vfs, filePath) {
    const parts = filePath.split('/').filter(Boolean);
    parts.pop(); // remove filename
    let current = '';
    for (const part of parts) {
        current += '/' + part;
        if (!vfs.exists(current)) {
            vfs.mkdir(current, { recursive: true });
        }
    }
}
