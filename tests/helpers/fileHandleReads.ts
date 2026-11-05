import { promises as fs } from 'node:fs';
import type { FileReadResult } from 'node:fs/promises';
import { vi } from 'vitest';

const originalOpen = fs.open.bind(fs);

/**
 * Observe or hold the first actual read of each handle without replacing
 * admission/stat. This preserves per-file path/hold observations; subsequent
 * chunks and EOF reads are delegated unchanged, not counted as separate files.
 * Content-boundary fixtures independently record every raw read operation.
 */
export function observeFileHandleReads(
  observe: (path: string, read: () => Promise<FileReadResult<NodeJS.ArrayBufferView>>) => Promise<FileReadResult<NodeJS.ArrayBufferView>>
) {
  return vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    const read = handle.read.bind(handle);
    let firstRead = true;
    vi.spyOn(handle, 'read').mockImplementation((...options) => {
      if (!firstRead) { return read(...options); }
      firstRead = false;
      return observe(String(args[0]), () => read(...options));
    });
    return handle;
  });
}
