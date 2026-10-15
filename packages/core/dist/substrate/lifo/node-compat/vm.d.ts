/**
 * The engine's vm, a program's: its contexts, scripts and functions are the
 * engine's. Code it compiles reaches a module loader only through
 * `importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`, the
 * engine's own; there, the import goes through the program's loader instead
 * (`scripts` is told the code's filename, which the engine resolves it
 * against), so it loads the program's modules, not the host's. Code with no
 * absolute filename gives an import no referrer of the program's, and is
 * refused that loader; so is a context made with it, whose imports have no
 * script at all. Without `scripts` (no loader) the loader is refused
 * outright. A program's own callback is its own. vm's module classes are
 * absent, as in Node without --experimental-vm-modules.
 */
export declare function createVm(scripts: ((filename: string) => void) | null): object;
//# sourceMappingURL=vm.d.ts.map