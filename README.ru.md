<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.ar.md">العربية</a> | <a href="README.de.md">Deutsch</a> | <a href="README.fr.md">Français</a> | <a href="README.tr.md">Türkçe</a> | Русский
</p>

# Mysti - Ваша команда ИИ-программирования работает вместе

<p align="center">
  <img src="resources/Mysti-Logo.png" alt="Логотип Mysti" width="128" height="128">
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/v/DeepMyst.mysti?style=flat-square&label=Version" alt="Версия">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/i/DeepMyst.mysti?style=flat-square&label=Installs" alt="Установки">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/r/DeepMyst.mysti?style=flat-square&label=Rating" alt="Рейтинг">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/stargazers">
    <img src="https://img.shields.io/github/stars/DeepMyst/Mysti?style=flat-square&label=Stars" alt="GitHub Stars">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/network/members">
    <img src="https://img.shields.io/github/forks/DeepMyst/Mysti?style=flat-square&label=Forks" alt="GitHub Forks">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue?style=flat-square" alt="Лицензия">
  </a>
</p>

<p align="center">
  <strong>Ваша команда ИИ-программирования для VSCode</strong><br>
  <em>11 ИИ-провайдеров — Claude Code, Codex, Gemini, Copilot, Cline, Cursor, OpenClaw, OpenCode, Qwen Code, Ollama и LocalAI — работают поодиночке или в команде</em><br>
  <em>Мудрость толпы, где коллективный интеллект нескольких агентов превосходит одного.</em>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/badge/Установить%20из-VS%20Code%20Marketplace-007ACC?style=for-the-badge&logo=visual-studio-code" alt="Установить из VS Code Marketplace">
  </a>
</p>

<p align="center">
  <a href="#выберите-свой-ии">Провайдеры</a> •
  <a href="#режим-мозгового-штурма">Мозговой штурм</a> •
  <a href="#основные-возможности">Возможности</a> •
  <a href="#быстрый-старт">Быстрый старт</a> •
  <a href="#конфигурация">Конфигурация</a> •
  <a href="#документация">Документация</a>
</p>

---

## Что нового в v0.3.4

### 11 ИИ-провайдеров

Mysti теперь поддерживает **11 ИИ-провайдеров** — добавлены **OpenCode**, **Qwen Code**, **Ollama** и **LocalAI** наряду с Claude Code, Codex, Gemini, GitHub Copilot, Cline, Cursor и OpenClaw. Запускайте локальные модели с Ollama/LocalAI или используйте облачных провайдеров, таких как OpenCode и Qwen Code. Каждый провайдер имеет свой уникальный логотип в интерфейсе.

### Qwen Code

CLI для ИИ-программирования от Alibaba с возможностями глубокого рассуждения. Использует тот же протокол потоковой передачи, что и Claude Code, для бесшовной интеграции. Поддерживает модели Qwen3 Coder с режимами одобрения plan, auto-edit и yolo.

### OpenCode

Мультибэкенд-агент программирования с поддержкой Anthropic, OpenAI, Google и Groq через единый CLI. Использует вашу настроенную модель по умолчанию — без привязки к конкретным провайдерам.

### Поддержка локального ИИ

Запускайте ИИ-модели локально с **Ollama** и **LocalAI** — без облачной подписки. Полная конфиденциальность, нулевая задержка, полный контроль над моделями.

---

## Установка за секунды

**Из VS Code:** Нажмите `Ctrl+P` (`Cmd+P` на Mac), затем вставьте:

```
ext install DeepMyst.mysti
```

**Или** [установите из VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti)

---

## Выберите свой ИИ

Mysti работает с инструментами ИИ-программирования, которые у вас уже есть. **Дополнительные подписки не нужны.**

<p align="center">
  <img src="docs/gifs/agent switching.gif" alt="Переключение агента" width="450">
</p>

