<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.ar.md">العربية</a> | Deutsch | <a href="README.fr.md">Français</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.ru.md">Русский</a>
</p>

# Mysti - Dein KI-Codierungsteam arbeitet zusammen

<p align="center">
  <img src="resources/Mysti-Logo.png" alt="Mysti Logo" width="128" height="128">
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/v/DeepMyst.mysti?style=flat-square&label=Version" alt="Version">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/i/DeepMyst.mysti?style=flat-square&label=Installs" alt="Installationen">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/r/DeepMyst.mysti?style=flat-square&label=Rating" alt="Bewertung">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/stargazers">
    <img src="https://img.shields.io/github/stars/DeepMyst/Mysti?style=flat-square&label=Stars" alt="GitHub Stars">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/network/members">
    <img src="https://img.shields.io/github/forks/DeepMyst/Mysti?style=flat-square&label=Forks" alt="GitHub Forks">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue?style=flat-square" alt="Lizenz">
  </a>
</p>

<p align="center">
  <strong>Dein KI-Codierungsteam für VSCode</strong><br>
  <em>11 KI-Anbieter — Claude Code, Codex, Gemini, Copilot, Cline, Cursor, OpenClaw, OpenCode, Qwen Code, Ollama & LocalAI — einzeln oder im Team</em><br>
  <em>Schwarmintelligenz, bei der die kollektive Intelligenz mehrerer Agenten einen einzelnen übertrifft.</em>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/badge/Installieren%20vom-VS%20Code%20Marketplace-007ACC?style=for-the-badge&logo=visual-studio-code" alt="Vom VS Code Marketplace installieren">
  </a>
</p>

<p align="center">
  <a href="#wähle-deine-ki">Anbieter</a> •
  <a href="#brainstorm-modus">Brainstorm</a> •
  <a href="#hauptfunktionen">Funktionen</a> •
  <a href="#schnellstart">Schnellstart</a> •
  <a href="#konfiguration">Konfiguration</a> •
  <a href="#dokumentation">Docs</a>
</p>

---

## Neu in v0.3.4

### 11 KI-Anbieter

Mysti unterstützt jetzt **11 KI-Anbieter** — **OpenCode**, **Qwen Code**, **Ollama** und **LocalAI** wurden neben Claude Code, Codex, Gemini, GitHub Copilot, Cline, Cursor und OpenClaw hinzugefügt. Führe lokale Modelle mit Ollama/LocalAI aus oder nutze Cloud-Anbieter wie OpenCode und Qwen Code. Jeder Anbieter hat sein eigenes Logo in der Oberfläche.

### Qwen Code

Alibabas KI-Codierungs-CLI mit tiefgreifenden Reasoning-Fähigkeiten. Verwendet dasselbe Streaming-Protokoll wie Claude Code für nahtlose Integration. Unterstützt Qwen3-Coder-Modelle mit plan-, auto-edit- und yolo-Genehmigungsmodi.

### OpenCode

Multi-Backend-Codierungsagent mit Unterstützung für Anthropic, OpenAI, Google und Groq über ein einzelnes CLI. Verwendet dein konfiguriertes Standardmodell — kein Lock-in an bestimmte Anbieter.

### Lokale KI-Unterstützung

Führe KI-Modelle lokal mit **Ollama** und **LocalAI** aus — kein Cloud-Abo nötig. Volle Privatsphäre, keine Latenz, vollständige Kontrolle über deine Modelle.

---

## Installation in Sekunden

**Von VS Code:** Drücke `Ctrl+P` (`Cmd+P` auf Mac), dann einfügen:

```
ext install DeepMyst.mysti
```

**Oder** [vom VS Code Marketplace installieren](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti)

---

## Wähle deine KI

Mysti arbeitet mit den KI-Codierungstools, die du bereits hast. **Keine zusätzlichen Abos nötig.**

<p align="center">
  <img src="docs/gifs/agent switching.gif" alt="Agentenwechsel" width="450">
</p>

