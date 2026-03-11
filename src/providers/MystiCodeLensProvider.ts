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

export class MystiCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Listen for config changes to refresh
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mysti.codeLens.enabled')) {
        this._onDidChangeCodeLenses.fire();
      }
    });
  }

  async provideCodeLenses(document: vscode.TextDocument, _token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    const config = vscode.workspace.getConfiguration('mysti');
    if (!config.get<boolean>('codeLens.enabled', true)) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];

    try {
      // Use VS Code's built-in document symbol provider
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri
      );

      if (!symbols) { return []; }

      // Recursively find functions/methods that are 10+ lines
      this._collectSymbolLenses(symbols, document, lenses);
    } catch (err) {
      console.log('[Mysti] CodeLens: Error getting symbols:', err);
    }

    return lenses;
  }

  resolveCodeLens(codeLens: vscode.CodeLens, _token: vscode.CancellationToken): vscode.CodeLens {
    return codeLens;
  }

  private _collectSymbolLenses(
    symbols: vscode.DocumentSymbol[],
    document: vscode.TextDocument,
    lenses: vscode.CodeLens[]
  ): void {
    for (const symbol of symbols) {
      // Only target functions, methods, and constructors
      const isFunction = symbol.kind === vscode.SymbolKind.Function
        || symbol.kind === vscode.SymbolKind.Method
        || symbol.kind === vscode.SymbolKind.Constructor;

      if (isFunction) {
        const lineCount = symbol.range.end.line - symbol.range.start.line + 1;
        // Only show for functions 10+ lines
        if (lineCount >= 10) {
          const range = new vscode.Range(symbol.range.start, symbol.range.start);
          const functionCode = document.getText(symbol.range);
          const filePath = document.uri.fsPath;
          const functionName = symbol.name;

          // Three branded CodeLens items
          lenses.push(new vscode.CodeLens(range, {
            title: 'Mysti: Explain',
            command: 'mysti.codeLensAction',
            arguments: ['explain', functionCode, filePath, functionName]
          }));

          lenses.push(new vscode.CodeLens(range, {
            title: 'Mysti: Refactor',
            command: 'mysti.codeLensAction',
            arguments: ['refactor', functionCode, filePath, functionName]
          }));

          lenses.push(new vscode.CodeLens(range, {
            title: 'Mysti: Write Tests',
            command: 'mysti.codeLensAction',
            arguments: ['test', functionCode, filePath, functionName]
          }));
        }
      }

      // Recurse into children (e.g., methods inside classes)
      if (symbol.children && symbol.children.length > 0) {
        this._collectSymbolLenses(symbol.children, document, lenses);
      }
    }
  }

  dispose(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    this._onDidChangeCodeLenses.dispose();
  }
}
