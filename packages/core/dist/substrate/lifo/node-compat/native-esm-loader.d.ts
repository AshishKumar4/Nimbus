import type { CjsLoader, NativeModuleLoader } from './cjs-loader.js';
import type { NodeContext } from './index.js';
export interface LifoNativeLoader extends NativeModuleLoader {
    /** The preread entry, evaluated as an ES module even on an async-only mount. */
    importMain(): Promise<unknown>;
    /** A lifo command runs in the host realm; release its URL scope after its handler ends. */
    dispose(): void;
}
/** A loader's own sources, builtins, records and metadata under one private URL root. */
export declare function createNativeEsmLoader(context: NodeContext, cjs: CjsLoader, main?: {
    readonly filename: string;
    readonly source: string;
}, conditions?: readonly string[]): Promise<LifoNativeLoader>;
//# sourceMappingURL=native-esm-loader.d.ts.map