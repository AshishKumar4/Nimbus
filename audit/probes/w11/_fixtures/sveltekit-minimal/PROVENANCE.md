# SvelteKit minimal fixture

Hand-written, deliberately minimal SvelteKit 2 project mirrored against
the upstream `sveltejs/kit` v2.7 `create-svelte` "minimal" template.

- Pinned upstream commit: `https://github.com/sveltejs/kit/tree/v2.7.0/packages/create-svelte/templates/default`
- Adapted for Nimbus: removed `@sveltejs/adapter-auto` (we test with
  `@sveltejs/adapter-node` to avoid runtime introspection that fights
  our facet sandbox).
- The fault-mode bake: `+page.svelte` imports `greet` from `$lib/greet`,
  which exercises the SK Vite plugin's `$lib` alias regression that the
  W11 plan §3.1 calls out.
