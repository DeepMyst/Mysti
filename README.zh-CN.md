<p align="center">
  <a href="README.md">English</a> | 简体中文 | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.ar.md">العربية</a> | <a href="README.de.md">Deutsch</a> | <a href="README.fr.md">Français</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.ru.md">Русский</a>
</p>

# Mysti - 你的 AI 编程团队协同工作

<p align="center">
  <img src="resources/Mysti-Logo.png" alt="Mysti 图标" width="128" height="128">
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/v/DeepMyst.mysti?style=flat-square&label=Version" alt="版本">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/i/DeepMyst.mysti?style=flat-square&label=Installs" alt="安装量">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/r/DeepMyst.mysti?style=flat-square&label=Rating" alt="评分">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/stargazers">
    <img src="https://img.shields.io/github/stars/DeepMyst/Mysti?style=flat-square&label=Stars" alt="GitHub Stars">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/network/members">
    <img src="https://img.shields.io/github/forks/DeepMyst/Mysti?style=flat-square&label=Forks" alt="GitHub Forks">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue?style=flat-square" alt="许可证">
  </a>
</p>

<p align="center">
  <strong>你的 VSCode AI 编程团队</strong><br>
  <em>11 个 AI 提供商 — Claude Code、Codex、Gemini、Copilot、Cline、Cursor、OpenClaw、OpenCode、Qwen Code、Ollama 和 LocalAI — 独立工作或团队协作</em><br>
  <em>群体智慧，多个智能体的集体智能超越单一智能体。</em>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/badge/从%20VS%20Code%20商店安装-007ACC?style=for-the-badge&logo=visual-studio-code" alt="从 VS Code 商店安装">
  </a>
</p>

<p align="center">
  <a href="#选择你的-ai">提供商</a> •
  <a href="#头脑风暴模式">头脑风暴</a> •
  <a href="#核心功能">功能</a> •
  <a href="#快速开始">快速开始</a> •
  <a href="#配置">配置</a> •
  <a href="#文档">文档</a>
</p>

---

## v0.3.4 新特性

### 11 个 AI 提供商

Mysti 现在支持 **11 个 AI 提供商** — 新增 **OpenCode**、**Qwen Code**、**Ollama** 和 **LocalAI**，与 Claude Code、Codex、Gemini、GitHub Copilot、Cline、Cursor 和 OpenClaw 并肩作战。使用 Ollama/LocalAI 运行本地模型，或使用 OpenCode 和 Qwen Code 等云端提供商。每个提供商在 UI 中都有独特的品牌图标。

### Qwen Code

阿里巴巴的 AI 编程 CLI，具备深度推理能力。使用与 Claude Code 相同的流式协议，实现无缝集成。支持 Qwen3 Coder 模型，提供 plan、auto-edit 和 yolo 审批模式。

### OpenCode

支持 Anthropic、OpenAI、Google 和 Groq 的多后端编程智能体，通过单一 CLI 实现。使用您配置的默认模型 — 不锁定特定提供商。

### 本地 AI 支持

使用 **Ollama** 和 **LocalAI** 在本地运行 AI 模型 — 无需云端订阅。完全隐私，零延迟，完全掌控您的模型。

---

## 秒速安装

**从 VS Code：** 按 `Ctrl+P`（Mac 上为 `Cmd+P`），然后粘贴：

```
ext install DeepMyst.mysti
```

**或者** [从 VS Code 商店安装](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti)

---

## 选择你的 AI

Mysti 与您已有的 AI 编程工具配合使用。**无需额外订阅。**

<p align="center">
  <img src="docs/gifs/agent switching.gif" alt="切换智能体" width="450">
</p>

