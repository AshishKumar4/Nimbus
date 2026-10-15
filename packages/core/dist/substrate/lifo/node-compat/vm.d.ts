/**
 * The engine's vm, a program's: its contexts, scripts and functions are the
 * engine's. Code it compiles reaches a module loader only through
 * `importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`, the
 * engine's own, which imports past the program's module map: refused, at
 * each compile and context that names it. Options are read once, and the
 * engine is given what was read, so what it compiles with is what was
 * refused or not. A program's own callback is its own. vm's module classes
 * are absent, as in Node without --experimental-vm-modules, and so is the
 * engine's Script: a program's Script holds one.
 */
export declare function createVm(): object;
//# sourceMappingURL=vm.d.ts.map