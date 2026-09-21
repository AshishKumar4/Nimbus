import type { ExecutionFs as VFS } from '../../../shell/execution-fs.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { Command, CommandContext } from '../commands/types.js';

const METADATA_FILE = '/usr/share/pkg/packages.json';
const MODULES_DIR = '/usr/share/pkg/node_modules';

export async function loadInstalledPackages(vfs: VFS, registry: CommandRegistry): Promise<void> {
  let meta: { packages: Record<string, { name: string }> };

  try {
    const content = (await vfs.readFileString(METADATA_FILE));
    meta = JSON.parse(content);
  } catch {
    return; // No packages installed
  }

  for (const name of Object.keys(meta.packages)) {
    const scriptPath = `${MODULES_DIR}/${name}/index.js`;
    if (!(await vfs.exists(scriptPath))) continue;

    // Register as a lazy command that invokes `node <script>`
    registry.registerLazy(name, () =>
      import('../commands/system/node.js').then((mod) => ({
        default: ((ctx: CommandContext) =>
          mod.default({
            ...ctx,
            args: [scriptPath, ...ctx.args],
          })) as Command,
      })),
    );
  }
}
