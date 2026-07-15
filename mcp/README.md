# ZEEHIVE MCP server

Gives an agent a **structured** way to talk to the queenzee (an alternative to the `/xell`
and `/xell-done` slash-command skills, which use `curl`). Same operations, native tools.

## Tools

| Tool | What it does | API |
|------|--------------|-----|
| `zeehive_get_context` | Claim a ready xell; return its binding | `POST /api/xell/claim` |
| `zeehive_status` | This session's xell status (done? awaiting? prod-lock?) | `GET /api/xell/status` |
| `zeehive_report_done` | Report finished → flags for human confirm | `POST /api/xell/report-done` |
| `zeehive_prod_lock_acquire` | Take the prod deploy lock | `POST /api/prod-lock/acquire` |
| `zeehive_prod_lock_release` | Release it | `POST /api/prod-lock/release` |
| `zeehive_prod_lock_status` | Who holds prod | `GET /api/prod-lock` |

## Register (Claude Code)

Add to `.mcp.json` (project) or `~/.claude.json`:

```json
{
  "mcpServers": {
    "zeehive": {
      "command": "node",
      "args": ["D:/Repos/Zeehive/mcp/server.js"],
      "env": { "ZEEHIVE_API": "http://localhost:4700" }
    }
  }
}
```

The server reads `CLAUDE_CODE_SESSION_ID` from the environment to resolve "this session's"
xell, so status/report-done need no arguments. It talks to the queenzee at `ZEEHIVE_API`.
