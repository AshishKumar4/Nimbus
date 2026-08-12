const METADATA_FILE = '/usr/share/pkg/packages.json';
const MODULES_DIR = '/usr/share/pkg/node_modules';
export function loadInstalledPackages(vfs, registry) {
    let meta;
    try {
        const content = vfs.readFileString(METADATA_FILE);
        meta = JSON.parse(content);
    }
    catch {
        return; // No packages installed
    }
    for (const name of Object.keys(meta.packages)) {
        const scriptPath = `${MODULES_DIR}/${name}/index.js`;
        if (!vfs.exists(scriptPath))
            continue;
        // Register as a lazy command that invokes `node <script>`
        registry.registerLazy(name, () => import('../commands/system/node.js').then((mod) => ({
            default: ((ctx) => mod.default({
                ...ctx,
                args: [scriptPath, ...ctx.args],
            })),
        })));
    }
}
