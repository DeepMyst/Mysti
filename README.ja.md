<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | 日本語 | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.ar.md">العربية</a> | <a href="README.de.md">Deutsch</a> | <a href="README.fr.md">Français</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.ru.md">Русский</a>
</p>

# Mysti - あなたのAIコーディングチームが協力して働く

<p align="center">
  <img src="resources/Mysti-Logo.png" alt="Mysti ロゴ" width="128" height="128">
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/v/DeepMyst.mysti?style=flat-square&label=Version" alt="バージョン">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/i/DeepMyst.mysti?style=flat-square&label=Installs" alt="インストール数">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/r/DeepMyst.mysti?style=flat-square&label=Rating" alt="評価">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/stargazers">
    <img src="https://img.shields.io/github/stars/DeepMyst/Mysti?style=flat-square&label=Stars" alt="GitHub Stars">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/network/members">
    <img src="https://img.shields.io/github/forks/DeepMyst/Mysti?style=flat-square&label=Forks" alt="GitHub Forks">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue?style=flat-square" alt="ライセンス">
  </a>
</p>

<p align="center">
  <strong>VSCode用AIコーディングチーム</strong><br>
  <em>11のAIプロバイダー — Claude Code、Codex、Gemini、Copilot、Cline、Cursor、OpenClaw、OpenCode、Qwen Code、Ollama、LocalAI — 単独またはチームで作業</em><br>
  <em>集合知の力 — 複数のエージェントの集合知能が単独のエージェントを上回る。</em>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/badge/VS%20Code%20マーケットプレイスからインストール-007ACC?style=for-the-badge&logo=visual-studio-code" alt="VS Code マーケットプレイスからインストール">
  </a>
</p>

<p align="center">
  <a href="#aiを選ぶ">プロバイダー</a> •
  <a href="#ブレインストームモード">ブレインストーム</a> •
  <a href="#主要機能">機能</a> •
  <a href="#クイックスタート">クイックスタート</a> •
  <a href="#設定">設定</a> •
  <a href="#ドキュメント">ドキュメント</a>
</p>

---

## v0.3.4 の新機能

### 11のAIプロバイダー

Mystiは**11のAIプロバイダー**をサポート — **OpenCode**、**Qwen Code**、**Ollama**、**LocalAI**が新たに加わり、Claude Code、Codex、Gemini、GitHub Copilot、Cline、Cursor、OpenClawと共に利用できます。Ollama/LocalAIでローカルモデルを実行するか、OpenCodeやQwen Codeなどのクラウドプロバイダーを使用できます。各プロバイダーにはUI上で独自のロゴが表示されます。

### Qwen Code

Alibabaの深い推論能力を持つAIコーディングCLI。Claude Codeと同じストリーミングプロトコルを使用し、シームレスに統合されます。Qwen3 Coderモデルをサポートし、plan、auto-edit、yolo承認モードを提供します。

### OpenCode

Anthropic、OpenAI、Google、Groqをサポートするマルチバックエンドコーディングエージェント。単一のCLIで実現。設定済みのデフォルトモデルを使用 — 特定のプロバイダーにロックインされません。

### ローカルAIサポート

**Ollama**と**LocalAI**でAIモデルをローカルで実行 — クラウドサブスクリプション不要。完全なプライバシー、ゼロレイテンシー、モデルの完全な制御。

---

## 数秒でインストール

**VS Codeから：** `Ctrl+P`（Macは`Cmd+P`）を押して、以下を貼り付け：

```
ext install DeepMyst.mysti
```

**または** [VS Code マーケットプレイスからインストール](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti)

---

## AIを選ぶ

Mystiはお使いのAIコーディングツールと連携します。**追加のサブスクリプションは不要です。**

<p align="center">
  <img src="docs/gifs/agent switching.gif" alt="エージェント切り替え" width="450">
</p>

