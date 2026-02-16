# Personas & Skills

Mysti uses a flexible agent system to shape how your AI responds. **Personas** change the AI's overall approach and personality, while **Skills** add specific behavioral modifiers.

## Personas

Personas change how the AI thinks about your problems. When you select a persona, the AI adopts that role's perspective, priorities, and best practices.

### Built-in Personas

Mysti includes 16 developer personas:

| Persona | Focus | When to Use |
|---------|-------|-------------|
| **Architect** | System design, scalability, clean structure | Designing new systems or evaluating architecture |
| **Debugger** | Root cause analysis, systematic debugging | Tracking down bugs and unexpected behavior |
| **Security-Minded** | Vulnerabilities, threat modeling, OWASP | Security reviews, handling auth/crypto code |
| **Performance Tuner** | Optimization, profiling, latency | Slow queries, high memory usage, bottlenecks |
| **Prototyper** | Quick iteration, proof of concepts | Rapid experimentation, MVPs |
| **Refactorer** | Code quality, maintainability, patterns | Cleaning up tech debt, improving structure |
| **Full-Stack** | End-to-end implementation | Features spanning frontend and backend |
| **DevOps** | CI/CD, infrastructure, deployment | Build pipelines, Docker, cloud config |
| **Mentor** | Teaching, explanations, learning | Understanding new concepts or codebases |
| **Designer** | UI/UX, accessibility, user experience | Frontend work, component design |
| **Data Engineer** | Databases, ETL, data pipelines | Schema design, query optimization |
| **ML Engineer** | Machine learning, data science | Model training, feature engineering |
| **Mobile Dev** | iOS, Android, React Native, Flutter | Mobile app development |
| **API Designer** | REST, GraphQL, API contracts | Designing and documenting APIs |
| **Test Engineer** | Testing strategies, coverage, TDD | Writing tests, improving test suites |
| **Tech Writer** | Documentation, comments, READMEs | Writing docs, explaining code |

### Selecting a Persona

**From the toolbar:** Click the persona indicator in the chat toolbar to see all available personas.

**From auto-suggestions:** Mysti automatically suggests relevant personas based on your message content. For example, mentioning "security" or "vulnerability" triggers a suggestion for the Security-Minded persona.

**Via settings:**
```json
{
  "mysti.agents.persona": "architect"
}
```

### How Personas Work

When a persona is active, Mysti injects role-specific instructions into the prompt:

1. **Key Characteristics**: Defines the persona's approach and mindset
2. **Priorities**: Ordered list of what the persona values most
3. **Best Practices**: Specific techniques the persona follows
4. **Anti-Patterns**: What the persona avoids

## Skills

Skills are toggleable behavioral modifiers that can be combined with any persona.

### Built-in Skills

| Skill | Effect |
|-------|--------|
| **Concise** | Brief, clear communication — no unnecessary verbosity |
| **Test-Driven** | Writes tests alongside (or before) code |
| **Auto-Commit** | Makes incremental, well-described commits |
| **First Principles** | Reasons from fundamentals, questions assumptions |
| **Scope Discipline** | Stays focused on the current task, avoids scope creep |
| **Documentation** | Adds clear comments and documentation |
| **Accessibility** | Prioritizes a11y in UI work (ARIA, keyboard nav, contrast) |
| **Performance** | Focuses on runtime efficiency and resource usage |
| **Security** | Applies security best practices throughout |
| **Error Handling** | Comprehensive error handling and edge cases |
| **Code Review** | Applies code review standards to suggestions |
| **Incremental** | Makes small, reviewable changes instead of large rewrites |

### Enabling Skills

Skills can be toggled on/off from the settings panel. Multiple skills can be active simultaneously.

```json
{
  "mysti.agents.skills": ["concise", "test-driven", "scope-discipline"]
}
```

## Three-Tier Agent Loading System

Mysti uses a progressive loading system for agent definitions (both personas and skills) to keep the UI fast while supporting rich content.

### Loading Tiers

| Tier | What Loads | When | Purpose |
|------|-----------|------|---------|
| **Tier 1: Metadata** | ID, name, description, icon, category | Always | Fast UI display (lists, dropdowns) |
| **Tier 2: Instructions** | Key characteristics, priorities, practices | On selection | Prompt injection for active persona |
| **Tier 3: Full** | Complete content including code examples | On demand | Deep reference material |

This means the persona picker loads instantly (Tier 1), while the full prompt content only loads when actually needed (Tier 2/3).

## Creating Custom Personas

You can create your own personas using markdown files with YAML frontmatter.

### File Locations (Priority Order)

| Location | Scope | Priority |
|----------|-------|----------|
| `.mysti/agents/personas/` | Workspace (project-specific) | Highest |
| `~/.mysti/agents/personas/` | User (all projects) | Medium |
| `resources/agents/core/personas/` | Core (bundled with Mysti) | Lowest |

Higher-priority locations override lower ones if IDs match.

### Persona Format

Create a markdown file (e.g., `my-persona.md`):

```markdown
---
id: my-persona
name: My Custom Persona
description: Brief description shown in the UI
icon: 🎯
category: general
activationTriggers:
  - keyword1
  - keyword2
---

## Key Characteristics

Describe the persona's approach, mindset, and style.

## Priorities

1. First priority
2. Second priority
3. Third priority

## Best Practices

- Practice one
- Practice two
- Practice three

## Anti-Patterns to Avoid

- Don't do this
- Avoid that
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier (used in settings) |
| `name` | Yes | Display name in the UI |
| `description` | Yes | Brief description for Tier 1 display |
| `icon` | No | Emoji icon for the UI |
| `category` | No | Category for grouping (general, frontend, backend, etc.) |
| `activationTriggers` | No | Keywords that trigger auto-suggestion |

## Creating Custom Skills

Skills follow the same format as personas but are placed in the `skills/` subdirectory.

### File Locations

| Location | Scope | Priority |
|----------|-------|----------|
| `.mysti/agents/skills/` | Workspace | Highest |
| `~/.mysti/agents/skills/` | User | Medium |
| `resources/agents/core/skills/` | Core | Lowest |

### Skill Format

```markdown
---
id: my-skill
name: My Custom Skill
description: What this skill does
icon: 🔧
category: workflow
---

## Instructions

Describe the behavioral modification this skill applies.

## Rules

1. Always do X
2. Never do Y
3. Prefer Z over W
```

## Syncing Community Agents

Mysti can fetch curated personas and skills from the community repository:

```bash
# Sync community agents (cached for 24 hours)
npm run sync-agents

# Force sync (bypass cache)
npm run sync-agents:force
```

Synced agents are stored in `resources/agents/plugins/` and load alongside core agents.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.agents.persona` | `""` | Active persona ID |
| `mysti.agents.skills` | `[]` | Active skill IDs |
| `mysti.agents.autoSuggest` | `true` | Auto-suggest personas based on message content |
| `mysti.agents.maxTokenBudget` | `0` | Max tokens for agent context (0 = unlimited) |

## Tips

1. **Combine personas with skills** for targeted behavior — e.g., Architect + Concise for quick design feedback
2. **Use auto-suggest** to discover relevant personas naturally
3. **Create project-specific personas** in `.mysti/agents/personas/` for domain-specific expertise
4. **Share personas across teams** by committing `.mysti/agents/` to your repo
5. **Token budget**: Set `maxTokenBudget` if agent context is making prompts too long
