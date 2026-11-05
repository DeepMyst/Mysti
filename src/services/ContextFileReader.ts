import { isUtf8 } from 'buffer';
import { AttachmentTooLargeError, MAX_ATTACHMENT_BYTES, readAttachmentBytes } from './AttachmentReader';

export const MAX_CONTEXT_FILE_BYTES = MAX_ATTACHMENT_BYTES;

export interface ContextFileFailure {
  path: string;
  reason: 'too-large' | 'not-text' | 'unreadable';
}

class ContextFileEncodingError extends Error {}

/** Preserve exact UTF-8 bytes, including a BOM and empty files; never decode lossily. */
export async function readContextFileText(filePath: string, isCurrent: () => boolean): Promise<string | undefined> {
  const bytes = await readAttachmentBytes(filePath, isCurrent);
  if (bytes === undefined) { return undefined; }
  if (!isUtf8(bytes) || bytes.includes(0)) { throw new ContextFileEncodingError('Context requires UTF-8 text without NUL bytes.'); }
  return bytes.toString('utf8');
}

export function contextFileFailure(filePath: string, error: unknown): ContextFileFailure {
  // Saved context can contain a damaged path field. Keep reporting independent
  // of that value so one bad record cannot interrupt the remaining restoration.
  return { path: typeof filePath === 'string' && filePath ? filePath : '(unknown file)', reason: error instanceof AttachmentTooLargeError ? 'too-large'
    : error instanceof ContextFileEncodingError ? 'not-text' : 'unreadable' };
}
