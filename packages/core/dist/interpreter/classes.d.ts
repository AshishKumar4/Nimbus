/**
 * classes.ts — a class definition at runtime, from the plan compile.ts makes
 * of it (Compiler.classPlan): its scope entered, its private names made, its
 * heritage and computed keys evaluated, its constructor and elements
 * defined, and what constructing an instance initializes.
 */
import { type Code } from './code.js';
import { type Env, type FunctionInfo, PrivateName, type Sync } from './runtime.js';
/**
 * A class element's key: static, one of the class's private names, or the
 * index of its computed key among the class's computed keys, which are all
 * evaluated (in order) before the class's elements are defined. Nothing can
 * reach the class until its definition completes, so that order is
 * unobservable, and it lets a key await or yield.
 */
export type ElementKey = {
    readonly kind: 'static';
    readonly static: PropertyKey;
} | {
    readonly kind: 'private';
    readonly private: (env: Env) => PrivateName;
} | {
    readonly kind: 'computed';
    readonly computed: number;
};
/** A class's making at runtime: its scope entered, private names made, heritage and keys evaluated, then defined. */
export declare function classMaking(entry: ((env: Env) => Env) | null, heritage: Code | null, plan: ClassPlan): ClassMaker;
/** ClassDefinitionEvaluation, with the class's name given when it runs. */
export type ClassMaker = {
    readonly s: (env: Env, name: string) => unknown;
    readonly g: ((env: Env, name: string) => Generator<unknown, unknown, unknown>) | null;
};
/** One element of a class, compiled. */
export type ClassElement = {
    readonly kind: 'method';
    readonly isStatic: boolean;
    readonly key: ElementKey;
    readonly fi: FunctionInfo;
    readonly accessor: 'get' | 'set' | null;
} | {
    readonly kind: 'field';
    readonly isStatic: boolean;
    readonly key: ElementKey;
    readonly value: Sync | null;
    readonly named: ((env: Env, name: string) => unknown) | null;
} | {
    readonly kind: 'static';
    readonly fi: FunctionInfo;
};
export type ClassPrivateName = {
    readonly slot: number;
    readonly kind: 'field' | 'method' | 'accessor';
    readonly description: string;
};
/** A class definition, compiled (Compiler.classPlan): what classDefiner needs, and nothing of the AST. */
export interface ClassPlan {
    readonly ctorInfo: FunctionInfo;
    /** Writes the class's own name binding (a named class), in its scope. */
    readonly writeInner: ((env: Env, value: unknown) => void) | null;
    readonly elements: readonly ClassElement[];
    readonly privateNames: readonly ClassPrivateName[];
    /** The computed keys, evaluated in order before the elements are defined. */
    readonly computedKeys: readonly Code[];
    readonly instanceFi: FunctionInfo | null;
    readonly staticFi: FunctionInfo | null;
}
/** A field initializer's (or static block's) frame: `this` and the home object. */
export declare function fieldFrame(fi: FunctionInfo, scope: Env, thisArg: unknown, home: object): Env;
/** ClassDefinitionEvaluation's runtime half, from a compiled plan. */
export declare function classDefiner(plan: ClassPlan): (classEnv: Env, parent: unknown, name: string, computed: readonly PropertyKey[]) => Function;
//# sourceMappingURL=classes.d.ts.map