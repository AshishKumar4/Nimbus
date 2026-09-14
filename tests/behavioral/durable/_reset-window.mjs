const RESET_MESSAGE = 'Application called abort() to reset Durable Object.';

/** The deliberate abort response can beat teardown; retry only that exact platform error. */
export async function afterReset(operation, budgetMs = 10_000) {
  const deadline = Date.now() + Math.min(10_000, budgetMs);
  for (;;) {
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes(RESET_MESSAGE) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
    }
  }
}
