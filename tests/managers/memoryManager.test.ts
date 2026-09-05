import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryManager } from '../../src/managers/MemoryManager';

function createMockContext(): vscode.ExtensionContext {
  const state = new Map<string, unknown>();
  return {
    globalState: {
      get: vi.fn((key: string) => state.get(key)),
      update: vi.fn((key: string, value: unknown) => {
        state.set(key, value);
        return Promise.resolve();
      }),
    },
  } as unknown as vscode.ExtensionContext;
}

describe('MemoryManager project memory keys', () => {
  let tempRoot: string;
  let oldHome: string | undefined;
  let oldUserProfile: string | undefined;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-memory-test-'));
    oldHome = process.env.HOME;
    oldUserProfile = process.env.USERPROFILE;
    process.env.HOME = path.join(tempRoot, 'home');
    process.env.USERPROFILE = process.env.HOME;
    fs.mkdirSync(process.env.HOME, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = oldHome;
    process.env.USERPROFILE = oldUserProfile;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('does not reuse project memory when the same lexical path points to a different real workspace', () => {
    const victimProject = path.join(tempRoot, 'srv', 'users', 'alice', 'repo');
    const attackerProject = path.join(tempRoot, 'srv', 'users', 'bob', 'repo');
    const workDir = path.join(tempRoot, 'work');
    const sharedWorkspacePath = path.join(workDir, 'current');
    const victimMemory = '# Mysti Project Memory\n\n- VICTIM_ONLY_MEMORY\n';

    fs.mkdirSync(victimProject, { recursive: true });
    fs.mkdirSync(attackerProject, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });

    fs.symlinkSync(victimProject, sharedWorkspacePath, 'dir');

    const victimManager = new MemoryManager(createMockContext());
    victimManager.initProjectMemory(sharedWorkspacePath);
    victimManager.writeProjectMemory(victimMemory);
    const victimMemoryPath = victimManager.getProjectMemoryPath();
    expect(victimManager.getProjectMemoryContent()).toContain('VICTIM_ONLY_MEMORY');
    victimManager.dispose();

    fs.unlinkSync(sharedWorkspacePath);
    fs.symlinkSync(attackerProject, sharedWorkspacePath, 'dir');

    const attackerManager = new MemoryManager(createMockContext());
    attackerManager.initProjectMemory(sharedWorkspacePath);
    const attackerMemoryPath = attackerManager.getProjectMemoryPath();

    expect(attackerMemoryPath).not.toBe(victimMemoryPath);
    expect(attackerManager.getProjectMemoryContent()).not.toContain('VICTIM_ONLY_MEMORY');
    attackerManager.dispose();
  });

  it('migrates a legacy v1-keyed project memory dir to the v2 key', () => {
    const project = path.join(tempRoot, 'projects', 'legacy-repo');
    fs.mkdirSync(project, { recursive: true });

    // Seed a legacy dir keyed by sha256(<literal path>).substring(0, 12)
    const legacyHash = crypto.createHash('sha256').update(project).digest('hex').substring(0, 12);
    const legacyMemoryDir = path.join(process.env.HOME as string, '.mysti', 'projects', legacyHash, 'memory');
    fs.mkdirSync(legacyMemoryDir, { recursive: true });
    fs.writeFileSync(path.join(legacyMemoryDir, 'MEMORY.md'), '# Mysti Project Memory\n\n- LEGACY_MEMORY_CONTENT\n');

    const manager = new MemoryManager(createMockContext());
    manager.initProjectMemory(project);

    expect(manager.getProjectMemoryContent()).toContain('LEGACY_MEMORY_CONTENT');
    expect(manager.getProjectMemoryPath()).not.toContain(legacyHash);
    expect(fs.existsSync(path.join(process.env.HOME as string, '.mysti', 'projects', legacyHash))).toBe(false);
    manager.dispose();
  });
});
