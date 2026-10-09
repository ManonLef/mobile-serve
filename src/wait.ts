// Waiting for something on this machine to happen: a server to stop, or to start.

const POLL_INTERVAL_MS = 500;

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Calls `check` until it returns something truthy, or resolves to undefined after `timeoutMs`.
 * Waits `intervalMs` between checks, which may depend on how long it has been waiting.
 * A check that fails (lsof timing out on a busy machine, say) counts as "not yet", so one bad
 * moment doesn't end the wait. If the last check before the time ran out failed, its error is thrown.
 */
export async function waitFor<T>(
  check: () => Promise<T>, timeoutMs: number, intervalMs: number | ((elapsedMs: number) => number) = POLL_INTERVAL_MS,
): Promise<T | undefined> {
  const start = Date.now();
  const end = start + timeoutMs;
  let failure: { error: unknown } | undefined;
  while (Date.now() < end) {
    try {
      const result = await check();
      if (result) return result;
      failure = undefined;
    } catch (error) {
      failure = { error };
    }
    await sleep(typeof intervalMs === 'number' ? intervalMs : intervalMs(Date.now() - start));
  }
  if (failure) throw failure.error;
  return undefined;
}

// Why a server that was starting isn't being waited for any more.
export type StartOutcome = 'listening' | 'closed' | 'cancelled' | 'ended' | 'timedOut';

/**
 * Waits for a server that's starting to accept connections. `state` says what has happened since:
 * Close Mobile stopped it, the user cancelled the wait, or its task ended. Stopping it with Close
 * Mobile ends its task too, so `closed` wins over `ended`: that's no failure to report.
 */
export async function waitForStart(
  listening: () => Promise<boolean>,
  state: () => { closed: boolean; cancelled: boolean; ended: boolean },
  timeoutMs: number, intervalMs = POLL_INTERVAL_MS,
): Promise<StartOutcome> {
  const stopped = (): StartOutcome | undefined => {
    const { closed, cancelled, ended } = state();
    return closed ? 'closed' : cancelled ? 'cancelled' : ended ? 'ended' : undefined;
  };
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const reason = stopped();
    if (reason) return reason;
    if (await listening()) return 'listening';
    await sleep(intervalMs);
  }
  return stopped() ?? 'timedOut';
}
