# Contributing to Mysti

Thank you for your interest in contributing to Mysti! We welcome contributions from the community.

## Ways to Contribute

- **Bug Reports**: Found a bug? [Open an issue](https://github.com/DeepMyst/Mysti/issues/new)
- **Feature Requests**: Have an idea? [Start a discussion](https://github.com/DeepMyst/Mysti/issues/new)
- **Code Contributions**: Fix bugs or add features via pull requests
- **Documentation**: Improve README, add examples, or fix typos
- **Testing**: Try new features and report feedback

## Getting Started

### Prerequisites

- Node.js 18+
- VS Code 1.85+
- At least one CLI tool installed:
  - `npm install -g @anthropic-ai/claude-code`
  - `npm install -g @google/gemini-cli`
  - `npm install -g @github/copilot`

### Development Setup

1. **Fork and clone the repository**
   ```bash
   git clone https://github.com/YOUR_USERNAME/Mysti.git
   cd Mysti
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start development build**
   ```bash
   npm run watch
   ```

4. **Launch Extension Development Host**
   - Press `F5` in VS Code
   - A new VS Code window opens with Mysti loaded
   - Set breakpoints and debug in the original window

### Project Structure

```
Mysti/
├── src/
│   ├── extension.ts           # Entry point
│   ├── providers/             # AI provider implementations
│   │   ├── base/              # BaseCliProvider, IProvider interface
│   │   ├── claude/            # Claude Code provider
│   │   ├── codex/             # OpenAI Codex provider
│   │   ├── copilot/           # GitHub Copilot provider
│   │   └── gemini/            # Google Gemini provider
│   ├── managers/              # Business logic managers
│   ├── webview/               # Chat UI (webviewContent.ts)
│   └── types.ts               # TypeScript type definitions
├── resources/                 # Icons, logos, agent definitions
└── package.json               # Extension manifest
```

## Pull Request Process

1. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Follow existing code style
   - Add comments for complex logic
   - Use `[Mysti]` prefix for console logs

3. **Test your changes**
   - Press `F5` to launch Extension Development Host
   - Test with multiple providers if applicable
   - Check the Debug Console for errors

4. **Commit with clear messages**
   ```bash
   git commit -m "feat: add support for new feature"
   ```

   Use conventional commits:
   - `feat:` - New feature
   - `fix:` - Bug fix
   - `docs:` - Documentation
   - `refactor:` - Code refactoring
   - `test:` - Tests

5. **Push and create PR**
   ```bash
   git push origin feature/your-feature-name
   ```
   Then open a Pull Request on GitHub.

## Code Style

- **TypeScript**: Use strict types, avoid `any`
- **Naming**: Private members use `_` prefix (`_currentProcess`)
- **Logging**: Use `console.log('[Mysti] ProviderName: message')`
- **Error handling**: Always catch and log errors

## Adding a New Provider

1. Create `src/providers/newprovider/NewProvider.ts`
2. Extend `BaseCliProvider` and implement required methods
3. Register in `src/providers/ProviderRegistry.ts`
4. Add to `ProviderType` union in `src/types.ts`
5. Add configuration in `package.json`
6. Update webview UI in `src/webview/webviewContent.ts`

See existing providers (especially `GeminiProvider`) as reference.

## Good First Issues

Look for issues labeled [`good first issue`](https://github.com/DeepMyst/Mysti/labels/good%20first%20issue) - these are great starting points for new contributors.

## Questions?

- [Open an issue](https://github.com/DeepMyst/Mysti/issues) for bugs or features
- Check existing issues before creating new ones

## License

By contributing to Mysti, you agree that your contributions will be licensed under the MIT License.

---

Thank you for helping make Mysti better!
