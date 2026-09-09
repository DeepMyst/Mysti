/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import type { Attachment } from '../../types';

/**
 * Materialize inline attachments for a CLI with filesystem access. Every call
 * owns a fresh directory, so concurrent turns cannot overwrite or unlink each
 * other's files, even when they receive the same attachment ID.
 * Attachment records must be owned by this request; the provider clones them
 * at its sendMessage boundary before this helper assigns temporary file paths.
 */
export async function prepareCliAttachments(
  attachments: Attachment[] | undefined,
  parentDirectory: string,
): Promise<(() => Promise<void>) | null> {
  const inline = (attachments ?? []).filter(att =>
    (att.type === 'image' || att.type === 'file') && att.base64Data,
  );
  if (inline.length === 0) { return null; }

  await fs.mkdir(parentDirectory, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parentDirectory, 'mysti-attachments-'));
  const changed: { attachment: Attachment; target: string; previousPath: string | undefined }[] = [];
  let cleaning: Promise<void> | undefined;
  const cleanup = () => cleaning ??= (async () => {
    try {
      await fs.rm(directory, { recursive: true, force: true });
      for (const { attachment, target, previousPath } of changed) {
        if (attachment.filePath === target) { attachment.filePath = previousPath; }
      }
    } catch (error) {
      console.warn('[Mysti] Unable to remove temporary CLI attachments:', error);
    }
  })();

  try {
    for (const [index, attachment] of inline.entries()) {
      const candidate = attachment.fileName?.split('.').pop()
        || attachment.mimeType?.split('/')[1] || 'bin';
      const extension = /^[a-zA-Z0-9]{1,16}$/.test(candidate) ? candidate : 'bin';
      const target = path.join(directory, `attachment-${index}.${extension}`);
      await fs.writeFile(target, Buffer.from(attachment.base64Data!, 'base64'));
      changed.push({ attachment, target, previousPath: attachment.filePath });
      attachment.filePath = target;
    }
    return cleanup;
  } catch (error) {
    // Also removes a partially written failing file in this call's directory.
    await cleanup();
    throw error;
  }
}
