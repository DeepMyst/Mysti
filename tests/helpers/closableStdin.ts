import type { Socket } from 'node:net';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Use fd 3 as the real input pipe of an inert child. libuv intentionally makes
 * fs.close(0) a no-op on Windows; fd 3 can actually close while stdout stays open.
 * Spawn with stdio ['ignore', 'pipe', 'pipe', 'pipe'] before calling this helper.
 */
export function withClosableStdin(child: ChildProcess): ChildProcessWithoutNullStreams {
  const pipe = child.stdio[3] as Socket;
  // An extra pipe is duplex. Keep its write side open after peer EOF so the
  // next write observes EPIPE, like the parent's write-only standard input.
  pipe.allowHalfOpen = true;
  Object.defineProperty(child, 'stdin', { value: pipe });
  return child as ChildProcessWithoutNullStreams;
}
