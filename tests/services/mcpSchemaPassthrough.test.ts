/**
 * Plan 20 Phase 5 — pass the REAL MCP inputSchema through, and defer the rest.
 *
 * The bug: `McpClient.listTools()` returns each server's `inputSchema` and the
 * coordinator threw it away, emitting `{additionalProperties:true, properties:{}}`
 * for every connected tool — so the model had to GUESS argument names, and each
 * wrong guess costs the user an approval card.
 *
 * The catch that shapes the fix: attaching all 60 real schemas would be a
 * regression, not a repair — roughly 12k tokens of definitions on every request,
 * on top of an accuracy cliff that published data puts at 30–50 tools. So the
 * most-used few are resident and the rest are retrievable with `findtool`.
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeMcpInputSchema,
  searchMcpTools,
  coordinatorToolSchemas,
  toolCallToDirective,
  MCP_RESIDENT_SCHEMA_COUNT,
  type McpToolInfo,
} from '../../src/services/coordinatorTools';
import {
  MystiTagScanner,
  MYSTI_MCP_KINDS,
  MYSTI_MCP_READONLY_KINDS,
  ALL_MYSTI_KINDS,
} from '../../src/utils/mystiDelegateParser';

const GMAIL_SCHEMA = {
  type: 'object',
  properties: {
    to: { type: 'string', description: 'recipient address' },
    subject: { type: 'string' },
    body: { type: 'string' },
    cc: { type: 'array', items: { type: 'string' } },
  },
  required: ['to', 'subject', 'body'],
};

describe('sanitizeMcpInputSchema', () => {
  it('preserves the parts the model needs to call correctly', () => {
    const clean = sanitizeMcpInputSchema(GMAIL_SCHEMA)!;
    expect(Object.keys(clean.properties as object).sort()).toEqual(['body', 'cc', 'subject', 'to']);
    expect(clean.required).toEqual(['to', 'subject', 'body']);
    expect((clean.properties as Record<string, { description?: string }>).to.description).toBe('recipient address');
    expect(((clean.properties as Record<string, { items?: unknown }>).cc.items as { type: string }).type).toBe('string');
  });

  it('drops keywords we would only be copying blindly', () => {
    const clean = sanitizeMcpInputSchema({
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/definitions/evil',
      allOf: [{ required: ['x'] }],
      anyOf: [{ type: 'string' }],
      properties: { a: { type: 'string' } },
    })!;
    expect(clean).not.toHaveProperty('$schema');
    expect(clean).not.toHaveProperty('$ref');
    expect(clean).not.toHaveProperty('allOf');
    expect(clean).not.toHaveProperty('anyOf');
    expect(clean.properties).toBeDefined();
  });

  it('strips control characters and bounds descriptions', () => {
    const clean = sanitizeMcpInputSchema({
      type: 'object',
      properties: { a: { type: 'string', description: `line1\nline2\tx${'y'.repeat(500)}` } },
    })!;
    const desc = (clean.properties as Record<string, { description: string }>).a.description;
    expect(desc).not.toMatch(/[\n\t]/);
    expect(desc.length).toBeLessThanOrEqual(200);
  });

  it('bounds width and depth so a hostile server cannot flood the prefix', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) { wide[`p${i}`] = { type: 'string' }; }
    const clean = sanitizeMcpInputSchema({ type: 'object', properties: wide })!;
    expect(Object.keys(clean.properties as object).length).toBeLessThanOrEqual(30);

    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 30; i++) { deep = { type: 'object', properties: { nested: deep } }; }
    expect(() => sanitizeMcpInputSchema(deep)).not.toThrow();
    expect(JSON.stringify(sanitizeMcpInputSchema(deep)).length).toBeLessThan(2000);
  });

  it('drops property names that are not identifier-shaped', () => {
    const clean = sanitizeMcpInputSchema({
      type: 'object',
      properties: { ok_name: { type: 'string' }, 'bad name!': { type: 'string' }, '../evil': { type: 'string' } },
    })!;
    expect(Object.keys(clean.properties as object)).toEqual(['ok_name']);
  });

  it('narrows `required` to properties that actually survived', () => {
    const clean = sanitizeMcpInputSchema({
      type: 'object',
      properties: { keep: { type: 'string' }, 'bad name!': { type: 'string' } },
      required: ['keep', 'bad name!'],
    })!;
    expect(clean.required).toEqual(['keep']);
  });

  it('preserves additionalProperties rather than forcing it false', () => {
    // Forcing `false` would over-constrain: we drop anyOf/oneOf, and some
    // providers enforce the flag in strict mode — that would break calls that
    // work today. The broker validates the real call; this schema is advisory.
    expect(sanitizeMcpInputSchema({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true })!.additionalProperties).toBe(true);
    expect(sanitizeMcpInputSchema({ type: 'object', properties: { a: { type: 'string' } } })!).not.toHaveProperty('additionalProperties');
  });

  it('returns null for input that carries nothing usable', () => {
    expect(sanitizeMcpInputSchema(null)).toBeNull();
    expect(sanitizeMcpInputSchema('a string')).toBeNull();
    expect(sanitizeMcpInputSchema([1, 2])).toBeNull();
    expect(sanitizeMcpInputSchema({ $ref: '#/x' })).toBeNull();
  });
});

describe('searchMcpTools', () => {
  const tools: McpToolInfo[] = [
    { name: 'gmail_send_email', description: 'Send an email message' },
    { name: 'slack_post_message', description: 'Post a message to a channel' },
    { name: 'notion_create_page', description: 'Create a page' },
    { name: 'jira_create_issue', description: 'Create an issue and email the reporter' },
  ];

  it('finds the right tool from a natural-language description', () => {
    expect(searchMcpTools(tools, 'send an email')[0].name).toBe('gmail_send_email');
    expect(searchMcpTools(tools, 'post to slack')[0].name).toBe('slack_post_message');
  });

  it('ranks a name hit above a description-only hit', () => {
    const ranked = searchMcpTools(tools, 'email');
    expect(ranked[0].name).toBe('gmail_send_email');   // name match
    expect(ranked.map(t => t.name)).toContain('jira_create_issue'); // description match, lower
    expect(ranked.indexOf(ranked.find(t => t.name === 'jira_create_issue')!)).toBeGreaterThan(0);
  });

  it('returns nothing rather than a wrong guess when nothing matches', () => {
    expect(searchMcpTools(tools, 'deploy to kubernetes')).toEqual([]);
  });

  it('does not let stop-words manufacture a match', () => {
    // Regression: "to" matched "Post a message TO a channel" and returned Slack
    // for a Kubernetes query. A wrong tool is worse than no tool — the model
    // acts on it and the user pays with an approval card.
    expect(searchMcpTools(tools, 'deploy to kubernetes')).toEqual([]);
    expect(searchMcpTools(tools, 'please use the thing for me')).toEqual([]);
    expect(searchMcpTools(tools, 'send an email')[0].name).toBe('gmail_send_email');
  });

  it('honors the limit and is stable for equal scores', () => {
    expect(searchMcpTools(tools, 'create', 1)).toHaveLength(1);
    expect(searchMcpTools(tools, 'create')[0].name).toBe('jira_create_issue');
  });
});

describe('coordinatorToolSchemas — tiered MCP schemas', () => {
  const many: McpToolInfo[] = Array.from({ length: 60 }, (_, i) => ({
    name: `tool_${i}`,
    description: `Does thing number ${i}`,
    inputSchema: { type: 'object', properties: { alpha: { type: 'string' }, beta: { type: 'string' } }, required: ['alpha'] },
  }));

  it('gives the most-used tools their real parameters', () => {
    const schemas = coordinatorToolSchemas(false, many);
    const first = schemas.find(s => s.function.name === 'mcp__tool_0')!;
    expect(Object.keys(first.function.parameters.properties as object)).toEqual(['alpha', 'beta']);
    expect(first.function.parameters.required).toEqual(['alpha']);
  });

  it('leaves the long tail open rather than dropping it — every tool stays callable', () => {
    const schemas = coordinatorToolSchemas(false, many);
    const cold = schemas.find(s => s.function.name === `mcp__tool_${MCP_RESIDENT_SCHEMA_COUNT}`)!;
    expect(cold).toBeDefined();
    expect(cold.function.parameters).toEqual({ type: 'object', additionalProperties: true, properties: {} });
    // All 60 are present: a model handed a tools array prefers it over the text
    // protocol, so omitting the cold ones would make them effectively uncallable.
    expect(schemas.filter(s => s.function.name.startsWith('mcp__'))).toHaveLength(60);
  });

  it('keeps the definition budget near the old baseline instead of ~12k tokens', () => {
    const before = JSON.stringify(coordinatorToolSchemas(false, many.map(t => ({ ...t, inputSchema: undefined })))).length;
    const after = JSON.stringify(coordinatorToolSchemas(false, many)).length;
    const allResident = JSON.stringify(
      coordinatorToolSchemas(false, many).map(s => ({ ...s, function: { ...s.function, parameters: many[0].inputSchema } }))
    ).length;
    expect(after).toBeGreaterThan(before);              // real schemas did land...
    expect(after - before).toBeLessThan(allResident * 0.2); // ...but only for a few
  });

  it('offers findtool only when there are connected tools to search', () => {
    expect(coordinatorToolSchemas(false, []).some(s => s.function.name === 'findtool')).toBe(false);
    expect(coordinatorToolSchemas(false, many).some(s => s.function.name === 'findtool')).toBe(true);
  });

  it('falls back to the open shape when a server publishes no schema', () => {
    const schemas = coordinatorToolSchemas(false, [{ name: 'bare', description: 'no schema' }]);
    expect(schemas.find(s => s.function.name === 'mcp__bare')!.function.parameters)
      .toEqual({ type: 'object', additionalProperties: true, properties: {} });
  });
});

describe('findtool directive', () => {
  const N = 'abc12345';
  const KINDS = [...ALL_MYSTI_KINDS, ...MYSTI_MCP_KINDS];

  function scan(input: string, nonce = N) {
    const s = new MystiTagScanner(nonce, KINDS);
    const fed = s.feed(input);
    const flushed = s.flush();
    return fed.directive || flushed.directive || null;
  }

  it('parses the text form', () => {
    expect(scan(`<findtool:${N}>send an email</findtool>`)).toEqual({ kind: 'findtool', query: 'send an email' });
  });

  it('ignores an empty query', () => {
    expect(scan(`<findtool:${N}></findtool>`)).toBeNull();
  });

  it('ignores a tag carrying the wrong nonce', () => {
    expect(scan(`<findtool:deadbeef>send an email</findtool>`)).toBeNull();
  });

  it('maps the native tool_call onto the same directive', () => {
    expect(toolCallToDirective('findtool', { query: 'send an email' }))
      .toEqual({ kind: 'findtool', query: 'send an email' });
    expect(toolCallToDirective('findtool', {})).toEqual({ error: 'findtool: "query" is required.' });
  });

  it('is registered as the read-only member of the MCP kinds', () => {
    // It searches already-connected metadata and calls nothing — gating it would
    // only teach the model to skip it and guess.
    expect(MYSTI_MCP_KINDS).toContain('findtool');
    expect(MYSTI_MCP_READONLY_KINDS).toEqual(['findtool']);
    expect(MYSTI_MCP_KINDS).toContain('mcptool');
    expect(MYSTI_MCP_READONLY_KINDS).not.toContain('mcptool');
  });
});