| Anbieter | Am besten für |
|----------|--------------|
| **Claude Code** | Tiefes Reasoning, komplexes Refactoring, gründliche Analyse |
| **Codex** | Schnelle Iterationen, vertrauter OpenAI-Stil |
| **Gemini** | Schnelle Antworten, Google-Ökosystem-Integration |
| **GitHub Copilot** | Multi-Modell-Zugang (Claude, GPT-5, Gemini) über GitHub-Abo |
| **Cline** | Plan/Act-Modus, strukturierte Aufgabenerfüllung |
| **Cursor** | Automatische Modellauswahl, Multi-Modell mit Claude, GPT-5, Gemini |
| **OpenClaw** | Echtzeit-WebSocket-Streaming, konfigurierbare Denkstufen |
| **OpenCode** | Multi-Backend-Agent (Anthropic, OpenAI, Google, Groq) |
| **Qwen Code** | Alibabas KI-Codierungsagent, tiefes Reasoning |
| **Ollama** | Lokale LLM-Inferenz, Privatsphäre zuerst, kein Abo |
| **LocalAI** | Selbst gehostete KI-Modelle, vollständige Kontrolle |

**Anbieter mit einem Klick wechseln. Kein Lock-in.**

### Warum Mysti?

| vs Copilot/Cursor | Mysti-Vorteil |
|-------------------|--------------|
| Einzelne KI | **Multi-Agenten-Brainstorming** — zwei KIs arbeiten mit 5 Strategien zusammen |
| An einen Anbieter gebunden | **11 Anbieter** — Claude, Codex, Gemini, Copilot, Cline, Cursor, OpenClaw, OpenCode, Qwen, Ollama, LocalAI |
| Black Box | **Vollständige Berechtigungskontrolle** — von schreibgeschützt bis Vollzugriff |
| Generische Antworten | **16 Personas** — Architekt, Debugger, Sicherheitsexperte... |
| Manueller Workflow | **Autonomer Modus** — KI arbeitet selbstständig mit Sicherheitskontrollen |
| Kein Cross-Agent-Routing | **@-Erwähnungen** — Aufgaben inline an bestimmte Agenten weiterleiten |

---

## In Aktion sehen

<p align="center">
  <img src="docs/gifs/main screen.gif" alt="Mysti Chat-Oberfläche" width="700">
</p>

<p align="center"><em>Schöne, moderne Chat-Oberfläche mit Syntaxhervorhebung, Markdown-Unterstützung und Mermaid-Diagrammen</em></p>

<p align="center">
  <img src="docs/gifs/Task list rendering and progress tracking.gif" alt="Aufgabenlisten-Rendering" width="700">
</p>

<p align="center"><em>Echtzeit-Aufgabenlisten-Rendering und Fortschrittsverfolgung</em></p>

---

## Brainstorm-Modus

**Zweite Meinung gewünscht?** Aktiviere den Brainstorm-Modus und lass zwei KI-Agenten dein Problem gemeinsam lösen. **Wähle beliebige 2 von 11 Agenten** im Einstellungspanel.

<p align="center">
  <img src="docs/gifs/brainstorm example.gif" alt="Brainstorm-Modus" width="700">
</p>

### 5 Kollaborationsstrategien

| Strategie | Rollen | Am besten für |
|-----------|--------|--------------|
| **Quick** | Direkte Synthese | Einfache Aufgaben, schnelle Antworten |
| **Debate** | Kritiker vs Verteidiger | Architekturentscheidungen, Abwägungen |
| **Red-Team** | Vorschlagender vs Herausforderer | Sicherheitsreviews, Grenzfälle entdecken |
| **Perspectives** | Risikoanalyst vs Innovator | Greenfield-Design, Technologieauswahl |
| **Delphi** | Moderator vs Verfeinerer | Komplexe Probleme, Konsens erreichen |

### Warum zwei KIs besser sind als eine

**Claude Code** (Anthropic), **Codex** (OpenAI), **Gemini** (Google), **GitHub Copilot**, **Cline**, **Cursor**, **OpenClaw**, **OpenCode**, **Qwen Code** (Alibaba), **Ollama** und **LocalAI** haben unterschiedliches Training, unterschiedliche Stärken und unterschiedliche blinde Flecken. Wenn zwei zusammenarbeiten:

