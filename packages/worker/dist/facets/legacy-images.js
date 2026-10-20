// facets/legacy-images.ts — the generated Node entries earlier releases left
// in the image directories, their process's environment in them (ask 62).
//
// Releases before ask 62 wrote a resident's generated entry, its arguments
// and environment in it, into /.nimbus/facet-images (before that, below
// /var/lib/nimbus). This release writes its entries to the image store's own
// directory, and /.nimbus/facet-images is the embedder's: Nimbus lists what
// looks generated there and deletes nothing. Only a host that owns the whole
// directory removes them (the hosted runtime, hosted/runtime.ts).
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { FACET_IMAGE_WRITE_SLICE_BYTES } from '@nimbus-sh/fabric/image-store.js';
import { FACET_IMAGE_DIR } from '@nimbus-sh/fabric/process-fabric.js';
/** Where releases through worker 0.19 wrote the image directory, below the user's /var. */
const LEGACY_FACET_IMAGE_DIR = 'var/lib/nimbus/facet-images';
/**
 * The declaration of a generated entry's arguments, its environment among
 * them, as it stands in the entry's composed recipe: inside one of its JSON
 * strings, where JSON.stringify writes the line break before it as the
 * escape `\n`, always.
 */
const RECIPE_ARGS_DECLARATION = '\\nconst __NIMBUS_ARGS = ';
/**
 * Whether a text, fed in order a piece at a time, is a composed recipe that
 * declares a generated entry's arguments: JSON (by its grammar, whitespace
 * aside) of an array of strings and objects of strings, as the store wrote
 * `vfsComposedModules`, one of its strings holding the declaration. Only
 * the scan's state is held, never the text. A JSON array of strings is a
 * legal module too, so this says how a file looks, not who wrote it.
 */
class RecipeScan {
    state = 'start';
    string = null;
    escaped = false;
    matched = 0;
    declares = false;
    /** The text broke the grammar: nothing more of it need be read. */
    refused = false;
    feed(text) {
        for (const char of text) {
            if (this.refused)
                return;
            if (this.string !== null)
                this.stringChar(char);
            else
                this.structureChar(char);
        }
    }
    get result() {
        return !this.refused && this.state === 'ended' && this.declares;
    }
    stringChar(char) {
        const startsEscape = char === '\\' && !this.escaped;
        if (this.string === 'element' && !this.declares) {
            if (char === RECIPE_ARGS_DECLARATION[this.matched] && (this.matched > 0 || startsEscape))
                this.matched++;
            else
                this.matched = startsEscape ? 1 : 0;
            if (this.matched === RECIPE_ARGS_DECLARATION.length)
                this.declares = true;
        }
        if (char === '"' && !this.escaped) {
            this.state = this.string === 'element' ? 'comma-or-end' : this.string === 'key' ? 'colon' : 'comma-or-close';
            this.string = null;
        }
        this.escaped = startsEscape;
    }
    structureChar(char) {
        if (char === ' ' || char === '\n' || char === '\r' || char === '\t')
            return;
        const next = this.after(char);
        if (next === null)
            this.refused = true;
        else
            this.state = next;
    }
    /** The state `char` (outside a string) leads to, or null when the grammar does not allow it there. */
    after(char) {
        switch (this.state) {
            case 'start': return char === '[' ? 'element-or-end' : null;
            case 'element-or-end':
            case 'element':
                if (char === '"') {
                    this.string = 'element';
                    this.matched = 0;
                    return this.state;
                }
                if (char === '{')
                    return 'key-or-close';
                return char === ']' && this.state === 'element-or-end' ? 'ended' : null;
            case 'comma-or-end': return char === ',' ? 'element' : char === ']' ? 'ended' : null;
            case 'key-or-close':
            case 'key':
                if (char === '"') {
                    this.string = 'key';
                    return this.state;
                }
                return char === '}' && this.state === 'key-or-close' ? 'comma-or-end' : null;
            case 'colon': return char === ':' ? 'value' : null;
            case 'value':
                if (char === '"') {
                    this.string = 'value';
                    return this.state;
                }
                return null;
            case 'comma-or-close': return char === ',' ? 'key' : char === '}' ? 'comma-or-end' : null;
            case 'ended': return null;
        }
    }
}
/**
 * The files in the image directories that look like a generated entry an
 * earlier release wrote, with its environment (RecipeScan): regular files
 * the kernel owns, named by a digest, in a directory the kernel owns. Each
 * is read a slice at a time, never whole, as an entry can be tens of MiB
 * (the store's own write slice: whole chunks within one storage
 * transaction). Paths are relative to the root.
 */
export function legacyGeneratedImages(vfs) {
    const kernel = vfs.as(CRED_KERNEL);
    const kernelOwned = (path, type) => {
        if (!kernel.exists(path))
            return false;
        const stat = kernel.lstat(path);
        return stat.type === type && stat.uid === CRED_KERNEL.uid;
    };
    const looksGenerated = (path) => {
        const size = kernel.stat(path).size;
        const scan = new RecipeScan();
        const decoder = new TextDecoder();
        for (let offset = 0; offset < size && !scan.refused; offset += FACET_IMAGE_WRITE_SLICE_BYTES) {
            scan.feed(decoder.decode(kernel.readRangeUncached(path, offset, Math.min(FACET_IMAGE_WRITE_SLICE_BYTES, size - offset)), { stream: true }));
        }
        scan.feed(decoder.decode());
        return scan.result;
    };
    const found = [];
    for (const dir of [FACET_IMAGE_DIR, LEGACY_FACET_IMAGE_DIR]) {
        if (!kernelOwned(dir, 'directory'))
            continue;
        for (const { name } of kernel.readdir(dir)) {
            const path = `${dir}/${name}`;
            if (/^[0-9a-f]{64}\.js$/.test(name) && kernelOwned(path, 'file') && looksGenerated(path))
                found.push(path);
        }
    }
    return found;
}
/**
 * For a host that owns /.nimbus/facet-images whole (it writes no image of its
 * own there, and no one else in its sessions can): the generated entries
 * earlier releases left there, with their environments, removed. Answers
 * how many.
 */
export function removeLegacyGeneratedImages(vfs) {
    const kernel = vfs.as(CRED_KERNEL);
    const owned = legacyGeneratedImages(vfs).filter((path) => path.startsWith(`${FACET_IMAGE_DIR}/`));
    for (const path of owned)
        kernel.unlink(path);
    return owned.length;
}
