export const CORE_CPU_SOURCES = {
  source: 'packages/core/src',
  files: ['vfs/sqlite-vfs.ts', 'vfs/path.ts', 'vfs/composite.ts', 'vfs/sqlite-files.ts', 'runtime/process-files.ts', 'runtime/sqlite-runtime-fs-bridge.ts'],
};

export const HOLDER_CPU_SOURCES = {
  source: 'packages/core/src',
  directories: ['runtime/wasi', '_shared'],
};

export const PLATFORM_CPU_SOURCES = { source: 'packages/platform/src' };

export const LIFO_SHELL_CPU_SOURCES = {
  source: 'packages/core/src',
  directories: ['substrate/lifo/shell'],
};
