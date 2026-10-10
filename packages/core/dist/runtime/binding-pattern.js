export function forEachBindingIdentifier(pattern, visit, context) {
    if (pattern === null)
        return;
    switch (pattern.type) {
        case 'Identifier':
            visit(pattern, context);
            return;
        case 'ObjectPattern':
            for (let i = 0; i < pattern.properties.length; i++) {
                const property = pattern.properties[i];
                forEachBindingIdentifier(property.type === 'RestElement' ? property.argument : property.value, visit, context);
            }
            return;
        case 'ArrayPattern':
            for (let i = 0; i < pattern.elements.length; i++)
                forEachBindingIdentifier(pattern.elements[i], visit, context);
            return;
        case 'RestElement':
            forEachBindingIdentifier(pattern.argument, visit, context);
            return;
        case 'AssignmentPattern':
            forEachBindingIdentifier(pattern.left, visit, context);
            return;
        default:
            return;
    }
}
