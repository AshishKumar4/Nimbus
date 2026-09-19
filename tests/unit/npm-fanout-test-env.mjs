// Shared fanout env fake for NpmInstaller unit tests.
//
// Fanout picks its topology by task width: >= IN_DO_THRESHOLD goes to
// NIMBUS_SESSION._rpcFanoutExecute (peer-DO), below that to the in-DO
// IsolatePool which drives LOADER.get(id).getEntrypoint().execute(spec).
// A fake that only covers the session binding breaks the moment a test
// dispatches a narrow layer — both shapes here answer the same fake so
// either topology works. `resultFor(name)` answers resolve tasks;
// `shardsSeen` records package names the write shard was asked to
// install.
export function makeFanoutEnv({ root, NM, resultFor, shardsSeen = [], log = [] }) {
  const fanoutReply = (args) => {
    if (args[0] && Array.isArray(args[0].packages)) {
      // The install shard: write each package's package.json so the
      // tree is real for on-disk assertions.
      return { results: args.map((shard) => {
        shardsSeen.push(...shard.packages.map((p) => p.name));
        for (const p of shard.packages) {
          root.mkdir(`${NM}/${p.name}`, { recursive: true });
          root.writeFile(`${NM}/${p.name}/package.json`, JSON.stringify({ name: p.name, version: p.version }));
        }
        return {
          perPackage: shard.packages.map((p) => ({ name: p.name, version: p.version, fileCount: 1, bytesWritten: 40, elapsed: 1, warnings: [] })),
          elapsed: 1,
          facetCounters: { tarballsCompleted: 0, cumulativeBytesDecoded: 0, peakInFlight: 1, pipelinedTarballRaceWins: 0, pipelinedTarballRaceLosses: 0 },
          cacheStatEvents: [],
        };
      }) };
    }
    return { results: args.map((spec) => resultFor(spec.name)) };
  };
  return {
    // In-DO fanout: one entrypoint.execute per task spec.
    LOADER: { get() { return { getEntrypoint: () => ({ execute: async (...args) => fanoutReply(args).results[0] }) }; } },
    NIMBUS_SESSION: {
      idFromName(name) { return { toString: () => name, name }; },
      idFromString(id) { return { toString: () => id, name: id }; },
      get() {
        return {
          async supervisorOp(envelope) {
            const [_fnSource, args] = envelope.args;
            return fanoutReply(args);
          },
        };
      },
    },
  };
}
