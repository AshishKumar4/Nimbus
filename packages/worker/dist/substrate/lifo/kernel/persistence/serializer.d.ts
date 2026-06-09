import type { INode } from '../vfs/types.js';
export interface SerializedChunkRef {
    h: string;
    s: number;
}
export interface SerializedNode {
    t: 'f' | 'd';
    n: string;
    d?: string;
    c?: SerializedNode[];
    ct: number;
    mt: number;
    m: number;
    mi?: string;
    br?: string;
    ch?: SerializedChunkRef[];
    sz?: number;
}
export declare function serialize(root: INode): SerializedNode;
export declare function deserialize(data: SerializedNode): INode;
//# sourceMappingURL=serializer.d.ts.map