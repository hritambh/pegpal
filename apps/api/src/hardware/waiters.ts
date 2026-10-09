import type { HardwareEvent } from '@pegpal/shared';

export class WaitTimeoutError extends Error {
  constructor(readonly what: string) {
    super(`Timed out waiting for ${what}`);
    this.name = 'WaitTimeoutError';
  }
}

export class ControllerDisconnectedError extends Error {
  constructor(readonly machineId: string) {
    super(`Controller ${machineId} disconnected`);
    this.name = 'ControllerDisconnectedError';
  }
}

export interface Wait<T extends HardwareEvent> {
  promise: Promise<T>;
  cancel(): void;
}

interface Waiter {
  match(e: HardwareEvent): boolean;
  resolve(e: HardwareEvent): void;
  reject(err: Error): void;
  machineId: string | null;
}

/**
 * Registry of pending waits on hardware events. Register a wait *before*
 * sending the command so a fast reply can't be missed.
 */
export class EventWaiters {
  private readonly waiters = new Set<Waiter>();

  waitFor<T extends HardwareEvent>(
    what: string,
    match: (e: HardwareEvent) => e is T,
    timeoutMs: number,
    opts: { abortOnDisconnectOf?: string } = {},
  ): Wait<T> {
    let waiter!: Waiter;
    let timer: NodeJS.Timeout;
    const promise = new Promise<T>((resolve, reject) => {
      waiter = {
        match,
        machineId: opts.abortOnDisconnectOf ?? null,
        resolve: (e) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(e as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          reject(err);
        },
      };
      timer = setTimeout(() => waiter.reject(new WaitTimeoutError(what)), Math.max(1, Math.round(timeoutMs)));
      this.waiters.add(waiter);
    });
    // Avoid unhandled-rejection noise for waits whose result is never awaited.
    promise.catch(() => undefined);
    return { promise, cancel: () => waiter.reject(new WaitTimeoutError(`${what} (cancelled)`)) };
  }

  notify(event: HardwareEvent): void {
    for (const w of [...this.waiters]) {
      if (event.type === 'CONNECTION' && !event.connected && w.machineId === event.machineId) {
        w.reject(new ControllerDisconnectedError(event.machineId));
      } else if (w.match(event)) {
        w.resolve(event);
      }
    }
  }

  rejectAll(err: Error): void {
    for (const w of [...this.waiters]) w.reject(err);
  }
}
