// What Mobile Serve did and what went wrong, for bug reports. The extension sends it to the
// "Mobile Serve" output channel; in tests it goes nowhere. Kept free of VS Code, so any module can log.

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string | Error): void;
}

let logger: Logger | undefined;

export function setLogger(next: Logger | undefined): void {
  logger = next;
}

// An error's message, or the value itself, for a log line.
export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const log: Logger = {
  debug: message => logger?.debug(message),
  info: message => logger?.info(message),
  warn: message => logger?.warn(message),
  error: message => logger?.error(message),
};