| プロバイダー | 最適な用途 |
|-------------|-----------|
| **Claude Code** | 深い推論、複雑なリファクタリング、徹底的な分析 |
| **Codex** | 素早いイテレーション、馴染みのあるOpenAIスタイル |
| **Gemini** | 高速レスポンス、Googleエコシステム統合 |
| **GitHub Copilot** | GitHubサブスクリプションでマルチモデルアクセス（Claude、GPT-5、Gemini） |
| **Cline** | Plan/Actモード、構造化されたタスク完了 |
| **Cursor** | 自動モデル選択、Claude、GPT-5、Geminiのマルチモデル対応 |
| **OpenClaw** | リアルタイムWebSocketストリーミング、設定可能な思考レベル |
| **OpenCode** | マルチバックエンドエージェント（Anthropic、OpenAI、Google、Groq） |
| **Qwen Code** | AlibabaのAIコーディングエージェント、深い推論 |
| **Ollama** | ローカルLLM推論、プライバシー優先、サブスクリプション不要 |
| **LocalAI** | セルフホスト型AIモデル、完全な制御 |

**ワンクリックでプロバイダーを切り替え。ロックインなし。**

### なぜMystiなのか？

| Copilot/Cursorとの比較 | Mystiの優位性 |
|-----------------------|--------------|
| 単一のAI | **マルチエージェントブレインストーム** — 2つのAIが5つの戦略で協力 |
| 単一プロバイダーにロック | **11プロバイダー** — Claude、Codex、Gemini、Copilot、Cline、Cursor、OpenClaw、OpenCode、Qwen、Ollama、LocalAI |
| ブラックボックス | **完全な権限制御** — 読み取り専用からフルアクセスまで |
| 汎用的な回答 | **16のペルソナ** — アーキテクト、デバッガー、セキュリティエキスパート... |
| 手動ワークフロー | **自律モード** — AIが安全制御のもと独立して作業 |
| クロスエージェントルーティングなし | **@メンション** — タスクをインラインで特定のエージェントにルーティング |

---

## 実際の動作

<p align="center">
  <img src="docs/gifs/main screen.gif" alt="Mysti チャットインターフェース" width="700">
</p>

<p align="center"><em>シンタックスハイライト、Markdownサポート、Mermaid図表を備えた美しくモダンなチャットインターフェース</em></p>

<p align="center">
  <img src="docs/gifs/Task list rendering and progress tracking.gif" alt="タスクリストレンダリング" width="700">
</p>

<p align="center"><em>リアルタイムのタスクリストレンダリングと進捗追跡</em></p>

---

## ブレインストームモード

**セカンドオピニオンが欲しい？** ブレインストームモードを有効にして、2つのAIエージェントに一緒に問題を解決させましょう。設定パネルから**11のエージェントのうち任意の2つを選択**できます。

<p align="center">
  <img src="docs/gifs/brainstorm example.gif" alt="ブレインストームモード" width="700">
</p>

### 5つのコラボレーション戦略

| 戦略 | 役割 | 最適な用途 |
|------|------|-----------|
| **Quick** | 直接統合 | シンプルなタスク、迅速な回答 |
| **Debate** | 批評者 vs 擁護者 | アーキテクチャ決定、トレードオフ |
| **Red-Team** | 提案者 vs 挑戦者 | セキュリティレビュー、エッジケースの発見 |
| **Perspectives** | リスクアナリスト vs イノベーター | グリーンフィールド設計、技術選定 |
| **Delphi** | ファシリテーター vs リファイナー | 複雑な問題、合意形成 |

### なぜ2つのAIが1つに勝るのか

**Claude Code**（Anthropic）、**Codex**（OpenAI）、**Gemini**（Google）、**GitHub Copilot**、**Cline**、**Cursor**、**OpenClaw**、**OpenCode**、**Qwen Code**（Alibaba）、**Ollama**、**LocalAI**は、異なるトレーニング、異なる強み、異なる弱点を持っています。任意の2つが協力すると：

- 各AIが相手が見逃す可能性のあるエッジケースを発見
- 異なる視点がより堅牢なソリューションにつながる
- **一緒に** 議論し、互いに挑戦し、最良のソリューションを統合する

シニアデベロッパーとテックリードがコードをレビューするようなもの — ただし、彼らは実際にまず議論します。

### 収束検出

ディスカッション中、Mystiはエージェントの合意と立場の安定性を追跡します。**自動収束**が有効な場合、エージェントが合意に達すると議論は早期に終了 — 品質を犠牲にすることなく時間を節約します。

### チームを選ぶ

**設定パネル**でどの2つのエージェントが協力するかを設定：

<p align="center">
  <img src="docs/gifs/Brainstorm model selection.gif" alt="ブレインストームモデル選択" width="600">
</p>

