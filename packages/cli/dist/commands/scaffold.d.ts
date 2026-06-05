/**
 * cli/commands/scaffold — `create-nimbus-app <project-name>`.
 *
 * v0.1 ships a single template: `worker-only`. The scaffolder writes:
 *
 *   <project>/
 *   ├── package.json       — deps: @nimbus-sh/sdk, @nimbus-sh/worker
 *   ├── wrangler.jsonc     — the canonical 28-LOC embedder snippet
 *   ├── src/
 *   │   └── index.ts       — 6 LOC default-export
 *   ├── README.md          — install + deploy instructions
 *   └── .gitignore         — node_modules, .wrangler
 *
 * The scaffolder does NOT call `wrangler login`, `wrangler secret put`,
 * or `wrangler deploy` — those are interactive and operator-owned. We
 * print the exact commands to run as a "next steps" trailer.
 */
/**
 * Scaffold a new Nimbus project at the given directory.
 *
 * @param args Argv: `[project-name, ...flags]`. Flags:
 *               `--template worker-only` (default)
 *               `--name <wrangler-name>` (default: project-name)
 *               `--force` overwrite existing files.
 */
export declare function scaffold(args: string[]): Promise<number>;
//# sourceMappingURL=scaffold.d.ts.map