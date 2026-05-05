# Remix minimal fixture

Hand-written, deliberately minimal Remix v2 project (vite-plugin path).

- Pinned upstream commit: `https://github.com/remix-run/remix/tree/remix%402.13.0/templates/vite`
- Fault-mode bake: `routes/_index.tsx` includes a `<Link to="/about">`
  to exercise the `react-router-dom` peer-dep recheck flagged in W11
  plan §3.3.
- Uses `@remix-run/node` (not `@remix-run/cloudflare`) so we don't
  collide with the wrangler-on-framework override.
