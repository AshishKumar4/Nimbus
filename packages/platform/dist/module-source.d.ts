/** A deployed source asset: its digest, not its pathname, is its identity. */
export interface ModuleSourceAsset {
    path: string;
    sha256: string;
}
export interface ModuleSourceEnv {
    ASSETS?: {
        fetch(request: Request): Promise<Response>;
    };
}
/** Source already verified against its deployment pin. Shared across generated programs. */
export declare class ImmutableModuleSource {
    readonly asset: ModuleSourceAsset;
    readonly byteLength: number;
    readonly text: string;
    constructor(bytes: ArrayBuffer | Uint8Array, asset: ModuleSourceAsset);
}
export type ModuleSourcePart = string | ImmutableModuleSource;
export type ModuleSourceRecipe = (string | ModuleSourceAsset)[];
/** A generated module retains its immutable pieces until the Loader needs its complete text. */
export declare class ModuleSource {
    readonly parts: readonly ModuleSourcePart[];
    private joined;
    readonly byteLength: number;
    constructor(parts: readonly ModuleSourcePart[]);
    get text(): string;
    recipe(): ModuleSourceRecipe;
}
/** Template interpolation without flattening immutable runtime libraries into process-owned text. */
export declare function moduleSource(strings: TemplateStringsArray, ...values: (string | number | boolean | null | undefined | ImmutableModuleSource | ModuleSource)[]): ModuleSource;
//# sourceMappingURL=module-source.d.ts.map