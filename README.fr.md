<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.ar.md">العربية</a> | <a href="README.de.md">Deutsch</a> | Français | <a href="README.tr.md">Türkçe</a> | <a href="README.ru.md">Русский</a>
</p>

# Mysti - Votre Équipe de Codage IA Travaillant Ensemble

<p align="center">
  <img src="resources/Mysti-Logo.png" alt="Logo Mysti" width="128" height="128">
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/v/DeepMyst.mysti?style=flat-square&label=Version" alt="Version">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/i/DeepMyst.mysti?style=flat-square&label=Installs" alt="Installations">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/r/DeepMyst.mysti?style=flat-square&label=Rating" alt="Note">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/stargazers">
    <img src="https://img.shields.io/github/stars/DeepMyst/Mysti?style=flat-square&label=Stars" alt="GitHub Stars">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/network/members">
    <img src="https://img.shields.io/github/forks/DeepMyst/Mysti?style=flat-square&label=Forks" alt="GitHub Forks">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue?style=flat-square" alt="Licence">
  </a>
</p>

<p align="center">
  <strong>Votre équipe de codage IA pour VSCode</strong><br>
  <em>11 fournisseurs d'IA — Claude Code, Codex, Gemini, Copilot, Cline, Cursor, OpenClaw, OpenCode, Qwen Code, Ollama et LocalAI — travaillant seuls ou en équipe</em><br>
  <em>La sagesse collective où l'intelligence combinée de plusieurs agents surpasse un seul.</em>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/badge/Installer%20depuis-VS%20Code%20Marketplace-007ACC?style=for-the-badge&logo=visual-studio-code" alt="Installer depuis VS Code Marketplace">
  </a>
</p>

<p align="center">
  <a href="#choisissez-votre-ia">Fournisseurs</a> •
  <a href="#mode-brainstorm">Brainstorm</a> •
  <a href="#fonctionnalités-principales">Fonctionnalités</a> •
  <a href="#démarrage-rapide">Démarrage Rapide</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#documentation">Docs</a>
</p>

---

## Nouveautés v0.3.4

### 11 Fournisseurs d'IA

Mysti prend désormais en charge **11 fournisseurs d'IA** — ajout de **OpenCode**, **Qwen Code**, **Ollama** et **LocalAI** aux côtés de Claude Code, Codex, Gemini, GitHub Copilot, Cline, Cursor et OpenClaw. Exécutez des modèles locaux avec Ollama/LocalAI ou utilisez des fournisseurs cloud comme OpenCode et Qwen Code. Chaque fournisseur a son propre logo dans l'interface.

### Qwen Code

CLI de codage IA d'Alibaba avec des capacités de raisonnement profond. Utilise le même protocole de streaming que Claude Code pour une intégration transparente. Prend en charge les modèles Qwen3 Coder avec les modes d'approbation plan, auto-edit et yolo.

### OpenCode

Agent de codage multi-backend supportant Anthropic, OpenAI, Google et Groq via un seul CLI. Utilise votre modèle par défaut configuré — pas de verrouillage fournisseur.

### Support IA Locale

Exécutez des modèles d'IA localement avec **Ollama** et **LocalAI** — pas d'abonnement cloud nécessaire. Confidentialité totale, latence nulle, contrôle total de vos modèles.

---

## Installation en Quelques Secondes

**Depuis VS Code :** Appuyez sur `Ctrl+P` (`Cmd+P` sur Mac), puis collez :

```
ext install DeepMyst.mysti
```

**Ou** [installez depuis le VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti)

---

## Choisissez Votre IA

Mysti fonctionne avec les outils de codage IA que vous possédez déjà. **Pas d'abonnement supplémentaire nécessaire.**

<p align="center">
  <img src="docs/gifs/agent switching.gif" alt="Changement d'Agent" width="450">
</p>

| Fournisseur | Idéal Pour |
|-------------|-----------|
| **Claude Code** | Raisonnement profond, refactoring complexe, analyse approfondie |
| **Codex** | Itérations rapides, style familier d'OpenAI |
| **Gemini** | Réponses rapides, intégration écosystème Google |
| **GitHub Copilot** | Accès multi-modèle (Claude, GPT-5, Gemini) via abonnement GitHub |
| **Cline** | Mode Plan/Act, achèvement structuré des tâches |
| **Cursor** | Sélection automatique du modèle, multi-modèle avec Claude, GPT-5, Gemini |
| **OpenClaw** | Streaming WebSocket en temps réel, niveaux de réflexion configurables |
| **OpenCode** | Agent multi-backend (Anthropic, OpenAI, Google, Groq) |
| **Qwen Code** | Agent de codage IA d'Alibaba, raisonnement profond |
| **Ollama** | Inférence LLM locale, confidentialité d'abord, sans abonnement |
| **LocalAI** | Modèles IA auto-hébergés, contrôle total |

