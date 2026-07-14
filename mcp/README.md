# XEEHIVE MCP server

Gives an agent a **structured** way to talk to the queenzee (an alternative to the `/xell`
and `/xell-done` slash-command skills, which use `curl`). Same operations, native tools.

## Tools

| Tool | What it does | API |
|------|--------------|-----|
| `xeehive_get_context` | Claim a ready xell; return its binding | `POST /api/xell/claim` |
| `xeehive_status` | This session's xell status (done? awaiting? prod-lock?) | `GET /api/xell/status` |
| `xeehive_report_done` | Report finished → flags for human confirm | `POST /api/xell/report-done` |
| `xeehive_prod_lock_acquire` | Take the prod deploy lock | `POST /api/prod-lock/acquire` |
| `xeehive_prod_lock_release` | Release it | `POST /api/prod-lock/release` |
| `xeehive_prod_lock_status` | Who holds prod | `GET /api/prod-lock` |

## Register (Claude Code)

Add to `.mcp.json` (project) or `~/.claude.json`:

```json
{
  "mcpServers": {
    "xeehive": {
      "command": "node",
      "args": ["D:/Repos/Xeehive/mcp/server.js"],
      "env": { "XEEHIVE_API": "http://localhost:4700" }
    }
  }
}
```

The server reads `CLAUDE_CODE_SESSION_ID` from the environment to resolve "this session's"
xell, so status/report-done need no arguments. It talks to the queenzee at `XEEHIVE_API`.
