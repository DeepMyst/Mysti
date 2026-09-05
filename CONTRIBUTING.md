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
   - Leave `npm run watch` from step 3 **running** — F5 does not build for you,
     and it will happily launch against a stale or absent `dist/extension.js`
     with no error explaining why your change is missing.
   - Press `F5` in VS Code
   - A new VS Code window opens with Mysti loaded
   - Set breakpoints and debug in the original window; filter the Debug Console
     by `[Mysti]` for the extension's own logs

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

Ten steps, not six. Steps 6 and 9 are enforced — miss them and `tsc` or
`npm run lint` fails — but the rest are silent, so work down the list.

1. Create the class in `src/providers/<name>/`, extending `BaseCliProvider`.
2. Implement the abstract methods: `discoverCli()`, `getCliPath()`,
   `buildCliArgs()`, `parseStreamLine()`, `getAuthConfig()`,
   `checkAuthentication()`, `getAuthCommand()`, `getInstallCommand()`.
3. Implement `_createSession(panelId)` returning your provider's session state.
   Per-panel state lives there — never as an instance field on the provider.
4. Declare `capabilities` **truthfully**. The UI is capability-driven, so a flag
   that lies produces a control that does nothing. In particular
   `supportsPromptEnhancement` must be `true` only if you implement
   `enhancePrompt()` — `tests/providers/promptEnhancement.test.ts` fails if the
   flag and the method disagree.
5. Register it in `_registerBuiltInProviders()` in
   `src/providers/ProviderRegistry.ts`.
6. Add the id to **both** the `ProviderType` **and** `AgentType` unions in
   `src/types.ts`, then to the four TS-enforced maps — `PROVIDER_DISPLAY_META`
   and `PROVIDER_CUSTOM_MODEL_SETTING_KEYS` in
   `src/providers/base/ProviderManifest.ts` (both `Record<ProviderType, …>`),
   and `AGENT_BRAINSTORM_ICONS` and `agentKeyMap` in
   `src/managers/BrainstormManager.ts` (both `Record<AgentType, …>` — the same
   15 ids; `agentKeyMap` is a local inside the method, so grep for it rather
   than expecting an export). All four are exhaustive `Record`s over a union,
   so a miss is a compile error, not a silent gap.
7. Add the settings in `package.json`: the `defaultProvider` enum plus its
   enumDescription, `<provider>Path`, `<provider>Model`, the
   `brainstorm.synthesisAgent` and `brainstorm.agents` enums, and
   `agents.<key>Persona` / `agents.<key>CustomPrompt`. Paths and API keys are
   `"scope": "machine"` — `tests/utils/settingsScopeParity.test.ts` enforces
   that by key shape.
8. Webview: logo in `resources/icons/`, boot URI in
   `src/webview/webviewContent.ts`, `LOGO_BY_ICON_PATH` in
   `media/chat/chat.js`, and the agent-menu item plus setup-wizard card in
   `media/chat/index.html`, inside the provider-literals allowlist markers.
   (The chat UI is **static assets under `media/chat/`**, not a template string
   in `webviewContent.ts` — that extraction landed in Plan 03.)
9. Add the id to `PROVIDER_IDS` in `scripts/check-provider-literals.js` (the
   lint guard, which runs first in `npm run lint`) and to
   `_getProviderDisplayName` in `src/managers/SlashCommandManager.ts`.
10. Tests: a `TestableXProvider` in `tests/helpers/providerFactory.ts`, a
    `createXSession` in `tests/helpers/sessionFactory.ts`, a
    `tests/providers/<name>/` suite, and the provider-id enumerations in
    `tests/providers/providerManifest.test.ts`,
    `tests/integration/chatViewDebranding.test.ts` and
    `tests/webview/mentionParsing.test.ts`.

`GeminiProvider` is the cleanest reference for a stream-json CLI backend;
`HermesProvider` for an ACP/persistent-process one.

## Good First Issues

Look for issues labeled [`good first issue`](https://github.com/DeepMyst/Mysti/labels/good%20first%20issue) - these are great starting points for new contributors.

## Questions?

- [Open an issue](https://github.com/DeepMyst/Mysti/issues) for bugs or features
- Check existing issues before creating new ones

## License

By contributing to Mysti, you agree that your contributions will be licensed under the Apache License 2.0.

---

Thank you for helping make Mysti better!