| Провайдер | Лучше всего для |
|-----------|----------------|
| **Claude Code** | Глубокое рассуждение, сложный рефакторинг, тщательный анализ |
| **Codex** | Быстрые итерации, привычный стиль OpenAI |
| **Gemini** | Быстрые ответы, интеграция с экосистемой Google |
| **GitHub Copilot** | Мультимодельный доступ (Claude, GPT-5, Gemini) через подписку GitHub |
| **Cline** | Режим Plan/Act, структурированное выполнение задач |
| **Cursor** | Автоматический выбор модели, мультимодель с Claude, GPT-5, Gemini |
| **OpenClaw** | Потоковая передача WebSocket в реальном времени, настраиваемые уровни мышления |
| **OpenCode** | Мультибэкенд-агент (Anthropic, OpenAI, Google, Groq) |
| **Qwen Code** | ИИ-агент программирования Alibaba, глубокое рассуждение |
| **Ollama** | Локальный вывод LLM, конфиденциальность прежде всего, без подписки |
| **LocalAI** | Самостоятельно размещённые ИИ-модели, полный контроль |

**Переключайте провайдеров одним кликом. Без привязки.**

### Почему Mysti?

| vs Copilot/Cursor | Преимущество Mysti |
|-------------------|-------------------|
| Один ИИ | **Мультиагентный мозговой штурм** — два ИИ сотрудничают с 5 стратегиями |
| Привязка к одному провайдеру | **11 провайдеров** — Claude, Codex, Gemini, Copilot, Cline, Cursor, OpenClaw, OpenCode, Qwen, Ollama, LocalAI |
| Чёрный ящик | **Полный контроль разрешений** — от только чтения до полного доступа |
| Общие ответы | **16 персон** — архитектор, отладчик, эксперт по безопасности... |
| Ручной рабочий процесс | **Автономный режим** — ИИ работает независимо с контролем безопасности |
| Нет маршрутизации между агентами | **@упоминания** — направляйте задачи конкретным агентам прямо в тексте |

---

## Смотрите в действии

<p align="center">
  <img src="docs/gifs/main screen.gif" alt="Интерфейс чата Mysti" width="700">
</p>

<p align="center"><em>Красивый, современный интерфейс чата с подсветкой синтаксиса, поддержкой Markdown и диаграммами Mermaid</em></p>

<p align="center">
  <img src="docs/gifs/Task list rendering and progress tracking.gif" alt="Отображение списка задач" width="700">
</p>

<p align="center"><em>Отображение списка задач в реальном времени и отслеживание прогресса</em></p>

---

## Режим мозгового штурма

**Хотите второе мнение?** Включите режим мозгового штурма и позвольте двум ИИ-агентам решить вашу задачу вместе. **Выберите любых 2 из 11 агентов** в панели настроек.

<p align="center">
  <img src="docs/gifs/brainstorm example.gif" alt="Режим мозгового штурма" width="700">
</p>

### 5 стратегий сотрудничества

| Стратегия | Роли | Лучше всего для |
|-----------|------|----------------|
| **Quick** | Прямой синтез | Простые задачи, быстрые ответы |
| **Debate** | Критик vs Защитник | Архитектурные решения, компромиссы |
| **Red-Team** | Предлагающий vs Оспаривающий | Обзоры безопасности, обнаружение крайних случаев |
| **Perspectives** | Аналитик рисков vs Новатор | Проектирование с нуля, выбор технологий |
| **Delphi** | Фасилитатор vs Уточнитель | Сложные проблемы, достижение консенсуса |

### Почему два ИИ лучше одного

**Claude Code** (Anthropic), **Codex** (OpenAI), **Gemini** (Google), **GitHub Copilot**, **Cline**, **Cursor**, **OpenClaw**, **OpenCode**, **Qwen Code** (Alibaba), **Ollama** и **LocalAI** имеют разное обучение, разные сильные стороны и разные слепые зоны. Когда любые два работают вместе:

- Каждый ИИ замечает крайние случаи, которые другой может пропустить
- Разные перспективы ведут к более надёжным решениям
- **Вместе** они дебатируют, бросают друг другу вызов и синтезируют лучшее решение

Это как если бы старший разработчик и технический руководитель проверяли ваш код — только они действительно сначала обсуждают его.

### Обнаружение конвергенции

Во время обсуждений Mysti отслеживает согласие агентов и стабильность позиций. Когда включена **авто-конвергенция**, обсуждение завершается досрочно, как только агенты достигают консенсуса — экономия времени без потери качества.

### Выберите свою команду

Настройте, какие два агента сотрудничают, в **Панели настроек**:

<p align="center">
  <img src="docs/gifs/Brainstorm model selection.gif" alt="Выбор модели мозгового штурма" width="600">
</p>

