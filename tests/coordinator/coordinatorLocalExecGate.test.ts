import { describe, expect, it, vi } from 'vitest';
import { CoordinatorLocalExecGate, type CoordinatorLocalExecGatePorts } from '../../src/coordinator/CoordinatorLocalExecGate';
import type { LocalExecGateInfo } from '../../src/services/MystiLocalExec';

function harness(modelPinned = true, modeGates = true) {
  const ports = {
    classifyAction: vi.fn<CoordinatorLocalExecGatePorts['classifyAction']>(() => 'file-edit'),
    classifyRisk: vi.fn<CoordinatorLocalExecGatePorts['classifyRisk']>(() => 'high'),
    shouldGate: vi.fn(() => modeGates),
    toolDetails: vi.fn<CoordinatorLocalExecGatePorts['toolDetails']>(tool => ({ toolName: tool.name, toolInput: tool.input as Record<string, unknown> })),
    request: vi.fn<CoordinatorLocalExecGatePorts['request']>(async () => false),
    confirmRemoteEffect: vi.fn<CoordinatorLocalExecGatePorts['confirmRemoteEffect']>(async () => false),
  } satisfies CoordinatorLocalExecGatePorts;
  return { gate: new CoordinatorLocalExecGate(modelPinned, ports), ports };
}

describe('CoordinatorLocalExecGate', () => {
  const combinations = Array.from({ length: 32 }, (_, n) => ({
    modelPinned: !!(n & 1), modeGates: !!(n & 2), safe: !!(n & 4), compound: !!(n & 8), sandboxed: !!(n & 16),
  }));
  it.each(combinations)('enforces every necessary shell auto-run condition: %j', async options => {
    const h = harness(options.modelPinned, options.modeGates);
    const result = await h.gate.check({ kind: 'bash', command: 'command', ...options });
    const mayAutoRun = options.modelPinned && !options.modeGates && options.safe && !options.compound && options.sandboxed;
    expect(result).toBe(mayAutoRun);
    expect(h.ports.request).toHaveBeenCalledTimes(mayAutoRun ? 0 : 1);
    if (!mayAutoRun) {
      expect(h.ports.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'bash-command', forceInteractive: true }));
    }
    expect(h.ports.confirmRemoteEffect).not.toHaveBeenCalled();
  });

  it.each([true, false])('routes remote effects only through the modal confirmation and returns its decision (%s)', async approved => {
    const h = harness(true, false);
    h.ports.confirmRemoteEffect.mockResolvedValue(approved);
    expect(await h.gate.check({ kind: 'bash', command: 'remote command', remoteEffect: true, safe: true, sandboxed: true })).toBe(approved);
    expect(h.ports.confirmRemoteEffect).toHaveBeenCalledExactlyOnceWith('remote command');
    expect(h.ports.request).not.toHaveBeenCalled();
  });

  it.each([true, false])('describes actual sandbox network policy on the interactive card (%s)', async network => {
    const h = harness();
    await h.gate.check({ kind: 'bash', command: 'command', sandboxed: true, network });
    expect(h.ports.request.mock.calls[0][0].description).toContain(network ? 'NETWORK ENABLED' : 'no network');
  });

  it.each(['write', 'edit', 'patch'] as const)('honors existing mode approval for %s without asking again', async kind => {
    const h = harness(false, false);
    expect(await h.gate.check({ kind })).toBe(true);
    expect(h.ports.request).not.toHaveBeenCalled();
  });

  it('uses the capped CLI edit shape, preserving the actual old/new bytes and replace-all flag', async () => {
    const h = harness();
    const info: LocalExecGateInfo = { kind: 'edit', relPath: 'src/a', oldString: 'before', newString: 'after', replaceAll: true, linesAdded: 1, linesRemoved: 1 };
    h.ports.toolDetails.mockReturnValue({ toolName: 'Edit', toolInput: { marker: 'capped by host' } });
    expect(await h.gate.check(info)).toBe(false);
    expect(h.ports.toolDetails).toHaveBeenCalledExactlyOnceWith({ name: 'Edit', input: { file_path: 'src/a', old_string: 'before', new_string: 'after', replace_all: true } });
    expect(h.ports.request.mock.calls[0][0].details).toEqual({ filePath: 'src/a', fileName: 'a', linesAdded: 1, linesRemoved: 1, riskLevel: 'high', toolName: 'Edit', toolInput: { marker: 'capped by host' } });
  });

  it.each([true, false])('preserves write contents and correctly labels an existing target (%s)', async exists => {
    const h = harness();
    h.ports.request.mockResolvedValue(true);
    expect(await h.gate.check({ kind: 'write', exists, relPath: 'a', content: 'complete file' })).toBe(true);
    expect(h.ports.toolDetails).toHaveBeenCalledWith({ name: 'Write', input: { file_path: 'a', content: 'complete file' } });
    expect(h.ports.request.mock.calls[0][0].title).toBe(`Mysti wants to ${exists ? 'overwrite' : 'create'} a file`);
  });

  it('keeps all patch file details while bounding only the readable title list', async () => {
    const h = harness();
    const files = Array.from({ length: 10 }, (_, n) => `file${n}`);
    await h.gate.check({ kind: 'patch', files, linesAdded: 5, linesRemoved: 2 });
    const request = h.ports.request.mock.calls[0][0];
    expect(request.action).toBe('multi-file-edit');
    expect(request.description).toContain('10 file(s)');
    expect(request.description).not.toContain('file8');
    expect(request.details.files).toHaveLength(10);
    expect(request.details).toMatchObject({ linesAdded: 5, linesRemoved: 2 });
  });
});
