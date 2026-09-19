/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import type { AgentConfiguration, Attachment, ContextItem, Conversation, Settings, StreamChunk, UsageStats } from '../../types';
import type { PersonaConfig } from './IProvider';
import { getEnrichedEnv } from '../../utils/platform';
import { killProcessTree } from '../../utils/processKill';
import { PROCESS_KILL_GRACE_PERIOD_MS } from '../../constants';
import { BaseCliProvider, type PanelSessionState } from './BaseCliProvider';
import { AcpNativeClient } from './AcpNativeClient';
import { prepareAcpGit, type AcpGitPolicy } from './AcpNativeGit';
import type { AcpNativeLaunch, AcpNativeLaunchContext, AcpObject } from './AcpNativeTypes';

type AcpSession = PanelSessionState & { lastUsageStats?: UsageStats | null };

/** Version-specific adapters prepare native policy; this class owns the turn. */
export abstract class AcpNativeProvider extends BaseCliProvider {
  protected abstract _prepareAcpLaunch(context: AcpNativeLaunchContext): Promise<AcpNativeLaunch>;

  protected override async _probeCliVersion(cliPath: string): Promise<string | undefined> {
    // A bootstrap wrapper may process environment/configuration before even
    // --version. Discovery only inspects installation metadata; the private
    // ACP launch verifies the actual running agent identity before submission.
    const candidates = path.isAbsolute(cliPath) ? [cliPath] : (getEnrichedEnv().PATH ?? '').split(path.delimiter).map(dir => path.resolve(dir, cliPath));
    for (const candidate of candidates) {
      try {
        const executable = await fs.realpath(candidate);
        for (let directory = path.dirname(executable), depth = 0; depth < 5; depth++, directory = path.dirname(directory)) {
          try {
            const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
            if (typeof metadata.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(metadata.version)) { return metadata.version; }
          } catch { /* No readable installation metadata at this level. */ }
        }
        return undefined;
      } catch { /* Continue through executable search candidates. */ }
    }
    return undefined;
  }

  protected async *_sendNativeTurn(
    content: string, context: ContextItem[], settings: Settings, conversation: Conversation | null,
    session: PanelSessionState, persona?: PersonaConfig, agentConfig?: AgentConfiguration, attachments?: Attachment[],
  ): AsyncGenerator<StreamChunk> {
    const signal = this._requestSignal(session);
    if (!signal || !this._isCurrentRequest(session, signal)) { return; }
    // Even CLI-path/environment lookup can fail before native preparation.
    (session as AcpSession).lastUsageStats = null;
    const captured = this._requestSettings(session) ?? Object.freeze({ ...settings });
    const handler = this._requestNativeHandler(session);
    const cliPath = this.getCliPath();
    const env = getEnrichedEnv();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    let launch: AcpNativeLaunch | undefined;
    let gitPolicy: AcpGitPolicy | undefined;
    let child: ChildProcess | undefined;
    let closed: Promise<void> | undefined;
    let client: AcpNativeClient | undefined;
    let attachmentCleanup: (() => Promise<void>) | null = null;
    let killing: Promise<void> | undefined;
    const terminate = () => {
      if (child && !killing) { killing = killProcessTree(child, PROCESS_KILL_GRACE_PERIOD_MS, { label: `${this.displayName} ACP` }); }
    };
    const current = () => this._isCurrentRequest(session, signal) && (!child || session.process === child);
    try {
      const prepared = await this._prepareAcpLaunch({ settings: captured, session, cwd,
        env, cliPath, signal });
      launch = Object.freeze({ ...prepared, args: [...prepared.args], env: prepared.env ? { ...prepared.env } : undefined });
      if (!current()) { return; }
      gitPolicy = await prepareAcpGit(cwd);
      if (!current()) { return; }
      if (attachments?.some(item => item.type === 'image') && !launch.images) {
        throw new Error(`${this.displayName}'s verified ACP transport does not support image attachments.`);
      }
      const args = [...launch.args];
      attachmentCleanup = await this.prepareAttachments(attachments, args);
      if (!current()) { return; }
      const prompt = await this.buildPromptAsync(content, context, conversation, captured as Settings,
        persona, agentConfig, attachments, session.channelSystemContext);
      if (!current()) { return; }
      const files = attachments?.filter(item => item.type === 'file' && item.filePath).map(item => item.filePath) ?? [];
      // Several ACP agents route leading slash text to native commands before
      // their model/tool policy. A fixed prefix keeps all submitted content in
      // the ordinary user-message path, including an initial slash request.
      const nativePrompt: AcpObject[] = [{ type: 'text', text: `Mysti user request:\n\n${files.length ? `Attached files:\n${files.join('\n')}\n\n` : ''}${prompt}` }];
      if (launch.images) {
        for (const attachment of attachments ?? []) {
          if (attachment.type !== 'image') { continue; }
          const data = attachment.base64Data ?? (attachment.filePath ? (await fs.readFile(attachment.filePath)).toString('base64') : undefined);
          if (!data || !attachment.mimeType.startsWith('image/')) { throw new Error('The ACP image attachment has no usable image data.'); }
          nativePrompt.push({ type: 'image', mimeType: attachment.mimeType, data });
        }
      }
      if (!current()) { return; }
      await launch.assertUnchanged?.();
      await gitPolicy.assertUnchanged();
      if (!current()) { return; }
      child = this._spawnCliProcess(args, cwd, gitPolicy.applyEnv(launch.env ?? env), launch.cliPath ?? cliPath);
      // A launcher may exit before its child's inherited pipes close. Register
      // immediately so cleanup also waits for that final native shutdown.
      closed = new Promise(resolve => child!.once('close', () => resolve()));
      session.process = child;
      client = new AcpNativeClient({ process: child, providerId: this.id, label: this.displayName,
        panelId: session.panelId, signal, settings: captured, handler, launch, isCurrent: current, terminate });
      const initialized = await client.initialize();
      if (!current()) { return; }
      const nativeSession = await client.newSession(cwd);
      if (!current()) { return; }
      if (launch.mode) { await client.setMode(launch.mode); }
      if (launch.model) { await client.setModel(launch.model); }
      await launch.configure?.(client, nativeSession, initialized);
      await launch.assertUnchanged?.();
      await gitPolicy.assertUnchanged();
      if (!current()) { return; }
      session.sessionId = client.sessionId ?? null;
      client.startPrompt(nativePrompt);
      for await (const chunk of client.stream()) {
        if (!current()) { break; }
        yield chunk;
      }
      if (current()) { (session as AcpSession).lastUsageStats = client.usage ?? null; }
    } finally {
      client?.dispose(); terminate();
      if (killing) { await killing; }
      if (closed) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${this.displayName} native process did not close after termination; private state retained.`)), 5000);
          void closed!.then(() => { clearTimeout(timer); resolve(); });
        });
      }
      // Retain all private state if shutdown could not be verified above.
      if (session.process === child) { session.process = null; }
      try { await attachmentCleanup?.(); }
      finally {
        try { await launch?.cleanup?.(); }
        finally { await gitPolicy?.cleanup(); }
      }
    }
  }

  getStoredUsage(panelId?: string): UsageStats | null {
    const session = this._getSession(panelId) as AcpSession;
    const usage = session.lastUsageStats ?? null;
    session.lastUsageStats = null;
    return usage;
  }
}
