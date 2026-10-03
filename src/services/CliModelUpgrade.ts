import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { getProviderNpmPackage, getProviderSelfUpdateCommand } from '../providers/base/ProviderManifest';
import { compareVersions, parseVersion } from './CliUpdateService';

/** Recognize explicit model/CLI compatibility failures, never commands in text. */
export function requiredCliVersion(providerId: string, raw: string): string | undefined {
  if (typeof getProviderNpmPackage(providerId) !== 'string' && typeof getProviderSelfUpdateCommand(providerId) !== 'string') { return undefined; }
  if (typeof raw !== 'string' || raw.length > 16384 || !/\bmodel\b/i.test(raw)) { return undefined; }
  const version = '(\\d{1,6}\\.\\d{1,6}\\.\\d{1,6})';
  const explicit = new RegExp('(?:does not support|doesn.t support|unsupported)[^\\n]{0,160}model[^\\n]{0,160}version\\s+' + version + '\\s+(?:or newer|or later|or higher)\\s+is required', 'i').exec(raw);
  const requires = new RegExp('(?:model[^\\n]{0,100}requires|requires[^\\n]{0,100}(?:CLI|Claude Code|Codex))\\s+(?:version\\s*)?(?:>=\\s*|v)?' + version + '(?=\\s|[,.]|$)', 'i').exec(raw);
  const minimum = explicit?.[1] || requires?.[1];
  return minimum && parseVersion(minimum, true) ? minimum : undefined;
}

export function meetsCliVersion(actual: string | undefined, minimum: string): boolean {
  const installed = parseVersion(actual);
  const required = parseVersion(minimum, true);
  return !!installed && !!required && compareVersions(installed, required) >= 0;
}

export interface CliUpgradePlan { executable: string; args: string[] }

/** A visible, cancellable VS Code task with a real exit result (VS Code 1.86+). */
export async function runCliUpgradeTask(label: string, plan: CliUpgradePlan): Promise<void> {
  const id = randomUUID();
  const task = new vscode.Task(
    { type: 'mysti-cli-upgrade', id }, vscode.TaskScope.Global,
    `Upgrade ${label}`, 'Mysti', new vscode.ShellExecution(plan.executable, plan.args), [],
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, focus: false };
  let execution: vscode.TaskExecution | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners: vscode.Disposable[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const owns = (event: { execution: vscode.TaskExecution }): boolean => event.execution.task.definition.id === id;
      listeners.push(vscode.tasks.onDidEndTaskProcess(event => {
        if (!owns(event)) { return; }
        if (event.exitCode === 0) { resolve(); }
        else { reject(new Error(event.exitCode === undefined ? 'Upgrade was cancelled.' : `Upgrade exited with code ${event.exitCode}. See the upgrade terminal for details.`)); }
      }));
      listeners.push(vscode.tasks.onDidEndTask(event => {
        // Process-end normally arrives first. This also covers tasks that never launch.
        if (owns(event)) { reject(new Error('Upgrade ended without a successful install. See the upgrade terminal for details.')); }
      }));
      timer = setTimeout(() => {
        execution?.terminate();
        reject(new Error('Upgrade timed out. See the upgrade terminal for details.'));
      }, 10 * 60_000);
      void vscode.tasks.executeTask(task).then(value => { execution = value; }, reject);
    });
  } finally {
    if (timer) { clearTimeout(timer); }
    listeners.forEach(listener => listener.dispose());
  }
}
