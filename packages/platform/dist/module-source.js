/** Source already verified against its deployment pin. Shared across generated programs. */
export class ImmutableModuleSource {
    asset;
    byteLength;
    text;
    constructor(bytes, asset) {
        this.asset = asset;
        this.text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        this.byteLength = bytes.byteLength;
    }
}
/** A generated module retains its immutable pieces until the Loader needs its complete text. */
export class ModuleSource {
    parts;
    joined;
    byteLength;
    constructor(parts) {
        this.parts = parts;
        this.byteLength = parts.reduce((bytes, part) => bytes + (typeof part === 'string' ? new TextEncoder().encode(part).byteLength : part.byteLength), 0);
    }
    get text() {
        return this.joined ??= this.parts.map((part) => typeof part === 'string' ? part : part.text).join('');
    }
    recipe() {
        return this.parts.map((part) => typeof part === 'string' ? part : part.asset);
    }
}
/** Template interpolation without flattening immutable runtime libraries into process-owned text. */
export function moduleSource(strings, ...values) {
    const parts = [];
    const append = (part) => {
        if (part === '')
            return;
        const last = parts.length - 1;
        const previous = parts[last];
        if (typeof part === 'string' && typeof previous === 'string')
            parts[last] = previous + part;
        else
            parts.push(part);
    };
    for (const [i, literal] of strings.entries()) {
        append(literal);
        if (i === values.length)
            continue;
        const value = values[i];
        if (value instanceof ModuleSource)
            value.parts.forEach(append);
        else
            append(value instanceof ImmutableModuleSource ? value : String(value));
    }
    return new ModuleSource(parts);
}
