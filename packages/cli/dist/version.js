import manifest from '@nimbus-sh/cli/package.json' with { type: 'json' };
export const CLI_VERSION = manifest.version;
