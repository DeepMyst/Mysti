<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | Español | <a href="README.pt-BR.md">Português</a> | <a href="README.ar.md">العربية</a> | <a href="README.de.md">Deutsch</a> | <a href="README.fr.md">Français</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.ru.md">Русский</a>
</p>

# Mysti - Tu Equipo de Codificación con IA Trabajando Juntos

<p align="center">
  <img src="resources/Mysti-Logo.png" alt="Logo de Mysti" width="128" height="128">
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/v/DeepMyst.mysti?style=flat-square&label=Version" alt="Versión">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/i/DeepMyst.mysti?style=flat-square&label=Installs" alt="Instalaciones">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/r/DeepMyst.mysti?style=flat-square&label=Rating" alt="Calificación">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/stargazers">
    <img src="https://img.shields.io/github/stars/DeepMyst/Mysti?style=flat-square&label=Stars" alt="GitHub Stars">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/network/members">
    <img src="https://img.shields.io/github/forks/DeepMyst/Mysti?style=flat-square&label=Forks" alt="GitHub Forks">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue?style=flat-square" alt="Licencia">
  </a>
</p>

<p align="center">
  <strong>Tu equipo de codificación con IA para VSCode</strong><br>
  <em>11 proveedores de IA — Claude Code, Codex, Gemini, Copilot, Cline, Cursor, OpenClaw, OpenCode, Qwen Code, Ollama y LocalAI — trabajando solos o en equipo</em><br>
  <em>Sabiduría colectiva donde la inteligencia colectiva de varios agentes supera a uno solo.</em>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/badge/Instalar%20desde-VS%20Code%20Marketplace-007ACC?style=for-the-badge&logo=visual-studio-code" alt="Instalar desde VS Code Marketplace">
  </a>
</p>

<p align="center">
  <a href="#elige-tu-ia">Proveedores</a> •
  <a href="#modo-brainstorm">Brainstorm</a> •
  <a href="#características-principales">Características</a> •
  <a href="#inicio-rápido">Inicio Rápido</a> •
  <a href="#configuración">Configuración</a> •
  <a href="#documentación">Docs</a>
</p>

---

## Novedades en v0.3.4

### 11 Proveedores de IA

Mysti ahora soporta **11 proveedores de IA** — se añadieron **OpenCode**, **Qwen Code**, **Ollama** y **LocalAI** junto a Claude Code, Codex, Gemini, GitHub Copilot, Cline, Cursor y OpenClaw. Ejecuta modelos locales con Ollama/LocalAI o usa proveedores en la nube como OpenCode y Qwen Code. Cada proveedor tiene su propio logo auténtico en la interfaz.

### Qwen Code

CLI de codificación con IA de Alibaba con capacidades de razonamiento profundo. Usa el mismo protocolo de streaming que Claude Code para una integración perfecta. Soporta modelos Qwen3 Coder con modos de aprobación plan, auto-edit y yolo.

### OpenCode

Agente de codificación multi-backend que soporta Anthropic, OpenAI, Google y Groq a través de un solo CLI. Usa tu modelo predeterminado configurado — sin dependencia de proveedores específicos.

### Soporte de IA Local

Ejecuta modelos de IA localmente con **Ollama** y **LocalAI** — sin necesidad de suscripción en la nube. Privacidad total, latencia cero, control completo sobre tus modelos.

---

## Instala en Segundos

**Desde VS Code:** Presiona `Ctrl+P` (`Cmd+P` en Mac), luego pega:

```
ext install DeepMyst.mysti
```

**O** [instala desde VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti)

---

## Elige Tu IA

Mysti funciona con las herramientas de codificación con IA que ya tienes. **Sin suscripciones adicionales.**

<p align="center">
  <img src="docs/gifs/agent switching.gif" alt="Cambio de Agente" width="450">
</p>

| Proveedor | Mejor Para |
|-----------|-----------|
| **Claude Code** | Razonamiento profundo, refactorización compleja, análisis exhaustivo |
| **Codex** | Iteraciones rápidas, estilo familiar de OpenAI |
| **Gemini** | Respuestas rápidas, integración con el ecosistema Google |
| **GitHub Copilot** | Acceso multi-modelo (Claude, GPT-5, Gemini) vía suscripción GitHub |
| **Cline** | Modo Plan/Act, finalización estructurada de tareas |
| **Cursor** | Selección automática de modelo, multi-modelo con Claude, GPT-5, Gemini |
| **OpenClaw** | Streaming WebSocket en tiempo real, niveles de pensamiento configurables |
| **OpenCode** | Agente multi-backend (Anthropic, OpenAI, Google, Groq) |
| **Qwen Code** | Agente de codificación IA de Alibaba, razonamiento profundo |
| **Ollama** | Inferencia LLM local, privacidad primero, sin suscripción |
| **LocalAI** | Modelos de IA autoalojados, control total |

