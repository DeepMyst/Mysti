/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareCliAttachments } from '../../../src/providers/base/prepareCliAttachments';
import type { Attachment } from '../../../src/types';

function inline(id = 'same-id'): Attachment {
  return { id, type: 'image', fileName: 'image.png', mimeType: 'image/png', size: 11, base64Data: Buffer.from('image bytes').toString('base64') };
}

describe('CLI attachment ownership and rollback', () => {
  let directory: string;
  beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-attachment-test-')); });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

  it('does no filesystem work for absent attachments or files already on disk', async () => {
    const mkdir = vi.spyOn(fs, 'mkdir');
    const attachment = { ...inline(), base64Data: undefined, filePath: '/existing/image.png' };
    expect(await prepareCliAttachments(undefined, directory)).toBeNull();
    expect(await prepareCliAttachments([], directory)).toBeNull();
    expect(await prepareCliAttachments([attachment], directory)).toBeNull();
    expect(mkdir).not.toHaveBeenCalled();
    expect(attachment.filePath).toBe('/existing/image.png');
  });

  it('cleans a completed preparation without touching existing files', async () => {
    const existing = path.join(directory, 'keep.txt');
    await fs.writeFile(existing, 'keep');
    const attachment = inline();
    const cleanup = await prepareCliAttachments([attachment], directory);
    expect(await fs.readFile(attachment.filePath!, 'utf8')).toBe('image bytes');
    await cleanup!();
    await cleanup!();
    expect(await fs.readdir(directory)).toEqual(['keep.txt']);
    expect(await fs.readFile(existing, 'utf8')).toBe('keep');
    expect(attachment.filePath).toBeUndefined();
  });

  it('rolls back successful and partially written files when a later write fails', async () => {
    const existing = path.join(directory, 'keep.txt');
    await fs.writeFile(existing, 'keep');
    const first = { ...inline('first'), filePath: existing };
    const second = inline('second');
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile')
      .mockImplementationOnce(writeFile)
      .mockImplementationOnce(async file => {
        await writeFile(file, 'partial');
        throw new Error('disk full');
      });
    await expect(prepareCliAttachments([first, second], directory)).rejects.toThrow('disk full');
    expect(await fs.readdir(directory)).toEqual(['keep.txt']);
    expect(await fs.readFile(existing, 'utf8')).toBe('keep');
    expect(first.filePath).toBe(existing);
    expect(second.filePath).toBeUndefined();
  });

  it('concurrent preparations with the same attachment ID have independent cleanup', async () => {
    const first = inline();
    const second = inline();
    const [cleanupFirst, cleanupSecond] = await Promise.all([
      prepareCliAttachments([first], directory),
      prepareCliAttachments([second], directory),
    ]);
    expect(first.filePath).not.toBe(second.filePath);
    await cleanupFirst!();
    expect(await fs.readFile(second.filePath!, 'utf8')).toBe('image bytes');
    await cleanupSecond!();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('cleanup does not overwrite a path assigned by a newer preparation', async () => {
    const attachment = inline();
    const cleanup = await prepareCliAttachments([attachment], directory);
    attachment.filePath = '/newer/preparation.png';
    await cleanup!();
    expect(attachment.filePath).toBe('/newer/preparation.png');
  });

  it('untrusted attachment IDs and extensions cannot escape the owned directory', async () => {
    const attachment = { ...inline('../escape'), fileName: 'image.../../escape' };
    const cleanup = await prepareCliAttachments([attachment], directory);
    expect(path.dirname(path.dirname(attachment.filePath!))).toBe(directory);
    expect(path.basename(attachment.filePath!)).toBe('attachment-0.bin');
    await cleanup!();
    expect(await fs.readdir(directory)).toEqual([]);
  });
});
