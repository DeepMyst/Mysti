<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja.md">日本語</a> | 한국어 | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.ar.md">العربية</a> | <a href="README.de.md">Deutsch</a> | <a href="README.fr.md">Français</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.ru.md">Русский</a>
</p>

# Mysti - 함께 일하는 AI 코딩 팀

<p align="center">
  <img src="resources/Mysti-Logo.png" alt="Mysti 로고" width="128" height="128">
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/v/DeepMyst.mysti?style=flat-square&label=Version" alt="버전">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/i/DeepMyst.mysti?style=flat-square&label=Installs" alt="설치 수">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/r/DeepMyst.mysti?style=flat-square&label=Rating" alt="평점">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/stargazers">
    <img src="https://img.shields.io/github/stars/DeepMyst/Mysti?style=flat-square&label=Stars" alt="GitHub Stars">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/network/members">
    <img src="https://img.shields.io/github/forks/DeepMyst/Mysti?style=flat-square&label=Forks" alt="GitHub Forks">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue?style=flat-square" alt="라이선스">
  </a>
</p>

<p align="center">
  <strong>VSCode를 위한 AI 코딩 팀</strong><br>
  <em>11개의 AI 프로바이더 — Claude Code, Codex, Gemini, Copilot, Cline, Cursor, OpenClaw, OpenCode, Qwen Code, Ollama & LocalAI — 단독 또는 팀으로 작업</em><br>
  <em>집단 지성의 힘 — 여러 에이전트의 집합적 지능이 단일 에이전트를 능가합니다.</em>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/badge/VS%20Code%20마켓플레이스에서%20설치-007ACC?style=for-the-badge&logo=visual-studio-code" alt="VS Code 마켓플레이스에서 설치">
  </a>
</p>

<p align="center">
  <a href="#ai-선택하기">프로바이더</a> •
  <a href="#브레인스토밍-모드">브레인스토밍</a> •
  <a href="#주요-기능">기능</a> •
  <a href="#빠른-시작">빠른 시작</a> •
  <a href="#설정">설정</a> •
  <a href="#문서">문서</a>
</p>

---

## v0.3.4 새로운 기능

### 11개의 AI 프로바이더

Mysti는 이제 **11개의 AI 프로바이더**를 지원합니다 — **OpenCode**, **Qwen Code**, **Ollama**, **LocalAI**가 새로 추가되어 Claude Code, Codex, Gemini, GitHub Copilot, Cline, Cursor, OpenClaw와 함께 사용할 수 있습니다. Ollama/LocalAI로 로컬 모델을 실행하거나 OpenCode, Qwen Code 같은 클라우드 프로바이더를 사용하세요. 각 프로바이더는 UI에서 고유한 로고를 표시합니다.

### Qwen Code

알리바바의 깊은 추론 능력을 갖춘 AI 코딩 CLI. Claude Code와 동일한 스트리밍 프로토콜을 사용하여 매끄럽게 통합됩니다. Qwen3 Coder 모델을 지원하며 plan, auto-edit, yolo 승인 모드를 제공합니다.

### OpenCode

Anthropic, OpenAI, Google, Groq를 지원하는 멀티 백엔드 코딩 에이전트. 단일 CLI로 구현됩니다. 설정된 기본 모델을 사용 — 특정 프로바이더에 종속되지 않습니다.

### 로컬 AI 지원

**Ollama**와 **LocalAI**로 AI 모델을 로컬에서 실행 — 클라우드 구독이 필요 없습니다. 완벽한 프라이버시, 제로 레이턴시, 모델에 대한 완전한 제어.

---

## 몇 초 만에 설치

**VS Code에서:** `Ctrl+P` (Mac에서는 `Cmd+P`)를 누른 후 붙여넣기:

```
ext install DeepMyst.mysti
```

**또는** [VS Code 마켓플레이스에서 설치](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti)

---

## AI 선택하기

