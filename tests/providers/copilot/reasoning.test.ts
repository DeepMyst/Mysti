import { beforeEach, describe, expect, it } from 'vitest';
import { TestableCopilotProvider } from '../../helpers/providerFactory';
import { createCopilotSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { StreamChunk } from '../../../src/types';

// Captured from `copilot --output-format json -p …` on 1.0.94 (Auto →
// mai-code-1.1-flash); the reasoning text is cut short, ids and shapes verbatim.
// The full `assistant.reasoning` arrives AFTER the answer and repeats the deltas.
const RID = '6f30d8eb-7f92-45bd-9966-5c7834983d8e';
const MID = '4713b7ab-36e6-4621-88c5-b919c3f0f702';
const captured = [
  `{"type":"assistant.reasoning_delta","data":{"reasoningId":"${RID}","deltaContent":"**Deciding formatting choices**\\n\\nI"},"ephemeral":true,"id":"7a46e691-bcef-4e30-8b7e-59b8ea2ce1bb","timestamp":"2026-11-07T22:02:06.779Z","parentId":"01e805a8-6679-4d18-a146-e45a9ea09cdf"}`,
  `{"type":"assistant.reasoning_delta","data":{"reasoningId":"${RID}","deltaContent":"’m"},"ephemeral":true,"id":"936230ce-a3d3-482e-9645-23af01d5be3c","timestamp":"2026-11-07T22:02:06.784Z","parentId":"01e805a8-6679-4d18-a146-e45a9ea09cdf"}`,
  `{"type":"assistant.reasoning_delta","data":{"reasoningId":"${RID}","deltaContent":" thinking"},"ephemeral":true,"id":"fbec3efa-4349-4fc3-8f81-f48e6dc18501","timestamp":"2026-11-07T22:02:06.789Z","parentId":"01e805a8-6679-4d18-a146-e45a9ea09cdf"}`,
  `{"type":"assistant.message_start","data":{"messageId":"${MID}","phase":"final_answer"},"ephemeral":true,"id":"07c17b8b-68ca-4aec-b64e-9d718da7f1a7","timestamp":"2026-11-07T22:02:07.399Z","parentId":"01e805a8-6679-4d18-a146-e45a9ea09cdf"}`,
  `{"type":"assistant.message_delta","data":{"messageId":"${MID}","deltaContent":"Tabs or spaces?"},"ephemeral":true,"id":"ab3b57d8-d557-4aba-a0a5-2dfee1744fad","timestamp":"2026-11-07T22:02:07.399Z","parentId":"01e805a8-6679-4d18-a146-e45a9ea09cdf"}`,
  `{"type":"assistant.message","data":{"messageId":"${MID}","model":"mai-code-1.1-flash","providerId":"copilot","content":"Tabs or spaces?","toolRequests":[],"reasoningText":"**Deciding formatting choices**\\n\\nI’m thinking"}}`,
  `{"type":"assistant.reasoning","data":{"reasoningId":"${RID}","content":"**Deciding formatting choices**\\n\\nI’m thinking","rte":true},"ephemeral":true,"id":"06676e5d-694d-4df3-b851-d15646a71eb6","timestamp":"2026-11-07T22:02:07.549Z","parentId":"3c6d314b-270f-4b31-8803-97ab5b20d61e"}`,
];

describe('Copilot 1.0 reasoning stream', () => {
  let provider: TestableCopilotProvider;
  beforeEach(() => { clearMockConfig(); provider = new TestableCopilotProvider(); });
  const parse = (lines: string[], session = createCopilotSession()) =>
    lines.map(line => provider.parseStreamLine(line, session)).filter((c): c is StreamChunk => c !== null);

  it('streams reasoning deltas as thinking and drops the repeated full reasoning', () => {
    const chunks = parse(captured);
    expect(chunks.filter(c => c.type === 'thinking').map(c => c.content).join(''))
      .toBe('**Deciding formatting choices**\n\nI’m thinking');
    expect(chunks.filter(c => c.type === 'text').map(c => c.content).join('')).toBe('Tabs or spaces?');
    expect(chunks.map(c => c.type)).toEqual(['thinking', 'thinking', 'thinking', 'text']);
  });

  it('renders the full reasoning when no deltas were streamed for it', () => {
    const chunks = parse([captured[5], captured[6]]);
    expect(chunks).toEqual([
      { type: 'text', content: 'Tabs or spaces?' },
      { type: 'thinking', content: '**Deciding formatting choices**\n\nI’m thinking' },
    ]);
  });

  it('keeps reasoning ids apart: a streamed block does not hide another full one', () => {
    const other = captured[6].replace(RID, 'other-reasoning').replace('I’m thinking', 'second block');
    const chunks = parse([captured[0], captured[6], other]);
    expect(chunks.map(c => c.content)).toEqual(['**Deciding formatting choices**\n\nI', '**Deciding formatting choices**\n\nsecond block']);
  });

  it('declares the streamed thinking it now emits', () => {
    expect(provider.capabilities.supportsThinking).toBe(true);
    expect(provider.capabilities.thinkingStyle).toBe('streamed');
  });
});
