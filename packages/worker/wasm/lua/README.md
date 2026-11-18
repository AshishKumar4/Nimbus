# Lua 5.4.8 CLI

`nimbus install lua` installs the pinned Lua 5.4.8 guest from a catalog that
includes it. Run `lua script.lua` from the project's directory. Ordinary
Lua `require` finds `./name.lua` and `./name/init.lua` there. The guest does
not provide an interactive REPL or LuaRocks, and has no native module loader.

The guest uses `wasi-cli-runner@1` and Nimbus's shared cwd, wait/restart and
signal glue. The source digest is in `runtime-specs.mjs`; the wasi-sdk 27.0
archive digest is in `scripts/ci/remote-wasi-cli-build.mjs`. The build extracts
the MIT license from the pinned source. The runtime spec pins both outputs.

From a clean commit, rebuild and run the fixtures against pristine native
Lua and the Nimbus guest on Armada:

```sh
bun scripts/ci/remote-wasi-cli-build.mjs lua
```

For the end-to-end probe, create a dedicated `nimbus-probe-*` R2 bucket and
publish only to it. `CLOUDFLARE_ACCOUNT_ID` must pin the intended account.
Read the catalog SHA-256 from the publisher's `catalog/sha256/…` output.

```sh
(cd packages/worker && node scripts/bundle-runtime.mjs lua 5.4.8 --bucket "$bucket")
bun scripts/ci/remote-probes.mjs --deploy lua-cli --only _manual/lua-catalog \
  --runtime-bucket "$bucket" --runtime-catalog-sha256 "$catalog_sha256" --parts 1 --jobs 1
bun tests/behavioral/_throwaway-target.mjs down --name lua-cli
```

The probe runs both install forms in separate fresh sessions and reruns
the pinned install's fixtures after a confirmed Durable Object reset. It also
checks a restarted input wait and delivery of SIGINT to Lua. After the probe,
delete the dedicated bucket and its objects. Keep the production catalog and
its deployment pin unchanged.