**Cambia de proveedor con un clic. Sin dependencia.**

### ¿Por Qué Mysti?

| vs Copilot/Cursor | Ventaja de Mysti |
|-------------------|-----------------|
| IA única | **Brainstorming multi-agente** — dos IAs colaboran con 5 estrategias |
| Atado a un proveedor | **11 proveedores** — Claude, Codex, Gemini, Copilot, Cline, Cursor, OpenClaw, OpenCode, Qwen, Ollama, LocalAI |
| Caja negra | **Control total de permisos** — desde solo lectura hasta acceso completo |
| Respuestas genéricas | **16 personas** — arquitecto, depurador, experto en seguridad... |
| Flujo de trabajo manual | **Modo autónomo** — la IA trabaja independientemente con controles de seguridad |
| Sin enrutamiento entre agentes | **@menciones** — enruta tareas a agentes específicos en línea |

---

## Véalo en Acción

<p align="center">
  <img src="docs/gifs/main screen.gif" alt="Interfaz de Chat de Mysti" width="700">
</p>

<p align="center"><em>Interfaz de chat moderna y hermosa con resaltado de sintaxis, soporte Markdown y diagramas Mermaid</em></p>

<p align="center">
  <img src="docs/gifs/Task list rendering and progress tracking.gif" alt="Renderizado de Lista de Tareas" width="700">
</p>

<p align="center"><em>Renderizado de lista de tareas en tiempo real y seguimiento de progreso</em></p>

---

## Modo Brainstorm

**¿Quieres una segunda opinión?** Activa el Modo Brainstorm y deja que dos agentes de IA aborden tu problema juntos. **Elige cualquier 2 de 11 agentes** desde el panel de configuración.

<p align="center">
  <img src="docs/gifs/brainstorm example.gif" alt="Modo Brainstorm" width="700">
</p>

### 5 Estrategias de Colaboración

| Estrategia | Roles | Mejor Para |
|-----------|-------|-----------|
| **Quick** | Síntesis directa | Tareas simples, respuestas rápidas |
| **Debate** | Crítico vs Defensor | Decisiones de arquitectura, compensaciones |
| **Red-Team** | Proponente vs Desafiante | Revisiones de seguridad, descubrimiento de casos extremos |
| **Perspectives** | Analista de Riesgo vs Innovador | Diseño greenfield, selección de tecnología |
| **Delphi** | Facilitador vs Refinador | Problemas complejos, alcanzar consenso |

### Por Qué Dos IAs Son Mejor Que Una

**Claude Code** (Anthropic), **Codex** (OpenAI), **Gemini** (Google), **GitHub Copilot**, **Cline**, **Cursor**, **OpenClaw**, **OpenCode**, **Qwen Code** (Alibaba), **Ollama** y **LocalAI** tienen diferente entrenamiento, diferentes fortalezas y diferentes puntos ciegos. Cuando dos trabajan juntos:

- Cada IA detecta casos extremos que la otra podría pasar por alto
- Diferentes perspectivas conducen a soluciones más robustas
- **Juntos** debaten, se desafían mutuamente y sintetizan la mejor solución

Es como tener a un desarrollador senior y un líder técnico revisando tu código — excepto que realmente lo discuten primero.

### Detección de Convergencia

Durante las discusiones, Mysti rastrea el acuerdo entre agentes y la estabilidad de posiciones. Cuando la **auto-convergencia** está habilitada, la discusión termina anticipadamente una vez que los agentes alcanzan consenso — ahorrando tiempo sin sacrificar calidad.

### Elige Tu Equipo

Configura qué dos agentes colaboran en el **Panel de Configuración**:

<p align="center">
  <img src="docs/gifs/Brainstorm model selection.gif" alt="Selección de Modelo Brainstorm" width="600">
</p>

