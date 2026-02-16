/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://deepmyst.com
 *
 * This file is part of Mysti, licensed under the Business Source License 1.1.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: BUSL-1.1
 */

import * as vscode from 'vscode';

/**
 * TelemetryManager handles usage analytics for Mysti using Azure Application Insights.
 *
 * Privacy considerations:
 * - No PII: Never logs user code, file paths, or message content
 * - Aggregate only: Focus on usage patterns, not individual actions
 * - Opt-out respected: Checks vscode.env.isTelemetryEnabled before sending
 *
 * Setup:
 * 1. Create an Application Insights resource in Azure Portal
 * 2. Copy the Instrumentation Key from the resource
 * 3. Set TELEMETRY_KEY below with your key
 *
 * Telemetry is automatically disabled if:
 * - User has telemetry disabled in VSCode settings
 * - TELEMETRY_KEY is empty
 */

import TelemetryReporter from '@vscode/extension-telemetry';

// Azure Application Insights instrumentation key
const TELEMETRY_KEY = 'b9310dd2-b563-42f7-8fd9-796874f66a94';

export class TelemetryManager {
  private _reporter: TelemetryReporter | null = null;
  private _enabled: boolean = false;
  private _context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;

    // Only enable telemetry if:
    // 1. User has telemetry enabled globally
    // 2. We have a valid telemetry key
    if (vscode.env.isTelemetryEnabled && TELEMETRY_KEY) {
      this._enabled = true;
      this._reporter = new TelemetryReporter(TELEMETRY_KEY);
      context.subscriptions.push(this._reporter);
    }

    console.log('[Mysti] TelemetryManager initialized, enabled:', this._enabled);
  }

  /**
   * Send a telemetry event
   */
  sendEvent(eventName: string, properties?: Record<string, string>, measurements?: Record<string, number>): void {
    if (!this._enabled) {return;}

    if (this._reporter) {
      this._reporter.sendTelemetryEvent(eventName, properties, measurements);
    }

    // Also log in development for debugging
    console.log('[Mysti] Telemetry event:', eventName, properties, measurements);
  }

  /**
   * Send a telemetry error event
   */
  sendError(error: Error, properties?: Record<string, string>): void {
    if (!this._enabled) {return;}

    if (this._reporter) {
      this._reporter.sendTelemetryErrorEvent(error.name, {
        message: error.message,
        ...properties
      });
    }

    // Also log in development for debugging
    console.log('[Mysti] Telemetry error:', error.name, error.message, properties);
  }

  // Convenience methods for common events

  /**
   * Track extension activation
   */
  trackActivation(version: string): void {
    this.sendEvent('extension.activated', { version });
  }

  /**
   * Track when a new conversation is started
   */
  trackConversationStarted(provider: string, model: string): void {
    this.sendEvent('conversation.started', { provider, model });
  }

  /**
   * Track when a message is sent
   */
  trackMessageSent(provider: string, hasContext: boolean, personaId: string | null, skillCount: number): void {
    this.sendEvent('message.sent', {
      provider,
      hasContext: String(hasContext),
      personaId: personaId || 'none',
      skillCount: String(skillCount)
    });
  }

  /**
   * Track when brainstorm mode is started
   */
  trackBrainstormStarted(agentCount: number, discussionMode: string): void {
    this.sendEvent('brainstorm.started', {
      agentCount: String(agentCount),
      discussionMode
    });
  }

  /**
   * Track when a persona is selected
   */
  trackPersonaSelected(personaId: string): void {
    this.sendEvent('persona.selected', { personaId });
  }

  /**
   * Track when a skill is toggled
   */
  trackSkillToggled(skillId: string, enabled: boolean): void {
    this.sendEvent('skill.toggled', { skillId, enabled: String(enabled) });
  }

  /**
   * Track when a plan option is selected
   */
  trackPlanSelected(planIndex: number, executionMode: string): void {
    this.sendEvent('plan.selected', {
      planIndex: String(planIndex),
      executionMode
    });
  }

  /**
   * Track provider errors
   */
  trackProviderError(provider: string, errorType: string): void {
    this.sendEvent('error.occurred', {
      provider,
      errorType
    });
  }

  /**
   * Check if telemetry is enabled
   */
  isEnabled(): boolean {
    return this._enabled;
  }

  dispose(): void {
    // Reporter is disposed via context.subscriptions
    console.log('[Mysti] TelemetryManager disposed');
  }
}
