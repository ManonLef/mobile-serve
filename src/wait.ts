// Waiting for something on this machine to happen: a server to stop, or to start.

const POLL_INTERVAL_MS = 500;

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Calls `check` until it returns something truthy, or resolves to undefined after `timeoutMs`.
 * A check that fails (lsof timing out on a busy machine, say) counts as "not yet", so one bad
 * moment doesn't end the wait. If the last check before the time ran out failed, its error is thrown.
 */
export async function waitFor<T>(check: () => Promise<T>, timeoutMs: number, intervalMs = POLL_INTERVAL_MS): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  let failure: { error: unknown } | undefined;
  while (Date.now() < end) {
    try {
      const result = await check();
      if (result) return result;
      failure = undefined;
    } catch (error) {
      failure = { error };
    }
    await sleep(intervalMs);
  }
  if (failure) throw failure.error;
  return undefined;
}
