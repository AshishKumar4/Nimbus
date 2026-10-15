/**
 * npm-spec.ts — a package spec as npm reads it, with npm's own
 * npm-package-arg, for every npm here: the worker's installer and npx, the
 * resolver facet (the build bundles this module into its preamble, worker
 * scripts/bundle-facet-workers.mjs), and the shell's fallback npm.
 */
import type { Result as NpaResult } from 'npm-package-arg';
import { npa } from './npm-libs.js';

/** A spec as npm-package-arg reads it. */
export type { NpaResult };

/** What a spec asks the registry for: the name it installs under, the package and range it fetches, and whether it is an `npm:` alias. */
export interface RegistryRequest {
  installName: string;
  registryName: string;
  range: string;
  alias: boolean;
  /** Whether a registry answers it: a version, range or dist-tag (an alias's too). A git, file, directory or URL spec is not. */
  registry: boolean;
}

/**
 * The package a command-line spec names and the range it asks for, as npa
 * splits `name[@range]` (`@scope/name@range`, `name@npm:other@range`); the
 * range is null when the spec gives none, and a spec that names no package
 * (a path, a git repository, a URL) is its own name. `parsed`: npa's reading
 * of it, null for a spec npa refuses.
 */
export function splitPackageSpec(spec: string): { name: string; range: string | null; parsed: NpaResult | null } {
  let parsed: NpaResult;
  try {
    parsed = npa(spec);
  } catch {
    return { name: spec, range: null, parsed: null };
  }
  const name = parsed.name;
  if (!name || !spec.startsWith(name)) return { name: spec, range: null, parsed };
  return spec.length > name.length && spec[name.length] === '@'
    ? { name, range: spec.slice(name.length + 1), parsed }
    : { name: spec, range: null, parsed };
}

/**
 * The registry request a dependency `name` with `range` makes: an `npm:`
 * alias fetches the package it names, at its range, and installs it under
 * `name`; anything else fetches `name` at `range` (a non-registry spec too,
 * whose range the picker reads as no range).
 */
export function parseRegistryRequest(name: string, range: string): RegistryRequest {
  const text = String(range || 'latest');
  let parsed: NpaResult | null = null;
  try {
    parsed = npa.resolve(name, text);
  } catch {
    parsed = null;
  }
  const target = parsed?.type === 'alias' ? parsed.subSpec : undefined;
  const kind = (target ?? parsed)?.type;
  const registry = kind === 'version' || kind === 'range' || kind === 'tag';
  if (target?.name) return { installName: name, registryName: target.name, range: target.rawSpec, alias: true, registry };
  return { installName: name, registryName: name, range: text, alias: false, registry };
}
