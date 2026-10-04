// Says what it can see of its host's environment, then ends.
import { joinRealm } from './join.mjs';

const realm = await joinRealm();
realm.post({
  env: process.env.NIMBUS_REALM_SENTINEL ?? null,
  dotenv: process.env.NIMBUS_DOTENV_SENTINEL ?? null,
  preloaded: globalThis.__nimbusPreloaded ?? false,
  payload: realm.payload,
});