Mysti는 이미 사용 중인 AI 코딩 도구와 함께 작동합니다. **추가 구독이 필요 없습니다.**

<p align="center">
  <img src="docs/gifs/agent switching.gif" alt="에이전트 전환" width="450">
</p>

| 프로바이더 | 최적 용도 |
|-----------|----------|
| **Claude Code** | 깊은 추론, 복잡한 리팩토링, 철저한 분석 |
| **Codex** | 빠른 반복, 익숙한 OpenAI 스타일 |
| **Gemini** | 빠른 응답, Google 생태계 통합 |
| **GitHub Copilot** | GitHub 구독으로 멀티 모델 액세스 (Claude, GPT-5, Gemini) |
| **Cline** | Plan/Act 모드, 구조화된 작업 완료 |
| **Cursor** | 자동 모델 선택, Claude, GPT-5, Gemini 멀티 모델 |
| **OpenClaw** | 실시간 WebSocket 스트리밍, 구성 가능한 사고 레벨 |
| **OpenCode** | 멀티 백엔드 에이전트 (Anthropic, OpenAI, Google, Groq) |
| **Qwen Code** | 알리바바의 AI 코딩 에이전트, 깊은 추론 |
| **Ollama** | 로컬 LLM 추론, 프라이버시 우선, 구독 불필요 |
| **LocalAI** | 셀프 호스팅 AI 모델, 완전한 제어 |

**원클릭으로 프로바이더 전환. 종속성 없음.**

### 왜 Mysti인가?

| Copilot/Cursor 대비 | Mysti 장점 |
|--------------------|-----------|
| 단일 AI | **멀티 에이전트 브레인스토밍** — 2개의 AI가 5가지 전략으로 협업 |
| 단일 프로바이더 종속 | **11개 프로바이더** — Claude, Codex, Gemini, Copilot, Cline, Cursor, OpenClaw, OpenCode, Qwen, Ollama, LocalAI |
| 블랙박스 | **완전한 권한 제어** — 읽기 전용부터 전체 액세스까지 |
| 일반적인 응답 | **16개 페르소나** — 아키텍트, 디버거, 보안 전문가... |
| 수동 워크플로우 | **자율 모드** — AI가 안전 제어 하에 독립적으로 작업 |
| 크로스 에이전트 라우팅 없음 | **@멘션** — 인라인으로 특정 에이전트에 작업 라우팅 |

---

## 실제 동작

<p align="center">
  <img src="docs/gifs/main screen.gif" alt="Mysti 채팅 인터페이스" width="700">
</p>

<p align="center"><em>구문 강조, Markdown 지원, Mermaid 다이어그램을 갖춘 아름답고 현대적인 채팅 인터페이스</em></p>

<p align="center">
  <img src="docs/gifs/Task list rendering and progress tracking.gif" alt="작업 목록 렌더링" width="700">
</p>

<p align="center"><em>실시간 작업 목록 렌더링 및 진행 상황 추적</em></p>

---

## 브레인스토밍 모드

**두 번째 의견이 필요하세요?** 브레인스토밍 모드를 활성화하고 2개의 AI 에이전트가 함께 문제를 해결하게 하세요. 설정 패널에서 **11개 에이전트 중 아무 2개나 선택**하세요.

<p align="center">
  <img src="docs/gifs/brainstorm example.gif" alt="브레인스토밍 모드" width="700">
</p>

### 5가지 협업 전략

| 전략 | 역할 | 최적 용도 |
|------|------|----------|
| **Quick** | 직접 종합 | 간단한 작업, 빠른 답변 |
| **Debate** | 비평가 vs 옹호자 | 아키텍처 결정, 트레이드오프 |
| **Red-Team** | 제안자 vs 도전자 | 보안 리뷰, 엣지 케이스 발견 |
| **Perspectives** | 리스크 분석가 vs 혁신가 | 그린필드 설계, 기술 선택 |
| **Delphi** | 진행자 vs 개선자 | 복잡한 문제, 합의 도달 |

