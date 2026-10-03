import { describe, it, expect, beforeEach } from 'vitest';
import { planExplicitMentions, resolveExplicitMentions } from '../../src/services/ExplicitMentionPlan';
import { runExplicitMentions } from '../../src/managers/ExplicitMentionRunner';
import { CollaborationManager } from '../../src/managers/CollaborationManager';
import { CollaboratorPool } from '../../src/services/CollaboratorPool';
import { MockProviderManager } from '../helpers/mockProviderManager';
import { collabSettings } from '../helpers/collaboratorFactory';
import { clearMockConfig } from '../helpers/mockVscode';
import { parseAgentRoleMentions } from '../../src/utils/mentionParser';
import type { Mention, StreamChunk } from '../../src/types';

const ids: Record<string, string> = { claude: 'claude-code', codex: 'openai-codex', gemini: 'google-gemini', mysti: 'mysti' };
const mentions = (text: string): Mention[] => parseAgentRoleMentions(text).map(m => ({
  type: 'agent', value: ids[m.name] || m.name, displayName: m.raw,
  startIndex: m.startIndex, endIndex: m.endIndex, role: m.role,
}));
const plan = (text: string) => planExplicitMentions(text, mentions(text));
const textStream = async function* (text: string): AsyncGenerator<StreamChunk> {
  yield { type: 'text', content: text }; yield { type: 'done' };
};
const roleContext = { buildRoleContext: async (id: string) => ({
  name: id, prompt: `Role ${id}`, access: id === 'coworker' ? 'gated-write' : 'read-only', trusted: true,
}) } as any;

beforeEach(() => clearMockConfig());

describe('explicit assignment planning', () => {
  it('resolves tags without a loaded webview catalog and ignores code/email examples', () => {
    const resolved = resolveExplicitMentions('@claude-code @codex:reviewer opinions? `@gemini` user@claude \n```text\n@qwen\n```');
    expect(resolved.map(m => m.value)).toEqual(['claude-code', 'openai-codex']);
    expect(resolved[1].role).toBe('reviewer');
  });
  it.each([
    '@claude @codex What are your opinions on this design?',
    'Ask @claude and @codex for their opinions on this design',
    '@mysti ask @claude and @codex for opinions on this design',
  ])('keeps both named agents on one independent frontier: %s', text => {
    const phases = plan(text);
    expect(phases).toHaveLength(1);
    expect(phases[0].assignments.map(a => a.agentId)).toEqual(['claude-code', 'openai-codex']);
    expect(phases[0].assignments.every(a => a.advisory)).toBe(true);
  });
  it('a question addressed to an agent stays assigned to it', () => {
    expect(plan('@claude How does this work?')[0].assignments[0].agentId).toBe('claude-code');
  });
  it('preserves explicit dependencies and separate task descriptions', () => {
    const phases = plan('@claude Write the parser, then @codex review it');
    expect(phases).toHaveLength(2);
    expect(phases[0].assignments[0].brief).toBe('Write the parser');
    expect(phases[1].dependsOnPrevious).toBe(true);
    expect(phases[1].assignments[0].brief).toBe('review it');
  });
  it('deduplicates a shared alias without removing a later dependent assignment', () => {
    expect(plan('@claude @claude opinions?')[0].assignments).toHaveLength(1);
    expect(plan('@claude explain it, then @claude review it')).toHaveLength(2);
  });
  it('keeps independent agent-specific review requests separate within one frontier', () => {
    const phases = plan('@claude review security; @codex assess performance');
    expect(phases).toHaveLength(1);
    expect(phases[0].assignments.map(a => a.brief)).toEqual(['review security', 'assess performance']);
  });
});

describe('explicit assignment execution through the real bounded pool', () => {
  function harness() {
    const pm = new MockProviderManager();
    for (const id of ['claude-code', 'openai-codex']) { pm.setProviderAvailable(id); }
    const manager = new CollaborationManager(new CollaboratorPool(pm as any), roleContext);
    const events: any[] = [];
    const input = { settings: collabSettings({ provider: 'openai-codex' }), context: [], panelId: 'p' };
    return { pm, manager, events, input, run: (text: string) => runExplicitMentions(manager, plan(text), input, m => events.push(m)) };
  }
  it('starts Claude and Codex before either finishes, even when Codex is selected', async () => {
    const h = harness();
    let release!: () => void;
    const barrier = new Promise<void>(r => { release = r; });
    const started: string[] = [];
    for (const id of ['claude-code', 'openai-codex']) {
      h.pm.streamFactories.set(id, (_id, prompt) => (async function* () {
        started.push(id);
        if (started.length === 2) { release(); }
        await barrier;
        expect(prompt).not.toContain('opinion from the other provider');
        yield* textStream(`Opinion from ${id}`);
      })());
    }
    const result = await h.run('@claude @codex What are your opinions?');
    expect(started).toEqual(['claude-code', 'openai-codex']);
    expect(h.pm.sendCalls).toHaveLength(2); // no planner, selected-agent substitution or extra synthesis
    expect(result).toContain('Opinion from claude-code'); expect(result).toContain('Opinion from openai-codex');
    expect(h.events.filter(e => e.payload.type === 'collab_started')).toHaveLength(2);
  });
  it('serializes writers, including gated-write roles, while preserving both assignments', async () => {
    for (const prompt of ['@claude @codex implement the feature', '@claude:coworker @codex:coworker implement it']) {
      const h = harness(); let active = 0; let peak = 0;
      for (const id of ['claude-code', 'openai-codex']) {
        h.pm.streamFactories.set(id, () => (async function* () {
          active++; peak = Math.max(peak, active);
          await new Promise(r => setTimeout(r, 5)); active--;
          yield* textStream('done');
        })());
      }
      await h.run(prompt);
      expect(peak).toBe(1); expect(h.pm.sendCalls).toHaveLength(2);
    }
  });
  it('passes completed output only into dependent assignments, fenced as untrusted', async () => {
    const h = harness();
    h.pm.streamFactories.set('claude-code', () => textStream('PARSER_RESULT'));
    h.pm.streamFactories.set('openai-codex', (_id, prompt) => {
      expect(prompt).toContain('PARSER_RESULT'); expect(prompt).toContain('UNTRUSTED');
      return textStream('review done');
    });
    await h.run('@claude write the parser, then @codex review it');
    expect(h.pm.sendCalls.map(c => c.providerId)).toEqual(['claude-code', 'openai-codex']);
  });
  it('reports an unavailable participant without substituting or running its dependent task', async () => {
    const h = harness(); h.pm.setProviderNotInstalled('claude-code');
    const result = await h.run('@claude write it, then @codex review it');
    expect(h.pm.sendCalls).toHaveLength(0);
    expect(result).toContain('No opinion was substituted');
    expect(result).toContain('preceding assignment');
  });
  it('retains another participant’s successful result on partial failure', async () => {
    const h = harness(); h.pm.setProviderNotInstalled('claude-code');
    h.pm.streamFactories.set('openai-codex', () => textStream('Codex assessment'));
    const result = await h.run('@claude @codex opinions?');
    expect(result).toContain('Codex assessment'); expect(result).toContain('No opinion was substituted');
  });
  it('does not start an assignment when cancelled during role resolution', async () => {
    const h = harness();
    await runExplicitMentions(h.manager, plan('@claude:reviewer @codex:reviewer review it'), {
      ...h.input, isCancelled: () => true,
    }, m => h.events.push(m));
    expect(h.pm.sendCalls).toHaveLength(0); expect(h.events).toHaveLength(0);
  });
});
