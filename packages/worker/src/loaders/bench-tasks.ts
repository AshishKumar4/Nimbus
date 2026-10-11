export async function fanoutBenchTask(item: { id: number; sleepMs: number }, env: object) {
  const startMs = Date.now();
  const loaderEnvKeys = Object.keys(env || {}).sort();
  await new Promise((resolve) => setTimeout(resolve, item.sleepMs));
  return { id: item.id, startMs, endMs: Date.now(), loaderEnvKeys };
}

export async function serialBenchTask(item: { id: number; sleepMs: number }) {
  await new Promise((resolve) => setTimeout(resolve, item.sleepMs));
  return item.id;
}