- Jede KI findet Grenzfälle, die die andere übersehen könnte
- Verschiedene Perspektiven führen zu robusteren Lösungen
- **Zusammen** debattieren sie, fordern sich gegenseitig heraus und synthetisieren die beste Lösung

Es ist wie ein Senior-Entwickler und ein Tech-Lead, die deinen Code reviewen — nur dass sie ihn tatsächlich zuerst besprechen.

### Konvergenzerkennung

Während der Diskussionen verfolgt Mysti die Übereinstimmung der Agenten und die Stabilität der Positionen. Wenn **Auto-Konvergenz** aktiviert ist, endet die Diskussion frühzeitig, sobald die Agenten Konsens erreichen — spart Zeit ohne Qualitätsverlust.

### Wähle dein Team

Konfiguriere, welche zwei Agenten im **Einstellungspanel** zusammenarbeiten:

<p align="center">
  <img src="docs/gifs/Brainstorm model selection.gif" alt="Brainstorm-Modellauswahl" width="600">
</p>

| Kombination | Am besten für |
|-------------|--------------|
| Claude + Codex | Tiefe Analyse trifft schnelle Iteration |
| Claude + Gemini | Gründliches Reasoning mit schneller Validierung |
| Claude + Copilot | Natives Claude vs Copilots Multi-Modell-Ansatz vergleichen |
| Cursor + Gemini | Multi-Modell-Flexibilität mit Google-Integration |
| OpenClaw + Claude | WebSocket-Streaming mit tiefem Reasoning |
| Qwen + Claude | Alibaba- und Anthropic-Reasoning vergleichen |
| OpenCode + Gemini | Multi-Backend-Flexibilität mit Google-Geschwindigkeit |
| Ollama + Claude | Lokale Privatsphäre trifft Cloud-Intelligenz |

[Vollständige Brainstorm-Dokumentation](docs/BRAINSTORM.md)

### Intelligente Plan-Erkennung

Wenn die KI mehrere Implementierungsansätze präsentiert, erkennt Mysti diese automatisch und lässt dich deinen bevorzugten Weg wählen.

<p align="center">
  <img src="docs/screenshots/plan-suggestions.png" alt="Plan-Vorschläge" width="600">
</p>

