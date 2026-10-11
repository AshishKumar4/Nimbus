export function defineNimbusConfig(config) {
    return config;
}
function runtimeName(spec) {
    return String(spec).split('@')[0];
}
export function runtimePolicyError(policy, spec, action, profile) {
    const name = runtimeName(spec);
    if (policy?.allow && !policy.allow.includes(name)) {
        return { code: 'E_RUNTIME_NOT_ALLOWED', message: `Nimbus runtime '${name}' is not allowed by sandbox profile '${profile}'` };
    }
    if (action === 'onDemand' && policy?.onDemand === false && !policy.preinstall?.some((installed) => runtimeName(installed) === name)) {
        return { code: 'E_RUNTIME_ON_DEMAND_DISABLED', message: `Nimbus runtime '${name}' is not preinstalled and on-demand runtime installs are disabled by sandbox profile '${profile}'` };
    }
    return null;
}
export function codeRuntimeRequirement(language, install) {
    switch (language) {
        case 'python':
        case 'ruby': return { spec: language, action: install === 'ifMissing' ? 'onDemand' : 'use' };
        case 'shell': return { spec: 'shell', action: 'use' };
        case 'javascript':
        case 'typescript': return { spec: 'node', action: 'use' };
        default: return null;
    }
}
