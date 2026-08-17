/**
 * First-run onboarding and update UX.
 * Technical command/config IDs are intentionally kept unchanged.
 */
import * as vscode from 'vscode';

const LAST_VERSION_KEY = 'mysti.lastVersion';
const ONBOARDING_VERSION_KEY = 'mysti.onboardingVersion';
const ONBOARDING_VERSION = 2;
const WALKTHROUGH_ID = 'DeepMyst.mysti#mysti.gettingStarted';

export async function runOnboarding(context: vscode.ExtensionContext): Promise<void> {
  const currentVersion = context.extension.packageJSON.version as string;
  const previousVersion = context.globalState.get<string>(LAST_VERSION_KEY);
  const completedOnboardingVersion = context.globalState.get<number>(ONBOARDING_VERSION_KEY, 0);

  // Open the detailed guide once for a clean install and once when the guide itself
  // is materially upgraded. This also helps users installing the localized build
  // over the stock 0.4.0 package without changing the extension ID.
  if (!previousVersion || completedOnboardingVersion < ONBOARDING_VERSION) {
    await vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      WALKTHROUGH_ID,
      false
    );
    await context.globalState.update(ONBOARDING_VERSION_KEY, ONBOARDING_VERSION);
  } else if (previousVersion !== currentVersion) {
    const whatsNew = vscode.l10n.t("What's New");
    const rateMysti = vscode.l10n.t('Rate Mysti');
    const selection = await vscode.window.showInformationMessage(
      vscode.l10n.t("Mysti updated to v{0}! See what's new.", currentVersion),
      whatsNew,
      rateMysti
    );
    if (selection === whatsNew) {
      await vscode.env.openExternal(vscode.Uri.parse('https://github.com/DeepMyst/Mysti/blob/main/CHANGELOG.md'));
    } else if (selection === rateMysti) {
      await vscode.env.openExternal(vscode.Uri.parse('https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti&ssr=false#review-details'));
    }
  }

  await context.globalState.update(LAST_VERSION_KEY, currentVersion);
}