**Changez de fournisseur en un clic. Pas de verrouillage.**

### Pourquoi Mysti ?

| vs Copilot/Cursor | Avantage Mysti |
|-------------------|---------------|
| IA unique | **Brainstorming multi-agents** — deux IA collaborent avec 5 stratégies |
| Verrouillé à un fournisseur | **11 fournisseurs** — Claude, Codex, Gemini, Copilot, Cline, Cursor, OpenClaw, OpenCode, Qwen, Ollama, LocalAI |
| Boîte noire | **Contrôle total des permissions** — lecture seule jusqu'à accès complet |
| Réponses génériques | **16 personas** — architecte, débogueur, expert sécurité... |
| Flux de travail manuel | **Mode autonome** — l'IA travaille indépendamment avec des contrôles de sécurité |
| Pas de routage inter-agents | **@mentions** — acheminez les tâches vers des agents spécifiques en ligne |

---

## Voyez-le en Action

<p align="center">
  <img src="docs/gifs/main screen.gif" alt="Interface de Chat Mysti" width="700">
</p>

<p align="center"><em>Interface de chat belle et moderne avec coloration syntaxique, support Markdown et diagrammes Mermaid</em></p>

<p align="center">
  <img src="docs/gifs/Task list rendering and progress tracking.gif" alt="Rendu de Liste de Tâches" width="700">
</p>

<p align="center"><em>Rendu de liste de tâches en temps réel et suivi de progression</em></p>

---

## Mode Brainstorm

**Besoin d'un second avis ?** Activez le Mode Brainstorm et laissez deux agents IA résoudre votre problème ensemble. **Choisissez n'importe quels 2 agents parmi 11** depuis le panneau de paramètres.

<p align="center">
  <img src="docs/gifs/brainstorm example.gif" alt="Mode Brainstorm" width="700">
</p>

### 5 Stratégies de Collaboration

| Stratégie | Rôles | Idéal Pour |
|-----------|-------|-----------|
| **Quick** | Synthèse directe | Tâches simples, réponses rapides |
| **Debate** | Critique vs Défenseur | Décisions d'architecture, compromis |
| **Red-Team** | Proposant vs Challenger | Revues de sécurité, découverte de cas limites |
| **Perspectives** | Analyste de Risque vs Innovateur | Conception greenfield, sélection technologique |
| **Delphi** | Facilitateur vs Affineur | Problèmes complexes, atteindre un consensus |

### Pourquoi Deux IA Valent Mieux Qu'une

**Claude Code** (Anthropic), **Codex** (OpenAI), **Gemini** (Google), **GitHub Copilot**, **Cline**, **Cursor**, **OpenClaw**, **OpenCode**, **Qwen Code** (Alibaba), **Ollama** et **LocalAI** ont des entraînements différents, des forces différentes et des angles morts différents. Quand deux travaillent ensemble :

- Chaque IA repère des cas limites que l'autre pourrait manquer
- Des perspectives différentes mènent à des solutions plus robustes
- **Ensemble** ils débattent, se défient mutuellement et synthétisent la meilleure solution

C'est comme avoir un développeur senior et un lead technique qui examinent votre code — sauf qu'ils en discutent vraiment d'abord.

### Détection de Convergence

Pendant les discussions, Mysti suit l'accord entre agents et la stabilité des positions. Quand l'**auto-convergence** est activée, la discussion se termine prématurément dès que les agents atteignent un consensus — gain de temps sans sacrifier la qualité.

### Choisissez Votre Équipe

Configurez quels deux agents collaborent dans le **Panneau de Paramètres** :

<p align="center">
  <img src="docs/gifs/Brainstorm model selection.gif" alt="Sélection de Modèle Brainstorm" width="600">
</p>

| Combinaison | Idéal Pour |
|-------------|-----------|
| Claude + Codex | Analyse profonde et itération rapide |
| Claude + Gemini | Raisonnement approfondi avec validation rapide |
| Claude + Copilot | Comparer Claude natif vs l'approche multi-modèle de Copilot |
| Cursor + Gemini | Flexibilité multi-modèle avec intégration Google |
| OpenClaw + Claude | Streaming WebSocket avec raisonnement profond |
| Qwen + Claude | Comparer le raisonnement d'Alibaba et Anthropic |
| OpenCode + Gemini | Flexibilité multi-backend avec vitesse Google |
| Ollama + Claude | Confidentialité locale et intelligence cloud |

