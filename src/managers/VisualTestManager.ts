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
import { DevServerManager } from './DevServerManager';
import { BrowserManager } from '../services/BrowserManager';
import { ScreenshotService } from '../services/ScreenshotService';
import { BrowserInteractionService } from '../services/BrowserInteractionService';
import {
  VISUAL_TEST_HOT_RELOAD_WAIT_MS,
  VISUAL_TEST_ITERATION_TIMEOUT_MS,
  VISUAL_TEST_TOTAL_TIMEOUT_MS
} from '../constants';
import type {
  VisualTestConfig,
  VisualTestReport,
  VisualTestStreamChunk,
  VisualTestIssue,
  VisualTestIteration,
  VisualTestInteraction,
  VisualTestStatus,
  Settings,
  Attachment,
  StreamChunk,
  ToolCall
} from '../types';

// ProviderManager type — avoid circular import
interface ProviderManagerLike {
  sendMessage(
    content: string,
    context: any[],
    settings: Settings,
    conversation: any,
    persona?: any,
    panelId?: string,
    agentConfig?: any,
    attachments?: Attachment[]
  ): AsyncGenerator<StreamChunk>;
  getProviderInstance(providerType: string): { capabilities: { supportsImages?: boolean } } | null | undefined;
}

/**
 * Orchestrates the visual testing loop:
 * run → screenshot → AI analyze → fix → verify (bounded iterations).
 */
