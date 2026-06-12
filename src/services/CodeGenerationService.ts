/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  CANVAS_CODE_DEFAULT_FRAMEWORK,
  CANVAS_CODE_OUTPUT_DIR
} from '../constants';
import type {
  ComponentProp,
  GeneratedFile,
} from '../types';
import type { ImageGenerationService } from './ImageGenerationService';

type Framework = 'react' | 'vue' | 'html';

/**
 * Service for AI-powered code generation from SVG/images.
 * Handles framework detection, component + Storybook story generation,
 * property extraction, and workspace file writing.
 */
export class CodeGenerationService {

  // ========================================================================
  // Framework Detection
  // ========================================================================

  detectFramework(projectContext: string, workspaceRoot?: string): Framework {
    // Primary: read package.json directly
    if (workspaceRoot) {
      try {
        const pkgPath = path.join(workspaceRoot, 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (allDeps['react'] || allDeps['next'] || allDeps['gatsby'] || allDeps['react-dom']) {
            return 'react';
          }
          if (allDeps['vue'] || allDeps['nuxt']) {
            return 'vue';
          }
        }
      } catch { /* fall through */ }
    }

    // Fallback: parse project context string
    const lower = (projectContext || '').toLowerCase();
    if (lower.includes('react') || lower.includes('next') || lower.includes('jsx') || lower.includes('tsx')) {
      return 'react';
    }
    if (lower.includes('vue') || lower.includes('nuxt')) {
      return 'vue';
    }

    return CANVAS_CODE_DEFAULT_FRAMEWORK as Framework;
  }

  // ========================================================================
  // Component Name Derivation
  // ========================================================================

  deriveComponentName(label?: string, prompt?: string): string {
    const source = label || prompt || 'Component';
    // "Navigation Bar" → "NavigationBar", "hero-section" → "HeroSection"
    return source
      .replace(/[^a-zA-Z0-9\s-_]/g, '')
      .split(/[\s\-_]+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join('');
  }

  // ========================================================================
  // Code Generation
  // ========================================================================

  async *generateComponent(opts: {
    svgMarkup?: string;
    imageBase64?: string;
    componentName: string;
    framework: Framework;
    description?: string;
    metadata?: Record<string, string>;
    projectContext?: string;
    imageService: ImageGenerationService;
    designContext?: string;
  }): AsyncGenerator<{ type: string; content?: string; files?: GeneratedFile[]; props?: ComponentProp[] }> {
    yield { type: 'progress', content: `Generating ${opts.framework} component...` };

    const { framework, componentName } = opts;
    const hasTypeScript = this._detectTypeScript(opts.projectContext);
    const fileExt = this._getFileExt(framework, hasTypeScript);
    const storyExt = this._getStoryExt(framework, hasTypeScript);

    // Build the AI prompt
    const systemPrompt = this._buildCodeGenSystemPrompt(framework, hasTypeScript);
    const userPrompt = this._buildCodeGenUserPrompt(opts);

    let fullResponse = '';
    try {
      console.log(`[Mysti] CodeGen: Sending to vision API (imageSize=${(opts.imageBase64 || '').length}, svgSize=${(opts.svgMarkup || '').length})`);
      fullResponse = await opts.imageService.analyzeImage(
        opts.imageBase64 || '',
        systemPrompt + '\n\n' + userPrompt
      );
    } catch (err: any) {
      console.log(`[Mysti] CodeGen: Vision API error: ${err.message}`);
      yield { type: 'error', content: `Code generation failed: ${err.message}` };
      return;
    }

    console.log(`[Mysti] CodeGen: AI response length=${fullResponse.length}, first 500 chars: ${fullResponse.substring(0, 500)}`);

    // Parse the response — extract component code, story code, and props
    const parsed = this._parseCodeGenResponse(fullResponse, componentName, framework, fileExt, storyExt);
    console.log(`[Mysti] CodeGen: Parsed ${parsed.files.length} files, ${parsed.props.length} props`);

    yield { type: 'complete', files: parsed.files, props: parsed.props };
  }

  // ========================================================================
  // Regenerate with Modified Props
  // ========================================================================

  async *regenerateWithProps(opts: {
    svgMarkup: string;
    modifiedProps: ComponentProp[];
    framework: Framework;
    componentName: string;
    imageService: ImageGenerationService;
  }): AsyncGenerator<{ type: string; files?: GeneratedFile[]; content?: string }> {
    yield { type: 'progress', content: 'Updating component with new properties...' };

    const hasTypeScript = true; // Default to TS for regeneration
    const fileExt = this._getFileExt(opts.framework, hasTypeScript);
    const storyExt = this._getStoryExt(opts.framework, hasTypeScript);

    const propsDescription = opts.modifiedProps
      .map(p => `  ${p.name}: ${p.type} = ${JSON.stringify(p.value)}`)
      .join('\n');

    const prompt = `Regenerate the ${opts.framework} component "${opts.componentName}" with these updated property defaults:

${propsDescription}

Original SVG:
\`\`\`svg
${opts.svgMarkup}
\`\`\`

Return the updated component code and Storybook story in the same format as before.
Use \`\`\`component and \`\`\`story code fences.`;

    const systemPrompt = this._buildCodeGenSystemPrompt(opts.framework, hasTypeScript);

    let fullResponse = '';
    try {
      fullResponse = await opts.imageService.analyzeImage('', systemPrompt + '\n\n' + prompt);
    } catch (err: any) {
      yield { type: 'error', content: `Regeneration failed: ${err.message}` };
      return;
    }

    const parsed = this._parseCodeGenResponse(fullResponse, opts.componentName, opts.framework, fileExt, storyExt);
    yield { type: 'complete', files: parsed.files };
  }

  // ========================================================================
  // File Writing
  // ========================================================================

  async writeToWorkspace(files: GeneratedFile[], workspaceRoot: string): Promise<string[]> {
    const writtenPaths: string[] = [];

    for (const file of files) {
      const fullPath = path.join(workspaceRoot, file.filePath);
      const dir = path.dirname(fullPath);

      // Create directory if needed
      const dirUri = vscode.Uri.file(dir);
      try { await vscode.workspace.fs.createDirectory(dirUri); } catch { /* exists */ }

      // Write file
      const fileUri = vscode.Uri.file(fullPath);
      const content = Buffer.from(file.content, 'utf-8');
      await vscode.workspace.fs.writeFile(fileUri, content);
      writtenPaths.push(file.filePath);

      console.log(`[Mysti] Canvas: wrote ${file.filePath}`);
    }

    return writtenPaths;
  }

  async openInEditor(filePath: string, workspaceRoot: string): Promise<void> {
    const fullPath = path.join(workspaceRoot, filePath);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err) {
      console.log('[Mysti] Canvas: failed to open file in editor:', err);
    }
  }

