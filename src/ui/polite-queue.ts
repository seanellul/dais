/**
 * The batching behind the polite live region: at most one announcement every
 * `batchMs`, with everything that arrived in between read out as one sentence.
 * Pure timers and callbacks, no React, so it can be tested with fake timers.
 */

/** Minimum gap between polite announcements. */
export const POLITE_BATCH_MS = 3000;

export interface PoliteQueue {
  /** Adds a message. It is read now, or with the next batch. */
  push(message: string): void;
  /** Drops any pending batch. Call it when the owner unmounts. */
  cancel(): void;
}

/**
 * Creates a queue that calls `onFlush` with the joined messages. The first
 * message is read at once; later ones wait until `batchMs` has passed since
 * the last flush, then go out together.
 */
export function createPoliteQueue(
  onFlush: (text: string) => void,
  batchMs = POLITE_BATCH_MS,
): PoliteQueue {
  let pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushAt: number | null = null;

  function flush(): void {
    timer = null;
    if (pending.length === 0) return;
    const text = pending.join(". ");
    pending = [];
    lastFlushAt = Date.now();
    onFlush(text);
  }

  function push(message: string): void {
    pending.push(message);
    if (timer !== null) return;
    const wait = lastFlushAt === null ? 0 : Math.max(0, batchMs - (Date.now() - lastFlushAt));
    if (wait === 0) {
      flush();
    } else {
      timer = setTimeout(flush, wait);
    }
  }

  function cancel(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = [];
  }

  return { push, cancel };
}
