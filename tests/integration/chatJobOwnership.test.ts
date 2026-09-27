/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Plan 32 H3: a background job is stopped only by the panel that owns it, and
 * the agent map's silent `requestJobs` refresh is echoed back as such.
 */
import { describe, expect, it, vi } from 'vitest';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import type { WebviewMessage } from '../../src/types';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));

interface JobHost {
  _handleMessage(message: WebviewMessage & { panelId: string }): Promise<void>;
}

function harness() {
  const jobs = new Map([
    ['job-a', { id: 'job-a', panelId: 'a', status: 'running' }],
    // Another window's job: same sidebar panel id, running in that window.
    ['job-other', { id: 'job-other', panelId: 'a', status: 'running' }],
    ['job-old', { id: 'job-old', panelId: 'a', status: 'done' }],
  ]);
  const executingHere = new Set(['job-a']);
  const abort = vi.fn();
  const posted: Array<{ panelId: string; message: WebviewMessage }> = [];
  const host = Object.assign(Object.create(ChatViewProvider.prototype), {
    _sidebarId: 'a',
    _backgroundJobManager: {
      get: (id: string) => jobs.get(id),
      isExecutingHere: (id: string) => executingHere.has(id),
      listForPanel: (panelId: string) => [...jobs.values()].filter(job => job.panelId === panelId),
    },
    _abortMystiJob: abort,
    _postToPanel: (panelId: string, message: WebviewMessage) => { posted.push({ panelId, message }); return true; },
  }) as JobHost;
  return { host, abort, posted };
}

describe('background job ownership', () => {
  it('stops a job only for the panel that started it', async () => {
    const { host, abort } = harness();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await host._handleMessage({ type: 'cancelJob', payload: { jobId: 'job-a' }, panelId: 'b' } as never);
    await host._handleMessage({ type: 'cancelJob', payload: { jobId: 'job-missing' }, panelId: 'a' } as never);
    await host._handleMessage({ type: 'cancelJob', payload: { jobId: 'job-other' }, panelId: 'a' } as never);
    expect(abort).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[Mysti] cancelJob ignored'), 'job-a');

    await host._handleMessage({ type: 'cancelJob', payload: { jobId: 'job-a' }, panelId: 'a' } as never);
    expect(abort).toHaveBeenCalledWith('job-a');
    log.mockRestore();
  });

  it('echoes only the agent map source on the jobs list, and the map never lists another window\'s running job', async () => {
    const { host, posted } = harness();

    await host._handleMessage({ type: 'requestJobs', payload: { source: 'agentMap' }, panelId: 'a' } as never);
    await host._handleMessage({ type: 'requestJobs', payload: { source: 'somethingElse' }, panelId: 'a' } as never);
    await host._handleMessage({ type: 'requestJobs', panelId: 'a' } as never);

    const all = ['job-a', 'job-other', 'job-old'].map(id => expect.objectContaining({ id }));
    expect(posted.map(p => p.message.payload)).toEqual([
      { jobs: [expect.objectContaining({ id: 'job-a' }), expect.objectContaining({ id: 'job-old' })], source: 'agentMap' },
      { jobs: all },
      { jobs: all },
    ]);
    expect(posted.every(p => p.panelId === 'a')).toBe(true);
  });
});
