// Shared fanout env fake for NpmInstaller unit tests.
//
// Fanout picks its topology on the session's Dynamic Worker headroom: a
// batch wider than it goes to NIMBUS_SESSION supervisorOp (peer-DO), others
// to the in-DO IsolatePool which drives LOADER.get(id).getEntrypoint().execute(spec).
// A fake that only covers the session binding breaks the moment a test
// dispatches a narrow layer — both shapes here answer the same fake so
// either topology works. `resultFor(name, spec)` answers resolve tasks
// (`spec.range` is the edge's range, for registries with more than one
// version of a name); `shardsSeen` records package names the write shard
// was asked to install. Each package is written to the placement the
// supervisor chose (`pkgDir`), root or nested.
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { NpmInstaller } from '../../packages/worker/src/npm/installer.ts';

// The installer over `vfs`, installing as pid 1 with the kernel's credential:
// these fixtures' trees are root's, so an install reads and writes them as root.
export function kernelInstaller(vfs, sql, opts) {
  const installer = new NpmInstaller(new ProcessFiles(vfs), sql, opts);
  const install = installer.install.bind(installer);
  installer.install = (dir, options) => install(dir, { pid: 1, cred: CRED_KERNEL, ...options });
  return installer;
}

// Synthetic packument cache rows used by the installer fixtures below the RPC seam.
export function cacheRowForPackage(pkg) {
  return {
    name: pkg.name, version: pkg.version, tarballUrl: pkg.tarballUrl, integrity: pkg.integrity,
    depsJson: JSON.stringify(pkg.dependencies), peerDepsJson: JSON.stringify(pkg.peerDependencies ?? {}),
    exportsJson: JSON.stringify(pkg.exports ?? {}), main: pkg.main, moduleField: pkg.module,
    binJson: JSON.stringify(pkg.bin), platformJson: JSON.stringify({ os: pkg.os, cpu: pkg.cpu, libc: pkg.libc }),
    optionalDepsJson: JSON.stringify(pkg.optionalDependencies ?? {}), fetchedAt: Date.now(),
  };
}

export function makeFanoutEnv({ root, NM, resultFor, shardsSeen = [], log = [] }) {
  const fanoutReply = (args) => {
    if (args[0] && Array.isArray(args[0].packages)) {
      // The install shard: write each package's package.json so the
      // tree is real for on-disk assertions.
      return { results: args.map((shard) => {
        shardsSeen.push(...shard.packages.map((p) => p.name));
        for (const p of shard.packages) {
          const dir = p.pkgDir ?? `${NM}/${p.name}`;
          root.mkdir(dir, { recursive: true });
          root.writeFile(`${dir}/package.json`, JSON.stringify({ name: p.name, version: p.version }));
        }
        return {
          perPackage: shard.packages.map((p) => ({ name: p.name, version: p.version, pkgDir: p.pkgDir, fileCount: 1, bytesWritten: 40, elapsed: 1, warnings: [] })),
          elapsed: 1,
          facetCounters: { tarballsCompleted: 0, cumulativeBytesDecoded: 0, peakInFlight: 1, pipelinedTarballRaceWins: 0, pipelinedTarballRaceLosses: 0 },
          cacheStatEvents: [],
        };
      }) };
    }
    return { results: args.map((spec) => resultFor(spec.name, spec)) };
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