| 組み合わせ | 最適な用途 |
|-----------|-----------|
| Claude + Codex | 深い分析と素早いイテレーションの融合 |
| Claude + Gemini | 徹底的な推論と高速な検証 |
| Claude + Copilot | ネイティブClaude vs Copilotのマルチモデルアプローチを比較 |
| Cursor + Gemini | マルチモデルの柔軟性とGoogle統合 |
| OpenClaw + Claude | WebSocketストリーミングと深い推論 |
| Qwen + Claude | AlibabaとAnthropicの推論を比較 |
| OpenCode + Gemini | マルチバックエンドの柔軟性とGoogleの速度 |
| Ollama + Claude | ローカルプライバシーとクラウド知能の融合 |

[ブレインストーム完全ドキュメント](docs/BRAINSTORM.md)

### インテリジェントプラン検出

AIが複数の実装アプローチを提示すると、Mystiは自動的にそれらを検出し、お好みのパスを選択できるようにします。

<p align="center">
  <img src="docs/screenshots/plan-suggestions.png" alt="プラン提案" width="600">
</p>

*2つ以上のCLIツールのインストールが必要です。[要件](#要件)を参照してください。*

---

## 主要機能

### 自律モード

設定可能な安全制御のもとでAIに独立して作業させます：

- **安全分類器**：3段階 — 安全（自動承認）、注意（モード依存）、ブロック（常に拒否）
- **3つの安全モード**：保守的、バランス、積極的
- **学習メモリ**：あなたの権限設定を記憶し、時間とともに改善
- **継続モード**：目標ベースまたはタスクキューによる拡張自律セッション
- **監査証跡**：すべての自律的な決定がレビュー用に記録

<p align="center">
  <img src="docs/gifs/Selecting autonomy mode.gif" alt="自律モード選択" width="600">
</p>

[自律モード完全ドキュメント](docs/AUTONOMOUS-MODE.md)

### @メンションシステム

タスクを特定のエージェントにルーティングし、ファイルをインラインで参照：

<p align="center">
  <img src="docs/gifs/Agent tagging and multi agent workflows.gif" alt="@メンションタグ付け" width="600">
</p>

```
@claude このコードのセキュリティ問題をレビュー
@src/auth.ts @gemini このファイルのパフォーマンス改善を提案
@claude テストを書いて、次に @codex で最適化
```

- **ファイルメンション**：`@filename` で一時的なコンテキストを追加
- **エージェントメンション**：`@agent` でタスクをそのプロバイダーにルーティング
- **チェイニング**：後のエージェントは前のエージェントのレスポンスをコンテキストとして受け取る

[@メンション完全ドキュメント](docs/MENTIONS.md)

### コンテキスト圧縮

コンテキストオーバーフローを防ぐスマートな会話管理：

- **自動**：トークン使用量がしきい値に近づくとトリガー（デフォルト75%）
- **ネイティブサポート**：Claude Codeは組み込みの`/compact`コマンドを使用
- **クライアント側**：その他のプロバイダーはインテリジェントなメッセージ要約を使用
- **パネルごとの追跡**：各チャットパネルが独立して使用量を追跡

[圧縮完全ドキュメント](docs/COMPACTION.md)

### 16の開発者ペルソナ

AIの思考方法を形作ります。専門的なペルソナから選択して、AIの問題へのアプローチを変更します。

<p align="center">
  <img src="docs/gifs/Personas and skills.gif" alt="ペルソナとスキルパネル" width="550">
</p>

| ペルソナ | フォーカス |
|---------|----------|
| **アーキテクト** | システム設計、スケーラビリティ、クリーンな構造 |
| **デバッガー** | 根本原因分析、バグ修正 |
| **セキュリティ志向** | 脆弱性、脅威モデリング |
| **パフォーマンスチューナー** | 最適化、プロファイリング、レイテンシー |
| **プロトタイパー** | 素早いイテレーション、PoC |
| **リファクタラー** | コード品質、保守性 |
| + さらに10種... | フルスタック、DevOps、メンター、デザイナー... |

[ペルソナ＆スキル完全ドキュメント](docs/PERSONAS-AND-SKILLS.md)

---

### クイックペルソナ選択

パネルを開かずにツールバーから直接ペルソナを選択。

<p align="center">
  <img src="docs/screenshots/persona-toolbar.png" alt="ツールバーペルソナ選択" width="550">
</p>

---

### スマート自動提案

Mystiはメッセージに基づいて関連するペルソナやアクションを自動的に提案します。

<p align="center">
  <img src="docs/gifs/PErsona Suggestion.gif" alt="自動提案" width="550">
</p>

---

### 会話履歴

作業内容を失うことはありません。すべての会話が保存され、簡単にアクセスできます。

<p align="center">
  <img src="docs/screenshots/conversation-history.png" alt="会話履歴" width="450">
</p>

---

### ウェルカム画面のクイックアクション

一般的なタスクのワンクリックアクションで素早く開始。

<p align="center">
  <img src="docs/screenshots/quick-actions-welcome.png" alt="クイックアクション" width="550">
</p>

---

### 充実した設定

トークンバジェット、アクセスレベル、ブレインストームモードなど、Mystiのあらゆる側面を微調整。

<p align="center">
  <img src="docs/screenshots/settings-panel.png" alt="設定パネル" width="450">
</p>

---

## 要件

**Claude、ChatGPT、Gemini、またはGitHub Copilotをお使いですか？すぐに始められます。**

Mystiは既存のサブスクリプションで動作 — 追加コストなし！

| CLIツール | サブスクリプション | インストール |
|----------|-------------------|-------------|
| **Claude Code**（推奨） | Anthropic API または Claude Pro/Max | `npm install -g @anthropic-ai/claude-code` |
| **GitHub Copilot CLI** | GitHub Copilot Pro/Pro+/Business | `npm install -g @github/copilot-cli` |
| **Gemini CLI** | Google AI API または Gemini Advanced | `npm install -g @google/gemini-cli` |
| **Codex CLI** | OpenAI API | OpenAIのインストールガイドに従う |
| **Cline** | モデルプロバイダーに依存 | `npm install -g cline` |
| **Cursor** | Cursorサブスクリプション | `curl https://cursor.com/install -fsS \| bash` |
| **OpenClaw** | OpenClawアカウント | `npm install -g openclaw@latest && openclaw onboard --install-daemon` |
| **OpenCode** | プロバイダーAPIキー（Anthropic、OpenAIなど） | `npm i -g opencode-ai@latest` |
| **Qwen Code** | Qwen OAuthまたはAPIキー | `npm install -g @qwen-code/qwen-code@latest` |
| **Ollama** | ローカル（サブスクリプション不要） | [ollama.comからインストール](https://ollama.com) |
| **LocalAI** | ローカル（サブスクリプション不要） | [localai.ioからインストール](https://localai.io) |

開始には**1つ**のCLIだけで十分です。**任意の2つ**をインストールすればブレインストームモードが解放されます。

---

## クイックスタート

### 1. Mystiをインストール

**方法A：** `Ctrl+P`（Macは`Cmd+P`）を押して、貼り付けて実行：
```
ext install DeepMyst.mysti
```

**方法B：** [VS Code マーケットプレイスからインストール](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti)

### 2. CLIツールをインストール

```bash
# Claude Code（推奨）
npm install -g @anthropic-ai/claude-code
claude auth login

# または GitHub Copilot CLI（GitHubからClaude、GPT-5、Geminiにアクセス）
npm install -g @github/copilot-cli
copilot  # その後 /login コマンドを使用

# または Gemini CLI
npm install -g @google/gemini-cli
gemini auth login

# または Cursor
curl https://cursor.com/install -fsS | bash
agent login

# または OpenClaw
npm install -g openclaw@latest && openclaw onboard --install-daemon
openclaw login

# または OpenCode
npm i -g opencode-ai@latest
opencode auth login

# または Qwen Code
npm install -g @qwen-code/qwen-code@latest
qwen  # その後 /auth と入力
```

ブレインストームモードには、任意の2つのCLIツールをインストールしてください。

### 3. Mystiを開く

- アクティビティバーの**Mystiアイコン**をクリック、または
- `Ctrl+Shift+M`（Macは`Cmd+Shift+M`）を押す

### 4. コーディング開始

リクエストを入力して、AIにアシストしてもらいましょう！

---

## スラッシュコマンド

組み込みのスラッシュコマンドメニューでスキルやアクションに素早くアクセス。

<p align="center">
  <img src="docs/gifs/slash commands menu.gif" alt="スラッシュコマンドメニュー" width="600">
</p>

---

## 12の切り替え可能なスキル

行動修飾子を自由に組み合わせ：

- **簡潔** - 明確で簡潔なコミュニケーション
- **テスト駆動** - コードと一緒にテストを作成
- **自動コミット** - インクリメンタルなコミット
- **第一原理** - 基本原理からの推論
- **スコープ規律** - タスクに集中
- さらに7つ...

[ペルソナ＆スキル完全ドキュメント](docs/PERSONAS-AND-SKILLS.md)

---

## 権限制御

AIの操作権限を制御：

- **読み取り専用** - AIは読み取りのみ、変更不可
- **権限要求** - 各ファイル変更を承認
- **フルアクセス** - AIに自律的に作業させる

<p align="center">
  <img src="docs/gifs/Semi auto answering questions .gif" alt="権限制御デモ" width="600">
</p>

---

## 設定

### 基本設定

```json
{
  "mysti.defaultProvider": "claude-code",
  "mysti.brainstorm.agents": ["claude-code", "google-gemini"],
  "mysti.brainstorm.strategy": "quick",
  "mysti.accessLevel": "ask-permission"
}
```

### プロバイダー設定

| 設定 | デフォルト | 説明 |
|------|----------|------|
| `mysti.defaultProvider` | `claude-code` | 主要AIプロバイダー |
| `mysti.claudePath` | `claude` | Claude CLIパス |
| `mysti.codexPath` | `codex` | Codex CLIパス |
| `mysti.geminiPath` | `gemini` | Gemini CLIパス |
| `mysti.copilotPath` | `copilot` | Copilot CLIパス |
| `mysti.clinePath` | `cline` | Cline CLIパス |
| `mysti.cursorPath` | `agent` | Cursor CLIパス |
| `mysti.openclawPath` | `openclaw` | OpenClaw CLIパス |
| `mysti.opencodePath` | `opencode` | OpenCode CLIパス |
| `mysti.qwenCodePath` | `qwen` | Qwen Code CLIパス |
| `mysti.ollamaPath` | `ollama` | Ollama CLIパス |
| `mysti.localaiPath` | `localai` | LocalAI CLIパス |

### ブレインストーム設定

| 設定 | デフォルト | 説明 |
|------|----------|------|
| `mysti.brainstorm.agents` | `["claude-code", "openai-codex"]` | 使用する2つのエージェント |
| `mysti.brainstorm.strategy` | `quick` | 戦略：`quick`、`debate`、`red-team`、`perspectives`、`delphi` |
| `mysti.brainstorm.autoConverge` | `true` | エージェントが収束したら自動終了 |
| `mysti.brainstorm.maxDiscussionRounds` | `3` | 最大ディスカッションラウンド数 |

### 自律モード設定

| 設定 | デフォルト | 説明 |
|------|----------|------|
| `mysti.autonomous.safetyMode` | `balanced` | `conservative`、`balanced`、`aggressive` |
| `mysti.autonomous.blockPatterns` | `[]` | 常にブロックするカスタムパターン |

### 圧縮設定

| 設定 | デフォルト | 説明 |
|------|----------|------|
| `mysti.compaction.enabled` | `true` | コンテキスト圧縮を有効化 |
| `mysti.compaction.threshold` | `75` | 圧縮しきい値（コンテキストウィンドウの%） |

### 一般設定

| 設定 | デフォルト | 説明 |
|------|----------|------|
| `mysti.accessLevel` | `ask-permission` | ファイルアクセスレベル |
| `mysti.agents.autoSuggest` | `true` | ペルソナを自動提案 |
| `mysti.agents.maxTokenBudget` | `0` | エージェントコンテキストの最大トークン数（0 = 無制限） |

[プロバイダー完全ドキュメント](docs/PROVIDERS.md)

---

## キーボードショートカット

| アクション | Windows/Linux | Mac |
|-----------|---------------|-----|
| Mystiを開く | `Ctrl+Shift+M` | `Cmd+Shift+M` |
| 新しいタブで開く | `Ctrl+Shift+N` | `Cmd+Shift+N` |

---

## コマンド

| コマンド | 説明 |
|---------|------|
| `Mysti: Open Chat` | チャットサイドバーを開く |
| `Mysti: New Conversation` | 新しい会話を開始 |
| `Mysti: Add to Context` | ファイル/選択範囲をコンテキストに追加 |
| `Mysti: Clear Context` | すべてのコンテキストをクリア |
| `Mysti: Open in New Tab` | エディタタブでチャットを開く |

---

## ドキュメント

| ガイド | 説明 |
|-------|------|
| [プロバイダー](docs/PROVIDERS.md) | 全11プロバイダー — セットアップ、モデル、機能 |
| [ブレインストームモード](docs/BRAINSTORM.md) | 5つの戦略、収束、チーム選択 |
| [ペルソナ＆スキル](docs/PERSONAS-AND-SKILLS.md) | 16ペルソナ、12スキル、カスタムエージェント |
| [自律モード](docs/AUTONOMOUS-MODE.md) | 安全システム、メモリ、継続モード |
| [@メンション](docs/MENTIONS.md) | エージェントルーティングとファイルコンテキスト |
| [圧縮](docs/COMPACTION.md) | コンテキスト管理と要約 |
| [アーキテクチャ](docs/ARCHITECTURE.md) | 技術的な内部構造と拡張ポイント |
| [機能](docs/FEATURES.md) | 完全な機能リファレンス |

---

## テレメトリ

Mystiは拡張機能を改善するために**匿名**の使用データを収集します：

- 機能の使用パターン
- エラー率
- プロバイダーの好み

**コード、ファイルパス、個人データは一切収集されません。**

VSCodeのテレメトリ設定に従います。以下で無効化：
設定 > Telemetry: Telemetry Level > off

---

## コントリビューター

Mystiの改善に貢献してくださったすべての方に感謝します！

<a href="https://github.com/BahaAbuNojaim"><img src="https://avatars.githubusercontent.com/u/6247079?v=4" width="60" height="60" style="border-radius:50%" alt="BahaAbuNojaim" /></a>
<a href="https://github.com/MostlyKIGuess"><img src="https://avatars.githubusercontent.com/u/135974627?v=4" width="60" height="60" style="border-radius:50%" alt="MostlyKIGuess" /></a>
<a href="https://github.com/a-programmers-programmer"><img src="https://avatars.githubusercontent.com/u/161260774?v=4" width="60" height="60" style="border-radius:50%" alt="a-programmers-programmer" /></a>
<a href="https://github.com/patrick-fu"><img src="https://avatars.githubusercontent.com/u/20736775?v=4" width="60" height="60" style="border-radius:50%" alt="patrick-fu" /></a>

参加しませんか？下の[コントリビュート](#コントリビュート)セクションをご覧ください。

---

## Star履歴

Mystiがお役に立ちましたら、ぜひStarをお願いします — プロジェクトの発見を助け、私たちのモチベーションになります！

<p align="center">
  <a href="https://github.com/DeepMyst/Mysti/stargazers">
    <img src="https://img.shields.io/github/stars/DeepMyst/Mysti?style=for-the-badge&logo=github&color=yellow" alt="GitHub Stars" />
  </a>
</p>

<p align="center">
  <a href="https://star-history.com/#DeepMyst/Mysti&Date">
    <img src="https://api.star-history.com/svg?repos=DeepMyst/Mysti&type=Date" width="600" alt="Star履歴チャート" />
  </a>
</p>

---

## コントリビュート

コントリビューションを歓迎します！バグレポート、機能リクエスト、コード貢献など、何でもお待ちしています。

- **初めての方向けIssue**：[`good first issue`](https://github.com/DeepMyst/Mysti/labels/good%20first%20issue) ラベルをチェック
- **開発**：VS Codeで`F5`を押して拡張機能開発ホストを起動
- **Pull Request**：フォーク、機能ブランチ作成、PRを提出

詳細なガイドラインは [CONTRIBUTING.md](CONTRIBUTING.md) をご覧ください。

---

## ライセンス

Apache License 2.0 — 商用利用を含め、自由に使用、変更、配布できます。
完全なテキストは`LICENSE`ファイルをご覧ください。

---

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">インストール</a> •
  <a href="https://github.com/DeepMyst/Mysti/issues">問題を報告</a> •
  <a href="https://github.com/DeepMyst/Mysti">GitHub</a>
</p>

<p align="center">
  <strong>Mysti</strong> — <a href="https://www.deepmyst.com/mysti">DeepMyst Inc</a> が構築<br>
  <sub>Mystiで作成</sub>
</p>