*Erfordert mindestens 2 installierte CLI-Tools. Siehe [Voraussetzungen](#voraussetzungen).*

---

## Hauptfunktionen

### Autonomer Modus

Lass die KI selbstständig arbeiten mit konfigurierbaren Sicherheitskontrollen:

- **Sicherheitsklassifizierer**: Drei Stufen — sicher (automatisch genehmigen), Vorsicht (modusabhängig), blockiert (immer ablehnen)
- **Drei Sicherheitsmodi**: Konservativ, Ausgewogen, Aggressiv
- **Lerngedächtnis**: Merkt sich deine Berechtigungspräferenzen und verbessert sich über die Zeit
- **Fortsetzungsmodi**: Zielbasiert oder Aufgabenwarteschlange für erweiterte autonome Sitzungen
- **Audit-Trail**: Jede autonome Entscheidung wird zur Überprüfung protokolliert

<p align="center">
  <img src="docs/gifs/Selecting autonomy mode.gif" alt="Autonomie-Modus auswählen" width="600">
</p>

[Vollständige Dokumentation zum autonomen Modus](docs/AUTONOMOUS-MODE.md)

### @-Erwähnungssystem

Leite Aufgaben an bestimmte Agenten weiter und referenziere Dateien inline:

<p align="center">
  <img src="docs/gifs/Agent tagging and multi agent workflows.gif" alt="@-Erwähnung-Tagging" width="600">
</p>

```
@claude Überprüfe diesen Code auf Sicherheitsprobleme
@src/auth.ts @gemini Schlage Performance-Verbesserungen für diese Datei vor
@claude Schreibe Tests, dann @codex optimiere sie
```

- **Datei-Erwähnungen**: `@filename` fügt temporären Kontext hinzu
- **Agenten-Erwähnungen**: `@agent` leitet Aufgaben an diesen Anbieter weiter
- **Verkettung**: Spätere Agenten erhalten die Antworten früherer Agenten als Kontext

[Vollständige @-Erwähnungs-Dokumentation](docs/MENTIONS.md)

### Kontextkomprimierung

Intelligentes Gespräch-Management, das Kontextüberlauf verhindert:

- **Automatisch**: Löst aus, wenn die Token-Nutzung den Schwellenwert erreicht (Standard 75%)
- **Native Unterstützung**: Claude Code nutzt den eingebauten `/compact`-Befehl
- **Clientseitig**: Andere Anbieter nutzen intelligente Nachrichtenzusammenfassung
- **Pro-Panel-Tracking**: Jedes Chat-Panel verfolgt die Nutzung unabhängig

[Vollständige Komprimierungs-Dokumentation](docs/COMPACTION.md)

### 16 Entwickler-Personas

Forme, wie deine KI denkt. Wähle aus spezialisierten Personas, die den Ansatz der KI für deine Probleme ändern.

<p align="center">
  <img src="docs/gifs/Personas and skills.gif" alt="Personas- und Skills-Panel" width="550">
</p>

| Persona | Fokus |
|---------|-------|
| **Architekt** | Systemdesign, Skalierbarkeit, saubere Struktur |
| **Debugger** | Ursachenanalyse, Bugfixing |
| **Sicherheitsorientiert** | Schwachstellen, Bedrohungsmodellierung |
| **Performance-Tuner** | Optimierung, Profiling, Latenz |
| **Prototyper** | Schnelle Iteration, PoCs |
| **Refactorer** | Codequalität, Wartbarkeit |
| + 10 weitere... | Full-Stack, DevOps, Mentor, Designer... |

[Vollständige Personas-&-Skills-Dokumentation](docs/PERSONAS-AND-SKILLS.md)

---

### Schnelle Persona-Auswahl

Wähle Personas direkt aus der Toolbar, ohne Panels zu öffnen.

<p align="center">
  <img src="docs/screenshots/persona-toolbar.png" alt="Toolbar-Persona-Auswahl" width="550">
</p>

---

### Intelligente Auto-Vorschläge

Mysti schlägt automatisch relevante Personas und Aktionen basierend auf deiner Nachricht vor.

<p align="center">
  <img src="docs/gifs/PErsona Suggestion.gif" alt="Auto-Vorschläge" width="550">
</p>

---

### Gesprächsverlauf

Verliere nie deine Arbeit. Alle Gespräche werden gespeichert und sind leicht zugänglich.

<p align="center">
  <img src="docs/screenshots/conversation-history.png" alt="Gesprächsverlauf" width="450">
</p>

---

### Schnellaktionen beim Willkommen

Starte schnell mit Ein-Klick-Aktionen für häufige Aufgaben.

<p align="center">
  <img src="docs/screenshots/quick-actions-welcome.png" alt="Schnellaktionen" width="550">
</p>

---

### Umfangreiche Einstellungen

Passe jeden Aspekt von Mysti an, einschließlich Token-Budgets, Zugriffsebenen und Brainstorm-Modus.

<p align="center">
  <img src="docs/screenshots/settings-panel.png" alt="Einstellungspanel" width="450">
</p>

---

## Voraussetzungen

**Zahlst du bereits für Claude, ChatGPT, Gemini oder GitHub Copilot? Du bist startklar.**

Mysti funktioniert mit deinen bestehenden Abos — keine zusätzlichen Kosten!

| CLI-Tool | Abo | Installation |
|----------|-----|-------------|
| **Claude Code** (empfohlen) | Anthropic API oder Claude Pro/Max | `npm install -g @anthropic-ai/claude-code` |
| **GitHub Copilot CLI** | GitHub Copilot Pro/Pro+/Business | `npm install -g @github/copilot-cli` |
| **Gemini CLI** | Google AI API oder Gemini Advanced | `npm install -g @google/gemini-cli` |
| **Codex CLI** | OpenAI API | Folge der OpenAI-Installationsanleitung |
| **Cline** | Hängt vom Modellanbieter ab | `npm install -g cline` |
| **Cursor** | Cursor-Abo | `curl https://cursor.com/install -fsS \| bash` |
| **OpenClaw** | OpenClaw-Konto | `npm install -g openclaw@latest && openclaw onboard --install-daemon` |
| **OpenCode** | Anbieter-API-Schlüssel (Anthropic, OpenAI, etc.) | `npm i -g opencode-ai@latest` |
| **Qwen Code** | Qwen OAuth oder API-Schlüssel | `npm install -g @qwen-code/qwen-code@latest` |
| **Ollama** | Lokal (kein Abo nötig) | [Von ollama.com installieren](https://ollama.com) |
| **LocalAI** | Lokal (kein Abo nötig) | [Von localai.io installieren](https://localai.io) |

Du brauchst nur **ein** CLI zum Starten. Installiere **beliebige zwei** um den Brainstorm-Modus freizuschalten.

---

## Schnellstart

### 1. Mysti installieren

**Option A:** Drücke `Ctrl+P` (`Cmd+P` auf Mac), einfügen und ausführen:
```
ext install DeepMyst.mysti
```

**Option B:** [Vom VS Code Marketplace installieren](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti)

### 2. CLI-Tool installieren

```bash
# Claude Code (empfohlen)
npm install -g @anthropic-ai/claude-code
claude auth login

# Oder GitHub Copilot CLI (Zugang zu Claude, GPT-5, Gemini über GitHub)
npm install -g @github/copilot-cli
copilot  # dann /login-Befehl verwenden

# Oder Gemini CLI
npm install -g @google/gemini-cli
gemini auth login

# Oder Cursor
curl https://cursor.com/install -fsS | bash
agent login

# Oder OpenClaw
npm install -g openclaw@latest && openclaw onboard --install-daemon
openclaw login

# Oder OpenCode
npm i -g opencode-ai@latest
opencode auth login

# Oder Qwen Code
npm install -g @qwen-code/qwen-code@latest
qwen  # dann /auth eingeben
```

Für den Brainstorm-Modus installiere beliebige zwei CLI-Tools.

### 3. Mysti öffnen

- Klicke auf das **Mysti-Symbol** in der Aktivitätsleiste, oder
- Drücke `Ctrl+Shift+M` (`Cmd+Shift+M` auf Mac)

### 4. Loslegen

Gib deine Anfrage ein und lass die KI dir helfen!

---

## Slash-Befehle

Greife schnell auf Skills und Aktionen über das eingebaute Slash-Befehlsmenü zu.

<p align="center">
  <img src="docs/gifs/slash commands menu.gif" alt="Slash-Befehle-Menü" width="600">
</p>

---

## 12 umschaltbare Skills

Mische und kombiniere Verhaltensmodifikatoren:

- **Prägnant** - Klare, knappe Kommunikation
- **Testgetrieben** - Tests neben dem Code
- **Auto-Commit** - Inkrementelle Commits
- **Erste Prinzipien** - Grundlegendes Reasoning
- **Scope-Disziplin** - Fokus auf die Aufgabe
- Und 7 weitere...

[Vollständige Personas-&-Skills-Dokumentation](docs/PERSONAS-AND-SKILLS.md)

---

## Berechtigungskontrollen

Behalte die Kontrolle über das, was die KI tun kann:

- **Schreibgeschützt** - KI kann nur lesen, nie ändern
- **Erlaubnis einholen** - Jede Dateiänderung genehmigen
- **Vollzugriff** - Die KI autonom arbeiten lassen

<p align="center">
  <img src="docs/gifs/Semi auto answering questions .gif" alt="Berechtigungskontrollen-Demo" width="600">
</p>

---

## Konfiguration

### Grundeinstellungen

```json
{
  "mysti.defaultProvider": "claude-code",
  "mysti.brainstorm.agents": ["claude-code", "google-gemini"],
  "mysti.brainstorm.strategy": "quick",
  "mysti.accessLevel": "ask-permission"
}
```

### Anbieter-Einstellungen

| Einstellung | Standard | Beschreibung |
|------------|----------|-------------|
| `mysti.defaultProvider` | `claude-code` | Primärer KI-Anbieter |
| `mysti.claudePath` | `claude` | Pfad zum Claude CLI |
| `mysti.codexPath` | `codex` | Pfad zum Codex CLI |
| `mysti.geminiPath` | `gemini` | Pfad zum Gemini CLI |
| `mysti.copilotPath` | `copilot` | Pfad zum Copilot CLI |
| `mysti.clinePath` | `cline` | Pfad zum Cline CLI |
| `mysti.cursorPath` | `agent` | Pfad zum Cursor CLI |
| `mysti.openclawPath` | `openclaw` | Pfad zum OpenClaw CLI |
| `mysti.opencodePath` | `opencode` | Pfad zum OpenCode CLI |
| `mysti.qwenCodePath` | `qwen` | Pfad zum Qwen Code CLI |
| `mysti.ollamaPath` | `ollama` | Pfad zum Ollama CLI |
| `mysti.localaiPath` | `localai` | Pfad zum LocalAI CLI |

### Brainstorm-Einstellungen

| Einstellung | Standard | Beschreibung |
|------------|----------|-------------|
| `mysti.brainstorm.agents` | `["claude-code", "openai-codex"]` | Welche 2 Agenten nutzen |
| `mysti.brainstorm.strategy` | `quick` | Strategie: `quick`, `debate`, `red-team`, `perspectives`, `delphi` |
| `mysti.brainstorm.autoConverge` | `true` | Automatisch beenden bei Konvergenz |
| `mysti.brainstorm.maxDiscussionRounds` | `3` | Maximale Diskussionsrunden |

### Autonome Einstellungen

| Einstellung | Standard | Beschreibung |
|------------|----------|-------------|
| `mysti.autonomous.safetyMode` | `balanced` | `conservative`, `balanced`, `aggressive` |
| `mysti.autonomous.blockPatterns` | `[]` | Benutzerdefinierte Muster zum dauerhaften Blockieren |

### Komprimierungs-Einstellungen

| Einstellung | Standard | Beschreibung |
|------------|----------|-------------|
| `mysti.compaction.enabled` | `true` | Kontextkomprimierung aktivieren |
| `mysti.compaction.threshold` | `75` | Komprimierungsschwelle (% des Kontextfensters) |

### Allgemeine Einstellungen

| Einstellung | Standard | Beschreibung |
|------------|----------|-------------|
| `mysti.accessLevel` | `ask-permission` | Dateizugriffsebene |
| `mysti.agents.autoSuggest` | `true` | Personas automatisch vorschlagen |
| `mysti.agents.maxTokenBudget` | `0` | Max. Token für Agentenkontext (0 = unbegrenzt) |

[Vollständige Anbieter-Dokumentation](docs/PROVIDERS.md)

---

## Tastaturkürzel

| Aktion | Windows/Linux | Mac |
|--------|---------------|-----|
| Mysti öffnen | `Ctrl+Shift+M` | `Cmd+Shift+M` |
| In neuem Tab öffnen | `Ctrl+Shift+N` | `Cmd+Shift+N` |

---

## Befehle

| Befehl | Beschreibung |
|--------|-------------|
| `Mysti: Open Chat` | Chat-Seitenleiste öffnen |
| `Mysti: New Conversation` | Neue Konversation starten |
| `Mysti: Add to Context` | Datei/Auswahl zum Kontext hinzufügen |
| `Mysti: Clear Context` | Allen Kontext löschen |
| `Mysti: Open in New Tab` | Chat als Editor-Tab öffnen |

---

## Dokumentation

| Leitfaden | Beschreibung |
|-----------|-------------|
| [Anbieter](docs/PROVIDERS.md) | Alle 11 Anbieter — Setup, Modelle, Funktionen |
| [Brainstorm-Modus](docs/BRAINSTORM.md) | 5 Strategien, Konvergenz, Teamauswahl |
| [Personas & Skills](docs/PERSONAS-AND-SKILLS.md) | 16 Personas, 12 Skills, benutzerdefinierte Agenten |
| [Autonomer Modus](docs/AUTONOMOUS-MODE.md) | Sicherheitssystem, Gedächtnis, Fortsetzungsmodi |
| [@-Erwähnungen](docs/MENTIONS.md) | Agenten-Routing und Dateikontext |
| [Komprimierung](docs/COMPACTION.md) | Kontextverwaltung und Zusammenfassung |
| [Architektur](docs/ARCHITECTURE.md) | Technische Interna und Erweiterungspunkte |
| [Funktionen](docs/FEATURES.md) | Vollständige Funktionsreferenz |

---

## Telemetrie

Mysti sammelt **anonyme** Nutzungsdaten zur Verbesserung der Erweiterung:

- Funktionsnutzungsmuster
- Fehlerraten
- Anbieterpräferenzen

**Es werden niemals Code, Dateipfade oder persönliche Daten gesammelt.**

Respektiert die Telemetrie-Einstellung von VSCode. Deaktivieren über:
Einstellungen > Telemetry: Telemetry Level > off

---

## Mitwirkende

Danke an alle, die geholfen haben, Mysti zu verbessern!

<a href="https://github.com/BahaAbuNojaim"><img src="https://avatars.githubusercontent.com/u/6247079?v=4" width="60" height="60" style="border-radius:50%" alt="BahaAbuNojaim" /></a>
<a href="https://github.com/MostlyKIGuess"><img src="https://avatars.githubusercontent.com/u/135974627?v=4" width="60" height="60" style="border-radius:50%" alt="MostlyKIGuess" /></a>
<a href="https://github.com/a-programmers-programmer"><img src="https://avatars.githubusercontent.com/u/161260774?v=4" width="60" height="60" style="border-radius:50%" alt="a-programmers-programmer" /></a>
<a href="https://github.com/patrick-fu"><img src="https://avatars.githubusercontent.com/u/20736775?v=4" width="60" height="60" style="border-radius:50%" alt="patrick-fu" /></a>

Möchtest du mitmachen? Schau dir den Abschnitt [Beitragen](#beitragen) unten an.

---

## Star-Verlauf

Wenn Mysti dir nützlich war, erwäge einen Star zu geben — es hilft anderen, das Projekt zu entdecken und motiviert uns!

<p align="center">
  <a href="https://github.com/DeepMyst/Mysti/stargazers">
    <img src="https://img.shields.io/github/stars/DeepMyst/Mysti?style=for-the-badge&logo=github&color=yellow" alt="GitHub Stars" />
  </a>
</p>

<p align="center">
  <a href="https://star-history.com/#DeepMyst/Mysti&Date">
    <img src="https://api.star-history.com/svg?repos=DeepMyst/Mysti&type=Date" width="600" alt="Star-Verlaufsdiagramm" />
  </a>
</p>

---

## Beitragen

Wir freuen uns über Beiträge! Ob Fehlermeldungen, Feature-Anfragen oder Code-Beiträge.

- **Gute erste Issues**: Suche nach [`good first issue`](https://github.com/DeepMyst/Mysti/labels/good%20first%20issue) Labels
- **Entwicklung**: Drücke `F5` in VS Code um den Extension Development Host zu starten
- **Pull Requests**: Forke, erstelle einen Feature-Branch und reiche einen PR ein

Siehe [CONTRIBUTING.md](CONTRIBUTING.md) für detaillierte Richtlinien.

---

## Lizenz

Apache License 2.0 — frei zu verwenden, zu modifizieren und zu verteilen, einschließlich für kommerzielle Zwecke.
Siehe die `LICENSE`-Datei für den vollständigen Text.

---

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">Installieren</a> •
  <a href="https://github.com/DeepMyst/Mysti/issues">Problem melden</a> •
  <a href="https://github.com/DeepMyst/Mysti">GitHub</a>
</p>

<p align="center">
  <strong>Mysti</strong> — Erstellt von <a href="https://www.deepmyst.com/mysti">DeepMyst Inc</a><br>
  <sub>Gemacht mit Mysti</sub>
</p>
