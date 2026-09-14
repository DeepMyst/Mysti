import { describe, expect, it, vi } from 'vitest';
import { CanvasMcpSession, type CanvasMcpSessionServer } from '../../src/canvas/CanvasMcpSession';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const endpoint = (id: string) => ({ url: `http://127.0.0.1/${id}`, token: `fixture-${id}` });

function server(id: string) {
  return { start: vi.fn(async () => endpoint(id)), stop: vi.fn(async () => {}) };
}

function harness() {
  const state = { artifactId: 'design-A', origin: 'chat-A' as string | null };
  const createServer = vi.fn((_artifactId: string): CanvasMcpSessionServer | null => server(_artifactId));
  const link = vi.fn();
  const unlink = vi.fn();
  const onError = vi.fn();
  const session = new CanvasMcpSession({
    artifactId: () => state.artifactId,
    originPanel: () => state.origin,
    createServer, link, unlink, onError,
  });
  return { state, createServer, link, unlink, onError, session };
}

describe('canvas MCP session ownership', () => {
  it('links the current design and immediately unlinks before its replacement starts', async () => {
    const h = harness();
    const old = server('design-A');
    const next = server('design-B');
    h.createServer.mockReturnValueOnce(old).mockReturnValueOnce(next);
    await h.session.relink('design-A');
    expect(h.link).toHaveBeenCalledExactlyOnceWith('chat-A', endpoint('design-A'));
    h.state.artifactId = 'design-B';
    const switching = h.session.relink('design-B');
    expect(h.unlink).toHaveBeenCalledExactlyOnceWith('chat-A');
    expect(old.stop).toHaveBeenCalledOnce();
    expect(next.start).not.toHaveBeenCalled();
    await switching;
    expect(h.link).toHaveBeenLastCalledWith('chat-A', endpoint('design-B'));
    await h.session.dispose();
    expect(next.stop).toHaveBeenCalledOnce();
    expect(h.unlink).toHaveBeenCalledTimes(2);
  });

  it('lets only the newest switch resume after a slow previous shutdown', async () => {
    const h = harness();
    const stopped = deferred<void>();
    const old = server('design-A');
    old.stop.mockReturnValue(stopped.promise);
    const latest = server('design-C');
    h.createServer.mockReturnValueOnce(old).mockReturnValueOnce(latest);
    await h.session.relink('design-A');
    h.state.artifactId = 'design-B';
    const intermediate = h.session.relink('design-B');
    h.state.artifactId = 'design-C';
    const newest = h.session.relink('design-C');
    await Promise.resolve();
    expect(h.createServer).toHaveBeenCalledTimes(1);
    stopped.resolve();
    await Promise.all([intermediate, newest]);
    expect(h.createServer.mock.calls).toEqual([['design-A'], ['design-C']]);
    expect(h.link.mock.calls).toEqual([
      ['chat-A', endpoint('design-A')], ['chat-A', endpoint('design-C')],
    ]);
    await h.session.dispose();
  });

  it('does not construct a server when the canvas closes during old shutdown', async () => {
    const h = harness();
    const stopped = deferred<void>();
    const old = server('design-A');
    old.stop.mockReturnValue(stopped.promise);
    h.createServer.mockReturnValue(old);
    await h.session.relink('design-A');
    h.state.artifactId = 'design-B';
    const relinking = h.session.relink('design-B');
    const closed = h.session.close();
    stopped.resolve();
    await Promise.all([relinking, closed]);
    expect(h.createServer).toHaveBeenCalledOnce();
    expect(h.link).toHaveBeenCalledOnce();
    expect(old.stop).toHaveBeenCalledOnce();
  });

  it('stops a pending startup and never publishes its endpoint after close', async () => {
    const h = harness();
    const started = deferred<ReturnType<typeof endpoint>>();
    const pending = server('design-A');
    pending.start.mockReturnValue(started.promise);
    h.createServer.mockReturnValue(pending);
    const relinking = h.session.relink('design-A');
    await Promise.resolve();
    expect(pending.start).toHaveBeenCalledOnce();
    const closed = h.session.close();
    expect(pending.stop).toHaveBeenCalledOnce();
    started.resolve(endpoint('design-A'));
    await Promise.all([relinking, closed]);
    expect(h.link).not.toHaveBeenCalled();
    expect(pending.stop).toHaveBeenCalledOnce();
  });

  it('waits for an obsolete startup to stop before sharing its tool server again', async () => {
    const h = harness();
    const started = deferred<ReturnType<typeof endpoint>>();
    const stopped = deferred<void>();
    const pending = server('design-A');
    pending.start.mockReturnValue(started.promise);
    pending.stop.mockReturnValue(stopped.promise);
    const next = server('design-B');
    h.createServer.mockReturnValueOnce(pending).mockReturnValueOnce(next);
    const first = h.session.relink('design-A');
    await Promise.resolve();
    h.state.artifactId = 'design-B';
    const second = h.session.relink('design-B');
    started.resolve(endpoint('design-A'));
    await Promise.resolve();
    expect(next.start).not.toHaveBeenCalled();
    stopped.resolve();
    await Promise.all([first, second]);
    expect(h.link).toHaveBeenCalledExactlyOnceWith('chat-A', endpoint('design-B'));
    await h.session.dispose();
  });

  it('an obsolete startup failure cannot remove a newer registration', async () => {
    const h = harness();
    const started = deferred<ReturnType<typeof endpoint>>();
    const obsolete = server('design-A');
    obsolete.start.mockReturnValue(started.promise);
    const current = server('design-B');
    h.createServer.mockReturnValueOnce(obsolete).mockReturnValueOnce(current);
    const oldRelink = h.session.relink('design-A');
    await Promise.resolve();
    h.state.artifactId = 'design-B';
    await h.session.relink('design-B');
    started.reject(new Error('obsolete startup failed'));
    await oldRelink;
    expect(h.link).toHaveBeenCalledExactlyOnceWith('chat-A', endpoint('design-B'));
    expect(h.unlink).not.toHaveBeenCalled();
    expect(current.stop).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
    await h.session.dispose();
  });

  it.each(['artifact', 'origin'])('refuses a changed %s binding while startup is pending', async binding => {
    const h = harness();
    const started = deferred<ReturnType<typeof endpoint>>();
    const pending = server('design-A');
    pending.start.mockReturnValue(started.promise);
    h.createServer.mockReturnValue(pending);
    const relinking = h.session.relink('design-A');
    await Promise.resolve();
    if (binding === 'artifact') { h.state.artifactId = 'design-B'; }
    else { h.state.origin = 'chat-B'; }
    started.resolve(endpoint('design-A'));
    await relinking;
    expect(h.link).not.toHaveBeenCalled();
    expect(pending.stop).toHaveBeenCalledOnce();
  });

  it('does not create a server for an already stale artifact ID', async () => {
    const h = harness();
    await h.session.relink('obsolete-design');
    expect(h.createServer).not.toHaveBeenCalled();
    expect(h.link).not.toHaveBeenCalled();
  });

  it('a stale delayed relink cannot revoke the current design endpoint', async () => {
    const h = harness();
    const current = server('design-A');
    h.createServer.mockReturnValue(current);
    await h.session.relink('design-A');
    await h.session.relink('obsolete-design');
    expect(current.stop).not.toHaveBeenCalled();
    expect(h.unlink).not.toHaveBeenCalled();
    expect(h.createServer).toHaveBeenCalledOnce();
    await h.session.dispose();
  });

  it('retains an unlinked command-palette canvas server until close', async () => {
    const h = harness();
    h.state.origin = null;
    const unlinked = server('design-A');
    h.createServer.mockReturnValue(unlinked);
    await h.session.relink('design-A');
    expect(unlinked.start).toHaveBeenCalledOnce();
    expect(h.link).not.toHaveBeenCalled();
    await h.session.close();
    expect(unlinked.stop).toHaveBeenCalledOnce();
    expect(h.unlink).not.toHaveBeenCalled();
  });

  it('allows reopening after close and refuses all work after disposal', async () => {
    const h = harness();
    await h.session.relink('design-A');
    await h.session.close();
    await h.session.relink('design-A');
    await h.session.dispose();
    await h.session.relink('design-A');
    expect(h.createServer).toHaveBeenCalledTimes(2);
    expect(h.link).toHaveBeenCalledTimes(2);
    expect(h.unlink).toHaveBeenCalledTimes(2);
  });

  it('stops a failed startup before a later successful retry', async () => {
    const h = harness();
    const failure = new Error('fixture startup failure');
    const failed = server('design-A');
    failed.start.mockRejectedValue(failure);
    h.createServer.mockReturnValueOnce(failed).mockReturnValueOnce(server('retry'));
    await h.session.relink('design-A');
    expect(failed.stop).toHaveBeenCalledOnce();
    expect(h.onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(h.link).not.toHaveBeenCalled();
    await h.session.relink('design-A');
    expect(h.link).toHaveBeenCalledExactlyOnceWith('chat-A', endpoint('retry'));
    await h.session.dispose();
  });

  it('removes a partially installed configuration when linking throws', async () => {
    const h = harness();
    const failure = new Error('fixture config failure');
    const started = server('design-A');
    h.createServer.mockReturnValue(started);
    h.link.mockImplementation(() => { throw failure; });
    await h.session.relink('design-A');
    expect(h.unlink).toHaveBeenCalledExactlyOnceWith('chat-A');
    expect(started.stop).toHaveBeenCalledOnce();
    expect(h.onError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it.each(['missing', 'throws'])('recovers when server construction %s', async outcome => {
    const h = harness();
    const failure = new Error('fixture factory failure');
    h.createServer.mockImplementationOnce(() => {
      if (outcome === 'throws') { throw failure; }
      return null;
    });
    await h.session.relink('design-A');
    expect(h.link).not.toHaveBeenCalled();
    await h.session.relink('design-A');
    expect(h.link).toHaveBeenCalledOnce();
    await h.session.dispose();
  });

  it('cleanup failures do not prevent the next design from connecting', async () => {
    const h = harness();
    const old = server('design-A');
    old.stop.mockRejectedValue(new Error('fixture stop failure'));
    h.createServer.mockReturnValueOnce(old).mockReturnValueOnce(server('design-B'));
    h.unlink.mockImplementation(() => { throw new Error('fixture unlink failure'); });
    h.onError.mockImplementation(() => { throw new Error('fixture logger failure'); });
    await h.session.relink('design-A');
    h.state.artifactId = 'design-B';
    await expect(h.session.relink('design-B')).resolves.toBeUndefined();
    expect(h.link).toHaveBeenLastCalledWith('chat-A', endpoint('design-B'));
    await h.session.dispose();
  });
});
