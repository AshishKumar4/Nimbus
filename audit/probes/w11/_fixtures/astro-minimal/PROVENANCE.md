# Astro minimal fixture

Hand-written, deliberately minimal Astro 4 project mirrored against
`withastro/astro` v4.16 `create-astro` "minimal" template.

- Pinned upstream commit: `https://github.com/withastro/astro/tree/v4.16.0/packages/astro/test/fixtures`
- Fault-mode bake: ships a `<Counter client:load />` React island so
  `<astro-island>` element appears in rendered HTML (the W11 e2e marker).
  Without an island, an Astro page renders as plain HTML and the
  `<astro-island>` regex would false-RED on a working Astro install.
- Includes `@astrojs/react` to exercise the integration loader.
