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
/** The filesystem reads a project probe needs. */
export interface ProjectProbeFs {
    exists(path: string): boolean;
    readFileString(path: string): string;
}
/**
 * W10: detect whether the project at `<root>` is a Cloudflare Workers
 * project. Returns true if any of the standard markers are present:
 *   - <root>/wrangler.jsonc
 *   - <root>/wrangler.json
 *   - <root>/wrangler.toml
 *   - <root>/package.json with `wrangler` in deps or devDeps
 */
export declare function detectCloudflareWorkersProject(vfs: ProjectProbeFs, root: string): boolean;
//# sourceMappingURL=project-detect.d.ts.map