| Комбинация | Лучше всего для |
|-----------|----------------|
| Claude + Codex | Глубокий анализ встречает быструю итерацию |
| Claude + Gemini | Тщательное рассуждение с быстрой валидацией |
| Claude + Copilot | Сравните нативный Claude и мультимодельный подход Copilot |
| Cursor + Gemini | Мультимодельная гибкость с интеграцией Google |
| OpenClaw + Claude | Потоковая передача WebSocket с глубоким рассуждением |
| Qwen + Claude | Сравните рассуждения Alibaba и Anthropic |
| OpenCode + Gemini | Мультибэкенд-гибкость со скоростью Google |
| Ollama + Claude | Локальная конфиденциальность встречает облачный интеллект |

[Полная документация по мозговому штурму](docs/BRAINSTORM.md)

### Интеллектуальное обнаружение планов

Когда ИИ представляет несколько подходов к реализации, Mysti автоматически обнаруживает их и позволяет выбрать предпочтительный путь.

<p align="center">
  <img src="docs/screenshots/plan-suggestions.png" alt="Предложения планов" width="600">
</p>

*Требуется как минимум 2 установленных CLI-инструмента. См. [Требования](#требования).*

---

## Основные возможности

### Автономный режим

Позвольте ИИ работать независимо с настраиваемыми контролями безопасности:

- **Классификатор безопасности**: Три уровня — безопасно (авто-одобрение), осторожность (зависит от режима), заблокировано (всегда отклонять)
- **Три режима безопасности**: Консервативный, Сбалансированный, Агрессивный
- **Обучающаяся память**: Запоминает ваши предпочтения разрешений и улучшается со временем
- **Режимы продолжения**: На основе целей или очереди задач для расширенных автономных сессий
- **Журнал аудита**: Каждое автономное решение записывается для проверки

<p align="center">
  <img src="docs/gifs/Selecting autonomy mode.gif" alt="Выбор режима автономии" width="600">
</p>

[Полная документация по автономному режиму](docs/AUTONOMOUS-MODE.md)

### Система @упоминаний

Направляйте задачи конкретным агентам и ссылайтесь на файлы прямо в тексте:

<p align="center">
  <img src="docs/gifs/Agent tagging and multi agent workflows.gif" alt="Тегирование @упоминаний" width="600">
</p>

```
@claude Проверь этот код на проблемы безопасности
@src/auth.ts @gemini Предложи улучшения производительности для этого файла
@claude Напиши тесты, затем @codex оптимизируй их
```

- **Упоминания файлов**: `@filename` добавляет временный контекст
- **Упоминания агентов**: `@agent` направляет задачи этому провайдеру
- **Цепочки**: Последующие агенты получают ответы предыдущих как контекст

[Полная документация по @упоминаниям](docs/MENTIONS.md)

### Сжатие контекста

Умное управление разговором, предотвращающее переполнение контекста:

- **Автоматическое**: Срабатывает, когда использование токенов приближается к порогу (по умолчанию 75%)
- **Нативная поддержка**: Claude Code использует встроенную команду `/compact`
- **На стороне клиента**: Другие провайдеры используют интеллектуальное резюмирование сообщений
- **Отслеживание по панелям**: Каждая панель чата отслеживает использование независимо

[Полная документация по сжатию](docs/COMPACTION.md)

### 16 персон разработчика

Формируйте образ мышления вашего ИИ. Выбирайте из специализированных персон, которые меняют подход ИИ к вашим задачам.

<p align="center">
  <img src="docs/gifs/Personas and skills.gif" alt="Панель персон и навыков" width="550">
</p>

| Персона | Фокус |
|---------|-------|
| **Архитектор** | Проектирование систем, масштабируемость, чистая структура |
| **Отладчик** | Анализ первопричин, исправление ошибок |
| **Ориентированный на безопасность** | Уязвимости, моделирование угроз |
| **Оптимизатор производительности** | Оптимизация, профилирование, задержка |
| **Прототипист** | Быстрая итерация, PoC |
| **Рефакторщик** | Качество кода, поддерживаемость |
| + ещё 10... | Full-Stack, DevOps, Ментор, Дизайнер... |

[Полная документация по персонам и навыкам](docs/PERSONAS-AND-SKILLS.md)

---

### Быстрый выбор персоны

Выбирайте персоны прямо с панели инструментов, не открывая панели.

<p align="center">
  <img src="docs/screenshots/persona-toolbar.png" alt="Выбор персоны на панели инструментов" width="550">
</p>

---

### Умные автоматические предложения

Mysti автоматически предлагает релевантные персоны и действия на основе вашего сообщения.

<p align="center">
  <img src="docs/gifs/PErsona Suggestion.gif" alt="Автоматические предложения" width="550">
</p>

---

### История разговоров

Никогда не теряйте свою работу. Все разговоры сохраняются и легко доступны.

<p align="center">
  <img src="docs/screenshots/conversation-history.png" alt="История разговоров" width="450">
</p>

---

### Быстрые действия на экране приветствия

Начните быстро с действий в один клик для распространённых задач.

<p align="center">
  <img src="docs/screenshots/quick-actions-welcome.png" alt="Быстрые действия" width="550">
</p>

---

### Обширные настройки

Настройте каждый аспект Mysti, включая бюджеты токенов, уровни доступа и режим мозгового штурма.

<p align="center">
  <img src="docs/screenshots/settings-panel.png" alt="Панель настроек" width="450">
</p>

---

## Требования

**Уже платите за Claude, ChatGPT, Gemini или GitHub Copilot? Вы готовы.**

Mysti работает с вашими существующими подписками — без дополнительных затрат!

| CLI-инструмент | Подписка | Установка |
|---------------|----------|-----------|
| **Claude Code** (рекомендуется) | Anthropic API или Claude Pro/Max | `npm install -g @anthropic-ai/claude-code` |
| **GitHub Copilot CLI** | GitHub Copilot Pro/Pro+/Business | `npm install -g @github/copilot-cli` |
| **Gemini CLI** | Google AI API или Gemini Advanced | `npm install -g @google/gemini-cli` |
| **Codex CLI** | OpenAI API | Следуйте руководству по установке OpenAI |
| **Cline** | Зависит от провайдера модели | `npm install -g cline` |
| **Cursor** | Подписка Cursor | `curl https://cursor.com/install -fsS \| bash` |
| **OpenClaw** | Аккаунт OpenClaw | `npm install -g openclaw@latest && openclaw onboard --install-daemon` |
| **OpenCode** | API-ключи провайдера (Anthropic, OpenAI и т.д.) | `npm i -g opencode-ai@latest` |
| **Qwen Code** | Qwen OAuth или API-ключи | `npm install -g @qwen-code/qwen-code@latest` |
| **Ollama** | Локально (подписка не нужна) | [Установить с ollama.com](https://ollama.com) |
| **LocalAI** | Локально (подписка не нужна) | [Установить с localai.io](https://localai.io) |

Для начала нужен только **один** CLI. Установите **любые два** для разблокировки режима мозгового штурма.

---

## Быстрый старт

### 1. Установите Mysti

**Вариант А:** Нажмите `Ctrl+P` (`Cmd+P` на Mac), вставьте и выполните:
```
ext install DeepMyst.mysti
```

**Вариант Б:** [Установить из VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti)

### 2. Установите CLI-инструмент

```bash
# Claude Code (рекомендуется)
npm install -g @anthropic-ai/claude-code
claude auth login

# Или GitHub Copilot CLI (доступ к Claude, GPT-5, Gemini через GitHub)
npm install -g @github/copilot-cli
copilot  # затем используйте команду /login

# Или Gemini CLI
npm install -g @google/gemini-cli
gemini auth login

# Или Cursor
curl https://cursor.com/install -fsS | bash
agent login

# Или OpenClaw
npm install -g openclaw@latest && openclaw onboard --install-daemon
openclaw login

# Или OpenCode
npm i -g opencode-ai@latest
opencode auth login

# Или Qwen Code
npm install -g @qwen-code/qwen-code@latest
qwen  # затем введите /auth
```

Для режима мозгового штурма установите любые два CLI-инструмента.

### 3. Откройте Mysti

- Нажмите на **иконку Mysti** в Панели активности, или
- Нажмите `Ctrl+Shift+M` (`Cmd+Shift+M` на Mac)

### 4. Начните программировать

Введите ваш запрос и позвольте ИИ помочь вам!

---

## Слэш-команды

Быстрый доступ к навыкам и действиям через встроенное меню слэш-команд.

<p align="center">
  <img src="docs/gifs/slash commands menu.gif" alt="Меню слэш-команд" width="600">
</p>

---

## 12 переключаемых навыков

Смешивайте и комбинируйте модификаторы поведения:

- **Краткость** - Чёткая, лаконичная коммуникация
- **Тест-ориентированность** - Тесты вместе с кодом
- **Авто-коммит** - Инкрементальные коммиты
- **Первые принципы** - Фундаментальное рассуждение
- **Дисциплина охвата** - Фокус на задаче
- И ещё 7...

[Полная документация по персонам и навыкам](docs/PERSONAS-AND-SKILLS.md)

---

## Контроль разрешений

Контролируйте, что может делать ИИ:

- **Только чтение** - ИИ может только читать, никогда не изменяет
- **Запрос разрешения** - Одобряйте каждое изменение файла
- **Полный доступ** - Позвольте ИИ работать автономно

<p align="center">
  <img src="docs/gifs/Semi auto answering questions .gif" alt="Демо контроля разрешений" width="600">
</p>

---

## Конфигурация

### Основные настройки

```json
{
  "mysti.defaultProvider": "claude-code",
  "mysti.brainstorm.agents": ["claude-code", "google-gemini"],
  "mysti.brainstorm.strategy": "quick",
  "mysti.accessLevel": "ask-permission"
}
```

### Настройки провайдеров

| Настройка | По умолчанию | Описание |
|-----------|-------------|----------|
| `mysti.defaultProvider` | `claude-code` | Основной ИИ-провайдер |
| `mysti.claudePath` | `claude` | Путь к CLI Claude |
| `mysti.codexPath` | `codex` | Путь к CLI Codex |
| `mysti.geminiPath` | `gemini` | Путь к CLI Gemini |
| `mysti.copilotPath` | `copilot` | Путь к CLI Copilot |
| `mysti.clinePath` | `cline` | Путь к CLI Cline |
| `mysti.cursorPath` | `agent` | Путь к CLI Cursor |
| `mysti.openclawPath` | `openclaw` | Путь к CLI OpenClaw |
| `mysti.opencodePath` | `opencode` | Путь к CLI OpenCode |
| `mysti.qwenCodePath` | `qwen` | Путь к CLI Qwen Code |
| `mysti.ollamaPath` | `ollama` | Путь к CLI Ollama |
| `mysti.localaiPath` | `localai` | Путь к CLI LocalAI |

### Настройки мозгового штурма

| Настройка | По умолчанию | Описание |
|-----------|-------------|----------|
| `mysti.brainstorm.agents` | `["claude-code", "openai-codex"]` | Какие 2 агента использовать |
| `mysti.brainstorm.strategy` | `quick` | Стратегия: `quick`, `debate`, `red-team`, `perspectives`, `delphi` |
| `mysti.brainstorm.autoConverge` | `true` | Автоматический выход при конвергенции |
| `mysti.brainstorm.maxDiscussionRounds` | `3` | Максимум раундов обсуждения |

### Автономные настройки

| Настройка | По умолчанию | Описание |
|-----------|-------------|----------|
| `mysti.autonomous.safetyMode` | `balanced` | `conservative`, `balanced`, `aggressive` |
| `mysti.autonomous.blockPatterns` | `[]` | Пользовательские шаблоны для постоянной блокировки |

### Настройки сжатия

| Настройка | По умолчанию | Описание |
|-----------|-------------|----------|
| `mysti.compaction.enabled` | `true` | Включить сжатие контекста |
| `mysti.compaction.threshold` | `75` | Порог сжатия (% окна контекста) |

### Общие настройки

| Настройка | По умолчанию | Описание |
|-----------|-------------|----------|
| `mysti.accessLevel` | `ask-permission` | Уровень доступа к файлам |
| `mysti.agents.autoSuggest` | `true` | Автоматическое предложение персон |
| `mysti.agents.maxTokenBudget` | `0` | Макс. токенов для контекста агента (0 = без ограничений) |

[Полная документация по провайдерам](docs/PROVIDERS.md)

---

## Горячие клавиши

| Действие | Windows/Linux | Mac |
|----------|---------------|-----|
| Открыть Mysti | `Ctrl+Shift+M` | `Cmd+Shift+M` |
| Открыть в новой вкладке | `Ctrl+Shift+N` | `Cmd+Shift+N` |

---

## Команды

| Команда | Описание |
|---------|----------|
| `Mysti: Open Chat` | Открыть боковую панель чата |
| `Mysti: New Conversation` | Начать новый разговор |
| `Mysti: Add to Context` | Добавить файл/выделение в контекст |
| `Mysti: Clear Context` | Очистить весь контекст |
| `Mysti: Open in New Tab` | Открыть чат как вкладку редактора |

---

## Документация

| Руководство | Описание |
|-------------|----------|
| [Провайдеры](docs/PROVIDERS.md) | Все 11 провайдеров — настройка, модели, возможности |
| [Мозговой штурм](docs/BRAINSTORM.md) | 5 стратегий, конвергенция, выбор команды |
| [Персоны и навыки](docs/PERSONAS-AND-SKILLS.md) | 16 персон, 12 навыков, пользовательские агенты |
| [Автономный режим](docs/AUTONOMOUS-MODE.md) | Система безопасности, память, режимы продолжения |
| [@Упоминания](docs/MENTIONS.md) | Маршрутизация агентов и контекст файлов |
| [Сжатие](docs/COMPACTION.md) | Управление контекстом и резюмирование |
| [Архитектура](docs/ARCHITECTURE.md) | Техническое устройство и точки расширения |
| [Возможности](docs/FEATURES.md) | Полный справочник возможностей |

---

## Телеметрия

Mysti собирает **анонимные** данные об использовании для улучшения расширения:

- Шаблоны использования функций
- Частота ошибок
- Предпочтения провайдеров

**Код, пути к файлам и личные данные никогда не собираются.**

Соблюдает настройку телеметрии VSCode. Отключить через:
Настройки > Telemetry: Telemetry Level > off

---

## Участники

Спасибо всем, кто помог улучшить Mysti!

<a href="https://github.com/BahaAbuNojaim"><img src="https://avatars.githubusercontent.com/u/6247079?v=4" width="60" height="60" style="border-radius:50%" alt="BahaAbuNojaim" /></a>
<a href="https://github.com/MostlyKIGuess"><img src="https://avatars.githubusercontent.com/u/135974627?v=4" width="60" height="60" style="border-radius:50%" alt="MostlyKIGuess" /></a>
<a href="https://github.com/a-programmers-programmer"><img src="https://avatars.githubusercontent.com/u/161260774?v=4" width="60" height="60" style="border-radius:50%" alt="a-programmers-programmer" /></a>
<a href="https://github.com/patrick-fu"><img src="https://avatars.githubusercontent.com/u/20736775?v=4" width="60" height="60" style="border-radius:50%" alt="patrick-fu" /></a>

Хотите присоединиться? Смотрите раздел [Участие](#участие) ниже.

---

## История звёзд

Если Mysti был вам полезен, поставьте звезду — это помогает другим найти проект и мотивирует нас!

<p align="center">
  <a href="https://github.com/DeepMyst/Mysti/stargazers">
    <img src="https://img.shields.io/github/stars/DeepMyst/Mysti?style=for-the-badge&logo=github&color=yellow" alt="GitHub Stars" />
  </a>
</p>

<p align="center">
  <a href="https://star-history.com/#DeepMyst/Mysti&Date">
    <img src="https://api.star-history.com/svg?repos=DeepMyst/Mysti&type=Date" width="600" alt="График истории звёзд" />
  </a>
</p>

---

## Участие

Мы приветствуем вклад! Будь то баг-репорты, запросы функций или вклад в код.

- **Хорошие первые задачи**: Ищите метки [`good first issue`](https://github.com/DeepMyst/Mysti/labels/good%20first%20issue)
- **Разработка**: Нажмите `F5` в VS Code для запуска Extension Development Host
- **Pull Request**: Сделайте форк, создайте ветку для функции и отправьте PR

Подробные руководства в [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Лицензия

Apache License 2.0 — свободное использование, модификация и распространение, включая коммерческие цели.
Полный текст в файле `LICENSE`.

---

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">Установить</a> •
  <a href="https://github.com/DeepMyst/Mysti/issues">Сообщить о проблеме</a> •
  <a href="https://github.com/DeepMyst/Mysti">GitHub</a>
</p>

<p align="center">
  <strong>Mysti</strong> — Создано <a href="https://www.deepmyst.com/mysti">DeepMyst Inc</a><br>
  <sub>Сделано с Mysti</sub>
</p>
