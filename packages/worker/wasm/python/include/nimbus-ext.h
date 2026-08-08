/* Third-party C extensions linked into this interpreter variant.
 *
 * wasm32-wasi has no dlopen, so a compiled package is either in the binary or
 * unavailable. The set is fixed when the variant is linked; build-python.sh
 * generates the table from EXTENSION_PACKAGES and the base variant gets an
 * empty one, so both variants run the same code path.
 *
 * Registration is PyImport_AppendInittab rather than Modules/Setup, because
 * every one of these modules has a dotted name and makesetup derives the init
 * symbol as PyInit_$name — not a C identifier once there is a dot in it.
 * CPython 3.13's BuiltinImporter consults _imp.is_builtin for submodule
 * imports too, and is_builtin compares the inittab name as a plain string, so
 * a dotted entry resolves as markupsafe._speedups is imported from
 * markupsafe/__init__.py. */
#ifndef NIMBUS_EXT_H
#define NIMBUS_EXT_H

/* Appends every linked-in extension to the inittab. Must run before
 * Py_InitializeFromConfig. Returns 0, or -1 with the reason on stderr. */
int nimbus_ext_register(void);

#endif
