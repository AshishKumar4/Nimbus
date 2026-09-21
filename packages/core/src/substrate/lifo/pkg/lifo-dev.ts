/**
 * Dev-link management for lifo packages.
 *
 * Stores a registry at /etc/lifo/dev-links.json that maps command names
 * to local VFS paths.  `lifo link` adds entries, `lifo unlink` removes them.
 */

import type { ExecutionFs as VFS } from '../../../shell/execution-fs.js';
import type { CommandRegistry } from '../commands/registry.js';
import { join } from '../utils/path.js';
import { createLifoCommand, readLifoManifest } from './lifo-runtime.js';

const DEV_LINKS_PATH = '/etc/lifo/dev-links.json';

// ─── Types ───

export interface DevLink {
  /** Absolute VFS path to the package root. */
  path: string;
  /** command name -> relative entry path (from lifo.commands). */
  commands: Record<string, string>;
}

export type DevLinksMap = Record<string, DevLink>;

// ─── Persistence ───

export async function readDevLinks(vfs: VFS): Promise<DevLinksMap> {
  try {
    return JSON.parse((await vfs.readFileString(DEV_LINKS_PATH)));
  } catch {
    return {};
  }
}

export async function writeDevLinks(vfs: VFS, links: DevLinksMap): Promise<void> {
  try { (await vfs.mkdir('/etc/lifo', { recursive: true })); } catch { /* exists */ }
  (await vfs.writeFile(DEV_LINKS_PATH, JSON.stringify(links, null, 2) + '\n'));
}

// ─── Operations ───

/**
 * Link a local package directory for development.
 * Reads the lifo manifest from the directory's package.json and registers
 * all declared commands.
 *
 * Returns the list of command names registered.
 */
export async function linkPackage(
  vfs: VFS,
  registry: CommandRegistry,
  pkgDir: string,
): Promise<string[]> {
  const manifest = (await readLifoManifest(vfs, pkgDir));
  if (!manifest) {
    throw new Error(
      `No "lifo" field found in ${join(pkgDir, 'package.json')}. ` +
      'Is this a lifo package?',
    );
  }

  // Read package name for the dev-link key
  let pkgName: string;
  try {
    const pkg = JSON.parse((await vfs.readFileString(join(pkgDir, 'package.json'))));
    pkgName = pkg.name || pkgDir.split('/').pop() || 'unknown';
  } catch {
    pkgName = pkgDir.split('/').pop() || 'unknown';
  }

  const links = (await readDevLinks(vfs));
  links[pkgName] = {
    path: pkgDir,
    commands: manifest.commands,
  };
  (await writeDevLinks(vfs, links));

  // Register commands
  const registered: string[] = [];
  for (const [cmdName, entryRelPath] of Object.entries(manifest.commands)) {
    const entryPath = join(pkgDir, entryRelPath);
    registry.register(cmdName, createLifoCommand(entryPath, vfs));
    registered.push(cmdName);
  }

  return registered;
}

/**
 * Unlink a previously dev-linked package.
 * Note: we cannot truly un-register commands from the registry, but we
 * remove the dev-link entry so they won't be restored on next boot.
 *
 * Returns the command names that were linked, or null if not found.
 */
export async function unlinkPackage(
  vfs: VFS,
  pkgName: string,
): Promise<string[] | null> {
  const links = (await readDevLinks(vfs));
  const link = links[pkgName];
  if (!link) return null;

  const cmds = Object.keys(link.commands);
  delete links[pkgName];
  (await writeDevLinks(vfs, links));

  return cmds;
}

/**
 * Restore all dev-linked commands at boot time.
 */
export async function loadDevLinks(vfs: VFS, registry: CommandRegistry): Promise<void> {
  const links = (await readDevLinks(vfs));

  for (const link of Object.values(links)) {
    // Re-validate that the manifest still exists
    const manifest = (await readLifoManifest(vfs, link.path));
    if (!manifest) continue;

    for (const [cmdName, entryRelPath] of Object.entries(manifest.commands)) {
      const entryPath = join(link.path, entryRelPath);
      if ((await vfs.exists(entryPath))) {
        registry.register(cmdName, createLifoCommand(entryPath, vfs));
      }
    }
  }
}