| 提供商 | 最适合 |
|--------|--------|
| **Claude Code** | 深度推理、复杂重构、全面分析 |
| **Codex** | 快速迭代、熟悉的 OpenAI 风格 |
| **Gemini** | 快速响应、Google 生态系统集成 |
| **GitHub Copilot** | 通过 GitHub 订阅使用多模型（Claude、GPT-5、Gemini） |
| **Cline** | Plan/Act 模式、结构化任务完成 |
| **Cursor** | 自动模型选择、多模型支持 Claude、GPT-5、Gemini |
| **OpenClaw** | 实时 WebSocket 流式传输、可配置思考级别 |
| **OpenCode** | 多后端智能体（Anthropic、OpenAI、Google、Groq） |
| **Qwen Code** | 阿里巴巴 AI 编程智能体、深度推理 |
| **Ollama** | 本地 LLM 推理、隐私优先、无需订阅 |
| **LocalAI** | 自托管 AI 模型、完全掌控 |

**一键切换提供商。不锁定任何平台。**

### 为什么选择 Mysti？

| 对比 Copilot/Cursor | Mysti 优势 |
|---------------------|------------|
| 单一 AI | **多智能体头脑风暴** — 两个 AI 通过 5 种策略协作 |
| 锁定单一提供商 | **11 个提供商** — Claude、Codex、Gemini、Copilot、Cline、Cursor、OpenClaw、OpenCode、Qwen、Ollama、LocalAI |
| 黑盒操作 | **完整权限控制** — 从只读到完全访问 |
| 通用回复 | **16 种角色** — 架构师、调试专家、安全专家... |
| 手动工作流 | **自主模式** — AI 在安全控制下独立工作 |
| 无跨智能体路由 | **@提及** — 将任务内联路由到特定智能体 |

---

## 实际效果

<p align="center">
  <img src="docs/gifs/main screen.gif" alt="Mysti 聊天界面" width="700">
</p>

<p align="center"><em>美观现代的聊天界面，支持语法高亮、Markdown 渲染和 Mermaid 图表</em></p>

<p align="center">
  <img src="docs/gifs/Task list rendering and progress tracking.gif" alt="任务列表渲染" width="700">
</p>

<p align="center"><em>实时任务列表渲染和进度追踪</em></p>

---

## 头脑风暴模式

**想要第二意见？** 启用头脑风暴模式，让两个 AI 智能体一起解决您的问题。在设置面板中 **从 11 个智能体中选择任意 2 个**。

<p align="center">
  <img src="docs/gifs/brainstorm example.gif" alt="头脑风暴模式" width="700">
</p>

### 5 种协作策略

| 策略 | 角色 | 最适合 |
|------|------|--------|
| **Quick** | 直接综合 | 简单任务、快速回答 |
| **Debate** | 批评者 vs 辩护者 | 架构决策、权衡分析 |
| **Red-Team** | 提议者 vs 挑战者 | 安全审查、边界场景发现 |
| **Perspectives** | 风险分析师 vs 创新者 | 全新设计、技术选型 |
| **Delphi** | 协调者 vs 优化者 | 复杂问题、达成共识 |

### 为什么两个 AI 胜过一个

**Claude Code**（Anthropic）、**Codex**（OpenAI）、**Gemini**（Google）、**GitHub Copilot**、**Cline**、**Cursor**、**OpenClaw**、**OpenCode**、**Qwen Code**（阿里巴巴）、**Ollama** 和 **LocalAI** 拥有不同的训练数据、不同的优势和不同的盲点。当任意两个协同工作时：

- 每个 AI 能发现另一个可能遗漏的边界场景
- 不同的视角带来更健壮的解决方案
- **它们一起** 辩论、相互挑战，并综合出最佳方案

这就像有一位高级开发者和一位技术负责人审查你的代码 — 不同的是，他们会先进行讨论。

### 收敛检测

在讨论过程中，Mysti 追踪智能体的一致性和立场稳定性。当启用 **自动收敛** 时，一旦智能体达成共识，讨论会提前结束 — 节省时间而不牺牲质量。

### 选择你的团队

在**设置面板**中配置哪两个智能体协作：

<p align="center">
  <img src="docs/gifs/Brainstorm model selection.gif" alt="头脑风暴模型选择" width="600">
</p>

