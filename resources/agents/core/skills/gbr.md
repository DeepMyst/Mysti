---
id: gbr
name: Build Remote Agent
description: Pair a phone running Build Remote Agent to spectate this Mysti desktop session via gbr-agent
icon: gbr.png
category: workflow
activationTriggers:
  - phone
  - mobile
  - pair
  - spectator
  - gbr
  - build remote
---

# Instructions

When the user wants a phone to watch or veto this Mysti session, pair **Build
Remote Agent**. Do not invent a fourth pair protocol. Mysti keeps driving
Claude Code, Codex, Gemini, Cline, OpenCode, and the other CLIs.

Independent product by Linespotting AB. Not affiliated with xAI or SpaceX.
Requires `gbr-agent` ≥ 0.6.0 on the host. Loopback only. No mailbox keys.

## Pair (unchanged)

1. Phone: [Build Remote Agent](https://grokbuildremote.com/) → Connect.
2. PC: `gbr-agent pair` — browser QR **and** printed 8-char code.
3. Phone scans QR **or** types the 8-char code.
4. PC: `gbr-agent run` (keep it running).

```bash
curl -fsSL https://grokbuildremote.com/install.sh | bash
gbr-agent version    # need v0.6.0+
gbr-agent pair && gbr-agent run
```

Unpair on the phone before a new mailbox. Force-close is not enough.

## Attach (only these)

| How | Where |
|-----|--------|
| Bot API | `http://127.0.0.1:8788` after `gbr-agent run` |
| MCP | `gbr-mcp` stdio (same JSON as Bot API) |

Phone is spectator + veto, not orchestrator.

```bash
curl -sS http://127.0.0.1:8788/health
curl -sS http://127.0.0.1:8788/v1/sessions
```

If the active Mysti provider is Cline or another MCP host, add:

```json
{
  "mcpServers": {
    "gbr": {
      "command": "node",
      "args": ["GrokBuildRemote-Agents/mcp/gbr-mcp/bin/gbr-mcp.js"]
    }
  }
}
```

## MCP diagnose

```bash
git clone https://github.com/LinespottingOrg/GrokBuildRemote-Agents.git
cd GrokBuildRemote-Agents/mcp/gbr-mcp && npm install
node bin/gbr-mcp.js --diagnose
```

Remote bots: phone **Settings → Bot API** copies relay URL + mailbox id + key.
Never commit the key.

## Loop

diagnose → open/attach → lock → inject → wait idle → harvest excerpt → iterate or close

Docs: https://github.com/LinespottingOrg/GrokBuildRemote-Agents/blob/main/docs/BOT-API.md