| Combinación | Mejor Para |
|-------------|-----------|
| Claude + Codex | Análisis profundo con iteración rápida |
| Claude + Gemini | Razonamiento exhaustivo con validación rápida |
| Claude + Copilot | Compara Claude nativo vs el enfoque multi-modelo de Copilot |
| Cursor + Gemini | Flexibilidad multi-modelo con integración Google |
| OpenClaw + Claude | Streaming WebSocket con razonamiento profundo |
| Qwen + Claude | Compara razonamiento de Alibaba y Anthropic |
| OpenCode + Gemini | Flexibilidad multi-backend con velocidad Google |
| Ollama + Claude | Privacidad local con inteligencia en la nube |

[Documentación completa de Brainstorm](docs/BRAINSTORM.md)

### Detección Inteligente de Planes

Cuando la IA presenta múltiples enfoques de implementación, Mysti los detecta automáticamente y te permite elegir tu camino preferido.

<p align="center">
  <img src="docs/screenshots/plan-suggestions.png" alt="Sugerencias de Plan" width="600">
</p>

*Requiere al menos 2 herramientas CLI instaladas. Ver [Requisitos](#requisitos).*

---

## Características Principales

### Modo Autónomo

Deja que la IA trabaje independientemente con controles de seguridad configurables:

- **Clasificador de Seguridad**: Tres niveles — seguro (auto-aprobar), precaución (dependiente del modo), bloqueado (siempre denegar)
- **Tres Modos de Seguridad**: Conservador, Equilibrado, Agresivo
- **Memoria de Aprendizaje**: Recuerda tus preferencias de permisos y mejora con el tiempo
- **Modos de Continuación**: Basado en objetivos o cola de tareas para sesiones autónomas extendidas
- **Registro de Auditoría**: Cada decisión autónoma queda registrada para revisión

<p align="center">
  <img src="docs/gifs/Selecting autonomy mode.gif" alt="Seleccionando Modo Autónomo" width="600">
</p>

[Documentación completa de Modo Autónomo](docs/AUTONOMOUS-MODE.md)

### Sistema de @Menciones

Enruta tareas a agentes específicos y referencia archivos en línea:

<p align="center">
  <img src="docs/gifs/Agent tagging and multi agent workflows.gif" alt="Etiquetado @Mención" width="600">
</p>

```
@claude Revisa este código por problemas de seguridad
@src/auth.ts @gemini Sugiere mejoras de rendimiento para este archivo
@claude Escribe tests, luego @codex optimízalos
```

- **Menciones de archivo**: `@filename` añade contexto transitorio
- **Menciones de agente**: `@agent` enruta tareas a ese proveedor
- **Encadenamiento**: Los agentes posteriores reciben las respuestas de los anteriores como contexto

[Documentación completa de @Menciones](docs/MENTIONS.md)

### Compactación de Contexto

Gestión inteligente de conversación que previene el desbordamiento de contexto:

- **Automática**: Se activa cuando el uso de tokens se acerca al umbral (predeterminado 75%)
- **Soporte nativo**: Claude Code usa el comando integrado `/compact`
- **Del lado del cliente**: Otros proveedores usan resumen inteligente de mensajes
- **Seguimiento por panel**: Cada panel de chat rastrea el uso independientemente

[Documentación completa de Compactación](docs/COMPACTION.md)

### 16 Personas de Desarrollador

Moldea cómo piensa tu IA. Selecciona de personas especializadas que cambian el enfoque de la IA ante tus problemas.

<p align="center">
  <img src="docs/gifs/Personas and skills.gif" alt="Panel de Personas y Habilidades" width="550">
</p>

| Persona | Enfoque |
|---------|---------|
| **Arquitecto** | Diseño de sistemas, escalabilidad, estructura limpia |
| **Depurador** | Análisis de causa raíz, corrección de bugs |
| **Orientado a Seguridad** | Vulnerabilidades, modelado de amenazas |
| **Optimizador de Rendimiento** | Optimización, profiling, latencia |
| **Prototipador** | Iteración rápida, PoCs |
| **Refactorizador** | Calidad de código, mantenibilidad |
| + 10 más... | Full-Stack, DevOps, Mentor, Diseñador... |

[Documentación completa de Personas y Habilidades](docs/PERSONAS-AND-SKILLS.md)

---

### Selección Rápida de Persona

Selecciona personas directamente desde la barra de herramientas sin abrir paneles.

<p align="center">
  <img src="docs/screenshots/persona-toolbar.png" alt="Selección de Persona en Barra de Herramientas" width="550">
</p>

---

### Sugerencias Automáticas Inteligentes

Mysti sugiere automáticamente personas y acciones relevantes basándose en tu mensaje.

<p align="center">
  <img src="docs/gifs/PErsona Suggestion.gif" alt="Sugerencias Automáticas" width="550">
</p>

---

### Historial de Conversaciones

Nunca pierdas tu trabajo. Todas las conversaciones se guardan y son fácilmente accesibles.

<p align="center">
  <img src="docs/screenshots/conversation-history.png" alt="Historial de Conversaciones" width="450">
</p>

---

### Acciones Rápidas en Bienvenida

Comienza rápidamente con acciones de un clic para tareas comunes.

<p align="center">
  <img src="docs/screenshots/quick-actions-welcome.png" alt="Acciones Rápidas" width="550">
</p>

---

### Configuración Extensiva

Ajusta cada aspecto de Mysti incluyendo presupuestos de tokens, niveles de acceso y modo brainstorm.

<p align="center">
  <img src="docs/screenshots/settings-panel.png" alt="Panel de Configuración" width="450">
</p>

---

## Requisitos

**¿Ya pagas por Claude, ChatGPT, Gemini o GitHub Copilot? Estás listo.**

Mysti funciona con tus suscripciones existentes — ¡sin costos adicionales!

| Herramienta CLI | Suscripción | Instalación |
|----------------|-------------|-------------|
| **Claude Code** (recomendado) | Anthropic API o Claude Pro/Max | `npm install -g @anthropic-ai/claude-code` |
| **GitHub Copilot CLI** | GitHub Copilot Pro/Pro+/Business | `npm install -g @github/copilot-cli` |
| **Gemini CLI** | Google AI API o Gemini Advanced | `npm install -g @google/gemini-cli` |
| **Codex CLI** | OpenAI API | Sigue la guía de instalación de OpenAI |
| **Cline** | Depende del proveedor de modelo | `npm install -g cline` |
| **Cursor** | Suscripción a Cursor | `curl https://cursor.com/install -fsS \| bash` |
| **OpenClaw** | Cuenta de OpenClaw | `npm install -g openclaw@latest && openclaw onboard --install-daemon` |
| **OpenCode** | Claves API del proveedor (Anthropic, OpenAI, etc.) | `npm i -g opencode-ai@latest` |
| **Qwen Code** | Qwen OAuth o claves API | `npm install -g @qwen-code/qwen-code@latest` |
| **Ollama** | Local (sin suscripción necesaria) | [Instalar desde ollama.com](https://ollama.com) |
| **LocalAI** | Local (sin suscripción necesaria) | [Instalar desde localai.io](https://localai.io) |

Solo necesitas **una** CLI para empezar. Instala **cualquier dos** para desbloquear el Modo Brainstorm.

---

## Inicio Rápido

### 1. Instala Mysti

**Opción A:** Presiona `Ctrl+P` (`Cmd+P` en Mac), pega y ejecuta:
```
ext install DeepMyst.mysti
```

**Opción B:** [Instalar desde VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti)

### 2. Instala una Herramienta CLI

```bash
# Claude Code (recomendado)
npm install -g @anthropic-ai/claude-code
claude auth login

# O GitHub Copilot CLI (accede a Claude, GPT-5, Gemini vía GitHub)
npm install -g @github/copilot-cli
copilot  # luego usa el comando /login

# O Gemini CLI
npm install -g @google/gemini-cli
gemini auth login

# O Cursor
curl https://cursor.com/install -fsS | bash
agent login

# O OpenClaw
npm install -g openclaw@latest && openclaw onboard --install-daemon
openclaw login

# O OpenCode
npm i -g opencode-ai@latest
opencode auth login

# O Qwen Code
npm install -g @qwen-code/qwen-code@latest
qwen  # luego escribe /auth
```

Para el Modo Brainstorm, instala cualquier dos herramientas CLI.

### 3. Abre Mysti

- Haz clic en el **icono de Mysti** en la Barra de Actividad, o
- Presiona `Ctrl+Shift+M` (`Cmd+Shift+M` en Mac)

### 4. Comienza a Codificar

¡Escribe tu solicitud y deja que la IA te asista!

---

## Comandos Slash

Accede a habilidades y acciones rápidamente con el menú de comandos slash integrado.

<p align="center">
  <img src="docs/gifs/slash commands menu.gif" alt="Menú de Comandos Slash" width="600">
</p>

---

## 12 Habilidades Alternables

Mezcla y combina modificadores de comportamiento:

- **Conciso** - Comunicación clara y breve
- **Test-Driven** - Tests junto al código
- **Auto-Commit** - Commits incrementales
- **Primeros Principios** - Razonamiento fundamental
- **Disciplina de Alcance** - Mantente enfocado en la tarea
- Y 7 más...

[Documentación completa de Personas y Habilidades](docs/PERSONAS-AND-SKILLS.md)

---

## Controles de Permisos

Mantén el control de lo que la IA puede hacer:

- **Solo lectura** - La IA solo puede leer, nunca modificar
- **Pedir permiso** - Aprueba cada cambio de archivo
- **Acceso completo** - Deja que la IA trabaje autónomamente

<p align="center">
  <img src="docs/gifs/Semi auto answering questions .gif" alt="Demo de Controles de Permisos" width="600">
</p>

---

## Configuración

### Configuración Esencial

```json
{
  "mysti.defaultProvider": "claude-code",
  "mysti.brainstorm.agents": ["claude-code", "google-gemini"],
  "mysti.brainstorm.strategy": "quick",
  "mysti.accessLevel": "ask-permission"
}
```

### Configuración de Proveedores

| Configuración | Predeterminado | Descripción |
|--------------|----------------|-------------|
| `mysti.defaultProvider` | `claude-code` | Proveedor de IA principal |
| `mysti.claudePath` | `claude` | Ruta al CLI de Claude |
| `mysti.codexPath` | `codex` | Ruta al CLI de Codex |
| `mysti.geminiPath` | `gemini` | Ruta al CLI de Gemini |
| `mysti.copilotPath` | `copilot` | Ruta al CLI de Copilot |
| `mysti.clinePath` | `cline` | Ruta al CLI de Cline |
| `mysti.cursorPath` | `agent` | Ruta al CLI de Cursor |
| `mysti.openclawPath` | `openclaw` | Ruta al CLI de OpenClaw |
| `mysti.opencodePath` | `opencode` | Ruta al CLI de OpenCode |
| `mysti.qwenCodePath` | `qwen` | Ruta al CLI de Qwen Code |
| `mysti.ollamaPath` | `ollama` | Ruta al CLI de Ollama |
| `mysti.localaiPath` | `localai` | Ruta al CLI de LocalAI |

### Configuración de Brainstorm

| Configuración | Predeterminado | Descripción |
|--------------|----------------|-------------|
| `mysti.brainstorm.agents` | `["claude-code", "openai-codex"]` | Qué 2 agentes usar |
| `mysti.brainstorm.strategy` | `quick` | Estrategia: `quick`, `debate`, `red-team`, `perspectives`, `delphi` |
| `mysti.brainstorm.autoConverge` | `true` | Auto-salir cuando los agentes convergen |
| `mysti.brainstorm.maxDiscussionRounds` | `3` | Máximo de rondas de discusión |

### Configuración Autónoma

| Configuración | Predeterminado | Descripción |
|--------------|----------------|-------------|
| `mysti.autonomous.safetyMode` | `balanced` | `conservative`, `balanced`, `aggressive` |
| `mysti.autonomous.blockPatterns` | `[]` | Patrones personalizados para bloquear siempre |

### Configuración de Compactación

| Configuración | Predeterminado | Descripción |
|--------------|----------------|-------------|
| `mysti.compaction.enabled` | `true` | Habilitar compactación de contexto |
| `mysti.compaction.threshold` | `75` | Umbral de compactación (% de ventana de contexto) |

### Configuración General

| Configuración | Predeterminado | Descripción |
|--------------|----------------|-------------|
| `mysti.accessLevel` | `ask-permission` | Nivel de acceso a archivos |
| `mysti.agents.autoSuggest` | `true` | Auto-sugerir personas |
| `mysti.agents.maxTokenBudget` | `0` | Máximo de tokens para contexto de agente (0 = ilimitado) |

[Documentación completa de Proveedores](docs/PROVIDERS.md)

---

## Atajos de Teclado

| Acción | Windows/Linux | Mac |
|--------|---------------|-----|
| Abrir Mysti | `Ctrl+Shift+M` | `Cmd+Shift+M` |
| Abrir en Nueva Pestaña | `Ctrl+Shift+N` | `Cmd+Shift+N` |

---

## Comandos

| Comando | Descripción |
|---------|-------------|
| `Mysti: Open Chat` | Abrir la barra lateral del chat |
| `Mysti: New Conversation` | Iniciar nueva conversación |
| `Mysti: Add to Context` | Añadir archivo/selección al contexto |
| `Mysti: Clear Context` | Limpiar todo el contexto |
| `Mysti: Open in New Tab` | Abrir chat como pestaña del editor |

---

## Documentación

| Guía | Descripción |
|------|-------------|
| [Proveedores](docs/PROVIDERS.md) | Los 11 proveedores — configuración, modelos, características |
| [Modo Brainstorm](docs/BRAINSTORM.md) | 5 estrategias, convergencia, selección de equipo |
| [Personas y Habilidades](docs/PERSONAS-AND-SKILLS.md) | 16 personas, 12 habilidades, agentes personalizados |
| [Modo Autónomo](docs/AUTONOMOUS-MODE.md) | Sistema de seguridad, memoria, modos de continuación |
| [@Menciones](docs/MENTIONS.md) | Enrutamiento de agentes y contexto de archivos |
| [Compactación](docs/COMPACTION.md) | Gestión de contexto y resumen |
| [Arquitectura](docs/ARCHITECTURE.md) | Internos técnicos y puntos de extensión |
| [Características](docs/FEATURES.md) | Referencia completa de características |

---

## Telemetría

Mysti recopila datos de uso **anónimos** para mejorar la extensión:

- Patrones de uso de características
- Tasas de error
- Preferencias de proveedores

**Nunca se recopila código, rutas de archivos ni datos personales.**

Respeta la configuración de telemetría de VSCode. Desactiva mediante:
Configuración > Telemetry: Telemetry Level > off

---

## Colaboradores

¡Gracias a todos los que han ayudado a mejorar Mysti!

<a href="https://github.com/BahaAbuNojaim"><img src="https://avatars.githubusercontent.com/u/6247079?v=4" width="60" height="60" style="border-radius:50%" alt="BahaAbuNojaim" /></a>
<a href="https://github.com/MostlyKIGuess"><img src="https://avatars.githubusercontent.com/u/135974627?v=4" width="60" height="60" style="border-radius:50%" alt="MostlyKIGuess" /></a>
<a href="https://github.com/a-programmers-programmer"><img src="https://avatars.githubusercontent.com/u/161260774?v=4" width="60" height="60" style="border-radius:50%" alt="a-programmers-programmer" /></a>
<a href="https://github.com/patrick-fu"><img src="https://avatars.githubusercontent.com/u/20736775?v=4" width="60" height="60" style="border-radius:50%" alt="patrick-fu" /></a>

¿Quieres unirte? Consulta la sección [Contribuir](#contribuir) a continuación.

---

## Historial de Stars

Si Mysti te ha sido útil, considera darle una estrella — ¡ayuda a otros a descubrir el proyecto y nos mantiene motivados!

<p align="center">
  <a href="https://github.com/DeepMyst/Mysti/stargazers">
    <img src="https://img.shields.io/github/stars/DeepMyst/Mysti?style=for-the-badge&logo=github&color=yellow" alt="GitHub Stars" />
  </a>
</p>

<p align="center">
  <a href="https://star-history.com/#DeepMyst/Mysti&Date">
    <img src="https://api.star-history.com/svg?repos=DeepMyst/Mysti&type=Date" width="600" alt="Gráfico de Historial de Stars" />
  </a>
</p>

---

## Contribuir

¡Damos la bienvenida a contribuciones! Ya sean reportes de bugs, solicitudes de características o contribuciones de código.

- **Buenos Primeros Issues**: Busca las etiquetas [`good first issue`](https://github.com/DeepMyst/Mysti/labels/good%20first%20issue)
- **Desarrollo**: Presiona `F5` en VS Code para lanzar el Host de Desarrollo de Extensiones
- **Pull Requests**: Haz fork, crea una rama de características y envía un PR

Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para guías detalladas.

---

## Licencia

Apache License 2.0 — libre para usar, modificar y distribuir, incluyendo para propósitos comerciales.
Consulta el archivo `LICENSE` para el texto completo.

---

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">Instalar</a> •
  <a href="https://github.com/DeepMyst/Mysti/issues">Reportar Problema</a> •
  <a href="https://github.com/DeepMyst/Mysti">GitHub</a>
</p>

<p align="center">
  <strong>Mysti</strong> — Creado por <a href="https://www.deepmyst.com/mysti">DeepMyst Inc</a><br>
  <sub>Hecho con Mysti</sub>
</p>
