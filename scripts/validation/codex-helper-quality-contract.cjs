/* Owned literal examples and exact helper-input authorization. No editor/model launch. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const base = require('./codex-semantic-followup-contract.cjs');
const repo = path.resolve(__dirname, '../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const identity = file => ({ path: fs.realpathSync(file), sha256: sha(fs.readFileSync(file)) });
function buildCases(token) {
  assert(/^PB02_SERVICE_[a-f0-9]+$/.test(token));
  const examples = [
    { caseId: 'NONE', topic: 'cache explanation', expectedReply: 'Café مرحبا € 😀 are display labels. An in-memory cache stores recently computed values so later requests can reuse them. A cache entry expires after its configured lifetime. This explanation describes existing behavior and does not request a decision or propose implementation approaches.' },
    { caseId: 'PLANS', topic: 'two retry validation approaches', expectedReply: 'There are two implementation approaches for the Café مرحبا retry service.\n\nApproach 1: Keep validation local. Add finite-number and range checks directly inside boundedDelay, then cover invalid inputs and cap boundaries in its tests. Pros: the behavior stays easy to trace in one function. Cons: other retry functions would repeat the checks. Complexity: low.\n\nApproach 2: Extract shared validation. Create a validateRetryPolicy helper used by boundedDelay and jitter, then test the helper and both callers. Pros: shared rules stay consistent. Cons: the extra abstraction adds another function to inspect. Complexity: medium.' },
    { caseId: 'QUESTIONS', topic: 'missing report format preference', expectedReply: 'Before preparing an implementation for the Café مرحبا report, which storage format should I use?\n\nA. JSON — preserve structured fields for applications.\nB. CSV — make the report easy to open in a spreadsheet.\n\nPlease choose one format so I can tailor the implementation to your preference.' },
  ];
  return examples.map(example => ({ ...example, marker: `HELPER_${example.caseId}`,
    prompt: `PB02_REQUEST:HELPER_${example.caseId}\nOwned fixture ${token}. This is a synthetic ${example.topic} example. Return exactly the text between BEGIN_LITERAL and END_LITERAL, preserving Unicode and line breaks. Do not add an introduction, commentary, conclusion, code fences, or other text. Do not use any tools or access files, network, settings, or external services.\nBEGIN_LITERAL\n${example.expectedReply}\nEND_LITERAL` }));
}
function template(file, method, expression, replacement) {
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf(`private async ${method}(`); assert(start >= 0, `Known product prompt method: ${method}`);
  const assignment = source.indexOf('const prompt = `', start); assert(assignment > start);
  const begin = assignment + 'const prompt = `'.length, end = source.indexOf('`;', begin); assert(end > begin);
  const text = source.slice(begin, end); assert.equal(text.split(expression).length, 2, 'One expected interpolation only');
  assert(!text.replace(expression, '').includes('${'), 'No unapproved prompt interpolation');
  // The current templates contain ordinary newlines and no escaped template syntax.
  assert(!text.includes('\\'), 'Prompt escape changes need explicit review');
  return text.replace(expression, replacement);
}
function buildAllowlist(cases) {
  const suggestion = path.join(repo, 'src/managers/SuggestionManager.ts'), classifier = path.join(repo, 'src/managers/ResponseClassifier.ts');
  const entries = cases.flatMap(example => [
    ['title', template(suggestion, '_generateTitleWithClaude', '${userMessage.substring(0, 500)}', example.prompt.substring(0, 500))],
    ['classification', template(classifier, '_callClaude', '${content.substring(0, 3000)}', example.expectedReply.substring(0, 3000))],
    ['suggestion', template(suggestion, '_callClaude', '${responseContent.substring(0, 1000)}', example.expectedReply.substring(0, 1000))],
  ].map(([purpose, input]) => ({ caseId: example.caseId, purpose, inputSha256: sha(input), inputBytes: Buffer.byteLength(input) })));
  assert.equal(entries.length, 9); assert.equal(new Set(entries.map(entry => entry.inputSha256)).size, 9);
  return { maxOutputBytes: 32768, entries, templateIdentities: [identity(suggestion), identity(classifier)] };
}
function verifyCopiedFixture(fixture, panelIds = []) {
  assert(Array.isArray(panelIds)); assert.equal(new Set(panelIds).size, panelIds.length); assert(panelIds.length <= 3);
  const workspace = fixture.workspace; assert.equal(fs.realpathSync(workspace), workspace); assert.deepEqual(fixture.editableFiles, []);
  const rows = base.treeIdentities(workspace).filter(value => !value.path.startsWith(path.join(workspace, '.git') + path.sep));
  const hashes = Object.fromEntries(rows.map(value => [path.relative(workspace, value.path), value.sha256]));
  for (const [relative, expected] of Object.entries(fixture.files)) assert.equal(hashes[relative], expected.sha256, `Copied file changed: ${relative}`);
  const allowed = new Set(panelIds.map(id => { assert.equal(typeof id, 'string'); assert(id.length > 0); return `.mysti/compaction/${id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)}/history.jsonl`; }));
  assert.equal(allowed.size, panelIds.length, 'Panel history paths cannot collide');
  const extras = Object.keys(hashes).filter(relative => !fixture.files[relative]);
  assert(extras.every(relative => allowed.has(relative) || panelIds.length > 0 && relative === '.mysti/compaction/.gitignore'), 'Only the three exact owned panel histories may be added');
  const git = base.treeIdentities(path.join(workspace, '.git')).map(value => ({ relativePath: path.relative(path.join(workspace, '.git'), value.path), sha256: value.sha256 }));
  assert.deepEqual(git, fixture.base.gitIdentities, 'Copied Git bytes and index remain exact');
  return { hashes, productArtifacts: extras.map(relative => ({ relative, sha256: hashes[relative] })), indexUnchanged: true, canaryUnchanged: true, preservedNotes: true };
}
module.exports = { buildCases, buildAllowlist, verifyCopiedFixture, copyPreservedFixture: base.copyPreservedFixture,
  verifyPreservedBase: base.verifyPreservedBase, treeIdentities: base.treeIdentities };
