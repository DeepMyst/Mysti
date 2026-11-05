import * as fs from 'fs';
import type { FileHandle } from 'fs/promises';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export class AttachmentTooLargeError extends Error {
  constructor() {
    super('File exceeds the attachment byte limit.');
    this.name = 'AttachmentTooLargeError';
  }
}

/** Read the selected file through one handle, including at most one overflow byte. */
export async function readAttachmentBytes(filePath: string, isCurrent: () => boolean): Promise<Buffer | undefined> {
  if (!isCurrent()) { return undefined; }
  let handle: FileHandle | undefined;
  let content: Buffer | undefined;
  try {
    // A regular path can be replaced after the picker's stat. Nonblocking open
    // lets the handle's own type check reject a substituted FIFO on POSIX.
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    if (!isCurrent()) { return undefined; }
    const stat = await handle.stat();
    if (!isCurrent()) { return undefined; }
    if (!stat.isFile()) { throw new Error('Attachment is not a regular file.'); }
    if (stat.size > MAX_ATTACHMENT_BYTES) { throw new AttachmentTooLargeError(); }

    const chunks: Buffer[] = [];
    let byteLength = 0;
    while (true) {
      if (!isCurrent()) { return undefined; }
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_ATTACHMENT_BYTES + 1 - byteLength));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!isCurrent()) { return undefined; }
      if (bytesRead === 0) {
        content = Buffer.concat(chunks, byteLength);
        break;
      }
      byteLength += bytesRead;
      if (byteLength > MAX_ATTACHMENT_BYTES) { throw new AttachmentTooLargeError(); }
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally {
    if (handle) { await handle.close(); }
  }
  return isCurrent() ? content : undefined;
}