### 2개의 AI가 1개보다 나은 이유

**Claude Code** (Anthropic), **Codex** (OpenAI), **Gemini** (Google), **GitHub Copilot**, **Cline**, **Cursor**, **OpenClaw**, **OpenCode**, **Qwen Code** (알리바바), **Ollama**, **LocalAI**는 서로 다른 훈련, 서로 다른 강점, 서로 다른 약점을 가지고 있습니다. 아무 2개가 함께 작동하면:

- 각 AI가 상대방이 놓칠 수 있는 엣지 케이스를 발견
- 서로 다른 관점이 더 견고한 솔루션으로 이어짐
- **함께** 토론하고, 서로 도전하며, 최상의 솔루션을 종합

시니어 개발자와 테크 리드가 코드를 리뷰하는 것과 같습니다 — 다만 실제로 먼저 토론한다는 점이 다릅니다.

### 수렴 감지

토론 중 Mysti는 에이전트의 합의와 입장 안정성을 추적합니다. **자동 수렴**이 활성화되면 에이전트가 합의에 도달하면 토론이 조기에 종료됩니다 — 품질을 희생하지 않고 시간을 절약합니다.

### 팀 선택하기

**설정 패널**에서 어떤 2개의 에이전트가 협업할지 구성:

<p align="center">
  <img src="docs/gifs/Brainstorm model selection.gif" alt="브레인스토밍 모델 선택" width="600">
</p>

| 조합 | 최적 용도 |
|------|----------|
| Claude + Codex | 깊은 분석과 빠른 반복의 결합 |
| Claude + Gemini | 철저한 추론과 빠른 검증 |
| Claude + Copilot | 네이티브 Claude vs Copilot의 멀티 모델 접근 비교 |
| Cursor + Gemini | 멀티 모델 유연성과 Google 통합 |
| OpenClaw + Claude | WebSocket 스트리밍과 깊은 추론 |
| Qwen + Claude | 알리바바와 Anthropic의 추론 비교 |
| OpenCode + Gemini | 멀티 백엔드 유연성과 Google 속도 |
| Ollama + Claude | 로컬 프라이버시와 클라우드 지능의 결합 |

[브레인스토밍 전체 문서](docs/BRAINSTORM.md)

### 지능형 플랜 감지

AI가 여러 구현 접근 방식을 제시하면 Mysti가 자동으로 감지하여 선호하는 경로를 선택할 수 있게 합니다.

<p align="center">
  <img src="docs/screenshots/plan-suggestions.png" alt="플랜 제안" width="600">
</p>

