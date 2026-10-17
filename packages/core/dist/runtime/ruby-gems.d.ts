import type { ProcessView as CredentialedVfs } from './process-files.js';
import type { WorkspaceNetwork } from '../_shared/workspace-network.js';
export interface RubyGemRequest {
    name: string;
    requirements: string[];
}
export interface RubyGemInstallReport {
    installed: string[];
    alreadyInstalled: string[];
}
export interface InstalledRubyGemBin {
    name: string;
    path: string;
}
/** Where `gem install` puts gems for the user whose home is `home`, as `gem --user-install` does. */
export declare function gemHomeFor(home: string): string;
/** What a launch gives Ruby of a gem home (installedGemLoadPath). */
export interface GemLoadPath {
    /** The lib directories its load path is given ahead of RubyGems (NIMBUS_GEM_LIBS), sorted. */
    libs: string[];
    /** Whether a gem was left for RubyGems to activate: only then does RubyGems read the home. */
    activates: boolean;
}
/**
 * The installed gems' lib directories Ruby's load path is given ahead of
 * RubyGems: each version the specifications name (`gems/<name>-<version>/lib`,
 * where that is a directory), the one inventory, so a gem whose install was
 * interrupted has none. A gem whose version RubyGems must choose is left out,
 * for `require` to activate it as RubyGems does: one with two versions
 * installed, and one whose runtime dependencies reach such a gem at any depth
 * (its requirements choose the version). A home with no version to choose
 * costs no activation, and RubyGems does not read it at all.
 */
export declare function installedGemLoadPath(vfs: CredentialedVfs, gemHome: string): Promise<GemLoadPath>;
/**
 * Every gem-bin wrapper in `gemHome` that an earlier Nimbus wrote, written
 * again as writeGemExecutableWrapper writes one now, so that RubyGems chooses
 * its executable where it chooses its version. Its gem is named by its
 * specification (readGemSpec). Run before the bins are registered; a wrapper
 * already current is read and left alone.
 */
export declare function reconcileGemBinWrappers(vfs: CredentialedVfs, gemHome: string): Promise<void>;
export declare function installedGemBins(vfs: CredentialedVfs, gemHome: string): Promise<InstalledRubyGemBin[]>;
export declare function installRubyGems(vfs: CredentialedVfs, requests: RubyGemRequest[], 
/** `network`: the workspace's; RubyGems is reached through its egress, when it has one. */
opts: {
    gemHome: string;
    includeDependencies?: boolean;
    network: WorkspaceNetwork;
}): Promise<RubyGemInstallReport>;
export declare function installRubyBundle(vfs: CredentialedVfs, cwd: string, opts: {
    gemHome: string;
    network: WorkspaceNetwork;
}): Promise<{
    requests: RubyGemRequest[];
    report: RubyGemInstallReport;
    lockfilePath: string;
}>;
export declare function parseGemfile(text: string): RubyGemRequest[];
export declare function parseRubyGemRequirements(input: string | undefined): string[];
//# sourceMappingURL=ruby-gems.d.ts.map