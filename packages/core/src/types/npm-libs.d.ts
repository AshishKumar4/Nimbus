// The surface of npm's own libraries every npm here runs (pinned to the
// versions npm 10.9.8 ships): versions and specs (_shared/npm-semver.ts,
// npm-spec.ts), `npm init`'s package.json (npm-init.ts) and npm's
// configuration (npm-config.ts: nopt and @npmcli/config's definitions, field
// parsing and validation).

declare module 'hosted-git-info' {
  interface GitHost {
    type: string;
    user: string;
    project: string;
    getDefaultRepresentation(): string;
    https(opts?: object): string;
    toString(opts?: object): string;
    bugs(opts?: object): string | undefined;
    docs(opts?: object): string | undefined;
  }
  const hostedGitInfo: {
    fromUrl(url: string, opts?: object): GitHost | undefined;
  };
  export default hostedGitInfo;
}

declare module 'npm-package-arg' {
  export interface Result {
    type: 'git' | 'tag' | 'version' | 'range' | 'file' | 'directory' | 'remote' | 'alias';
    registry?: boolean;
    name: string | null;
    scope: string | null;
    raw: string;
    rawSpec: string;
    hosted?: { user: string; project: string } | null;
    /** An alias's target. */
    subSpec?: Result;
  }
  interface Npa {
    (arg: string, where?: string): Result;
    resolve(name: string, spec: string, where?: string): Result;
  }
  const npa: Npa;
  export default npa;
}

declare module 'validate-npm-package-name' {
  function validate(name: unknown): { validForNewPackages: boolean; validForOldPackages: boolean; errors?: string[]; warnings?: string[] };
  export default validate;
}

declare module 'validate-npm-package-license' {
  function validate(license: unknown): { validForNewPackages: boolean; validForOldPackages: boolean; warnings?: string[] };
  export default validate;
}

declare module 'ini' {
  const ini: { decode(text: string): Record<string, unknown> };
  export default ini;
}

declare module 'semver' {
  type Options = boolean | { loose?: boolean; includePrerelease?: boolean };
  interface SemVer { major: number; minor: number; patch: number; prerelease: ReadonlyArray<string | number> }
  const semver: {
    valid(version: unknown, options?: Options): string | null;
    clean(version: string, options?: Options): string | null;
    parse(version: string, options?: Options): SemVer | null;
    compare(a: string, b: string, options?: Options): number;
    satisfies(version: string, range: string, options?: Options): boolean;
    validRange(range: string, options?: Options): string | null;
    maxSatisfying(versions: string[], range: string, options?: Options): string | null;
  };
  export default semver;
}

declare module 'nopt' {
  type Handler = ((key: string, value: unknown, type: unknown) => void) | null;
  interface Parsed { argv: { remain: string[]; cooked: string[]; original: string[] } }
  interface Nopt {
    (types: Record<string, unknown>, shorthands: Record<string, string[]>, args: string[], slice: number): Record<string, unknown> & Parsed;
    clean(data: Record<string, unknown>, types: Record<string, unknown>, typeDefs: object): void;
    invalidHandler: Handler;
  }
  const nopt: Nopt;
  export default nopt;
}

declare module '@npmcli/config/lib/definitions/index.js' {
  interface Definition { default: unknown; type: unknown; deprecated?: string }
  const npmDefinitions: { definitions: Record<string, Definition>; shorthands: Record<string, string[]> };
  export default npmDefinitions;
}

declare module '@npmcli/config/lib/env-replace.js' {
  function envReplace(text: string, env: Record<string, string>): string;
  export default envReplace;
}

declare module '@npmcli/config/lib/parse-field.js' {
  function parseField(value: unknown, key: string, options: { platform: string; types: Record<string, unknown>; home: string; env: Record<string, string> }): unknown;
  export default parseField;
}

declare module '@npmcli/config/lib/type-defs.js' {
  const typeDefs: Record<string, { type: unknown; description?: string }> & { url: { type: unknown }; path: { type: unknown } };
  export default typeDefs;
}

declare module '@npmcli/config/lib/type-description.js' {
  function typeDescription(type: unknown): unknown[];
  export default typeDescription;
}
