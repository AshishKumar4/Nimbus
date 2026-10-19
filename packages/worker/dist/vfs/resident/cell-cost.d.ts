/**
 * What holding a cell costs a process's resident store, in the one unit both
 * sides use: the facet's store charges itself this to hold a cell, and the
 * manager charges a launch's module map the same before it admits the launch
 * (manager.ts moduleMapStorageBytes).
 */
/** The platform's UTF-8 measure, on the launch's captures after a program starts. */
export declare function utf8Length(text: string): number;
/** A row's allowance: what one row of 'file', 'chunk' or 'ns' is charged beside its payload. */
export declare const RESIDENT_ROW_BYTES = 256;
/** A cell as the facet holds it — the shape `__vfsBundle` has always carried. */
export type ResidentCell = string | Uint8Array | {
    error: 'EACCES';
};
export declare function residentBytes(value: unknown): Uint8Array;
/**
 * What holding a cell costs the database: its bytes (a text cell's UTF-8
 * length) on overflow pages (1% over, for page headers and the b-tree pages
 * above them), a row per chunk and head, and a page of slack.
 */
export declare function residentCellCost(cell: unknown): number;
/**
 * At most what holding a file of `size` bytes costs, read as bytes or as
 * text (residentCellCost, with text's smaller chunks): what a fill whose
 * bytes have not arrived yet asks room for.
 */
export declare function residentFileCost(size: number): number;
/**
 * What a namespace row costs a one-shot's heap. JavaScript keeps path/target
 * strings in the heap: charge UTF-16 storage plus the row allowance, even
 * when the engine can compress text.
 */
export declare function namespaceRowBytes(parent: string, name: string, target: string | null | undefined): number;
//# sourceMappingURL=cell-cost.d.ts.map