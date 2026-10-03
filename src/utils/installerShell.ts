/** Installer snippets must run in the shell they were written for. */
export function installerShell(command: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') { return '/bin/bash'; }
  return /\b(?:irm|iex|Invoke-RestMethod|Invoke-Expression)\b/i.test(command)
    ? 'powershell.exe' : 'cmd.exe';
}

/** Quote an executable path for the fixed shells used by setup terminals. */
export function quoteSetupExecutable(file: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `"${file}"` : "'" + file.replace(/'/g, "'\"'\"'") + "'";
}
