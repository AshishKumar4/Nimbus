/**
 * Appends to `out` each identifier `pattern` binds; answers `out`. It
 * appends by index, so an interpreter SafeList serves as well as an array.
 */
export function bindingIdentifiers(pattern, out) {
    if (pattern === null)
        return out;
    switch (pattern.type) {
        case 'Identifier':
            out[out.length] = pattern;
            return out;
        case 'ObjectPattern':
            for (let i = 0; i < pattern.properties.length; i++) {
                const property = pattern.properties[i];
                bindingIdentifiers(property.type === 'RestElement' ? property.argument : property.value, out);
            }
            return out;
        case 'ArrayPattern':
            for (let i = 0; i < pattern.elements.length; i++)
                bindingIdentifiers(pattern.elements[i], out);
            return out;
        case 'RestElement':
            return bindingIdentifiers(pattern.argument, out);
        case 'AssignmentPattern':
            return bindingIdentifiers(pattern.left, out);
        default:
            return out;
    }
}
