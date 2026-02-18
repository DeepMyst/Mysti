# Brainstorm Mode & Team Reasoning

Brainstorm Mode lets two AI agents work together on your problem, combining their different strengths for better solutions.

## How It Works

1. You send a message with Brainstorm Mode enabled
2. Your message is sent to **both** selected agents simultaneously
3. Agents analyze independently, then collaborate based on the chosen strategy
4. A synthesis combines the best ideas into one refined response

```
Your Request
     |
     v
+----------+----------+
| Agent 1  | Agent 2  |
| analyzes | analyzes |
+----+-----+-----+----+
     |           |
     v           v
+-------------------------+
|  Collaboration Strategy |
|  (debate, red-team...)  |
+-----------+-------------+
            |
            v
+-------------------------+
|       Synthesis         |
| Best ideas combined     |
+-------------------------+
```

## Selecting Your Team

Choose any 2 of 7 available agents in the settings panel:

| Agent | Provider | Color |
|-------|----------|-------|
| Claude | Anthropic | Purple |
| Codex | OpenAI | Green |
| Gemini | Google | Blue |
| Cline | Multi-provider | Amber |
| Copilot | GitHub | Indigo |
| Cursor | Cursor | Blue |
| OpenClaw | OpenClaw | Rose |

Configure via settings:
```json
{
  "mysti.brainstorm.agents": ["claude-code", "google-gemini"]
}
```

**Requirement:** Both selected agents must have their CLI tools installed and authenticated.

## Collaboration Strategies

Mysti offers 5 collaboration strategies, each designed for different types of problems.

### Quick

The fastest strategy — no discussion phase.

- Both agents respond independently
- Responses are immediately synthesized into one answer
- **Best for:** Simple questions, quick lookups, straightforward tasks

```json
{ "mysti.brainstorm.strategy": "quick" }
```

### Debate

Structured argumentation where agents take opposing roles.

| Role | Agent | Behavior |
|------|-------|----------|
| **Critic** | Agent 1 | Finds weaknesses, questions assumptions |
| **Defender** | Agent 2 | Supports ideas, provides evidence |

- Agents review each other's solutions and engage in structured discussion
- Each round, agents respond to the other's arguments
- **Best for:** Architecture decisions, design trade-offs, evaluating approaches

```json
{ "mysti.brainstorm.strategy": "debate" }
```

### Red-Team

Adversarial testing where one agent tries to break the other's solution.

| Role | Agent | Behavior |
|------|-------|----------|
| **Proposer** | Agent 1 | Builds the solution, addresses challenges |
| **Challenger** | Agent 2 | Finds flaws, edge cases, security issues |

- The challenger actively tries to find problems with the proposer's solution
- The proposer must address each challenge
- **Best for:** Security reviews, error handling, edge case discovery, robustness testing

```json
{ "mysti.brainstorm.strategy": "red-team" }
```

### Perspectives

Complementary viewpoints from different analytical angles.

| Role | Agent | Behavior |
|------|-------|----------|
| **Risk Analyst** | Agent 1 | Identifies risks, maintenance burden, complexity |
| **Innovator** | Agent 2 | Explores creative solutions, new approaches |

- Agents provide complementary perspectives rather than opposing ones
- The synthesis balances innovation with risk awareness
- **Best for:** Greenfield design, technology selection, long-term planning

```json
{ "mysti.brainstorm.strategy": "perspectives" }
```

### Delphi

Iterative refinement toward consensus, inspired by the Delphi method.

| Role | Agent | Behavior |
|------|-------|----------|
| **Facilitator** | Agent 1 | Guides discussion, identifies common ground |
| **Refiner** | Agent 2 | Improves proposals, adds precision |

- Each round builds on the previous, progressively refining the solution
- Agents converge on a shared solution through iterative improvement
- **Best for:** Complex problems with many unknowns, reaching consensus, thorough exploration

```json
{ "mysti.brainstorm.strategy": "delphi" }
```

## Convergence Detection

During discussion rounds, Mysti tracks whether agents are converging toward agreement.

### How It Works

- **Agreement tracking**: Counts agreement keywords (agree, correct, good point, exactly, etc.)
- **Disagreement tracking**: Counts disagreement keywords (disagree, however, but, on the other hand, etc.)
- **Position stability**: Measures how much each agent's position shifts between rounds
- **Convergence score**: Calculated from agreement/disagreement ratio and position stability

### Auto-Convergence

When enabled, Mysti automatically exits the discussion phase early if agents reach sufficient agreement, saving time.

```json
{
  "mysti.brainstorm.autoConverge": true
}
```

### Convergence UI

The webview shows a convergence meter during discussions:
- Progress bar showing convergence level
- Round markers on a discussion timeline
- Role badges for each agent's contributions

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.brainstorm.enabled` | `false` | Enable brainstorm mode |
| `mysti.brainstorm.agents` | `["claude-code", "openai-codex"]` | Which 2 agents to use |
| `mysti.brainstorm.strategy` | `quick` | Collaboration strategy |
| `mysti.brainstorm.autoConverge` | `true` | Auto-exit when agents converge |
| `mysti.brainstorm.maxDiscussionRounds` | `3` | Maximum discussion rounds |

## Strategy Selection Guide

| Your Task | Recommended Strategy |
|-----------|---------------------|
| Quick answer needed | **Quick** |
| Choosing between approaches | **Debate** |
| Security or reliability review | **Red-Team** |
| Exploring new designs | **Perspectives** |
| Complex problem, need consensus | **Delphi** |

## Error Handling

Brainstorm Mode is designed to be resilient:

- If one agent fails, synthesis falls back to the other agent's response
- If both agents fail on synthesis, raw responses are concatenated
- Discussion errors are reported but don't halt the process
- Each agent's stream is independent — one agent timing out doesn't affect the other

## Tips

1. **Start with Quick** for most tasks — it's the fastest and often sufficient
2. **Use Debate** when you're deciding between two approaches
3. **Use Red-Team** before deploying critical code — it catches edge cases
4. **Mix providers** with different strengths (e.g., Claude for reasoning + Gemini for speed)
5. **Watch the convergence meter** — if agents converge quickly, the solution is likely solid
