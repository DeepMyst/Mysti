<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a> | Português | <a href="README.ar.md">العربية</a> | <a href="README.de.md">Deutsch</a> | <a href="README.fr.md">Français</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.ru.md">Русский</a>
</p>

# Mysti - Sua Equipe de Codificação com IA Trabalhando Juntos

<p align="center">
  <img src="resources/Mysti-Logo.png" alt="Logo do Mysti" width="128" height="128">
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/v/DeepMyst.mysti?style=flat-square&label=Version" alt="Versão">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/i/DeepMyst.mysti?style=flat-square&label=Installs" alt="Instalações">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/r/DeepMyst.mysti?style=flat-square&label=Rating" alt="Avaliação">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/stargazers">
    <img src="https://img.shields.io/github/stars/DeepMyst/Mysti?style=flat-square&label=Stars" alt="GitHub Stars">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/network/members">
    <img src="https://img.shields.io/github/forks/DeepMyst/Mysti?style=flat-square&label=Forks" alt="GitHub Forks">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue?style=flat-square" alt="Licença">
  </a>
</p>

<p align="center">
  <strong>Sua equipe de codificação com IA para VSCode</strong><br>
  <em>11 provedores de IA — Claude Code, Codex, Gemini, Copilot, Cline, Cursor, OpenClaw, OpenCode, Qwen Code, Ollama e LocalAI — trabalhando sozinhos ou em equipe</em><br>
  <em>Sabedoria coletiva onde a inteligência coletiva de vários agentes supera um único.</em>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/badge/Instalar%20do-VS%20Code%20Marketplace-007ACC?style=for-the-badge&logo=visual-studio-code" alt="Instalar do VS Code Marketplace">
  </a>
</p>

<p align="center">
  <a href="#escolha-sua-ia">Provedores</a> •
  <a href="#modo-brainstorm">Brainstorm</a> •
  <a href="#recursos-principais">Recursos</a> •
  <a href="#início-rápido">Início Rápido</a> •
  <a href="#configuração">Configuração</a> •
  <a href="#documentação">Docs</a>
</p>

---

## Novidades na v0.3.4

### 11 Provedores de IA

Mysti agora suporta **11 provedores de IA** — adicionados **OpenCode**, **Qwen Code**, **Ollama** e **LocalAI** junto ao Claude Code, Codex, Gemini, GitHub Copilot, Cline, Cursor e OpenClaw. Execute modelos locais com Ollama/LocalAI ou use provedores na nuvem como OpenCode e Qwen Code. Cada provedor tem seu próprio logo autêntico na interface.

### Qwen Code

CLI de codificação com IA da Alibaba com capacidades de raciocínio profundo. Usa o mesmo protocolo de streaming do Claude Code para integração perfeita. Suporta modelos Qwen3 Coder com modos de aprovação plan, auto-edit e yolo.

### OpenCode

Agente de codificação multi-backend que suporta Anthropic, OpenAI, Google e Groq através de um único CLI. Usa seu modelo padrão configurado — sem dependência de provedores específicos.

### Suporte a IA Local

Execute modelos de IA localmente com **Ollama** e **LocalAI** — sem necessidade de assinatura na nuvem. Privacidade total, latência zero, controle total sobre seus modelos.

---

## Instale em Segundos

**Do VS Code:** Pressione `Ctrl+P` (`Cmd+P` no Mac), depois cole:

```
ext install DeepMyst.mysti
```

**Ou** [instale do VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti)

---

## Escolha Sua IA

Mysti funciona com as ferramentas de codificação com IA que você já tem. **Sem assinaturas extras.**

<p align="center">
  <img src="docs/gifs/agent switching.gif" alt="Troca de Agente" width="450">
</p>

| Provedor | Melhor Para |
|----------|------------|
| **Claude Code** | Raciocínio profundo, refatoração complexa, análise completa |
| **Codex** | Iterações rápidas, estilo familiar da OpenAI |
| **Gemini** | Respostas rápidas, integração com ecossistema Google |
| **GitHub Copilot** | Acesso multi-modelo (Claude, GPT-5, Gemini) via assinatura GitHub |
| **Cline** | Modo Plan/Act, conclusão estruturada de tarefas |
| **Cursor** | Seleção automática de modelo, multi-modelo com Claude, GPT-5, Gemini |
| **OpenClaw** | Streaming WebSocket em tempo real, níveis de pensamento configuráveis |
| **OpenCode** | Agente multi-backend (Anthropic, OpenAI, Google, Groq) |
| **Qwen Code** | Agente de codificação IA da Alibaba, raciocínio profundo |
| **Ollama** | Inferência LLM local, privacidade primeiro, sem assinatura |
| **LocalAI** | Modelos de IA auto-hospedados, controle total |