*최소 2개의 CLI 도구가 설치되어 있어야 합니다. [요구 사항](#요구-사항)을 참조하세요.*

---

## 주요 기능

### 자율 모드

구성 가능한 안전 제어로 AI가 독립적으로 작업하게 합니다:

- **안전 분류기**: 3단계 — 안전 (자동 승인), 주의 (모드 의존), 차단 (항상 거부)
- **3가지 안전 모드**: 보수적, 균형, 적극적
- **학습 메모리**: 권한 선호도를 기억하고 시간이 지남에 따라 개선
- **계속 모드**: 목표 기반 또는 작업 대기열의 확장 자율 세션
- **감사 추적**: 모든 자율 결정이 검토를 위해 기록됨

<p align="center">
  <img src="docs/gifs/Selecting autonomy mode.gif" alt="자율 모드 선택" width="600">
</p>

[자율 모드 전체 문서](docs/AUTONOMOUS-MODE.md)

### @멘션 시스템

특정 에이전트에 작업을 라우팅하고 파일을 인라인으로 참조:

<p align="center">
  <img src="docs/gifs/Agent tagging and multi agent workflows.gif" alt="@멘션 태그" width="600">
</p>

```
@claude 이 코드의 보안 문제 검토
@src/auth.ts @gemini 이 파일의 성능 개선 제안
@claude 테스트 작성, 그런 다음 @codex 최적화
```

- **파일 멘션**: `@filename`으로 임시 컨텍스트 추가
- **에이전트 멘션**: `@agent`로 해당 프로바이더에 작업 라우팅
- **체이닝**: 이후 에이전트가 이전 에이전트의 응답을 컨텍스트로 수신

[@멘션 전체 문서](docs/MENTIONS.md)

### 컨텍스트 압축

컨텍스트 오버플로우를 방지하는 스마트한 대화 관리:

- **자동**: 토큰 사용량이 임계값에 접근하면 트리거 (기본 75%)
- **네이티브 지원**: Claude Code는 내장 `/compact` 명령 사용
- **클라이언트 측**: 다른 프로바이더는 지능형 메시지 요약 사용
- **패널별 추적**: 각 채팅 패널이 독립적으로 사용량 추적

[압축 전체 문서](docs/COMPACTION.md)

### 16개의 개발자 페르소나

AI의 사고 방식을 형성합니다. 전문 페르소나를 선택하여 AI의 문제 접근 방식을 변경합니다.

<p align="center">
  <img src="docs/gifs/Personas and skills.gif" alt="페르소나와 스킬 패널" width="550">
</p>

| 페르소나 | 초점 |
|---------|------|
| **아키텍트** | 시스템 설계, 확장성, 깔끔한 구조 |
| **디버거** | 근본 원인 분석, 버그 수정 |
| **보안 전문가** | 취약점, 위협 모델링 |
| **성능 튜너** | 최적화, 프로파일링, 레이턴시 |
| **프로토타이퍼** | 빠른 반복, PoC |
| **리팩토러** | 코드 품질, 유지보수성 |
| + 10개 더... | 풀스택, DevOps, 멘토, 디자이너... |

[페르소나 & 스킬 전체 문서](docs/PERSONAS-AND-SKILLS.md)

---

### 빠른 페르소나 선택

패널을 열지 않고 툴바에서 직접 페르소나 선택.

<p align="center">
  <img src="docs/screenshots/persona-toolbar.png" alt="툴바 페르소나 선택" width="550">
</p>

---

### 스마트 자동 제안

Mysti가 메시지를 기반으로 관련 페르소나와 액션을 자동 제안합니다.

<p align="center">
  <img src="docs/gifs/PErsona Suggestion.gif" alt="자동 제안" width="550">
</p>

---

### 대화 기록

작업을 잃지 않습니다. 모든 대화가 저장되고 쉽게 접근할 수 있습니다.

<p align="center">
  <img src="docs/screenshots/conversation-history.png" alt="대화 기록" width="450">
</p>

---

### 환영 화면 빠른 액션

일반적인 작업을 위한 원클릭 액션으로 빠르게 시작.

<p align="center">
  <img src="docs/screenshots/quick-actions-welcome.png" alt="빠른 액션" width="550">
</p>

---

### 풍부한 설정

토큰 예산, 액세스 레벨, 브레인스토밍 모드 등 Mysti의 모든 측면을 미세 조정.

<p align="center">
  <img src="docs/screenshots/settings-panel.png" alt="설정 패널" width="450">
</p>

---

## 요구 사항

**이미 Claude, ChatGPT, Gemini, 또는 GitHub Copilot을 사용 중이세요? 바로 시작할 수 있습니다.**

Mysti는 기존 구독으로 작동 — 추가 비용 없음!

| CLI 도구 | 구독 | 설치 |
|----------|------|------|
| **Claude Code** (추천) | Anthropic API 또는 Claude Pro/Max | `npm install -g @anthropic-ai/claude-code` |
| **GitHub Copilot CLI** | GitHub Copilot Pro/Pro+/Business | `npm install -g @github/copilot-cli` |
| **Gemini CLI** | Google AI API 또는 Gemini Advanced | `npm install -g @google/gemini-cli` |
| **Codex CLI** | OpenAI API | OpenAI 설치 가이드 참조 |
| **Cline** | 모델 프로바이더에 따라 다름 | `npm install -g cline` |
| **Cursor** | Cursor 구독 | `curl https://cursor.com/install -fsS \| bash` |
| **OpenClaw** | OpenClaw 계정 | `npm install -g openclaw@latest && openclaw onboard --install-daemon` |
| **OpenCode** | 프로바이더 API 키 (Anthropic, OpenAI 등) | `npm i -g opencode-ai@latest` |
| **Qwen Code** | Qwen OAuth 또는 API 키 | `npm install -g @qwen-code/qwen-code@latest` |
| **Ollama** | 로컬 (구독 불필요) | [ollama.com에서 설치](https://ollama.com) |
| **LocalAI** | 로컬 (구독 불필요) | [localai.io에서 설치](https://localai.io) |

시작하려면 **1개**의 CLI만 있으면 됩니다. **아무 2개**를 설치하면 브레인스토밍 모드가 해제됩니다.

---

## 빠른 시작

### 1. Mysti 설치

**방법 A:** `Ctrl+P` (Mac에서는 `Cmd+P`)를 누르고, 붙여넣기 후 실행:
```
ext install DeepMyst.mysti
```

**방법 B:** [VS Code 마켓플레이스에서 설치](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti)

### 2. CLI 도구 설치

```bash
# Claude Code (추천)
npm install -g @anthropic-ai/claude-code
claude auth login

# 또는 GitHub Copilot CLI (GitHub를 통해 Claude, GPT-5, Gemini 액세스)
npm install -g @github/copilot-cli
copilot  # 그런 다음 /login 명령 사용

# 또는 Gemini CLI
npm install -g @google/gemini-cli
gemini auth login

# 또는 Cursor
curl https://cursor.com/install -fsS | bash
agent login

# 또는 OpenClaw
npm install -g openclaw@latest && openclaw onboard --install-daemon
openclaw login

# 또는 OpenCode
npm i -g opencode-ai@latest
opencode auth login

# 또는 Qwen Code
npm install -g @qwen-code/qwen-code@latest
qwen  # 그런 다음 /auth 입력
```

브레인스토밍 모드를 사용하려면 아무 2개의 CLI 도구를 설치하세요.

### 3. Mysti 열기

- 활동 표시줄에서 **Mysti 아이콘** 클릭, 또는
- `Ctrl+Shift+M` (Mac에서는 `Cmd+Shift+M`) 누르기

### 4. 코딩 시작

요청을 입력하고 AI의 도움을 받으세요!

---

## 슬래시 명령

내장 슬래시 명령 메뉴로 스킬과 액션에 빠르게 접근.

<p align="center">
  <img src="docs/gifs/slash commands menu.gif" alt="슬래시 명령 메뉴" width="600">
</p>

---

## 12개의 전환 가능한 스킬

행동 수정자를 자유롭게 조합:

- **간결** - 명확하고 짧은 커뮤니케이션
- **테스트 주도** - 코드와 함께 테스트 작성
- **자동 커밋** - 증분 커밋
- **제1원리** - 기본 원리 추론
- **범위 규율** - 작업에 집중
- 그리고 7개 더...

[페르소나 & 스킬 전체 문서](docs/PERSONAS-AND-SKILLS.md)

---

## 권한 제어

AI가 할 수 있는 것을 제어:

- **읽기 전용** - AI는 읽기만 가능, 수정 불가
- **권한 요청** - 각 파일 변경을 승인
- **전체 액세스** - AI가 자율적으로 작업

<p align="center">
  <img src="docs/gifs/Semi auto answering questions .gif" alt="권한 제어 데모" width="600">
</p>

---

## 설정

### 기본 설정

```json
{
  "mysti.defaultProvider": "claude-code",
  "mysti.brainstorm.agents": ["claude-code", "google-gemini"],
  "mysti.brainstorm.strategy": "quick",
  "mysti.accessLevel": "ask-permission"
}
```

### 프로바이더 설정

| 설정 | 기본값 | 설명 |
|------|-------|------|
| `mysti.defaultProvider` | `claude-code` | 기본 AI 프로바이더 |
| `mysti.claudePath` | `claude` | Claude CLI 경로 |
| `mysti.codexPath` | `codex` | Codex CLI 경로 |
| `mysti.geminiPath` | `gemini` | Gemini CLI 경로 |
| `mysti.copilotPath` | `copilot` | Copilot CLI 경로 |
| `mysti.clinePath` | `cline` | Cline CLI 경로 |
| `mysti.cursorPath` | `agent` | Cursor CLI 경로 |
| `mysti.openclawPath` | `openclaw` | OpenClaw CLI 경로 |
| `mysti.opencodePath` | `opencode` | OpenCode CLI 경로 |
| `mysti.qwenCodePath` | `qwen` | Qwen Code CLI 경로 |
| `mysti.ollamaPath` | `ollama` | Ollama CLI 경로 |
| `mysti.localaiPath` | `localai` | LocalAI CLI 경로 |

### 브레인스토밍 설정

| 설정 | 기본값 | 설명 |
|------|-------|------|
| `mysti.brainstorm.agents` | `["claude-code", "openai-codex"]` | 사용할 2개의 에이전트 |
| `mysti.brainstorm.strategy` | `quick` | 전략: `quick`, `debate`, `red-team`, `perspectives`, `delphi` |
| `mysti.brainstorm.autoConverge` | `true` | 에이전트가 수렴하면 자동 종료 |
| `mysti.brainstorm.maxDiscussionRounds` | `3` | 최대 토론 라운드 수 |

### 자율 모드 설정

| 설정 | 기본값 | 설명 |
|------|-------|------|
| `mysti.autonomous.safetyMode` | `balanced` | `conservative`, `balanced`, `aggressive` |
| `mysti.autonomous.blockPatterns` | `[]` | 항상 차단할 사용자 지정 패턴 |

### 압축 설정

| 설정 | 기본값 | 설명 |
|------|-------|------|
| `mysti.compaction.enabled` | `true` | 컨텍스트 압축 활성화 |
| `mysti.compaction.threshold` | `75` | 압축 임계값 (컨텍스트 윈도우의 %) |

### 일반 설정

| 설정 | 기본값 | 설명 |
|------|-------|------|
| `mysti.accessLevel` | `ask-permission` | 파일 액세스 레벨 |
| `mysti.agents.autoSuggest` | `true` | 페르소나 자동 제안 |
| `mysti.agents.maxTokenBudget` | `0` | 에이전트 컨텍스트 최대 토큰 수 (0 = 무제한) |

[프로바이더 전체 문서](docs/PROVIDERS.md)

---

## 키보드 단축키

| 액션 | Windows/Linux | Mac |
|------|---------------|-----|
| Mysti 열기 | `Ctrl+Shift+M` | `Cmd+Shift+M` |
| 새 탭에서 열기 | `Ctrl+Shift+N` | `Cmd+Shift+N` |

---

## 명령

| 명령 | 설명 |
|------|------|
| `Mysti: Open Chat` | 채팅 사이드바 열기 |
| `Mysti: New Conversation` | 새 대화 시작 |
| `Mysti: Add to Context` | 파일/선택 영역을 컨텍스트에 추가 |
| `Mysti: Clear Context` | 모든 컨텍스트 지우기 |
| `Mysti: Open in New Tab` | 편집기 탭에서 채팅 열기 |

---

## 문서

| 가이드 | 설명 |
|-------|------|
| [프로바이더](docs/PROVIDERS.md) | 전체 11개 프로바이더 — 설정, 모델, 기능 |
| [브레인스토밍 모드](docs/BRAINSTORM.md) | 5가지 전략, 수렴, 팀 선택 |
| [페르소나 & 스킬](docs/PERSONAS-AND-SKILLS.md) | 16 페르소나, 12 스킬, 커스텀 에이전트 |
| [자율 모드](docs/AUTONOMOUS-MODE.md) | 안전 시스템, 메모리, 계속 모드 |
| [@멘션](docs/MENTIONS.md) | 에이전트 라우팅과 파일 컨텍스트 |
| [압축](docs/COMPACTION.md) | 컨텍스트 관리와 요약 |
| [아키텍처](docs/ARCHITECTURE.md) | 기술 내부 구조와 확장 포인트 |
| [기능](docs/FEATURES.md) | 전체 기능 레퍼런스 |

---

## 텔레메트리

Mysti는 확장 기능을 개선하기 위해 **익명** 사용 데이터를 수집합니다:

- 기능 사용 패턴
- 오류율
- 프로바이더 선호도

**코드, 파일 경로, 개인 데이터는 절대 수집하지 않습니다.**

VSCode의 텔레메트리 설정을 따릅니다. 비활성화 방법:
설정 > Telemetry: Telemetry Level > off

---

## 기여자

Mysti를 더 좋게 만들어 주신 모든 분께 감사합니다!

<a href="https://github.com/BahaAbuNojaim"><img src="https://avatars.githubusercontent.com/u/6247079?v=4" width="60" height="60" style="border-radius:50%" alt="BahaAbuNojaim" /></a>
<a href="https://github.com/MostlyKIGuess"><img src="https://avatars.githubusercontent.com/u/135974627?v=4" width="60" height="60" style="border-radius:50%" alt="MostlyKIGuess" /></a>
<a href="https://github.com/a-programmers-programmer"><img src="https://avatars.githubusercontent.com/u/161260774?v=4" width="60" height="60" style="border-radius:50%" alt="a-programmers-programmer" /></a>
<a href="https://github.com/patrick-fu"><img src="https://avatars.githubusercontent.com/u/20736775?v=4" width="60" height="60" style="border-radius:50%" alt="patrick-fu" /></a>

함께 하고 싶으세요? 아래 [기여하기](#기여하기) 섹션을 확인하세요.

---

## Star 히스토리

Mysti가 도움이 되셨다면 Star를 눌러주세요 — 다른 분들이 프로젝트를 발견하는 데 도움이 되고 우리에게 동기부여가 됩니다!

<p align="center">
  <a href="https://github.com/DeepMyst/Mysti/stargazers">
    <img src="https://img.shields.io/github/stars/DeepMyst/Mysti?style=for-the-badge&logo=github&color=yellow" alt="GitHub Stars" />
  </a>
</p>

<p align="center">
  <a href="https://star-history.com/#DeepMyst/Mysti&Date">
    <img src="https://api.star-history.com/svg?repos=DeepMyst/Mysti&type=Date" width="600" alt="Star 히스토리 차트" />
  </a>
</p>

---

## 기여하기

기여를 환영합니다! 버그 리포트, 기능 요청, 코드 기여 모두 환영합니다.

- **좋은 첫 번째 Issue**: [`good first issue`](https://github.com/DeepMyst/Mysti/labels/good%20first%20issue) 라벨 확인
- **개발**: VS Code에서 `F5`를 눌러 확장 기능 개발 호스트 실행
- **Pull Request**: 포크하고 기능 브랜치를 만들어 PR 제출

자세한 가이드라인은 [CONTRIBUTING.md](CONTRIBUTING.md)를 참조하세요.

---

## 라이선스

Apache License 2.0 — 상업적 용도를 포함하여 자유롭게 사용, 수정, 배포할 수 있습니다.
전체 텍스트는 `LICENSE` 파일을 참조하세요.

---

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">설치</a> •
  <a href="https://github.com/DeepMyst/Mysti/issues">이슈 보고</a> •
  <a href="https://github.com/DeepMyst/Mysti">GitHub</a>
</p>

<p align="center">
  <strong>Mysti</strong> — <a href="https://www.deepmyst.com/mysti">DeepMyst Inc</a> 제작<br>
  <sub>Mysti로 만듦</sub>
</p>
