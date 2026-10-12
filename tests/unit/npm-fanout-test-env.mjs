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
// supervisor chose (`pkgDir`), root or nested: `manifestFor(p)`, its
// package.json (by default its name and version), and `filesFor(p)`'s other
// files (path in the package → content: what its archive bundles), unless
// `failFor(p)` names why it fails there. `crashFor(p)` makes the shard
// itself fail when it reaches p: 'before' writing it, or 'after' (its
// outcome lost, as a timed-out execution's). Each task settles on its own,
// as the peer shard settles each.
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

export function makeFanoutEnv({ root, NM, resultFor, shardsSeen = [], log = [], failFor = () => null, crashFor = () => null, manifestFor = (p) => ({ name: p.name, version: p.version }), filesFor = () => ({}) }) {
  const fanoutReply = (args) => {
    if (args[0] && Array.isArray(args[0].packages)) {
      // The install shard: write each package's package.json so the
      // tree is real for on-disk assertions.
      return { results: args.map((shard) => {
        shardsSeen.push(...shard.packages.map((p) => p.name));
        const perPackage = shard.packages.map((p) => {
          if (crashFor(p) === 'before') throw new Error(`shard crashed before ${p.name}`);
          const errorText = failFor(p);
          if (errorText) return { name: p.name, version: p.version, pkgDir: p.pkgDir, fileCount: 0, bytesWritten: 0, elapsed: 1, warnings: [], errorText };
          const dir = p.pkgDir ?? `${NM}/${p.name}`;
          root.mkdir(dir, { recursive: true });
          root.writeFile(`${dir}/package.json`, JSON.stringify(manifestFor(p)));
          for (const [path, content] of Object.entries(filesFor(p))) {
            root.mkdir(`${dir}/${path.slice(0, path.lastIndexOf('/'))}`, { recursive: true });
            root.writeFile(`${dir}/${path}`, content);
          }
          if (crashFor(p) === 'after') throw new Error(`shard crashed after ${p.name}`);
          return { name: p.name, version: p.version, pkgDir: p.pkgDir, fileCount: 1, bytesWritten: 40, elapsed: 1, warnings: [] };
        });
        return {
          perPackage,
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
            return {
              results: args.map((arg) => {
                try {
                  return { ok: true, value: fanoutReply([arg]).results[0] };
                } catch (error) {
                  return { ok: false, message: error.message };
                }
              }),
            };
          },
        };
      },
    },
  };
}