  // ========================================================================
  // Private Helpers
  // ========================================================================

  private _detectTypeScript(projectContext?: string): boolean {
    // Check for tsconfig or TypeScript indicators in project context
    const lower = (projectContext || '').toLowerCase();
    return lower.includes('typescript') || lower.includes('tsconfig') || lower.includes('.tsx') || lower.includes('.ts');
  }

  private _getFileExt(framework: Framework, hasTypeScript: boolean): string {
    if (framework === 'vue') { return '.vue'; }
    if (framework === 'html') { return '.html'; }
    return hasTypeScript ? '.tsx' : '.jsx';
  }

  private _getStoryExt(framework: Framework, hasTypeScript: boolean): string {
    if (framework === 'html') { return '.stories.js'; }
    return hasTypeScript ? '.stories.tsx' : '.stories.jsx';
  }

  private _buildCodeGenSystemPrompt(framework: Framework, hasTypeScript: boolean): string {
    const lang = hasTypeScript ? 'TypeScript' : 'JavaScript';

    return `You are a senior frontend developer generating production-ready ${framework} components from SVG/image designs.

RULES:
1. Generate clean, idiomatic ${framework} component code in ${lang}.
2. Inline the SVG directly into the component (JSX for React, template for Vue, HTML for plain HTML).
3. Extract configurable values (colors, text, sizes, spacing) as component props with sensible defaults.
4. ${hasTypeScript && framework === 'react' ? 'Define a Props interface with JSDoc comments.' : ''}
5. ${framework === 'react' ? 'Use functional components with React.FC.' : ''}
6. ${framework === 'vue' ? 'Use Composition API with <script setup>.' : ''}
7. Generate a Storybook CSF3 story with argTypes mapped to each extractable prop.
8. Use semantic prop names (e.g., "primaryColor" not "fill0", "title" not "text1").
9. Group SVG elements logically. Use className/class for styling hooks.
10. Keep code clean and minimal — no unnecessary abstractions.

OUTPUT FORMAT:
Return exactly two code blocks:

\`\`\`component
// The component code here
\`\`\`

\`\`\`story
// The Storybook story here
\`\`\`

After the code blocks, return a JSON block with extracted props:

\`\`\`props
[
  { "id": "prop-1", "name": "primaryColor", "type": "color", "value": "#3B82F6", "category": "colors" },
  { "id": "prop-2", "name": "title", "type": "text", "value": "Hello World", "category": "content" }
]
\`\`\`

Prop types: color, text, number, enum, boolean
Prop categories: colors, typography, spacing, content, layout`;
  }

