export async function fanoutBenchTask(item, env) {
    const startMs = Date.now();
    const loaderEnvKeys = Object.keys(env || {}).sort();
    await new Promise((resolve) => setTimeout(resolve, item.sleepMs));
    return { id: item.id, startMs, endMs: Date.now(), loaderEnvKeys };
}
export async function serialBenchTask(item) {
    await new Promise((resolve) => setTimeout(resolve, item.sleepMs));
    return item.id;
}