[Documentation complète du Brainstorm](docs/BRAINSTORM.md)

### Détection Intelligente de Plans

Quand l'IA présente plusieurs approches d'implémentation, Mysti les détecte automatiquement et vous laisse choisir votre chemin préféré.

<p align="center">
  <img src="docs/screenshots/plan-suggestions.png" alt="Suggestions de Plan" width="600">
</p>

*Nécessite au moins 2 outils CLI installés. Voir [Prérequis](#prérequis).*

---

## Fonctionnalités Principales

### Mode Autonome

Laissez l'IA travailler indépendamment avec des contrôles de sécurité configurables :

- **Classificateur de Sécurité** : Trois niveaux — sûr (auto-approbation), prudence (dépendant du mode), bloqué (toujours refuser)
- **Trois Modes de Sécurité** : Conservateur, Équilibré, Agressif
- **Mémoire d'Apprentissage** : Se souvient de vos préférences de permissions et s'améliore avec le temps
- **Modes de Continuation** : Basé sur les objectifs ou file d'attente pour des sessions autonomes prolongées
- **Piste d'Audit** : Chaque décision autonome est enregistrée pour révision

<p align="center">
  <img src="docs/gifs/Selecting autonomy mode.gif" alt="Sélection du Mode Autonome" width="600">
</p>

[Documentation complète du Mode Autonome](docs/AUTONOMOUS-MODE.md)

### Système de @Mentions

Acheminez des tâches vers des agents spécifiques et référencez des fichiers en ligne :

<p align="center">
  <img src="docs/gifs/Agent tagging and multi agent workflows.gif" alt="Étiquetage @Mention" width="600">
</p>

```
@claude Examine ce code pour des problèmes de sécurité
@src/auth.ts @gemini Suggère des améliorations de performance pour ce fichier
@claude Écris des tests, puis @codex optimise-les
```

- **Mentions de fichier** : `@filename` ajoute du contexte transitoire
- **Mentions d'agent** : `@agent` achemine les tâches vers ce fournisseur
- **Chaînage** : Les agents suivants reçoivent les réponses des précédents comme contexte

[Documentation complète des @Mentions](docs/MENTIONS.md)

### Compaction de Contexte

Gestion intelligente des conversations qui prévient le débordement de contexte :

- **Automatique** : Se déclenche quand l'utilisation de tokens approche le seuil (par défaut 75%)
- **Support natif** : Claude Code utilise la commande intégrée `/compact`
- **Côté client** : Les autres fournisseurs utilisent un résumé intelligent des messages
- **Suivi par panneau** : Chaque panneau de chat suit l'utilisation indépendamment

[Documentation complète de la Compaction](docs/COMPACTION.md)

### 16 Personas de Développeur

Façonnez la façon dont votre IA pense. Sélectionnez parmi des personas spécialisées qui changent l'approche de l'IA face à vos problèmes.

<p align="center">
  <img src="docs/gifs/Personas and skills.gif" alt="Panneau Personas et Compétences" width="550">
</p>

| Persona | Focus |
|---------|-------|
| **Architecte** | Conception système, scalabilité, structure propre |
| **Débogueur** | Analyse des causes profondes, correction de bugs |
| **Expert Sécurité** | Vulnérabilités, modélisation des menaces |
| **Optimiseur de Performance** | Optimisation, profilage, latence |
| **Prototypeur** | Itération rapide, PoCs |
| **Refactoriseur** | Qualité du code, maintenabilité |
| + 10 autres... | Full-Stack, DevOps, Mentor, Designer... |

[Documentation complète des Personas et Compétences](docs/PERSONAS-AND-SKILLS.md)

---

### Sélection Rapide de Persona

Sélectionnez des personas directement depuis la barre d'outils sans ouvrir de panneaux.

<p align="center">
  <img src="docs/screenshots/persona-toolbar.png" alt="Sélection de Persona dans la Barre d'Outils" width="550">
</p>

---

### Suggestions Automatiques Intelligentes

Mysti suggère automatiquement des personas et actions pertinentes basées sur votre message.

<p align="center">
  <img src="docs/gifs/PErsona Suggestion.gif" alt="Suggestions Automatiques" width="550">
</p>

---

### Historique des Conversations

Ne perdez jamais votre travail. Toutes les conversations sont sauvegardées et facilement accessibles.

<p align="center">
  <img src="docs/screenshots/conversation-history.png" alt="Historique des Conversations" width="450">
</p>

---

### Actions Rapides d'Accueil

Démarrez rapidement avec des actions en un clic pour les tâches courantes.

<p align="center">
  <img src="docs/screenshots/quick-actions-welcome.png" alt="Actions Rapides" width="550">
</p>

---

### Paramètres Complets

Ajustez chaque aspect de Mysti, y compris les budgets de tokens, les niveaux d'accès et le mode brainstorm.

<p align="center">
  <img src="docs/screenshots/settings-panel.png" alt="Panneau de Paramètres" width="450">
</p>

---

## Prérequis

**Vous payez déjà pour Claude, ChatGPT, Gemini ou GitHub Copilot ? Vous êtes prêt.**

Mysti fonctionne avec vos abonnements existants — pas de coûts supplémentaires !

| Outil CLI | Abonnement | Installation |
|-----------|------------|-------------|
| **Claude Code** (recommandé) | Anthropic API ou Claude Pro/Max | `npm install -g @anthropic-ai/claude-code` |
| **GitHub Copilot CLI** | GitHub Copilot Pro/Pro+/Business | `npm install -g @github/copilot-cli` |
| **Gemini CLI** | Google AI API ou Gemini Advanced | `npm install -g @google/gemini-cli` |
| **Codex CLI** | OpenAI API | Suivez le guide d'installation d'OpenAI |
| **Cline** | Dépend du fournisseur de modèle | `npm install -g cline` |
| **Cursor** | Abonnement Cursor | `curl https://cursor.com/install -fsS \| bash` |
| **OpenClaw** | Compte OpenClaw | `npm install -g openclaw@latest && openclaw onboard --install-daemon` |
| **OpenCode** | Clés API fournisseur (Anthropic, OpenAI, etc.) | `npm i -g opencode-ai@latest` |
| **Qwen Code** | Qwen OAuth ou clés API | `npm install -g @qwen-code/qwen-code@latest` |
| **Ollama** | Local (pas d'abonnement nécessaire) | [Installer depuis ollama.com](https://ollama.com) |
| **LocalAI** | Local (pas d'abonnement nécessaire) | [Installer depuis localai.io](https://localai.io) |

Vous n'avez besoin que d'**un seul** CLI pour commencer. Installez **n'importe lesquels deux** pour débloquer le Mode Brainstorm.

---

## Démarrage Rapide

### 1. Installer Mysti

**Option A :** Appuyez sur `Ctrl+P` (`Cmd+P` sur Mac), collez et exécutez :
```
ext install DeepMyst.mysti
```

**Option B :** [Installer depuis le VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti)

### 2. Installer un Outil CLI

```bash
# Claude Code (recommandé)
npm install -g @anthropic-ai/claude-code
claude auth login

# Ou GitHub Copilot CLI (accédez à Claude, GPT-5, Gemini via GitHub)
npm install -g @github/copilot-cli
copilot  # puis utilisez la commande /login

# Ou Gemini CLI
npm install -g @google/gemini-cli
gemini auth login

# Ou Cursor
curl https://cursor.com/install -fsS | bash
agent login

# Ou OpenClaw
npm install -g openclaw@latest && openclaw onboard --install-daemon
openclaw login

# Ou OpenCode
npm i -g opencode-ai@latest
opencode auth login

# Ou Qwen Code
npm install -g @qwen-code/qwen-code@latest
qwen  # puis tapez /auth
```

Pour le Mode Brainstorm, installez deux outils CLI quelconques.

### 3. Ouvrir Mysti

- Cliquez sur l'**icône Mysti** dans la Barre d'Activité, ou
- Appuyez sur `Ctrl+Shift+M` (`Cmd+Shift+M` sur Mac)

### 4. Commencer à Coder

Tapez votre demande et laissez l'IA vous assister !

---

## Commandes Slash

Accédez rapidement aux compétences et actions avec le menu de commandes slash intégré.

<p align="center">
  <img src="docs/gifs/slash commands menu.gif" alt="Menu des Commandes Slash" width="600">
</p>

---

## 12 Compétences Activables

Mélangez et combinez les modificateurs de comportement :

- **Concis** - Communication claire et brève
- **Piloté par les Tests** - Tests avec le code
- **Auto-Commit** - Commits incrémentaux
- **Premiers Principes** - Raisonnement fondamental
- **Discipline de Périmètre** - Rester focalisé sur la tâche
- Et 7 autres...

[Documentation complète des Personas et Compétences](docs/PERSONAS-AND-SKILLS.md)

---

## Contrôles de Permissions

Gardez le contrôle sur ce que l'IA peut faire :

- **Lecture seule** - L'IA ne peut que lire, jamais modifier
- **Demander la permission** - Approuver chaque modification de fichier
- **Accès complet** - Laisser l'IA travailler de manière autonome

<p align="center">
  <img src="docs/gifs/Semi auto answering questions .gif" alt="Démo des Contrôles de Permissions" width="600">
</p>

---

## Configuration

### Paramètres Essentiels

```json
{
  "mysti.defaultProvider": "claude-code",
  "mysti.brainstorm.agents": ["claude-code", "google-gemini"],
  "mysti.brainstorm.strategy": "quick",
  "mysti.accessLevel": "ask-permission"
}
```

### Paramètres des Fournisseurs

| Paramètre | Par défaut | Description |
|-----------|-----------|-------------|
| `mysti.defaultProvider` | `claude-code` | Fournisseur IA principal |
| `mysti.claudePath` | `claude` | Chemin vers le CLI Claude |
| `mysti.codexPath` | `codex` | Chemin vers le CLI Codex |
| `mysti.geminiPath` | `gemini` | Chemin vers le CLI Gemini |
| `mysti.copilotPath` | `copilot` | Chemin vers le CLI Copilot |
| `mysti.clinePath` | `cline` | Chemin vers le CLI Cline |
| `mysti.cursorPath` | `agent` | Chemin vers le CLI Cursor |
| `mysti.openclawPath` | `openclaw` | Chemin vers le CLI OpenClaw |
| `mysti.opencodePath` | `opencode` | Chemin vers le CLI OpenCode |
| `mysti.qwenCodePath` | `qwen` | Chemin vers le CLI Qwen Code |
| `mysti.ollamaPath` | `ollama` | Chemin vers le CLI Ollama |
| `mysti.localaiPath` | `localai` | Chemin vers le CLI LocalAI |

### Paramètres Brainstorm

| Paramètre | Par défaut | Description |
|-----------|-----------|-------------|
| `mysti.brainstorm.agents` | `["claude-code", "openai-codex"]` | Quels 2 agents utiliser |
| `mysti.brainstorm.strategy` | `quick` | Stratégie : `quick`, `debate`, `red-team`, `perspectives`, `delphi` |
| `mysti.brainstorm.autoConverge` | `true` | Sortie automatique à la convergence |
| `mysti.brainstorm.maxDiscussionRounds` | `3` | Nombre maximum de tours de discussion |

### Paramètres Autonomes

| Paramètre | Par défaut | Description |
|-----------|-----------|-------------|
| `mysti.autonomous.safetyMode` | `balanced` | `conservative`, `balanced`, `aggressive` |
| `mysti.autonomous.blockPatterns` | `[]` | Motifs personnalisés à toujours bloquer |

### Paramètres de Compaction

| Paramètre | Par défaut | Description |
|-----------|-----------|-------------|
| `mysti.compaction.enabled` | `true` | Activer la compaction de contexte |
| `mysti.compaction.threshold` | `75` | Seuil de compaction (% de la fenêtre de contexte) |

### Paramètres Généraux

| Paramètre | Par défaut | Description |
|-----------|-----------|-------------|
| `mysti.accessLevel` | `ask-permission` | Niveau d'accès aux fichiers |
| `mysti.agents.autoSuggest` | `true` | Suggestion automatique de personas |
| `mysti.agents.maxTokenBudget` | `0` | Max tokens pour le contexte agent (0 = illimité) |

[Documentation complète des Fournisseurs](docs/PROVIDERS.md)

---

## Raccourcis Clavier

| Action | Windows/Linux | Mac |
|--------|---------------|-----|
| Ouvrir Mysti | `Ctrl+Shift+M` | `Cmd+Shift+M` |
| Ouvrir dans un Nouvel Onglet | `Ctrl+Shift+N` | `Cmd+Shift+N` |

---

## Commandes

| Commande | Description |
|----------|-------------|
| `Mysti: Open Chat` | Ouvrir la barre latérale de chat |
| `Mysti: New Conversation` | Démarrer une nouvelle conversation |
| `Mysti: Add to Context` | Ajouter fichier/sélection au contexte |
| `Mysti: Clear Context` | Effacer tout le contexte |
| `Mysti: Open in New Tab` | Ouvrir le chat comme onglet éditeur |

---

## Documentation

| Guide | Description |
|-------|-------------|
| [Fournisseurs](docs/PROVIDERS.md) | Les 11 fournisseurs — configuration, modèles, fonctionnalités |
| [Mode Brainstorm](docs/BRAINSTORM.md) | 5 stratégies, convergence, sélection d'équipe |
| [Personas & Compétences](docs/PERSONAS-AND-SKILLS.md) | 16 personas, 12 compétences, agents personnalisés |
| [Mode Autonome](docs/AUTONOMOUS-MODE.md) | Système de sécurité, mémoire, modes de continuation |
| [@Mentions](docs/MENTIONS.md) | Routage d'agents et contexte de fichiers |
| [Compaction](docs/COMPACTION.md) | Gestion du contexte et résumé |
| [Architecture](docs/ARCHITECTURE.md) | Détails techniques et points d'extension |
| [Fonctionnalités](docs/FEATURES.md) | Référence complète des fonctionnalités |

---

## Télémétrie

Mysti collecte des données d'utilisation **anonymes** pour améliorer l'extension :

- Modèles d'utilisation des fonctionnalités
- Taux d'erreur
- Préférences de fournisseurs

**Aucun code, chemin de fichier ou donnée personnelle n'est jamais collecté.**

Respecte le paramètre de télémétrie de VSCode. Désactivez via :
Paramètres > Telemetry: Telemetry Level > off

---

## Contributeurs

Merci à tous ceux qui ont aidé à améliorer Mysti !

<a href="https://github.com/BahaAbuNojaim"><img src="https://avatars.githubusercontent.com/u/6247079?v=4" width="60" height="60" style="border-radius:50%" alt="BahaAbuNojaim" /></a>
<a href="https://github.com/MostlyKIGuess"><img src="https://avatars.githubusercontent.com/u/135974627?v=4" width="60" height="60" style="border-radius:50%" alt="MostlyKIGuess" /></a>
<a href="https://github.com/a-programmers-programmer"><img src="https://avatars.githubusercontent.com/u/161260774?v=4" width="60" height="60" style="border-radius:50%" alt="a-programmers-programmer" /></a>
<a href="https://github.com/patrick-fu"><img src="https://avatars.githubusercontent.com/u/20736775?v=4" width="60" height="60" style="border-radius:50%" alt="patrick-fu" /></a>

Envie de nous rejoindre ? Consultez la section [Contribuer](#contribuer) ci-dessous.

---

## Historique des Stars

Si Mysti vous a été utile, pensez à lui donner une étoile — cela aide les autres à découvrir le projet et nous motive !

<p align="center">
  <a href="https://github.com/DeepMyst/Mysti/stargazers">
    <img src="https://img.shields.io/github/stars/DeepMyst/Mysti?style=for-the-badge&logo=github&color=yellow" alt="GitHub Stars" />
  </a>
</p>

<p align="center">
  <a href="https://star-history.com/#DeepMyst/Mysti&Date">
    <img src="https://api.star-history.com/svg?repos=DeepMyst/Mysti&type=Date" width="600" alt="Graphique de l'Historique des Stars" />
  </a>
</p>

---

## Contribuer

Les contributions sont les bienvenues ! Que ce soit des rapports de bugs, des demandes de fonctionnalités ou des contributions de code.

- **Bonnes Premières Issues** : Cherchez les labels [`good first issue`](https://github.com/DeepMyst/Mysti/labels/good%20first%20issue)
- **Développement** : Appuyez sur `F5` dans VS Code pour lancer l'Extension Development Host
- **Pull Requests** : Forkez, créez une branche de fonctionnalité et soumettez un PR

Voir [CONTRIBUTING.md](CONTRIBUTING.md) pour les directives détaillées.

---

## Licence

Apache License 2.0 — libre d'utilisation, de modification et de distribution, y compris à des fins commerciales.
Voir le fichier `LICENSE` pour le texte complet.

---

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">Installer</a> •
  <a href="https://github.com/DeepMyst/Mysti/issues">Signaler un Problème</a> •
  <a href="https://github.com/DeepMyst/Mysti">GitHub</a>
</p>

<p align="center">
  <strong>Mysti</strong> — Créé par <a href="https://www.deepmyst.com/mysti">DeepMyst Inc</a><br>
  <sub>Fait avec Mysti</sub>
</p>
