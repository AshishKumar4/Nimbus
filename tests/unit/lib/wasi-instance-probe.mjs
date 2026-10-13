// Appended exports only: the bundled body still owns its init, resident boot
// and filesystem. The returned adapter/view let tests inspect behaviour of a
// completed boot without replacing WASI imports or its store implementation.
export const WASI_INSTANCE_PROBE = `
export { __wasiInitFS, __wasiAdoptSupervisor, __wasiPrepareFilesystem, __wasiFsStats, __wasiSettleWrites };
export async function residentFilesystemForTest() {
  if (__wasiResident === null) throw new Error("WASI did not start its resident filesystem");
  const namespace = await __wasiResident.ready;
  if (namespace === null) throw new Error("WASI resident filesystem did not boot");
  return { fs: __wasiResident.fs, namespace };
}
`;

export async function startResidentWasi(module, supervisor, cred) {
  module.__wasiInitFS({ root: '', preopens: [{ wasiPath: '/', vfsPath: '' }], cred });
  module.__wasiAdoptSupervisor(supervisor);
  await module.__wasiPrepareFilesystem(['home/user']);
  return module.residentFilesystemForTest();
}
