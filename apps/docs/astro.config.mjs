// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';

// The docs site serves under /docs from the hosted-demo Worker's assets
// binding (apps/hosted-demo/scripts/build-assets.mjs mounts the build there).
export default defineConfig({
	site: 'https://nimbus.ashishkumarsingh.com',
	base: '/docs',
	// Serve from a /docs subtree so the assets-only Worker maps URLs 1:1.
	outDir: './dist/docs',
	// Retired URLs from the 2026-07 consolidation keep working.
	redirects: {
		'/start/tour': '/docs/start/boot/',
		'/machine/tty': '/docs/machine/terminal/',
		'/machine/packages': '/docs/machine/toolchains/',
		'/machine/network': '/docs/machine/processes/',
		'/sdk/react': '/docs/sdk/embed/',
		'/sdk/cli': '/docs/sdk/handler/',
		'/internals/git-engine': '/docs/machine/git/',
		'/internals/budgets': '/docs/internals/fabric/',
		'/internals/security': '/docs/internals/fabric/',
		'/fine-print/limitations': '/docs/fine-print/capabilities/',
	},
	integrations: [
		starlight({
			title: 'Nimbus',
			description:
				"Give every agent its own computer. Nimbus is a free and open-source, POSIX-like cloud OS that runs entirely on Cloudflare's network.",
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/AshishKumar4/Nimbus' },
			],
			customCss: ['./src/styles/theme.css', './src/styles/diagrams.css'],
			plugins: [starlightLlmsTxt()],
			components: {
				ThemeProvider: './src/components/ThemeProvider.astro',
			},
			editLink: {
				baseUrl: 'https://github.com/AshishKumar4/Nimbus/edit/main/apps/docs/',
			},
			sidebar: [
				{
					label: 'First boot',
					items: [
						{ label: 'Boot your first computer', slug: 'start/boot' },
						{ label: 'Where Nimbus fits', slug: 'start/where-it-fits' },
					],
				},
				{
					label: 'The machine',
					items: [
						{ label: 'Terminal & shell', slug: 'machine/terminal' },
						{ label: 'The disk', slug: 'machine/disk' },
						{ label: 'Toolchains & packages', slug: 'machine/toolchains' },
						{ label: 'Git', slug: 'machine/git' },
						{ label: 'Processes & servers', slug: 'machine/processes' },
						{ label: 'The session agent', slug: 'machine/agent' },
					],
				},
				{
					label: 'Computers for your agents',
					items: [
						{ label: 'Embed Nimbus in a Worker', slug: 'sdk/embed' },
						{ label: 'Configure the handler', slug: 'sdk/handler' },
						{ label: 'The sandbox API', slug: 'sdk/sandbox-api' },
						{ label: 'Tokens & auth', slug: 'sdk/tokens' },
					],
				},
				{
					label: 'Under the hood',
					items: [
						{ label: 'The fabric', slug: 'internals/fabric' },
						{ label: 'Inside the disk', slug: 'internals/disk' },
						{ label: 'The process fabric', slug: 'internals/processes' },
						{ label: 'Ports & routing', slug: 'internals/network' },
						{ label: 'WASI & syscalls', slug: 'internals/wasi' },
					],
				},
				{
					label: 'The fine print',
					items: [
						{ label: "What works & what doesn't", slug: 'fine-print/capabilities' },
						{ label: 'Benchmarks', slug: 'fine-print/benchmarks' },
						{ label: 'Research frontier', slug: 'fine-print/research' },
					],
				},
			],
		}),
	],
});
