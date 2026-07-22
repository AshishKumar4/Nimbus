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
		'/start/tour': '/docs/start/quickstart/',
		'/start/boot': '/docs/start/quickstart/',
		'/machine/tty': '/docs/machine/terminal/',
		'/machine/packages': '/docs/machine/toolchains/',
		'/machine/network': '/docs/machine/processes/',
		'/sdk/react': '/docs/sdk/embed/',
		'/sdk/cli': '/docs/sdk/handler/',
		'/internals/git-engine': '/docs/machine/git/',
		'/internals/budgets': '/docs/internals/fabric/',
		'/fine-print/limitations': '/docs/fine-print/capabilities/',
	},
	integrations: [
		starlight({
			title: 'Nimbus',
			description:
				'Documentation for Nimbus — an open-source, POSIX-like sandbox that runs on Cloudflare Durable Objects. A real shell with node, python, ruby, git, npm, and clang; no containers, no VMs.',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/AshishKumar4/Nimbus' },
			],
			customCss: ['./src/styles/theme.css', './src/styles/diagrams.css'],
			expressiveCode: {
				defaultProps: { frame: 'terminal' },
			},
			plugins: [starlightLlmsTxt()],
			components: {
				ThemeProvider: './src/components/ThemeProvider.astro',
			},
			editLink: {
				baseUrl: 'https://github.com/AshishKumar4/Nimbus/edit/main/apps/docs/',
			},
			sidebar: [
				{
					label: 'Getting started',
					items: [
						{ label: 'Quickstart', slug: 'start/quickstart' },
						{ label: 'Where Nimbus fits', slug: 'start/where-it-fits' },
					],
				},
				{
					label: 'The sandbox',
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
					label: 'SDK',
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
						{ label: 'Security', slug: 'internals/security' },
						{ label: 'Inside the disk', slug: 'internals/disk' },
						{ label: 'The process fabric', slug: 'internals/processes' },
						{ label: 'Ports & routing', slug: 'internals/network' },
						{ label: 'WASI & syscalls', slug: 'internals/wasi' },
					],
				},
				{
					label: 'Status & limits',
					items: [
						{ label: 'Capabilities & limits', slug: 'fine-print/capabilities' },
						{ label: 'Benchmarks', slug: 'fine-print/benchmarks' },
						{ label: 'Research & roadmap', slug: 'fine-print/research' },
					],
				},
			],
		}),
	],
});