**Troque de provedor com um clique. Sem dependência.**

### Por Que Mysti?

| vs Copilot/Cursor | Vantagem do Mysti |
|-------------------|-------------------|
| IA única | **Brainstorming multi-agente** — duas IAs colaboram com 5 estratégias |
| Preso a um provedor | **11 provedores** — Claude, Codex, Gemini, Copilot, Cline, Cursor, OpenClaw, OpenCode, Qwen, Ollama, LocalAI |
| Caixa preta | **Controle total de permissões** — de somente leitura a acesso completo |
| Respostas genéricas | **16 personas** — arquiteto, depurador, especialista em segurança... |
| Fluxo de trabalho manual | **Modo autônomo** — IA trabalha independentemente com controles de segurança |
| Sem roteamento entre agentes | **@menções** — roteie tarefas para agentes específicos inline |

---

## Veja em Ação

<p align="center">
  <img src="docs/gifs/main screen.gif" alt="Interface de Chat do Mysti" width="700">
</p>

<p align="center"><em>Interface de chat bonita e moderna com destaque de sintaxe, suporte Markdown e diagramas Mermaid</em></p>

<p align="center">
  <img src="docs/gifs/Task list rendering and progress tracking.gif" alt="Renderização de Lista de Tarefas" width="700">
</p>

<p align="center"><em>Renderização de lista de tarefas em tempo real e acompanhamento de progresso</em></p>

---

## Modo Brainstorm

**Quer uma segunda opinião?** Ative o Modo Brainstorm e deixe dois agentes de IA resolverem seu problema juntos. **Escolha qualquer 2 de 11 agentes** no painel de configurações.

<p align="center">
  <img src="docs/gifs/brainstorm example.gif" alt="Modo Brainstorm" width="700">
</p>

### 5 Estratégias de Colaboração

| Estratégia | Papéis | Melhor Para |
|-----------|--------|------------|
| **Quick** | Síntese direta | Tarefas simples, respostas rápidas |
| **Debate** | Crítico vs Defensor | Decisões de arquitetura, compensações |
| **Red-Team** | Proponente vs Desafiador | Revisões de segurança, descoberta de casos extremos |
| **Perspectives** | Analista de Risco vs Inovador | Design greenfield, seleção de tecnologia |
| **Delphi** | Facilitador vs Refinador | Problemas complexos, alcançar consenso |

### Por Que Duas IAs São Melhores Que Uma

**Claude Code** (Anthropic), **Codex** (OpenAI), **Gemini** (Google), **GitHub Copilot**, **Cline**, **Cursor**, **OpenClaw**, **OpenCode**, **Qwen Code** (Alibaba), **Ollama** e **LocalAI** têm treinamento diferente, pontos fortes diferentes e pontos cegos diferentes. Quando dois trabalham juntos:

- Cada IA detecta casos extremos que a outra pode perder
- Perspectivas diferentes levam a soluções mais robustas
- **Juntos** eles debatem, desafiam um ao outro e sintetizam a melhor solução

É como ter um desenvolvedor sênior e um líder técnico revisando seu código — exceto que eles realmente discutem primeiro.

### Detecção de Convergência

Durante as discussões, Mysti rastreia o acordo entre agentes e a estabilidade de posições. Quando a **auto-convergência** está habilitada, a discussão termina antecipadamente assim que os agentes alcançam consenso — economizando tempo sem sacrificar qualidade.

### Escolha Sua Equipe

Configure quais dois agentes colaboram no **Painel de Configurações**:

<p align="center">
  <img src="docs/gifs/Brainstorm model selection.gif" alt="Seleção de Modelo Brainstorm" width="600">
</p>

