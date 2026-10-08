// Node's fatal report may open with the arrow at a line of its own library
// (`node:internal/modules/run_main:123`), after a blank line when the thrown
// value is not an error; the runtime's has none. That block alone is left out.
export const withoutInternalArrow = (text) => text.replace(/^\n?node:internal\/\S+:\d+\n.*\n *\^\n\n?/, '');
