export type RuntimeSpec = string;
export type NimbusRuntimeName = 'node' | 'bun' | 'npm' | 'git' | 'python' | 'ruby' | 'clang' | 'shell' | (string & {});
export interface NimbusRuntimePolicy {
    preinstall?: RuntimeSpec[];
    onDemand?: boolean;
    allow?: NimbusRuntimeName[];
}
export interface NimbusSandboxProfile {
    root?: string;
    runtimes?: NimbusRuntimePolicy;
    tools?: {
        namespace?: string;
        kind?: string;
    };
    preview?: {
        baseUrl?: string;
        pathStyle?: boolean;
    };
}
export interface NimbusConfig {
    endpoint?: string;
    previewHostSuffix?: string;
    sandboxes?: Record<string, NimbusSandboxProfile>;
}
export declare function defineNimbusConfig<T extends NimbusConfig>(config: T): T;
export type NimbusRuntimeAction = 'preinstall' | 'onDemand' | 'use';
export type NimbusCodeLanguage = 'javascript' | 'typescript' | 'python' | 'ruby' | 'shell';
export interface NimbusRuntimePolicyError {
    code: 'E_RUNTIME_NOT_ALLOWED' | 'E_RUNTIME_ON_DEMAND_DISABLED';
    message: string;
}
export declare function runtimePolicyError(policy: NimbusRuntimePolicy | undefined, spec: RuntimeSpec, action: NimbusRuntimeAction, profile: string): NimbusRuntimePolicyError | null;
export declare function codeRuntimeRequirement(language: string, install: unknown): {
    spec: NimbusRuntimeName;
    action: NimbusRuntimeAction;
} | null;
//# sourceMappingURL=sandbox.d.ts.map