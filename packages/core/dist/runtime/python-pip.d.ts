import type { WorkspaceNetwork } from '../_shared/workspace-network.js';
import { EnvironmentMarkerVariable } from 'pip-requirements-js';
/** Where `pip install` puts packages for the user whose home is `home`. */
export declare function pythonSitePackages(home: string): string;
interface PythonPipVfs {
    exists(path: string): boolean | Promise<boolean>;
    readFile(path: string): Uint8Array | Promise<Uint8Array>;
}
/**
 * Whether this session has installed anything the sci interpreter variant
 * carries compiled code for.
 *
 * This reads installed state; it does not predict what a program might import.
 * The dist-info directory pip writes is the record, and a variant chosen from it
 * is right for `python -c` reading a module name out of a variable, which a
 * per-program classifier cannot be.
 */
export declare function sessionUsesSciVariant(vfs: PythonPipVfs, home: string): Promise<boolean>;
/**
 * The PEP 508 environment markers of the interpreter pip installs for, each
 * variable but `extra`: what packaging.markers.default_environment()
 * answers in it.
 */
export type PythonMarkerEnvironment = Readonly<Record<Exclude<EnvironmentMarkerVariable, EnvironmentMarkerVariable.Extra>, string>>;
export interface PythonPipRuntimeContext {
    /** The installing user's home: packages go to its {@link pythonSitePackages}. */
    home: string;
    /** The workspace's network: PyPI is reached through its egress, when it has one. */
    network: WorkspaceNetwork;
    /** The interpreter's markers: a requirement applies when its marker holds in them. */
    markers: PythonMarkerEnvironment;
}
export interface PipInvocation {
    mode: 'pip' | 'none';
    code: string;
    error?: string;
    exitCode: number;
}
export declare function buildPipInvocation(argv: string[], binName: string, cwd: string, vfs: PythonPipVfs, runtimeContext: PythonPipRuntimeContext): Promise<PipInvocation>;
export {};
//# sourceMappingURL=python-pip.d.ts.map