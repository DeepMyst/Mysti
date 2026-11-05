import * as fs from 'fs';
import * as path from 'path';
import type { ToolCall } from '../types';

/** Resolve existing write targets physically, including symlinked parents. */
export function resolveWorkspaceEditPath(file: string, workspaceRoots: readonly string[]): string {
  const resolved = fs.realpathSync(file);
  const insideWorkspace = workspaceRoots.some(root => {
    const relative = path.relative(fs.realpathSync(root), resolved);
    return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
  });
  if (!insideWorkspace) { throw new Error('This file is outside the current workspace.'); }
  if (!fs.statSync(resolved).isFile()) { throw new Error('The edit target is not a file.'); }
  return resolved;
}

/** Only invert an authenticated, complete replacement whose target is unambiguous. */
export function reverseToolEdit(content: string, tool: ToolCall): { start: number; end: number; replacement: string } {
  const input = tool.input;
  if (tool.historicalOnly || tool.proposalOnly || tool.status !== 'completed' || tool.truncated || tool.name.toLowerCase() !== 'edit'
    || !input || input.replace_all === true || typeof input.old_string !== 'string'
    || typeof input.new_string !== 'string' || input.new_string.length === 0) {
    throw new Error('This edit cannot be safely reverted automatically. Review the file and undo it manually.');
  }
  const before = input.old_string;
  const after = input.new_string;
  const start = content.indexOf(after);
  if (start < 0 || content.indexOf(after, start + 1) >= 0) {
    throw new Error('The edited text has changed or appears more than once. Review the file before reverting.');
  }
  // A replacement may occur inside the original; a second click must not
  // insert removed text again after a successful undo or editor reload.
  const originalStart = before.includes(after) ? content.lastIndexOf(before, start) : -1;
  if (before === after || (originalStart >= 0 && originalStart + before.length >= start + after.length)) {
    throw new Error('This edit has already been reverted or no longer has a unique inverse.');
  }
  return { start, end: start + after.length, replacement: before };
}
