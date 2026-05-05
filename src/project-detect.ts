/**
 * project-detect.ts — small, dependency-free project-type detectors.
 *
 * Lives in its own module so unit tests + diag endpoints can import the
 * detection helpers without pulling in nimbus-session.ts (which depends
 * on `cloudflare:workers` and won't load under Bun).
 *
 * Currently exports detectCloudflareWorkersProject — added in W10 as the
 * canonical "is this a Cloudflare Workers project?" check. Future waves
 * can add detectVite, detectNext, etc. here.
 */

/**
 * W10: detect whether the project at `<root>` is a Cloudflare Workers
 * project. Returns true if any of the standard markers are present:
 *   - <root>/wrangler.jsonc
 *   - <root>/wrangler.json
 *   - <root>/wrangler.toml
 *   - <root>/package.json with `wrangler` in deps or devDeps
 */
export function detectCloudflareWorkersProject(vfs: any, root: string): boolean {
  const r = String(root).replace(/^\/+/, '').replace(/\/+$/, '');
  for (const f of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']) {
    try {
      if (vfs.exists((r ? r + '/' : '') + f)) return true;
    } catch {}
  }
  try {
    const pkgPath = (r ? r + '/' : '') + 'package.json';
    if (vfs.exists(pkgPath)) {
      const text = vfs.readFileString(pkgPath);
      const pkg = JSON.parse(text);
      if (pkg && typeof pkg === 'object') {
        if (pkg.devDependencies && typeof pkg.devDependencies === 'object' && 'wrangler' in pkg.devDependencies) return true;
        if (pkg.dependencies && typeof pkg.dependencies === 'object' && 'wrangler' in pkg.dependencies) return true;
      }
    }
  } catch {
    // Malformed package.json or any other read error: not a CF Workers project per this signal.
  }
  return false;
}
