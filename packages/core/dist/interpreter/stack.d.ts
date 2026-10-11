import type { Env } from './runtime.js';
export interface StackUnit {
    readonly file: string | null;
    readonly source: string;
    readonly esModule: boolean;
    readonly capture: ((error: object, frames: readonly InterpretedFrame[]) => void) | null;
    readonly isProxy: ((value: unknown) => boolean) | null;
    readonly isError: ((value: unknown) => boolean) | null;
}
export interface StackInfo {
    readonly unit: StackUnit;
    readonly name: string;
    readonly start: number;
    readonly strict: boolean;
    readonly shape: string;
}
export interface InterpretedFrame {
    readonly unit: StackUnit;
    readonly name: string | null;
    readonly method: string | null;
    readonly type: string | null;
    readonly line: number;
    readonly column: number;
    readonly enclosingLine: number;
    readonly enclosingColumn: number;
    readonly constructor: boolean;
    readonly async: boolean;
    readonly top: boolean;
    readonly fn: unknown;
    readonly receiver: unknown;
}
export declare const STACK_SLOTS = 9;
export declare function initializeStack(env: Env, info: StackInfo, fn: unknown, receiver: unknown, constructor: boolean): void;
export declare function pushStack(env: Env): Env | null;
export declare function popStack(previous: Env | null): void;
/** Called only immediately before invoking a callee, after its arguments. */
export declare function callPosition(position: number): void;
/** The native async wrapper has returned its promise to the call expression. */
export declare function callResult<T>(value: T): T;
export declare function suspendedStack(env: Env): void;
/** Only an await establishes an async parent; an un-awaited call does not. */
export declare function awaitStack(value: unknown, position: number): void;
/** Stamp before code can read .stack. Re-throwing an error keeps its origin. */
export declare function stampStack(error: unknown, position?: number, above?: unknown, replace?: boolean): void;
export declare function stackFrames(error: object): readonly InterpretedFrame[] | null;
/** Preserve the original thrown value; stacks are metadata, not semantics. */
export declare function errorAt(error: unknown, position: number): never;
//# sourceMappingURL=stack.d.ts.map