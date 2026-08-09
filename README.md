# Brainstorm Board MCP server

Connects Claude (Desktop, Code, or any MCP client) to a [Brainstorm Board](https://brainstorm.cintelis.ai) workspace through its versioned machine API (`/api/v1`).

**Sign-in is SSO, not keys.** The first tool call starts an OAuth device flow (RFC 8628): Claude shows you a URL and a short code, you approve in a browser where you are already signed in, and a workspace-scoped token is delivered back automatically. Nothing is typed, pasted, or stored in any config file.

## Setup

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart Claude Desktop from the system tray:

```json
{
  "mcpServers": {
    "brainstorm": {
      "command": "npx",
      "args": ["-y", "@cintelisai/brainstorm-mcp"]
    }
  }
}
```

On Windows, if `npx` fails to launch, use `"command": "cmd", "args": ["/c", "npx", "-y", "@cintelisai/brainstorm-mcp"]`.

### Claude Code

```
claude mcp add brainstorm -- npx -y @cintelisai/brainstorm-mcp
```

## Connecting

In any chat: *"connect to brainstorm"*. Claude will call `brainstorm_connect` and give you a URL and code.

1. **Switch to the workspace this connection should access first** — in the Brainstorm app, make it your active workspace. The token is bound to whichever workspace is active when you approve, and that cannot be changed afterwards without reconnecting.
2. Open the URL, check the code matches, and approve. Approval requires a workspace admin on a Premium workspace.
3. Tell Claude you've approved; it calls `brainstorm_finish_connect` and you're connected.

## Tools

| Tool | What it does |
| --- | --- |
| `brainstorm_connect` | Start the SSO device flow |
| `brainstorm_finish_connect` | Collect the token after you approve |
| `brainstorm_status` | Show connection state and workspace |
| `brainstorm_list_notes` | List notes and folders (titles and ids, not content) |
| `brainstorm_read_note` | Read one note's full markdown content by id |
| `brainstorm_read_asset` | Fetch an attachment by name — images display inline, text formats as text |
| `brainstorm_create_note` | Create a markdown note; `folder` is a folder *name*, created if new |
| `brainstorm_disconnect` | Delete the stored token from this machine |

Reading requires the Brainstorm Board deployment to include the `/api/v1/notes/[id]` and `/api/v1/assets/[name]` routes (August 2026 or later); older deployments answer 404 and the tools say so.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `BRAINSTORM_URL` | `https://brainstorm.cintelis.ai` | The Brainstorm Board instance to talk to |

Set it in the MCP config entry to target another deployment:

```json
"brainstorm": {
  "command": "npx",
  "args": ["-y", "@cintelisai/brainstorm-mcp"],
  "env": { "BRAINSTORM_URL": "https://your-instance.example.com" }
}
```

## Security notes

- The token is cached in one file per host in your home directory (`~/.brainstorm-mcp-<host>.json`, mode 0600). It never appears in any config file or chat.
- Tokens are per-machine and individually revocable: each shows up under **Account → API tokens** in the app, and `brainstorm_disconnect` deletes the local copy.
- The API refuses plaintext writes into vault (end-to-end encrypted) workspaces by design — this server can only work with standard workspaces.
- The API is a Premium feature; a lapsed subscription stops tokens working immediately.

## License

MIT © Cintelis Pty Limited
