/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
'use strict';

// Build with the Node version in .nvmrc, then run the bundle on Node 18.17.1,
// the embedded runtime in the minimum supported editor, VS Code 1.86.0.
// This exercises bundled runtime paths; real editor/UI coverage is separate.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DeskWorkspaceLookup } = require('../src/services/DeskWorkspaceLookup');
const { compile, compilePartial } = require('../src/canvas/doc/PageCompiler');
const { emit } = require('../src/canvas/doc/DocEmitter');
const { applyOp } = require('../src/canvas/doc/DocPatch');
const { walk, collectMids, isMid, findNode } = require('../src/canvas/doc/DocNode');
const { PAGE_SCAFFOLDS } = require('../src/managers/CanvasScaffolds');
const babelTypes = require('@babel/types');
const { parse } = require('@babel/parser');
const { SafeUrlSchema } = require('@modelcontextprotocol/sdk/shared/auth.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const report = { node: process.versions.node, electron: process.versions.electron, checks: [] };

function check(name, body) {
  body();
  report.checks.push(name);
}

function compileOk(source) {
  const result = compile(source);
  assert.equal(result.ok, true, result.error);
  return result.doc;
}

async function main() {
  // Fail closed if the CI execution step accidentally retains the build Node.
  assert.equal(process.versions.node, '18.17.1', 'Execute this bundle with the minimum editor runtime');

  const workspaceRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-minimum-desk-')));
  try {
    await fs.mkdir(path.join(workspaceRoot, '.mysti'));
    await fs.mkdir(path.join(workspaceRoot, 'src'));
    await fs.writeFile(path.join(workspaceRoot, '.mysti/desk-share.json'), '{"allow":["src"]}');
    await fs.writeFile(path.join(workspaceRoot, 'src/example.ts'), 'function MinimumDesk() {}');
    const reader = new DeskWorkspaceLookup({ root: workspaceRoot, ceiling: () => ['src'], active: () => true });
    const snapshot = await reader.prepare(['src'], () => true);
    assert.deepEqual(snapshot.index.lookup('MinimumDesk', 'symbol'), [{ path: 'src/example.ts', line: 1, symbol: 'MinimumDesk' }]);
    assert.equal(await snapshot.isCurrent(), true);
    await fs.writeFile(path.join(workspaceRoot, '.mysti/desk-share.json'), '{"allow":[]}');
    assert.equal(await snapshot.isCurrent(), false);
    report.checks.push('desk-workspace-descriptor-read-and-scope-invalidation');
  } finally { await fs.rm(workspaceRoot, { recursive: true, force: true }); }

  assert.ok(PAGE_SCAFFOLDS.length > 0, 'At least one shipped scaffold must be exercised');
  for (const scaffold of PAGE_SCAFFOLDS) {
    const doc = compileOk(scaffold.jsx);
    check(`scaffold:${scaffold.id}`, () => {
      const nodes = [...walk(doc)];
      assert.ok(nodes.length > 3);
      assert.equal(collectMids(doc).size, nodes.length);
      nodes.forEach(node => assert.ok(isMid(node.mid)));
    });
    check(`roundtrip:${scaffold.id}`, () => {
      assert.deepEqual(compileOk(emit(doc, { mids: true })), doc);
    });
  }

  const doc = compileOk(`export default function Page(): unknown {
    const header = <h1>Welcome back — مرحباً 👋</h1>;
    return <main style={{ padding: 24, opacity: 0.5 }} title="A &amp; B">
      {header}<input type="email" aria-label="Email" />
      <UI.Chart data={[{ label: "Jan", value: 22 }]} />
    </main>;
  }`);
  check('typed-jsx-unicode-entities', () => {
    assert.equal(doc.children[0].text, 'Welcome back — مرحباً 👋');
    assert.equal(doc.props.title, 'A & B');
    assert.deepEqual(doc.style, { padding: '24px', opacity: '0.5' });
    assert.deepEqual(doc.children[2].props.data, [{ label: 'Jan', value: 22 }]);
  });
  check('text-edit-emit-reparse-undo', () => {
    const mid = doc.children[0].mid;
    const patched = applyOp(doc, {
      op: 'el.setText', pageId: 'minimum', mid, text: 'Changed <safe> & שלום',
    });
    assert.equal(findNode(patched.doc, mid).text, 'Changed <safe> & שלום');
    assert.deepEqual(compileOk(emit(patched.doc, { mids: true })), patched.doc);
    assert.deepEqual(applyOp(patched.doc, patched.inverse).doc, doc);
  });
  check('style-edit-emit-reparse-undo', () => {
    const patched = applyOp(doc, {
      op: 'el.setStyle', pageId: 'minimum', mid: doc.mid,
      style: { padding: '32px', 'background-color': '#123456' },
    });
    assert.equal(patched.doc.style.padding, '32px');
    assert.deepEqual(compileOk(emit(patched.doc, { mids: true })), patched.doc);
    assert.deepEqual(applyOp(patched.doc, patched.inverse).doc, doc);
  });
  check('streaming-partial-prefix', () => {
    const result = compilePartial('function Page(){return (<main><h1>Streaming</h1><UI.Button label="incomplete');
    assert.equal(result.ok, true, result.error);
    assert.equal(result.doc.tag, 'main');
    assert.ok([...walk(result.doc)].some(node => node.text === 'Streaming'));
  });
  check('unsupported-runtime-expression-rejected', () => {
    const result = compile('function Page(){return <div>{items.map(x=><span>{x}</span>)}</div>}');
    assert.equal(result.ok, false);
    assert.match(result.error, /CallExpression|outside|subset/);
  });
  check('malformed-jsx-rejected', () => {
    assert.equal(compile('function Page(){ return <main><div></main>; }').ok, false);
  });

  // Mysti imports @babel/types only for types today. Exercise its runtime too,
  // so a future value import cannot silently bypass the minimum-runtime gate.
  check('babel-build-clone-validate', () => {
    const ast = parse('const value: string = "hello"', { sourceType: 'module', plugins: ['typescript'] });
    const clone = babelTypes.cloneNode(ast, true);
    assert.ok(babelTypes.isFile(clone));
    assert.ok(babelTypes.isIdentifier(clone.program.body[0].declarations[0].id));
    assert.ok(babelTypes.isStringLiteral(babelTypes.stringLiteral('سلام')));
  });
  check('mcp-safe-url-validation', () => {
    assert.equal(SafeUrlSchema.parse('https://example.com/mcp'), 'https://example.com/mcp');
    for (const value of ['javascript:alert(1)', 'data:text/html,test', 'vbscript:msgbox(1)', '%%%']) {
      assert.equal(SafeUrlSchema.safeParse(value).success, false);
    }
  });

  // Real SDK negotiation and tool RPC, with no sockets, accounts or model calls.
  const server = new Server({ name: 'minimum-test', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'echo', description: 'Local echo',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => ({
    content: [{ type: 'text', text: request.params.arguments.text }],
  }));
  const client = new Client({ name: 'minimum-client', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.equal((await client.listTools()).tools[0].name, 'echo');
    const result = await client.callTool({ name: 'echo', arguments: { text: 'minimum-runtime' } });
    assert.equal(result.content[0].text, 'minimum-runtime');
    report.checks.push('mcp-client-server-tool-roundtrip');
  } finally {
    await client.close();
    await server.close();
  }
  console.log(JSON.stringify(report, null, 2));
}

// A stalled protocol handshake must fail instead of leaving CI waiting forever.
const deadline = setTimeout(() => {
  console.error('Minimum-runtime fixture exceeded 30 seconds');
  process.exit(1);
}, 30_000);
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => clearTimeout(deadline));
