/** A deployed source asset: its digest, not its pathname, is its identity. */
export interface ModuleSourceAsset {
  path: string;
  sha256: string;
}

export interface ModuleSourceEnv {
  ASSETS?: { fetch(request: Request): Promise<Response> };
}

/** Source already verified against its deployment pin. Shared across generated programs. */
export class ImmutableModuleSource {
  readonly byteLength: number;
  readonly text: string;
  constructor(bytes: ArrayBuffer | Uint8Array, readonly asset: ModuleSourceAsset) {
    this.text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    this.byteLength = bytes.byteLength;
  }
}

export type ModuleSourcePart = string | ImmutableModuleSource;
export type ModuleSourceRecipe = (string | ModuleSourceAsset)[];

/** A generated module retains its immutable pieces until the Loader needs its complete text. */
export class ModuleSource {
  private joined: string | undefined;
  readonly byteLength: number;
  constructor(readonly parts: readonly ModuleSourcePart[]) {
    this.byteLength = parts.reduce((bytes, part) => bytes + (typeof part === 'string' ? new TextEncoder().encode(part).byteLength : part.byteLength), 0);
  }
  get text(): string {
    return this.joined ??= this.parts.map((part) => typeof part === 'string' ? part : part.text).join('');
  }
  recipe(): ModuleSourceRecipe {
    return this.parts.map((part) => typeof part === 'string' ? part : part.asset);
  }
}

/** Template interpolation without flattening immutable runtime libraries into process-owned text. */
export function moduleSource(strings: TemplateStringsArray, ...values: (string | number | boolean | null | undefined | ImmutableModuleSource | ModuleSource)[]): ModuleSource {
  const parts: ModuleSourcePart[] = [];
  const append = (part: ModuleSourcePart) => {
    if (part === '') return;
    const last = parts.length - 1;
    const previous = parts[last];
    if (typeof part === 'string' && typeof previous === 'string') parts[last] = previous + part;
    else parts.push(part);
  };
  for (const [i, literal] of strings.entries()) {
    append(literal);
    if (i === values.length) continue;
    const value = values[i];
    if (value instanceof ModuleSource) value.parts.forEach(append);
    else append(value instanceof ImmutableModuleSource ? value : String(value));
  }
  return new ModuleSource(parts);
}
