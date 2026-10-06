import { z } from 'zod/v4';

export const RegistryVersionInfoSchema = z.object({
	name: z.string(),
	version: z.string(),
	description: z.string().optional(),
	main: z.string().optional(),
	bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
	scripts: z.record(z.string(), z.string()).optional(),
	dependencies: z.record(z.string(), z.string()).optional(),
	devDependencies: z.record(z.string(), z.string()).optional(),
	dist: z.object({
		tarball: z.string(),
		shasum: z.string().optional(),
		integrity: z.string().optional(),
	}),
}).passthrough();

export type RegistryVersionInfo = z.infer<typeof RegistryVersionInfoSchema>;

export const RegistryPackumentSchema = z.object({
	versions: z.record(z.string(), RegistryVersionInfoSchema),
}).passthrough();

export const RegistrySearchResponseSchema = z.object({
	objects: z.array(z.object({
		package: z.object({
			name: z.string(),
			version: z.string(),
			description: z.string().optional(),
		}).passthrough(),
	})),
}).passthrough();

/** A search hit as the results table shows it. */
export interface SearchRow { readonly name: string; readonly version: string; readonly description?: string }

/**
 * `npm search`'s results table, which `lifo search` prints too: NAME (30
 * columns, cut at 28 with `..`), VERSION (12), and 40 columns of
 * DESCRIPTION, under a 70-dash rule.
 */
export function renderSearchTable(rows: readonly SearchRow[]): string {
	let out = `${'NAME'.padEnd(30)}${'VERSION'.padEnd(12)}DESCRIPTION\n${'-'.repeat(70)}\n`;
	for (const row of rows) {
		const name = row.name.length > 28 ? `${row.name.slice(0, 28)}..` : row.name;
		out += `${name.padEnd(30)}${row.version.padEnd(12)}${(row.description || '').slice(0, 40)}\n`;
	}
	return out;
}
