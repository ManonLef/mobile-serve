// Runs one job per key at a time, so starting a folder twice at once doesn't start two servers.

/**
 * Returns a function that runs `run` for `key`, unless a job for that key is still running: then it
 * resolves (or rejects) with that job's result instead.
 */
export function singleFlight<K, T>(): (key: K, run: () => Promise<T>) => Promise<T> {
  const running = new Map<K, Promise<T>>();
  return (key, run) => {
    let job = running.get(key);
    if (!job) {
      job = run().finally(() => running.delete(key));
      running.set(key, job);
    }
    return job;
  };
}