| 组合 | 最适合 |
|------|--------|
| Claude + Codex | 深度分析与快速迭代相结合 |
| Claude + Gemini | 深入推理配合快速验证 |
| Claude + Copilot | 对比原生 Claude 与 Copilot 的多模型方案 |
| Cursor + Gemini | 多模型灵活性配合 Google 集成 |
| OpenClaw + Claude | WebSocket 流式传输配合深度推理 |
| Qwen + Claude | 对比阿里巴巴与 Anthropic 的推理能力 |
| OpenCode + Gemini | 多后端灵活性配合 Google 速度 |
| Ollama + Claude | 本地隐私与云端智能相结合 |

[完整头脑风暴文档](docs/BRAINSTORM.md)

### 智能方案检测

当 AI 提供多种实现方案时，Mysti 会自动检测并让您选择偏好的路径。

<p align="center">
  <img src="docs/screenshots/plan-suggestions.png" alt="方案建议" width="600">
</p>

*需要至少安装 2 个 CLI 工具。参见[系统要求](#系统要求)。*

---

## 核心功能

### 自主模式

让 AI 在可配置的安全控制下独立工作：

- **安全分类器**：三个级别 — 安全（自动批准）、警告（取决于模式）、阻止（始终拒绝）
- **三种安全模式**：保守、平衡、激进
- **学习记忆**：记住您的权限偏好，并随时间改进
- **继续模式**：基于目标或任务队列的扩展自主会话
- **审计追踪**：每个自主决策都有记录可供审查

<p align="center">
  <img src="docs/gifs/Selecting autonomy mode.gif" alt="选择自主模式" width="600">
</p>

[完整自主模式文档](docs/AUTONOMOUS-MODE.md)

### @提及系统

将任务路由到特定智能体并内联引用文件：

<p align="center">
  <img src="docs/gifs/Agent tagging and multi agent workflows.gif" alt="@提及标记" width="600">
</p>

```
@claude 审查这段代码的安全问题
@src/auth.ts @gemini 为此文件建议性能优化
@claude 编写测试，然后 @codex 优化它们
```

- **文件提及**：`@filename` 添加临时上下文
- **智能体提及**：`@agent` 将任务路由到该提供商
- **链式调用**：后续智能体接收前面智能体的响应作为上下文

[完整 @提及文档](docs/MENTIONS.md)

### 上下文压缩

智能对话管理，防止上下文溢出：

- **自动触发**：当令牌使用量接近阈值时触发（默认 75%）
- **原生支持**：Claude Code 使用内置 `/compact` 命令
- **客户端压缩**：其他提供商使用智能消息摘要
- **按面板追踪**：每个聊天面板独立追踪使用量

[完整压缩文档](docs/COMPACTION.md)

### 16 种开发者角色

塑造 AI 的思维方式。从专业角色中选择，改变 AI 处理问题的方式。

<p align="center">
  <img src="docs/gifs/Personas and skills.gif" alt="角色和技能面板" width="550">
</p>

| 角色 | 专注领域 |
|------|----------|
| **架构师** | 系统设计、可扩展性、清晰结构 |
| **调试专家** | 根因分析、Bug 修复 |
| **安全专家** | 漏洞发现、威胁建模 |
| **性能调优师** | 优化、性能分析、延迟优化 |
| **原型开发者** | 快速迭代、概念验证 |
| **重构专家** | 代码质量、可维护性 |
| + 10 种更多... | 全栈、DevOps、导师、设计师... |

[完整角色与技能文档](docs/PERSONAS-AND-SKILLS.md)

---

### 快速角色选择

直接从工具栏选择角色，无需打开面板。

<p align="center">
  <img src="docs/screenshots/persona-toolbar.png" alt="工具栏角色选择" width="550">
</p>

---

### 智能自动建议

Mysti 根据您的消息自动建议相关角色和操作。

<p align="center">
  <img src="docs/gifs/PErsona Suggestion.gif" alt="自动建议" width="550">
</p>

---

### 对话历史

永不丢失您的工作成果。所有对话都会保存并可轻松访问。

<p align="center">
  <img src="docs/screenshots/conversation-history.png" alt="对话历史" width="450">
</p>

---

### 欢迎页快捷操作

通过一键操作快速开始常见任务。

<p align="center">
  <img src="docs/screenshots/quick-actions-welcome.png" alt="快捷操作" width="550">
</p>

---

### 丰富的设置选项

微调 Mysti 的各个方面，包括令牌预算、访问级别和头脑风暴模式。

<p align="center">
  <img src="docs/screenshots/settings-panel.png" alt="设置面板" width="450">
</p>

---

## 系统要求

**已经在使用 Claude、ChatGPT、Gemini 或 GitHub Copilot？您已准备就绪。**

Mysti 使用您现有的订阅 — 无需额外费用！

| CLI 工具 | 订阅要求 | 安装方式 |
|----------|----------|----------|
| **Claude Code**（推荐） | Anthropic API 或 Claude Pro/Max | `npm install -g @anthropic-ai/claude-code` |
| **GitHub Copilot CLI** | GitHub Copilot Pro/Pro+/Business | `npm install -g @github/copilot-cli` |
| **Gemini CLI** | Google AI API 或 Gemini Advanced | `npm install -g @google/gemini-cli` |
| **Codex CLI** | OpenAI API | 参考 OpenAI 安装指南 |
| **Cline** | 取决于模型提供商 | `npm install -g cline` |
| **Cursor** | Cursor 订阅 | `curl https://cursor.com/install -fsS \| bash` |
| **OpenClaw** | OpenClaw 账户 | `npm install -g openclaw@latest && openclaw onboard --install-daemon` |
| **OpenCode** | 提供商 API 密钥（Anthropic、OpenAI 等） | `npm i -g opencode-ai@latest` |
| **Qwen Code** | Qwen OAuth 或 API 密钥 | `npm install -g @qwen-code/qwen-code@latest` |
| **Ollama** | 本地（无需订阅） | [从 ollama.com 安装](https://ollama.com) |
| **LocalAI** | 本地（无需订阅） | [从 localai.io 安装](https://localai.io) |

您只需 **一个** CLI 即可开始使用。安装 **任意两个** 即可解锁头脑风暴模式。

---

## 快速开始

### 1. 安装 Mysti

**方式 A：** 按 `Ctrl+P`（Mac 上为 `Cmd+P`），粘贴并运行：
```
ext install DeepMyst.mysti
```

**方式 B：** [从 VS Code 商店安装](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti)

### 2. 安装 CLI 工具

```bash
# Claude Code（推荐）
npm install -g @anthropic-ai/claude-code
claude auth login

# 或 GitHub Copilot CLI（通过 GitHub 使用 Claude、GPT-5、Gemini）
npm install -g @github/copilot-cli
copilot  # 然后使用 /login 命令

# 或 Gemini CLI
npm install -g @google/gemini-cli
gemini auth login

# 或 Cursor
curl https://cursor.com/install -fsS | bash
agent login

# 或 OpenClaw
npm install -g openclaw@latest && openclaw onboard --install-daemon
openclaw login

# 或 OpenCode
npm i -g opencode-ai@latest
opencode auth login

# 或 Qwen Code
npm install -g @qwen-code/qwen-code@latest
qwen  # 然后输入 /auth
```

要使用头脑风暴模式，请安装任意两个 CLI 工具。

### 3. 打开 Mysti

- 点击活动栏中的 **Mysti 图标**，或
- 按 `Ctrl+Shift+M`（Mac 上为 `Cmd+Shift+M`）

### 4. 开始编程

输入您的请求，让 AI 来协助您！

---

## 斜杠命令

使用内置的斜杠命令菜单快速访问技能和操作。

<p align="center">
  <img src="docs/gifs/slash commands menu.gif" alt="斜杠命令菜单" width="600">
</p>

---

## 12 种可切换技能

混合搭配行为修饰符：

- **简洁** - 清晰、简短的沟通
- **测试驱动** - 随代码编写测试
- **自动提交** - 增量式提交
- **第一性原理** - 基本原理推理
- **范围约束** - 专注于当前任务
- 还有 7 种更多...

[完整角色与技能文档](docs/PERSONAS-AND-SKILLS.md)

---

## 权限控制

掌控 AI 的操作权限：

- **只读** - AI 只能读取，不能修改
- **请求权限** - 逐一批准每个文件更改
- **完全访问** - 让 AI 自主工作

<p align="center">
  <img src="docs/gifs/Semi auto answering questions .gif" alt="权限控制演示" width="600">
</p>

---

## 配置

### 基本设置

```json
{
  "mysti.defaultProvider": "claude-code",
  "mysti.brainstorm.agents": ["claude-code", "google-gemini"],
  "mysti.brainstorm.strategy": "quick",
  "mysti.accessLevel": "ask-permission"
}
```

### 提供商设置

| 设置 | 默认值 | 描述 |
|------|--------|------|
| `mysti.defaultProvider` | `claude-code` | 主要 AI 提供商 |
| `mysti.claudePath` | `claude` | Claude CLI 路径 |
| `mysti.codexPath` | `codex` | Codex CLI 路径 |
| `mysti.geminiPath` | `gemini` | Gemini CLI 路径 |
| `mysti.copilotPath` | `copilot` | Copilot CLI 路径 |
| `mysti.clinePath` | `cline` | Cline CLI 路径 |
| `mysti.cursorPath` | `agent` | Cursor CLI 路径 |
| `mysti.openclawPath` | `openclaw` | OpenClaw CLI 路径 |
| `mysti.opencodePath` | `opencode` | OpenCode CLI 路径 |
| `mysti.qwenCodePath` | `qwen` | Qwen Code CLI 路径 |
| `mysti.ollamaPath` | `ollama` | Ollama CLI 路径 |
| `mysti.localaiPath` | `localai` | LocalAI CLI 路径 |

### 头脑风暴设置

| 设置 | 默认值 | 描述 |
|------|--------|------|
| `mysti.brainstorm.agents` | `["claude-code", "openai-codex"]` | 使用哪 2 个智能体 |
| `mysti.brainstorm.strategy` | `quick` | 策略：`quick`、`debate`、`red-team`、`perspectives`、`delphi` |
| `mysti.brainstorm.autoConverge` | `true` | 智能体达成共识时自动退出 |
| `mysti.brainstorm.maxDiscussionRounds` | `3` | 最大讨论轮数 |

### 自主模式设置

| 设置 | 默认值 | 描述 |
|------|--------|------|
| `mysti.autonomous.safetyMode` | `balanced` | `conservative`、`balanced`、`aggressive` |
| `mysti.autonomous.blockPatterns` | `[]` | 始终阻止的自定义模式 |

### 压缩设置

| 设置 | 默认值 | 描述 |
|------|--------|------|
| `mysti.compaction.enabled` | `true` | 启用上下文压缩 |
| `mysti.compaction.threshold` | `75` | 压缩阈值（上下文窗口的百分比） |

### 通用设置

| 设置 | 默认值 | 描述 |
|------|--------|------|
| `mysti.accessLevel` | `ask-permission` | 文件访问级别 |
| `mysti.agents.autoSuggest` | `true` | 自动建议角色 |
| `mysti.agents.maxTokenBudget` | `0` | 智能体上下文的最大令牌数（0 = 无限制） |

[完整提供商文档](docs/PROVIDERS.md)

---

## 快捷键

| 操作 | Windows/Linux | Mac |
|------|---------------|-----|
| 打开 Mysti | `Ctrl+Shift+M` | `Cmd+Shift+M` |
| 在新标签中打开 | `Ctrl+Shift+N` | `Cmd+Shift+N` |

---

## 命令

| 命令 | 描述 |
|------|------|
| `Mysti: Open Chat` | 打开聊天侧栏 |
| `Mysti: New Conversation` | 开始新对话 |
| `Mysti: Add to Context` | 添加文件/选区到上下文 |
| `Mysti: Clear Context` | 清除所有上下文 |
| `Mysti: Open in New Tab` | 在编辑器标签中打开聊天 |

---

## 文档

| 指南 | 描述 |
|------|------|
| [提供商](docs/PROVIDERS.md) | 全部 11 个提供商 — 设置、模型、功能 |
| [头脑风暴模式](docs/BRAINSTORM.md) | 5 种策略、收敛检测、团队选择 |
| [角色与技能](docs/PERSONAS-AND-SKILLS.md) | 16 种角色、12 种技能、自定义智能体 |
| [自主模式](docs/AUTONOMOUS-MODE.md) | 安全系统、记忆、继续模式 |
| [@提及](docs/MENTIONS.md) | 智能体路由和文件上下文 |
| [压缩](docs/COMPACTION.md) | 上下文管理和摘要 |
| [架构](docs/ARCHITECTURE.md) | 技术内部实现和扩展点 |
| [功能](docs/FEATURES.md) | 完整功能参考 |

---

## 遥测

Mysti 收集**匿名**使用数据以改进扩展：

- 功能使用模式
- 错误率
- 提供商偏好

**绝不收集代码、文件路径或个人数据。**

遵循 VSCode 的遥测设置。通过以下方式禁用：
设置 > Telemetry: Telemetry Level > off

---

## 贡献者

感谢所有帮助改进 Mysti 的人！

<a href="https://github.com/BahaAbuNojaim"><img src="https://avatars.githubusercontent.com/u/6247079?v=4" width="60" height="60" style="border-radius:50%" alt="BahaAbuNojaim" /></a>
<a href="https://github.com/MostlyKIGuess"><img src="https://avatars.githubusercontent.com/u/135974627?v=4" width="60" height="60" style="border-radius:50%" alt="MostlyKIGuess" /></a>
<a href="https://github.com/a-programmers-programmer"><img src="https://avatars.githubusercontent.com/u/161260774?v=4" width="60" height="60" style="border-radius:50%" alt="a-programmers-programmer" /></a>
<a href="https://github.com/patrick-fu"><img src="https://avatars.githubusercontent.com/u/20736775?v=4" width="60" height="60" style="border-radius:50%" alt="patrick-fu" /></a>

想加入他们？查看下面的[贡献](#贡献)部分。

---

## Star 历史

如果 Mysti 对您有帮助，请考虑给它一个 Star — 这有助于更多人发现这个项目，也是对我们的鼓励！

<p align="center">
  <a href="https://github.com/DeepMyst/Mysti/stargazers">
    <img src="https://img.shields.io/github/stars/DeepMyst/Mysti?style=for-the-badge&logo=github&color=yellow" alt="GitHub Stars" />
  </a>
</p>

<p align="center">
  <a href="https://star-history.com/#DeepMyst/Mysti&Date">
    <img src="https://api.star-history.com/svg?repos=DeepMyst/Mysti&type=Date" width="600" alt="Star 历史图表" />
  </a>
</p>

---

## 贡献

我们欢迎贡献！无论是 Bug 报告、功能请求还是代码贡献。

- **好的入门 Issue**：查找 [`good first issue`](https://github.com/DeepMyst/Mysti/labels/good%20first%20issue) 标签
- **开发**：在 VS Code 中按 `F5` 启动扩展开发宿主
- **Pull Request**：Fork、创建功能分支并提交 PR

详细指南请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 许可证

Apache License 2.0 — 可自由使用、修改和分发，包括商业用途。
查看 `LICENSE` 文件获取完整文本。

---

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">安装</a> •
  <a href="https://github.com/DeepMyst/Mysti/issues">报告问题</a> •
  <a href="https://github.com/DeepMyst/Mysti">GitHub</a>
</p>

<p align="center">
  <strong>Mysti</strong> — 由 <a href="https://www.deepmyst.com/mysti">DeepMyst Inc</a> 构建<br>
  <sub>使用 Mysti 制作</sub>
</p>