export class VisualTestManager {
  private _devServer: DevServerManager;
  private _browser: BrowserManager;
  private _screenshot: ScreenshotService;
  private _interaction: BrowserInteractionService;
  private _activeTests: Map<string, VisualTestReport> = new Map();
  private _cancelled: Set<string> = new Set();
  private _context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
    this._devServer = new DevServerManager();
    this._browser = new BrowserManager();
    this._screenshot = new ScreenshotService();
    this._interaction = new BrowserInteractionService();
  }

  /**
   * Start a visual test session.
   * Yields VisualTestStreamChunk events for the webview to display.
   */
  async *startVisualTest(
    panelId: string,
    config: VisualTestConfig,
    providerManager: ProviderManagerLike,
    settings: Settings
  ): AsyncGenerator<VisualTestStreamChunk> {
    this._cancelled.delete(panelId);

    const report: VisualTestReport = {
      id: `vt-${Date.now()}`,
      status: 'idle',
      config,
      iterations: [],
      summary: {
        totalIssuesFound: 0,
        totalIssuesFixed: 0,
        totalIterations: 0,
        maxIterations: config.maxIterations,
        totalDuration: 0,
        passRate: 0,
        verdict: 'fail'
      },
      startedAt: Date.now()
    };

    this._activeTests.set(panelId, report);

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const screenshotDir = path.join(workspaceRoot, '.mysti', 'visual-test', panelId);

    try {
      // ── Step 1: Start dev server if configured ──
      if (config.devServerCommand) {
        report.status = 'starting-server';
        yield { type: 'visual_test_started', status: 'starting-server', message: `Starting dev server: ${config.devServerCommand}` };

        try {
          const readyPattern = vscode.workspace.getConfiguration('mysti').get<string>(
            'visualTest.serverReadyPattern',
            'localhost:\\d+|ready in|compiled successfully|VITE|started server on'
          );
          const { url } = await this._devServer.start(panelId, config.devServerCommand, workspaceRoot, readyPattern);
          // Override URL if server reported a different one
          if (url && url !== config.url) {
            console.log(`[Mysti] Dev server ready at ${url} (overriding configured ${config.url})`);
            config.url = url;
          }
        } catch (err: any) {
          yield { type: 'visual_test_error', status: 'failed', message: `Dev server failed: ${err.message}` };
          report.status = 'failed';
          return;
        }
      }

      yield { type: 'visual_test_started', status: 'capturing', message: `Launching ${config.browser} browser...` };

      // ── Step 2: Launch browser ──
      try {
        await this._browser.launch(panelId, config);
      } catch (err: any) {
        yield { type: 'visual_test_error', status: 'failed', message: `Browser launch failed: ${err.message}` };
        report.status = 'failed';
        return;
      }

      const page = this._browser.getPage(panelId)!;
      const totalStart = Date.now();

      // ── Step 3: Iteration loop ──
      for (let i = 1; i <= config.maxIterations; i++) {
        if (this._cancelled.has(panelId)) {
          report.status = 'cancelled';
          yield { type: 'visual_test_complete', status: 'cancelled', message: 'Visual test cancelled', report };
          return;
        }

        if (Date.now() - totalStart > VISUAL_TEST_TOTAL_TIMEOUT_MS) {
          yield { type: 'visual_test_error', status: 'failed', message: 'Total test timeout exceeded' };
          report.status = 'failed';
          break;
        }

        report.status = 'capturing';
        const iterStart = Date.now();

        // 3a. Capture screenshot + DOM snapshot
        const screenshot = await this._screenshot.capture(page, {
          mode: config.screenshotMode,
          elementSelector: config.elementSelector,
          iteration: i,
          label: `iteration-${i}`,
          outputDir: screenshotDir
        });

        yield { type: 'visual_test_screenshot', screenshot, status: 'capturing' };

        const domSnapshot = await this._screenshot.getDomSnapshot(page);

        // 3b. Build prompt
        report.status = 'analyzing';
        const prompt = this._buildAnalysisPrompt(config, i, domSnapshot, report);

        // 3c. Create image attachment from screenshot (only if provider supports images)
        const provider = providerManager.getProviderInstance(settings.provider);
        const supportsImages = provider?.capabilities?.supportsImages ?? false;

        const attachment: Attachment = {
          id: screenshot.id,
          type: 'image',
          fileName: `screenshot-iter${i}.png`,
          mimeType: 'image/png',
          base64Data: screenshot.base64Data,
          size: screenshot.base64Data ? Buffer.from(screenshot.base64Data, 'base64').length : 0
        };
        const attachments: Attachment[] = supportsImages ? [attachment] : [];

        // For non-image providers, append a note to the prompt
        const imageNote = supportsImages
          ? ''
          : '\n\nNote: No screenshot image is attached (provider does not support images). Analyze based on the DOM snapshot only.\n';
        const fullPrompt = prompt + imageNote;

        // 3d. Send to AI provider
        let aiResponse = '';
        const fixesApplied: string[] = [];
        const iterationTimeout = setTimeout(() => {
          console.log(`[Mysti] Visual test iteration ${i} timeout`);
        }, VISUAL_TEST_ITERATION_TIMEOUT_MS);

        try {
          const stream = providerManager.sendMessage(
            fullPrompt,
            [], // no context items
            settings,
            null, // no conversation
            undefined, // no persona
            `${panelId}-visual-test`, // dedicated panel ID
            undefined, // no agent config
            attachments
          );

          for await (const chunk of stream) {
            if (this._cancelled.has(panelId)) { break; }
            if (chunk.type === 'text' && chunk.content) {
              aiResponse += chunk.content;
            }
            // Detailed tool_use/tool_result feedback
            if (chunk.type === 'tool_use' && chunk.toolCall) {
              const description = this._describeToolAction(chunk.toolCall);
              fixesApplied.push(description);
              yield {
                type: 'visual_test_fix',
                message: description,
                status: 'fixing',
                toolDetail: {
                  toolName: chunk.toolCall.name,
                  filePath: chunk.toolCall.fileChange?.filePath || (chunk.toolCall.input?.file_path as string),
                  action: chunk.toolCall.fileChange?.action,
                  description,
                  linesAdded: chunk.toolCall.fileChange?.linesAdded,
                  linesRemoved: chunk.toolCall.fileChange?.linesRemoved,
                  command: chunk.toolCall.input?.command as string | undefined,
                }
              };
            } else if (chunk.type === 'tool_result' && chunk.toolCall) {
              const description = `Completed: ${chunk.toolCall.name}${chunk.toolCall.fileChange?.fileName ? ` on ${chunk.toolCall.fileChange.fileName}` : ''}`;
              yield {
                type: 'visual_test_fix',
                message: description,
                status: 'fixing',
                toolDetail: { toolName: chunk.toolCall.name, description }
              };
            }
          }
        } finally {
          clearTimeout(iterationTimeout);
        }

        // 3e. Parse AI response for issues, interactions, and verdict
        const { issues, interactions, verdict } = this._parseAiResponse(aiResponse, screenshot.id, i);

        // 3f. Execute browser interactions if enabled
        const executedInteractions: VisualTestInteraction[] = [];
        if (config.interactionsEnabled && interactions.length > 0) {
          for (const interaction of interactions) {
            try {
              yield { type: 'visual_test_interaction', interaction, status: 'verifying' };
              await this._interaction.execute(page, interaction);
              executedInteractions.push({ ...interaction, timestamp: Date.now() });
            } catch (err: any) {
              console.log(`[Mysti] Interaction failed: ${err.message}`);
              yield {
                type: 'visual_test_error',
                message: `Interaction failed: ${interaction.action} on ${interaction.target || ''}: ${err.message}`,
                status: 'analyzing'
              };
            }
          }
        }

        // 3g. Wait for hot-reload if code fixes were applied
        if (aiResponse.includes('tool_use') || aiResponse.includes('"action"')) {
          report.status = 'verifying';
          await new Promise(resolve => setTimeout(resolve, VISUAL_TEST_HOT_RELOAD_WAIT_MS));
        }

        // 3h. Build iteration record
        const iteration: VisualTestIteration = {
          number: i,
          screenshot,
          issues,
          fixesApplied,
          interactions: executedInteractions,
          duration: Date.now() - iterStart
        };
        report.iterations.push(iteration);
        report.summary.totalIterations = i;
        report.summary.totalIssuesFound += issues.length;
        report.summary.totalIssuesFixed += issues.filter(iss => iss.status === 'fixed').length;

        yield { type: 'visual_test_iteration', iteration, status: 'analyzing' };

        // Yield individual issues
        for (const issue of issues) {
          yield { type: 'visual_test_issue', issue, status: 'analyzing' };
        }

        // 3i. Check verdict
        if (verdict === 'pass') {
          report.status = 'complete';
          report.summary.verdict = 'pass';
          report.summary.passRate = 1;
          break;
        }

        // If last iteration and not passed
        if (i === config.maxIterations) {
          const totalIssues = report.summary.totalIssuesFound;
          const fixedIssues = report.summary.totalIssuesFixed;
          report.summary.passRate = totalIssues > 0 ? fixedIssues / totalIssues : 0;
          report.summary.verdict = report.summary.passRate >= 0.8 ? 'partial' : 'fail';
        }
      }

      // ── Step 4: Finalize report ──
      report.completedAt = Date.now();
      report.summary.totalDuration = report.completedAt - report.startedAt;
      if (report.status !== 'complete' && report.status !== 'cancelled') {
        report.status = report.summary.verdict === 'fail' ? 'failed' : 'complete';
      }

      yield { type: 'visual_test_complete', report, status: report.status };

    } finally {
      // Cleanup
      await this._browser.close(panelId);
      // Don't auto-stop dev server — user may want it running
    }
  }

  /**
   * Build the AI analysis prompt for an iteration.
   */
  private _buildAnalysisPrompt(
    config: VisualTestConfig,
    iteration: number,
    domSnapshot: string,
    report: VisualTestReport
  ): string {
    const previousIssues = report.iterations
      .flatMap(iter => iter.issues)
      .map(i => `- [${i.severity}] ${i.description} (${i.status})`)
      .join('\n') || 'None';

    const previousFixes = report.iterations
      .flatMap(iter => iter.fixesApplied)
      .join('\n') || 'None';

    const actionsSection = config.interactionsEnabled
      ? `\n## Available Browser Actions\n${this._interaction.getAvailableActions()}\n`
      : '';

    return `You are testing a web application. Analyze the screenshot and DOM snapshot.

## Requirements
${config.requirements}

## Current State
- URL: ${config.url}
- Iteration: ${iteration} of ${config.maxIterations}
- Previous issues:
${previousIssues}
- Previous fixes:
${previousFixes}

## DOM Snapshot
\`\`\`html
${domSnapshot}
\`\`\`
${actionsSection}
## Instructions
1. Analyze the screenshot for visual bugs, missing features, or UX issues relative to the requirements
2. Report issues as a JSON block: \`\`\`issues\n[{"description": "...", "severity": "critical|major|minor|cosmetic", "location": "CSS selector or description"}]\n\`\`\`
3. If code fixes are needed, use your file editing tools to make the changes
4. If browser interactions are needed (click, type, navigate, etc.), request them as: \`\`\`interactions\n[{"action": "click|type|navigate|scroll|hover|select", "target": "CSS selector", "value": "optional value"}]\n\`\`\`
5. If ALL requirements are satisfied and the app looks correct, respond with: \`\`\`verdict\npass\n\`\`\`

Be specific about what you see in the screenshot versus what the requirements ask for.`;
  }

  /**
   * Parse AI response for structured data (issues, interactions, verdict).
   */
  private _parseAiResponse(
    response: string,
    screenshotId: string,
    iteration: number
  ): {
    issues: VisualTestIssue[];
    interactions: VisualTestInteraction[];
    verdict: 'pass' | 'fail';
  } {
    const issues: VisualTestIssue[] = [];
    const interactions: VisualTestInteraction[] = [];
    let verdict: 'pass' | 'fail' = 'fail';

    // Parse issues block
    const issuesMatch = response.match(/```issues\s*\n([\s\S]*?)```/);
    if (issuesMatch) {
      try {
        const parsed = JSON.parse(issuesMatch[1]);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            issues.push({
              id: `issue-${iteration}-${issues.length + 1}`,
              description: item.description || 'Unknown issue',
              severity: item.severity || 'minor',
              location: item.location,
              screenshotId,
              status: 'open'
            });
          }
        }
      } catch {
        console.log('[Mysti] Failed to parse issues JSON from AI response');
      }
    }

    // Parse interactions block
    const interactionsMatch = response.match(/```interactions\s*\n([\s\S]*?)```/);
    if (interactionsMatch) {
      try {
        const parsed = JSON.parse(interactionsMatch[1]);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            interactions.push({
              action: item.action,
              target: item.target,
              value: item.value,
              timestamp: Date.now()
            });
          }
        }
      } catch {
        console.log('[Mysti] Failed to parse interactions JSON from AI response');
      }
    }

    // Parse verdict
    const verdictMatch = response.match(/```verdict\s*\n\s*pass\s*\n?```/);
    if (verdictMatch) {
      verdict = 'pass';
    }

    return { issues, interactions, verdict };
  }

  /**
   * Generate a human-readable description from a ToolCall.
   */
  private _describeToolAction(toolCall: ToolCall): string {
    const name = toolCall.name || 'unknown';
    const filePath = toolCall.fileChange?.filePath || (toolCall.input?.file_path as string) || '';
    const fileName = toolCall.fileChange?.fileName || (filePath ? path.basename(filePath) : '');

    switch (name.toLowerCase()) {
      case 'write':
        return fileName ? `Creating ${fileName}` : `Creating file`;
      case 'edit': {
        let desc = fileName ? `Editing ${fileName}` : `Editing file`;
        if (toolCall.fileChange) {
          const added = toolCall.fileChange.linesAdded || 0;
          const removed = toolCall.fileChange.linesRemoved || 0;
          if (added || removed) { desc += ` (+${added}/-${removed})`; }
        }
        return desc;
      }
      case 'bash': {
        const cmd = (toolCall.input?.command as string) || '';
        const truncated = cmd.length > 100 ? cmd.slice(0, 97) + '...' : cmd;
        return `Running: ${truncated}`;
      }
      case 'read':
        return fileName ? `Reading ${fileName}` : `Reading file`;
      default: {
        const inputSummary = JSON.stringify(toolCall.input || {}).slice(0, 80);
        return `${name}: ${inputSummary}`;
      }
    }
  }

  /**
   * Build a concise markdown summary of a visual test report for injecting into chat context.
   */
  buildAgentFeedbackSummary(report: VisualTestReport): string {
    const s = report.summary;
    const verdictLabel = s.verdict === 'pass' ? 'PASS' : s.verdict === 'partial' ? 'PARTIAL' : 'FAIL';
    const duration = s.totalDuration ? `${Math.round(s.totalDuration / 1000)}s` : 'N/A';

    const openIssues = report.iterations
      .flatMap(iter => iter.issues)
      .filter(issue => issue.status === 'open')
      .map(issue => `  - [${issue.severity}] ${issue.description}`)
      .join('\n') || '  None';

    const allFixes = report.iterations
      .flatMap(iter => iter.fixesApplied)
      .filter(Boolean);
    const fixesSummary = allFixes.length > 0
      ? allFixes.map(f => `  - ${f}`).join('\n')
      : '  None';

    return `## Visual Test Results
- **Verdict**: ${verdictLabel}
- **Iterations**: ${s.totalIterations}/${s.maxIterations}
- **Issues**: ${s.totalIssuesFound} found, ${s.totalIssuesFixed} fixed
- **Duration**: ${duration}
- **Open Issues**:
${openIssues}
- **Actions Taken**:
${fixesSummary}`;
  }

  /**
   * Cancel an active visual test.
   */
  cancelTest(panelId: string): void {
    this._cancelled.add(panelId);
    const report = this._activeTests.get(panelId);
    if (report) {
      report.status = 'cancelled';
    }
  }

  /**
   * Get the report for a panel.
   */
  getReport(panelId: string): VisualTestReport | null {
    return this._activeTests.get(panelId) || null;
  }

  /**
   * Stop the dev server for a panel.
   */
  async stopDevServer(panelId: string): Promise<void> {
    await this._devServer.stop(panelId);
  }

  /**
   * Check if a dev server is running.
   */
  isDevServerRunning(panelId: string): boolean {
    return this._devServer.isRunning(panelId);
  }

  /**
   * Dispose all resources.
   */
  async dispose(): Promise<void> {
    await Promise.all([
      this._devServer.dispose(),
      this._browser.dispose()
    ]);
    this._activeTests.clear();
    this._cancelled.clear();
  }
}
