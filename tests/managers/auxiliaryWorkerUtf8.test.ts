import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SuggestionManager } from '../../src/managers/SuggestionManager';
import { PlanOptionManager } from '../../src/managers/PlanOptionManager';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import type { Conversation, Message } from '../../src/types';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: mocks.spawn }));
vi.mock('../../src/utils/processKill', async original => ({
  ...await original<typeof import('../../src/utils/processKill')>(),
  killProcessTree: vi.fn(async () => {}),
}));

const content = 'Compare the retry approaches and ask which implementation the user would prefer.';
const managers: Array<{ dispose(): void }> = [];
let children: any[];
type Kind = 'title' | 'suggestions' | 'classification';
const kinds: Kind[] = ['title', 'suggestions', 'classification'];
const splitCases = ['é', '€', '😀', 'مرحبا'].flatMap(text => {
  let preceding = 0;
  return [...text].flatMap(character => {
    const size = Buffer.byteLength(character);
    const result = Array.from({ length: size - 1 }, (_, index) => ({ text, offset: preceding + index + 1 }));
    preceding += size;
    return result;
  });
});
function start(kind: Kind) {
  const manager = kind === 'classification' ? new PlanOptionManager() : new SuggestionManager({} as any);
  managers.push(manager);
  const pending = kind === 'classification' ? (manager as PlanOptionManager).classifyResponse(content)
    : kind === 'title' ? (manager as SuggestionManager).generateTitle(content)
      : (manager as SuggestionManager).generateSuggestions({} as Conversation, { content } as Message);
  return { manager, pending, child: children.at(-1) };
}
function output(kind: Kind, text: string): string {
  if (kind === 'title') return text;
  if (kind === 'suggestions') return JSON.stringify([{ title: text, description: text, prompt: text }]);
  return JSON.stringify({ context: text, questions: [{ question: text, inputType: 'radio', options: [{ label: text, value: text }] }],
    planOptions: [{ title: text, summary: text, approach: text, pros: [text], cons: [text] }] });
}
function assertText(kind: Kind, result: any, text: string): void {
  if (kind === 'title') expect(result).toBe(text);
  else if (kind === 'suggestions') expect(result).toMatchObject([{ title: text, description: text, message: text }]);
  else expect(result).toMatchObject({ context: text, questions: [{ question: text, options: [{ label: text, value: text }] }],
    planOptions: [{ title: text, summary: text, approach: text, pros: [text], cons: [text] }] });
}
beforeEach(() => {
  vi.useFakeTimers(); clearMockConfig(); setMockConfig('claudeCodePath', '/controlled/text-worker'); children = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signalCode: null, kill: vi.fn(() => true) });
    children.push(child); return child;
  });
});
afterEach(() => {
  managers.splice(0).forEach(manager => manager.dispose());
  children.forEach(child => child.emit('close', null));
  vi.clearAllTimers(); vi.useRealTimers(); clearMockConfig(); vi.restoreAllMocks();
});

describe('PB-02 auxiliary output keeps complete UTF-8 characters across process chunks', () => {
  for (const kind of kinds) {
    it.each(splitCases)(`${kind}: preserves $text split at byte $offset`, async ({ text, offset }) => {
      const worker = start(kind), expected = `Review ${text} choices`, bytes = Buffer.from(output(kind, expected));
      const split = bytes.indexOf(Buffer.from(text)) + offset;
      worker.child.stdout.emit('data', bytes.subarray(0, split));
      worker.child.stdout.emit('data', bytes.subarray(split));
      worker.child.emit('close', 0);
      assertText(kind, await worker.pending, expected);
    });

    it(`${kind}: preserves all fields when every byte arrives separately`, async () => {
      const worker = start(kind), expected = 'Café € 😀 مرحبا';
      for (const byte of Buffer.from(output(kind, expected))) worker.child.stdout.emit('data', Buffer.from([byte]));
      worker.child.emit('close', 0);
      assertText(kind, await worker.pending, expected);
    });

    it(`${kind}: independent concurrent workers cannot share a pending character`, async () => {
      const first = start(kind), second = start(kind);
      const texts = ['First café 😀', 'Second مرحبا €'];
      const outputs = texts.map(text => Buffer.from(output(kind, text)));
      const splits = [outputs[0].indexOf(Buffer.from('é')) + 1, outputs[1].indexOf(Buffer.from('م')) + 1];
      first.child.stdout.emit('data', outputs[0].subarray(0, splits[0]));
      second.child.stdout.emit('data', outputs[1].subarray(0, splits[1]));
      second.child.stdout.emit('data', outputs[1].subarray(splits[1])); second.child.emit('close', 0);
      first.child.stdout.emit('data', outputs[0].subarray(splits[0])); first.child.emit('close', 0);
      assertText(kind, await first.pending, texts[0]); assertText(kind, await second.pending, texts[1]);
    });
  }

  it('a truly truncated title flushes one replacement character at stream completion', async () => {
    const worker = start('title');
    worker.child.stdout.emit('data', Buffer.from('Review '));
    worker.child.stdout.emit('data', Buffer.from([0xf0]));
    worker.child.stdout.emit('data', Buffer.from([0x9f, 0x98]));
    worker.child.emit('close', 0);
    expect(await worker.pending).toBe('Review �');
  });

  it('complete suggestion JSON received before the timeout retains Unicode', async () => {
    const worker = start('suggestions'), expected = 'Café مرحبا 😀';
    for (const byte of Buffer.from(output('suggestions', expected))) worker.child.stdout.emit('data', Buffer.from([byte]));
    await vi.advanceTimersByTimeAsync(20000);
    assertText('suggestions', await worker.pending, expected);
    worker.child.stdout.emit('data', Buffer.from('late bytes')); worker.child.emit('close', 0);
    expect(children).toHaveLength(1);
  });
});
