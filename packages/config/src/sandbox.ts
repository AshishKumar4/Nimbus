export type RuntimeSpec = string;
export type NimbusRuntimeName =
  | 'node' | 'bun' | 'npm' | 'git' | 'python' | 'ruby' | 'clang' | 'shell' | (string & {});

export interface NimbusRuntimePolicy {
  preinstall?: RuntimeSpec[];
  onDemand?: boolean;
  allow?: NimbusRuntimeName[];
}

export interface NimbusSandboxProfile {
  root?: string;
  runtimes?: NimbusRuntimePolicy;
  tools?: { namespace?: string; kind?: string };
  preview?: { baseUrl?: string; pathStyle?: boolean };
}

export interface NimbusConfig {
  endpoint?: string;
  previewHostSuffix?: string;
  sandboxes?: Record<string, NimbusSandboxProfile>;
}

export function defineNimbusConfig<T extends NimbusConfig>(config: T): T {
  return config;
}

export type NimbusRuntimeAction = 'preinstall' | 'onDemand' | 'use';
export type NimbusCodeLanguage = 'javascript' | 'typescript' | 'python' | 'ruby' | 'shell';

export interface NimbusRuntimePolicyError {
  code: 'E_RUNTIME_NOT_ALLOWED' | 'E_RUNTIME_ON_DEMAND_DISABLED';
  message: string;
}

function runtimeName(spec: RuntimeSpec): NimbusRuntimeName {
  return String(spec).split('@')[0] as NimbusRuntimeName;
}

export function runtimePolicyError(
  policy: NimbusRuntimePolicy | undefined,
  spec: RuntimeSpec,
  action: NimbusRuntimeAction,
  profile: string,
): NimbusRuntimePolicyError | null {
  const name = runtimeName(spec);
  if (policy?.allow && !policy.allow.includes(name)) {
    return { code: 'E_RUNTIME_NOT_ALLOWED', message: `Nimbus runtime '${name}' is not allowed by sandbox profile '${profile}'` };
  }
  if (action === 'onDemand' && policy?.onDemand === false && !policy.preinstall?.some((installed) => runtimeName(installed) === name)) {
    return { code: 'E_RUNTIME_ON_DEMAND_DISABLED', message: `Nimbus runtime '${name}' is not preinstalled and on-demand runtime installs are disabled by sandbox profile '${profile}'` };
  }
  return null;
}

export function codeRuntimeRequirement(language: string, install: unknown): { spec: NimbusRuntimeName; action: NimbusRuntimeAction } | null {
  switch (language) {
    case 'python': case 'ruby': return { spec: language, action: install === 'ifMissing' ? 'onDemand' : 'use' };
    case 'shell': return { spec: 'shell', action: 'use' };
    case 'javascript': case 'typescript': return { spec: 'node', action: 'use' };
    default: return null;
  }
}
