// The package source a paired bench's modules are named from. Each arm runs
// its side's whole tree (isolated-core.mjs): nothing here selects code.
export const CORE_CPU_SOURCES = { source: 'packages/core/src' };

export const HOLDER_CPU_SOURCES = { source: 'packages/core/src' };

export const PLATFORM_CPU_SOURCES = { source: 'packages/platform/src' };

// The shell and the pattern and glob helpers it reads (substrate/lifo/utils).
export const LIFO_SHELL_CPU_SOURCES = { source: 'packages/core/src' };
