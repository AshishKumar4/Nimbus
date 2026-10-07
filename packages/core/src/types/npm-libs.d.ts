// The surface of npm's own libraries the shell's npm runs (pinned to the
// versions npm 10.9.8 ships): `npm init`'s package.json (npm-init.ts) and
// npm's configuration (npm-config.ts).

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
    rawSpec: string;
    hosted?: { user: string; project: string } | null;
  }
  function npa(arg: string, where?: string): Result;
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
  const semver: {
    valid(version: unknown, loose?: boolean): string | null;
    clean(version: string, loose?: boolean): string | null;
  };
  export default semver;
}