| Combinação | Melhor Para |
|-----------|------------|
| Claude + Codex | Análise profunda com iteração rápida |
| Claude + Gemini | Raciocínio completo com validação rápida |
| Claude + Copilot | Compare Claude nativo vs abordagem multi-modelo do Copilot |
| Cursor + Gemini | Flexibilidade multi-modelo com integração Google |
| OpenClaw + Claude | Streaming WebSocket com raciocínio profundo |
| Qwen + Claude | Compare raciocínio da Alibaba e Anthropic |
| OpenCode + Gemini | Flexibilidade multi-backend com velocidade Google |
| Ollama + Claude | Privacidade local com inteligência na nuvem |

[Documentação completa do Brainstorm](docs/BRAINSTORM.md)

### Detecção Inteligente de Planos

Quando a IA apresenta múltiplas abordagens de implementação, Mysti detecta automaticamente e permite que você escolha seu caminho preferido.

<p align="center">
  <img src="docs/screenshots/plan-suggestions.png" alt="Sugestões de Plano" width="600">
</p>

*Requer pelo menos 2 ferramentas CLI instaladas. Veja [Requisitos](#requisitos).*

---

## Recursos Principais

### Modo Autônomo

Deixe a IA trabalhar independentemente com controles de segurança configuráveis:

- **Classificador de Segurança**: Três níveis — seguro (auto-aprovar), cautela (dependente do modo), bloqueado (sempre negar)
- **Três Modos de Segurança**: Conservador, Equilibrado, Agressivo
- **Memória de Aprendizado**: Lembra suas preferências de permissão e melhora com o tempo
- **Modos de Continuação**: Baseado em objetivos ou fila de tarefas para sessões autônomas estendidas
- **Trilha de Auditoria**: Cada decisão autônoma é registrada para revisão

<p align="center">
  <img src="docs/gifs/Selecting autonomy mode.gif" alt="Selecionando Modo Autônomo" width="600">
</p>

[Documentação completa do Modo Autônomo](docs/AUTONOMOUS-MODE.md)

### Sistema de @Menções

Roteie tarefas para agentes específicos e referencie arquivos inline:

<p align="center">
  <img src="docs/gifs/Agent tagging and multi agent workflows.gif" alt="Marcação @Menção" width="600">
</p>

```
@claude Revise este código por problemas de segurança
@src/auth.ts @gemini Sugira melhorias de desempenho para este arquivo
@claude Escreva testes, depois @codex otimize-os
```

- **Menções de arquivo**: `@filename` adiciona contexto transitório
- **Menções de agente**: `@agent` roteia tarefas para aquele provedor
- **Encadeamento**: Agentes posteriores recebem respostas dos anteriores como contexto

[Documentação completa de @Menções](docs/MENTIONS.md)

### Compactação de Contexto

Gerenciamento inteligente de conversa que previne overflow de contexto:

- **Automático**: Dispara quando o uso de tokens se aproxima do limite (padrão 75%)
- **Suporte nativo**: Claude Code usa o comando integrado `/compact`
- **Do lado do cliente**: Outros provedores usam resumo inteligente de mensagens
- **Rastreamento por painel**: Cada painel de chat rastreia o uso independentemente

[Documentação completa de Compactação](docs/COMPACTION.md)

### 16 Personas de Desenvolvedor

Molde como sua IA pensa. Selecione de personas especializadas que mudam a abordagem da IA para seus problemas.

<p align="center">
  <img src="docs/gifs/Personas and skills.gif" alt="Painel de Personas e Habilidades" width="550">
</p>

| Persona | Foco |
|---------|------|
| **Arquiteto** | Design de sistemas, escalabilidade, estrutura limpa |
| **Depurador** | Análise de causa raiz, correção de bugs |
| **Orientado à Segurança** | Vulnerabilidades, modelagem de ameaças |
| **Otimizador de Desempenho** | Otimização, profiling, latência |
| **Prototipador** | Iteração rápida, PoCs |
| **Refatorador** | Qualidade de código, manutenibilidade |
| + 10 mais... | Full-Stack, DevOps, Mentor, Designer... |

[Documentação completa de Personas e Habilidades](docs/PERSONAS-AND-SKILLS.md)

---

### Seleção Rápida de Persona

Selecione personas diretamente da barra de ferramentas sem abrir painéis.

<p align="center">
  <img src="docs/screenshots/persona-toolbar.png" alt="Seleção de Persona na Barra de Ferramentas" width="550">
</p>

---

### Sugestões Automáticas Inteligentes

Mysti sugere automaticamente personas e ações relevantes baseadas na sua mensagem.

<p align="center">
  <img src="docs/gifs/PErsona Suggestion.gif" alt="Sugestões Automáticas" width="550">
</p>

---

### Histórico de Conversas

Nunca perca seu trabalho. Todas as conversas são salvas e facilmente acessíveis.

<p align="center">
  <img src="docs/screenshots/conversation-history.png" alt="Histórico de Conversas" width="450">
</p>

---

### Ações Rápidas na Boas-vindas

Comece rapidamente com ações de um clique para tarefas comuns.

<p align="center">
  <img src="docs/screenshots/quick-actions-welcome.png" alt="Ações Rápidas" width="550">
</p>

---

### Configurações Extensivas

Ajuste cada aspecto do Mysti incluindo orçamentos de tokens, níveis de acesso e modo brainstorm.

<p align="center">
  <img src="docs/screenshots/settings-panel.png" alt="Painel de Configurações" width="450">
</p>

---

## Requisitos

**Já paga pelo Claude, ChatGPT, Gemini ou GitHub Copilot? Você está pronto.**

Mysti funciona com suas assinaturas existentes — sem custos adicionais!

| Ferramenta CLI | Assinatura | Instalação |
|---------------|------------|------------|
| **Claude Code** (recomendado) | Anthropic API ou Claude Pro/Max | `npm install -g @anthropic-ai/claude-code` |
| **GitHub Copilot CLI** | GitHub Copilot Pro/Pro+/Business | `npm install -g @github/copilot-cli` |
| **Gemini CLI** | Google AI API ou Gemini Advanced | `npm install -g @google/gemini-cli` |
| **Codex CLI** | OpenAI API | Siga o guia de instalação da OpenAI |
| **Cline** | Depende do provedor de modelo | `npm install -g cline` |
| **Cursor** | Assinatura Cursor | `curl https://cursor.com/install -fsS \| bash` |
| **OpenClaw** | Conta OpenClaw | `npm install -g openclaw@latest && openclaw onboard --install-daemon` |
| **OpenCode** | Chaves API do provedor (Anthropic, OpenAI, etc.) | `npm i -g opencode-ai@latest` |
| **Qwen Code** | Qwen OAuth ou chaves API | `npm install -g @qwen-code/qwen-code@latest` |
| **Ollama** | Local (sem assinatura necessária) | [Instalar do ollama.com](https://ollama.com) |
| **LocalAI** | Local (sem assinatura necessária) | [Instalar do localai.io](https://localai.io) |

Você só precisa de **uma** CLI para começar. Instale **qualquer duas** para desbloquear o Modo Brainstorm.

---

## Início Rápido

### 1. Instale o Mysti

**Opção A:** Pressione `Ctrl+P` (`Cmd+P` no Mac), cole e execute:
```
ext install DeepMyst.mysti
```

**Opção B:** [Instalar do VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti)

### 2. Instale uma Ferramenta CLI

```bash
# Claude Code (recomendado)
npm install -g @anthropic-ai/claude-code
claude auth login

# Ou GitHub Copilot CLI (acesse Claude, GPT-5, Gemini via GitHub)
npm install -g @github/copilot-cli
copilot  # depois use o comando /login

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
qwen  # depois digite /auth
```

Para o Modo Brainstorm, instale qualquer duas ferramentas CLI.

### 3. Abra o Mysti

- Clique no **ícone do Mysti** na Barra de Atividade, ou
- Pressione `Ctrl+Shift+M` (`Cmd+Shift+M` no Mac)

### 4. Comece a Codificar

Digite sua solicitação e deixe a IA te ajudar!

---

## Comandos Slash

Acesse habilidades e ações rapidamente com o menu de comandos slash integrado.

<p align="center">
  <img src="docs/gifs/slash commands menu.gif" alt="Menu de Comandos Slash" width="600">
</p>

---

## 12 Habilidades Alternáveis

Misture e combine modificadores de comportamento:

- **Conciso** - Comunicação clara e breve
- **Test-Driven** - Testes junto ao código
- **Auto-Commit** - Commits incrementais
- **Primeiros Princípios** - Raciocínio fundamental
- **Disciplina de Escopo** - Mantenha o foco na tarefa
- E mais 7...

[Documentação completa de Personas e Habilidades](docs/PERSONAS-AND-SKILLS.md)

---

## Controles de Permissão

Mantenha o controle do que a IA pode fazer:

- **Somente leitura** - IA só pode ler, nunca modificar
- **Pedir permissão** - Aprove cada mudança de arquivo
- **Acesso completo** - Deixe a IA trabalhar autonomamente

<p align="center">
  <img src="docs/gifs/Semi auto answering questions .gif" alt="Demo de Controles de Permissão" width="600">
</p>

---

## Configuração

### Configuração Essencial

```json
{
  "mysti.defaultProvider": "claude-code",
  "mysti.brainstorm.agents": ["claude-code", "google-gemini"],
  "mysti.brainstorm.strategy": "quick",
  "mysti.accessLevel": "ask-permission"
}
```

### Configuração de Provedores

| Configuração | Padrão | Descrição |
|-------------|--------|-----------|
| `mysti.defaultProvider` | `claude-code` | Provedor de IA principal |
| `mysti.claudePath` | `claude` | Caminho do CLI do Claude |
| `mysti.codexPath` | `codex` | Caminho do CLI do Codex |
| `mysti.geminiPath` | `gemini` | Caminho do CLI do Gemini |
| `mysti.copilotPath` | `copilot` | Caminho do CLI do Copilot |
| `mysti.clinePath` | `cline` | Caminho do CLI do Cline |
| `mysti.cursorPath` | `agent` | Caminho do CLI do Cursor |
| `mysti.openclawPath` | `openclaw` | Caminho do CLI do OpenClaw |
| `mysti.opencodePath` | `opencode` | Caminho do CLI do OpenCode |
| `mysti.qwenCodePath` | `qwen` | Caminho do CLI do Qwen Code |
| `mysti.ollamaPath` | `ollama` | Caminho do CLI do Ollama |
| `mysti.localaiPath` | `localai` | Caminho do CLI do LocalAI |

### Configuração do Brainstorm

| Configuração | Padrão | Descrição |
|-------------|--------|-----------|
| `mysti.brainstorm.agents` | `["claude-code", "openai-codex"]` | Quais 2 agentes usar |
| `mysti.brainstorm.strategy` | `quick` | Estratégia: `quick`, `debate`, `red-team`, `perspectives`, `delphi` |
| `mysti.brainstorm.autoConverge` | `true` | Sair automaticamente quando agentes convergem |
| `mysti.brainstorm.maxDiscussionRounds` | `3` | Máximo de rodadas de discussão |

### Configuração Autônoma

| Configuração | Padrão | Descrição |
|-------------|--------|-----------|
| `mysti.autonomous.safetyMode` | `balanced` | `conservative`, `balanced`, `aggressive` |
| `mysti.autonomous.blockPatterns` | `[]` | Padrões personalizados para sempre bloquear |

### Configuração de Compactação

| Configuração | Padrão | Descrição |
|-------------|--------|-----------|
| `mysti.compaction.enabled` | `true` | Habilitar compactação de contexto |
| `mysti.compaction.threshold` | `75` | Limite de compactação (% da janela de contexto) |

### Configuração Geral

| Configuração | Padrão | Descrição |
|-------------|--------|-----------|
| `mysti.accessLevel` | `ask-permission` | Nível de acesso a arquivos |
| `mysti.agents.autoSuggest` | `true` | Auto-sugerir personas |
| `mysti.agents.maxTokenBudget` | `0` | Máximo de tokens para contexto de agente (0 = ilimitado) |

[Documentação completa de Provedores](docs/PROVIDERS.md)

---

## Atalhos de Teclado

| Ação | Windows/Linux | Mac |
|------|---------------|-----|
| Abrir Mysti | `Ctrl+Shift+M` | `Cmd+Shift+M` |
| Abrir em Nova Aba | `Ctrl+Shift+N` | `Cmd+Shift+N` |

---

## Comandos

| Comando | Descrição |
|---------|-----------|
| `Mysti: Open Chat` | Abrir a barra lateral do chat |
| `Mysti: New Conversation` | Iniciar nova conversa |
| `Mysti: Add to Context` | Adicionar arquivo/seleção ao contexto |
| `Mysti: Clear Context` | Limpar todo o contexto |
| `Mysti: Open in New Tab` | Abrir chat como aba do editor |

---

## Documentação

| Guia | Descrição |
|------|-----------|
| [Provedores](docs/PROVIDERS.md) | Todos os 11 provedores — configuração, modelos, recursos |
| [Modo Brainstorm](docs/BRAINSTORM.md) | 5 estratégias, convergência, seleção de equipe |
| [Personas e Habilidades](docs/PERSONAS-AND-SKILLS.md) | 16 personas, 12 habilidades, agentes personalizados |
| [Modo Autônomo](docs/AUTONOMOUS-MODE.md) | Sistema de segurança, memória, modos de continuação |
| [@Menções](docs/MENTIONS.md) | Roteamento de agentes e contexto de arquivos |
| [Compactação](docs/COMPACTION.md) | Gerenciamento de contexto e resumo |
| [Arquitetura](docs/ARCHITECTURE.md) | Internos técnicos e pontos de extensão |
| [Recursos](docs/FEATURES.md) | Referência completa de recursos |

---

## Telemetria

Mysti coleta dados de uso **anônimos** para melhorar a extensão:

- Padrões de uso de recursos
- Taxas de erro
- Preferências de provedores

**Nenhum código, caminho de arquivo ou dado pessoal é coletado.**

Respeita a configuração de telemetria do VSCode. Desabilite via:
Configurações > Telemetry: Telemetry Level > off

---

## Colaboradores

Obrigado a todos que ajudaram a melhorar o Mysti!

<a href="https://github.com/BahaAbuNojaim"><img src="https://avatars.githubusercontent.com/u/6247079?v=4" width="60" height="60" style="border-radius:50%" alt="BahaAbuNojaim" /></a>
<a href="https://github.com/MostlyKIGuess"><img src="https://avatars.githubusercontent.com/u/135974627?v=4" width="60" height="60" style="border-radius:50%" alt="MostlyKIGuess" /></a>
<a href="https://github.com/a-programmers-programmer"><img src="https://avatars.githubusercontent.com/u/161260774?v=4" width="60" height="60" style="border-radius:50%" alt="a-programmers-programmer" /></a>
<a href="https://github.com/patrick-fu"><img src="https://avatars.githubusercontent.com/u/20736775?v=4" width="60" height="60" style="border-radius:50%" alt="patrick-fu" /></a>

Quer se juntar? Confira a seção [Contribuindo](#contribuindo) abaixo.

---

## Histórico de Stars

Se o Mysti foi útil para você, considere dar uma estrela — ajuda outros a descobrir o projeto e nos mantém motivados!

<p align="center">
  <a href="https://github.com/DeepMyst/Mysti/stargazers">
    <img src="https://img.shields.io/github/stars/DeepMyst/Mysti?style=for-the-badge&logo=github&color=yellow" alt="GitHub Stars" />
  </a>
</p>

<p align="center">
  <a href="https://star-history.com/#DeepMyst/Mysti&Date">
    <img src="https://api.star-history.com/svg?repos=DeepMyst/Mysti&type=Date" width="600" alt="Gráfico de Histórico de Stars" />
  </a>
</p>

---

## Contribuindo

Contribuições são bem-vindas! Seja relatórios de bugs, solicitações de recursos ou contribuições de código.

- **Boas Primeiras Issues**: Procure as labels [`good first issue`](https://github.com/DeepMyst/Mysti/labels/good%20first%20issue)
- **Desenvolvimento**: Pressione `F5` no VS Code para iniciar o Host de Desenvolvimento da Extensão
- **Pull Requests**: Faça fork, crie uma branch de feature e envie um PR

Veja [CONTRIBUTING.md](CONTRIBUTING.md) para diretrizes detalhadas.

---

## Licença

Apache License 2.0 — livre para usar, modificar e distribuir, incluindo para fins comerciais.
Veja o arquivo `LICENSE` para o texto completo.

---

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">Instalar</a> •
  <a href="https://github.com/DeepMyst/Mysti/issues">Reportar Problema</a> •
  <a href="https://github.com/DeepMyst/Mysti">GitHub</a>
</p>

<p align="center">
  <strong>Mysti</strong> — Criado por <a href="https://www.deepmyst.com/mysti">DeepMyst Inc</a><br>
  <sub>Feito com Mysti</sub>
</p>
