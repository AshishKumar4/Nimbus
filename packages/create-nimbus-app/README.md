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

The session UI also includes Agent mode. To let users connect their own
Cloudflare account for Workers AI, create a Cloudflare OAuth client with
redirect URL `https://<your-nimbus-host>/api/nimbus/oauth/callback`, add
`NIMBUS_CF_OAUTH_CLIENT_ID`, `NIMBUS_CF_OAUTH_SCOPES`,
`NIMBUS_AGENT_MODEL`, and `NIMBUS_AGENT_GATEWAY_ID` to `wrangler.jsonc`,
then store `NIMBUS_CF_OAUTH_CLIENT_SECRET` with `wrangler secret put`.
