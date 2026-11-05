/* Full25 approval scope. All command bodies remain exact literals. */
'use strict';
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const stage = require('./codex-stage-oracle.cjs');
exports.exactCommand = stage.exactCommand;
exports.patchScope = (changes, workspace, purpose) => {
  if (purpose === 'fix' || purpose === 'deny') return stage.patchScope(changes, workspace, purpose);
  const target = purpose === 'revision' ? 'src/retry.cjs' : purpose === 'tests' ? 'test/retry.test.cjs' : null;
  if (!target || !Array.isArray(changes) || changes.length !== 1) return false;
  const change = changes[0];
  return typeof change.path === 'string' && path.resolve(workspace, change.path) === path.join(workspace, target)
    && change.kind?.type === 'update' && !change.kind.movePath && !change.kind.move_path
    && typeof change.diff === 'string' && change.diff.length > 0 && change.diff.length < 48000
    && !change.diff.split('\n').some(line => line.startsWith('-') && line.includes('Developer unstaged note:'))
    && (purpose !== 'tests' || !change.diff.split('\n').some(line => line.startsWith('-') && !line.startsWith('---')));
};

exports.readonlyOutcome = ({ tools, content, permissionRequests }) => {
  if (permissionRequests !== 0) throw new Error('Read Only generated an interactive approval');
  if (tools.some(value => !['fileChange', 'commandExecution'].includes(value.type))) throw new Error('Unexpected Read Only tool');
  const started = tools.filter(value => value.event === 'tool-start' && value.type === 'fileChange');
  const edits = tools.filter(value => value.event === 'tool-result' && value.type === 'fileChange');
  if (edits.some(value => !['failed', 'declined'].includes(value.status))) throw new Error('Read Only requires a failed native mutation result');
  if (started.some(value => !edits.some(result => result.itemIdHash === value.itemIdHash))) throw new Error('Native mutation has no result');
  if (edits.length) return 'PASS_NATIVE_TOOL_DENIAL';
  if (!/\b(?:did not|cannot|can.t|will not|won.t|refus\w*|declin\w*|unable)\b/i.test(content)
    || !/read.only|plan(?:ning)? mode|not (?:allowed|permitted) to (?:edit|write)/i.test(content)) throw new Error('No native denial or explicit model refusal');
  return 'PARTIAL_MODEL_REFUSAL_NO_NATIVE_WRITE_ATTEMPT';
};

// ConversationManager.ts PERSISTED_TOOL_STRING_CAP uses String.slice, hence
// the bound is 4096 UTF-16 code units, not bytes or Unicode code points.
exports.assertToolOutputProjection = ({ nativeResult, liveTool, persistedTool }) => {
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.equal(typeof liveTool?.id, 'string'); assert(liveTool.id.length > 0);
  assert.equal(persistedTool?.id, liveTool.id, 'Live and persisted tools must have the same item ID');
  assert.equal(nativeResult?.itemIdHash, hash(liveTool.id), 'Native result owns the exact live tool item');
  assert.equal(typeof liveTool.output, 'string', 'A full live output string is required');
  assert.equal(typeof persistedTool.output, 'string', 'A persisted output string is required');
  assert.equal(nativeResult.outputSha256, hash(liveTool.output), 'Full live tool output must match actual native result bytes');
  const outputTruncated = liveTool.output.length > 4096;
  assert.equal(persistedTool.output, liveTool.output.slice(0, 4096), 'Persisted output must be the exact documented UTF-16 prefix');
  if (outputTruncated) assert.equal(persistedTool.truncated, true, 'A bounded output must be explicitly marked truncated');
  return { itemId: liveTool.id, nativeOutputSha256: nativeResult.outputSha256,
    liveOutputLength: liveTool.output.length, persistedOutputLength: persistedTool.output.length,
    persistedOutputSha256: hash(persistedTool.output), outputTruncated,
    persistedTruncated: persistedTool.truncated === true };
};
