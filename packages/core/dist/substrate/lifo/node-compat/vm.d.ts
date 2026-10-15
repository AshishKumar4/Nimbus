/**
 * The engine's vm, a program's: its contexts, scripts and functions are the
 * engine's, given the program's options as they are. Code it compiles
 * reaches a module loader only through `importModuleDynamically:
 * constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`, the engine's own, which would
 * import the host's files at the program's paths: refused, at each compile
 * and context that names it. That is the program's module map kept whole,
 * not a boundary: a program that seeks the engine's loader reaches it
 * (import() in a Function body), as core's README says of a realm. A
 * program's own callback is its own, and every script it is given (a
 * referrer) is a vm.Script, whichever function made it. vm's module classes
 * are absent, as in Node without --experimental-vm-modules.
 */
export declare function createVm(): object;
//# sourceMappingURL=vm.d.ts.map