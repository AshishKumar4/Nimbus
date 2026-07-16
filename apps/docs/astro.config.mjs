// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// The docs site serves under /docs so it can later be routed from
// nimbus.ashishkumarsingh.com/docs in front of the main app.
export default defineConfig({
	site: 'https://nimbus.ashishkumarsingh.com',
	base: '/docs',
	// Serve from a /docs subtree so the assets-only Worker maps URLs 1:1.
	outDir: './dist/docs',
	integrations: [
		starlight({
			title: 'Nimbus',
			description:
				"Give every agent its own computer. Nimbus is a free and open-source, POSIX-like cloud OS that runs entirely on Cloudflare's network.",
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/AshishKumar4/Nimbus' },
			],
			customCss: ['./src/styles/theme.css'],
			editLink: {
				baseUrl: 'https://github.com/AshishKumar4/Nimbus/edit/main/apps/docs/',
			},
			sidebar: [
				{
					label: 'First boot',
					items: [
						{ label: 'Boot your first computer', slug: 'start/boot' },
						{ label: 'A tour of the machine', slug: 'start/tour' },
						{ label: 'Where Nimbus fits', slug: 'start/where-it-fits' },
					],
				},
				{
					label: 'The machine',
					items: [
						{ label: 'Terminal & shell', slug: 'machine/terminal' },
						{ label: 'The disk', slug: 'machine/disk' },
						{ label: 'Toolchains', slug: 'machine/toolchains' },
						{ label: 'Package managers', slug: 'machine/packages' },
						{ label: 'Git', slug: 'machine/git' },
						{ label: 'The network', slug: 'machine/network' },
						{ label: 'Processes', slug: 'machine/processes' },
						{ label: 'The session agent', slug: 'machine/agent' },
						{ label: 'Interactive TTY apps', slug: 'machine/tty' },
					],
				},
				{
					label: 'Computers for your agents',
					items: [
						{ label: 'Embed Nimbus in a Worker', slug: 'sdk/embed' },
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
						{ label: 'The git engine', slug: 'internals/git-engine' },
						{ label: 'WASI & syscalls', slug: 'internals/wasi' },
						{ label: 'Security & isolation', slug: 'internals/security' },
						{ label: 'Budgets & limits', slug: 'internals/budgets' },
					],
				},
				{
					label: 'The fine print',
					items: [
						{ label: 'Capability matrix', slug: 'fine-print/capabilities' },
						{ label: 'What does not work', slug: 'fine-print/limitations' },
						{ label: 'Benchmarks', slug: 'fine-print/benchmarks' },
						{ label: 'Research frontier', slug: 'fine-print/research' },
					],
				},
			],
		}),
	],
});
