/**
 * Integration tests for ask_user_question flow across all providers.
 *
 * Verifies that each provider's parseStreamLine produces correctly structured
 * AskUserQuestionData when it encounters an ask-user tool call.
 * Tests the structure validation that ChatViewProvider depends on.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestableClaudeProvider, TestableCodexProvider, TestableGeminiProvider, TestableClineProvider, TestableCopilotProvider, TestableCursorProvider, TestableOpenClawProvider } from '../helpers/providerFactory';
import { createClaudeSession, createCodexSession, createGeminiSession, createClineSession, createCopilotSession, createCursorSession, createOpenClawSession } from '../helpers/sessionFactory';
import { clearMockConfig } from '../helpers/mockVscode';
import type { StreamChunk } from '../../src/types';

/**
 * Validate that an ask_user_question chunk has the correct structure
 * that ChatViewProvider expects (lines 2692-2758).
 */
function validateAskUserQuestionChunk(chunk: StreamChunk | null) {
  expect(chunk).not.toBeNull();
  expect(chunk!.type).toBe('ask_user_question');
  expect(chunk!.askUserQuestion).toBeDefined();

  const data = chunk!.askUserQuestion!;
  expect(typeof data.toolCallId).toBe('string');
  expect(data.toolCallId.length).toBeGreaterThan(0);
  expect(Array.isArray(data.questions)).toBe(true);
  expect(data.questions.length).toBeGreaterThan(0);

  for (const q of data.questions) {
    expect(typeof q.question).toBe('string');
    expect(typeof q.header).toBe('string');
    expect(Array.isArray(q.options)).toBe(true);
    expect(typeof q.multiSelect).toBe('boolean');

    for (const opt of q.options) {
      expect(typeof opt.label).toBe('string');
      expect(typeof opt.description).toBe('string');
    }
  }
}

describe('AskUserQuestion structure validation across providers', () => {
  beforeEach(() => {
    clearMockConfig();
  });

  describe('Claude Code', () => {
    it('should produce valid AskUserQuestionData from AskUserQuestion tool', () => {
      const provider = new TestableClaudeProvider();
      const session = createClaudeSession();

      // Start AskUserQuestion tool (suppressed — returns null)
      provider.parseStreamLine(JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_ask1', name: 'AskUserQuestion' },
        },
      }), session);

      // Send input JSON delta with questions
      provider.parseStreamLine(JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({
              questions: [{
                question: 'Which framework?',
                header: 'Framework Choice',
                options: [
                  { label: 'React', description: 'Component-based UI' },
                  { label: 'Vue', description: 'Progressive framework' },
                ],
                multiSelect: false,
              }],
            }),
          },
        },
      }), session);

      // Stop block → emits ask_user_question
      const result = provider.parseStreamLine(JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 1 },
      }), session);

      validateAskUserQuestionChunk(result);
      expect(result!.askUserQuestion!.questions[0].options).toHaveLength(2);
      expect(result!.askUserQuestion!.questions[0].options[0].label).toBe('React');
    });
  });

  // Qwen Code does NOT have explicit AskUserQuestion detection.
  // It treats AskUserQuestion as a regular tool_use (same stream_event protocol
  // as Claude but without the tool-name-based suppression/conversion).

  describe('Codex', () => {
    it('should produce valid AskUserQuestionData from mcp_tool_call', () => {
      const provider = new TestableCodexProvider();
      const session = createCodexSession();

      const result = provider.parseStreamLine(JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          id: 'ask_1',
          name: 'ask_user',
          arguments: {
            questions: [{
              question: 'Which DB?',
              header: 'Database',
              options: [{ label: 'PostgreSQL', description: 'Relational' }],
              multiSelect: false,
            }],
          },
        },
      }), session);

      validateAskUserQuestionChunk(result);
    });
  });

  describe('Gemini', () => {
    it('should produce valid AskUserQuestionData from tool_use event', () => {
      const provider = new TestableGeminiProvider();
      const session = createGeminiSession();

      const result = provider.parseStreamLine(JSON.stringify({
        type: 'tool_use',
        tool_id: 't_ask',
        tool_name: 'ask_user',
        parameters: {
          questions: [{
            question: 'Which approach?',
            header: 'Approach',
            options: [{ label: 'A', description: 'Option A' }],
            multiSelect: false,
          }],
        },
      }), session);

      validateAskUserQuestionChunk(result);
    });
  });

  describe('Cline', () => {
    it('should produce valid AskUserQuestionData from ask event', () => {
      const provider = new TestableClineProvider();
      const session = createClineSession();

      // Cline expects data.text to be a JSON string containing { question: "..." }
      const askData = JSON.stringify({
        question: 'Which testing framework do you prefer?',
        options: [{ label: 'Jest', description: 'Facebook' }, { label: 'Vitest', description: 'Vite' }],
      });

      const result = provider.parseStreamLine(JSON.stringify({
        type: 'ask',
        ask: 'followup',
        text: askData,
      }), session);

      validateAskUserQuestionChunk(result);
      expect(result!.askUserQuestion!.questions[0].question).toContain('testing framework');
      expect(session.askReceived).toBe(true);
    });
  });

  describe('Copilot', () => {
    it('should produce valid AskUserQuestionData from JSON tool event', () => {
      const provider = new TestableCopilotProvider();
      const session = createCopilotSession();

      const result = provider.parseStreamLine(JSON.stringify({
        type: 'tool_use',
        tool_id: 't_ask',
        tool_name: 'ask_user',
        parameters: {
          questions: [{
            question: 'Confirm?',
            header: 'Confirmation',
            options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
            multiSelect: false,
          }],
        },
      }), session);

      validateAskUserQuestionChunk(result);
    });
  });

  describe('Cursor', () => {
    it('should produce valid AskUserQuestionData from function tool call', () => {
      const provider = new TestableCursorProvider();
      const session = createCursorSession();

      // Cursor uses function key with JSON.stringify'd arguments
      const result = provider.parseStreamLine(JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'ask_1',
        tool_call: {
          function: {
            name: 'ask_user',
            arguments: JSON.stringify({
              questions: [{
                question: 'Which style?',
                header: 'Code Style',
                options: [{ label: 'Tabs', description: '' }, { label: 'Spaces', description: '' }],
                multiSelect: false,
              }],
            }),
          },
        },
      }), session);

      validateAskUserQuestionChunk(result);
      expect(result!.askUserQuestion!.toolCallId).toBe('ask_1');
    });
  });

  describe('OpenClaw', () => {
    it('should produce valid AskUserQuestionData from ask_user tool_call', () => {
      const provider = new TestableOpenClawProvider();
      const session = createOpenClawSession();

      const result = provider.parseStreamLine(JSON.stringify({
        type: 'tool_call',
        status: 'completed',
        name: 'ask_user',
        id: 'ask_1',
        input: {
          questions: [{
            question: 'License type?',
            header: 'License',
            options: [{ label: 'MIT', description: 'Permissive' }],
            multiSelect: false,
          }],
        },
      }), session);

      validateAskUserQuestionChunk(result);
    });
  });
});
