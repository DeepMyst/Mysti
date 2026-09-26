/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
import * as fs from 'fs';
import * as path from 'path';

export interface MermaidClient {
  initialize(options: Record<string, unknown>): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}

export interface MarkdownRenderer {
  renderMarkdown(value: unknown): string;
  renderDiagrams(scope?: Document | Element): Promise<void>;
  dispose(): void;
}

export interface MarkdownRendererPorts {
  document: Document;
  marked?: unknown;
  sanitize?: (html: string, options: Record<string, unknown>) => string;
  mermaidUri?: string;
  getMermaid(): MermaidClient | undefined;
  logger?: Pick<Console, 'warn' | 'error'>;
}

export function loadMarkdownRenderer(window: { eval(source: string): unknown }): {
  create(ports: MarkdownRendererPorts): MarkdownRenderer;
} {
  window.eval(fs.readFileSync(path.resolve(__dirname, '../../media/chat/markdownRenderer.js'), 'utf8'));
  return (window as unknown as { MystiMarkdownRenderer: { create(ports: MarkdownRendererPorts): MarkdownRenderer } }).MystiMarkdownRenderer;
}