  private _buildCodeGenUserPrompt(opts: {
    svgMarkup?: string;
    imageBase64?: string;
    componentName: string;
    framework: Framework;
    description?: string;
    metadata?: Record<string, string>;
    projectContext?: string;
    designContext?: string;
  }): string {
    const parts: string[] = [];

    parts.push(`Generate a ${opts.framework} component named "${opts.componentName}".`);

    if (opts.description) {
      parts.push(`\nDescription: ${opts.description}`);
    }

    if (opts.metadata) {
      const metaParts = Object.entries(opts.metadata)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      if (metaParts) {
        parts.push(`Metadata: ${metaParts}`);
      }
    }

    if (opts.projectContext) {
      parts.push(`\nProject context:\n${opts.projectContext}`);
    }

    if (opts.designContext) {
      parts.push(`\n${opts.designContext}`);
      parts.push('IMPORTANT: Use the provided design system tokens (colors, typography, spacing) exactly as specified. Do not guess colors from the image — use the theme tokens.');
    }

    if (opts.svgMarkup) {
      parts.push(`\nSource SVG:\n\`\`\`svg\n${opts.svgMarkup}\n\`\`\``);
    } else if (opts.imageBase64) {
      parts.push('\nA reference image is attached. Analyze it and create a component that faithfully reproduces this design as SVG elements within the component.');
    }

    return parts.join('\n');
  }

  private _parseCodeGenResponse(
    response: string,
    componentName: string,
    framework: Framework,
    fileExt: string,
    storyExt: string
  ): { files: GeneratedFile[]; props: ComponentProp[] } {
    const files: GeneratedFile[] = [];
    const outputDir = `${CANVAS_CODE_OUTPUT_DIR}/${componentName}`;

    // Extract component code block
    const componentMatch = response.match(/```component\s*\n([\s\S]*?)```/);
    if (componentMatch) {
      files.push({
        filePath: `${outputDir}/${componentName}${fileExt}`,
        fileName: `${componentName}${fileExt}`,
        fileType: 'component',
        content: componentMatch[1].trim(),
      });
    }

    // Extract story code block
    const storyMatch = response.match(/```story\s*\n([\s\S]*?)```/);
    if (storyMatch) {
      files.push({
        filePath: `${outputDir}/${componentName}${storyExt}`,
        fileName: `${componentName}${storyExt}`,
        fileType: 'story',
        content: storyMatch[1].trim(),
      });
    }

    // Fallback: if no tagged blocks, try to extract from generic code blocks
    if (files.length === 0) {
      const codeBlocks = [...response.matchAll(/```(?:tsx?|jsx?|vue|html)\s*\n([\s\S]*?)```/g)];
      if (codeBlocks.length >= 1) {
        files.push({
          filePath: `${outputDir}/${componentName}${fileExt}`,
          fileName: `${componentName}${fileExt}`,
          fileType: 'component',
          content: codeBlocks[0][1].trim(),
        });
      }
      if (codeBlocks.length >= 2) {
        files.push({
          filePath: `${outputDir}/${componentName}${storyExt}`,
          fileName: `${componentName}${storyExt}`,
          fileType: 'story',
          content: codeBlocks[1][1].trim(),
        });
      }
    }

    // Extract props
    let props: ComponentProp[] = [];
    const propsMatch = response.match(/```props\s*\n([\s\S]*?)```/);
    if (propsMatch) {
      try {
        props = JSON.parse(propsMatch[1].trim());
      } catch { /* ignore parse errors */ }
    }

    return { files, props };
  }
}
