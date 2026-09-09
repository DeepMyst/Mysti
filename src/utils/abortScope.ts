/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

export interface AbortScope {
  signal: AbortSignal;
  /** Release listeners and the deadline when the operation finishes. */
  dispose(): void;
}

/**
 * Combine cancellation and an optional deadline on every supported host,
 * including Node 18.15, which does not provide AbortSignal.any.
 * The caller must dispose the scope in finally after consuming the response.
 */
export function createAbortScope(
  signals: readonly (AbortSignal | undefined)[],
  timeoutMs?: number,
): AbortScope {
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    for (const [signal, listener] of listeners) {
      signal.removeEventListener('abort', listener);
    }
    listeners.clear();
  };
  const abort = (reason: unknown) => {
    dispose();
    controller.abort(reason);
  };

  for (const signal of new Set(signals)) {
    if (!signal) { continue; }
    if (signal.aborted) {
      abort(signal.reason);
      return { signal: controller.signal, dispose };
    }
    const listener = () => abort(signal.reason);
    listeners.set(signal, listener);
    signal.addEventListener('abort', listener, { once: true });
  }
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    }, timeoutMs);
    timer.unref?.();
  }
  return { signal: controller.signal, dispose };
}
