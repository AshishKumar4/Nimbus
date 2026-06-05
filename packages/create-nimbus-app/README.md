# create-nimbus-app

Scaffold a Nimbus-powered Cloudflare Workers app.

```bash
npx create-nimbus-app my-nimbus-worker
cd my-nimbus-worker
npm install
CLOUDFLARE_ACCOUNT_ID=<account-id> npx @nimbus-sh/cli setup cloudflare --name my-nimbus-worker
npx wrangler secret put JWT_SECRET
npx wrangler deploy
```

If setup reports Cloudflare R2 error `10042`, enable R2 in the Cloudflare
Dashboard once for this account, then rerun the setup command.

Options:

```bash
npx create-nimbus-app my-nimbus-worker --name my-worker-name
npx create-nimbus-app . --name my-worker-name
```

This package is a small wrapper around `@nimbus-sh/cli`.

The generated Worker embeds the interactive Nimbus UI and enables the
authenticated remote sandbox API. Add your application auth route before
minting user tokens from the backend.
