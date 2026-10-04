# GuardStein MCP server

Connects Claude (Desktop, Code, or any MCP client) to a [GuardStein](https://guardstein.com) workspace through its versioned machine API (`/api/v1`): read and write notes, upload files, and put editable draw.io diagrams into notes.

> Formerly `@cintelisai/brainstorm-mcp`. If you used that package, switch the name in your config (below). Your existing sign-in carries over: the first run reuses the token the old package stored.

**Sign-in is SSO, not keys.** The first tool call starts an OAuth device flow (RFC 8628): Claude shows you a URL and a short code, you approve in a browser where you are already signed in, and a workspace-scoped token is delivered back automatically. Nothing is typed, pasted, or stored in any config file.

## Setup

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart Claude Desktop from the system tray:

```json
{
  "mcpServers": {
    "guardstein": {
      "command": "npx",
      "args": ["-y", "@cintelisai/guardstein-mcp@latest"]
    }
  }
}
```

On Windows, if `npx` fails to launch, use `"command": "cmd", "args": ["/c", "npx", "-y", "@cintelisai/guardstein-mcp@latest"]`.

### Claude Code

```
claude mcp add guardstein -- npx -y @cintelisai/guardstein-mcp@latest
```

## Connecting

In any chat: *"connect to GuardStein"*. Claude will call `guardstein_connect` and give you a URL and code.

1. **Switch to the workspace this connection should access first**: in the GuardStein app, make it your active workspace. The token is bound to whichever workspace is active when you approve, and that cannot be changed afterwards without reconnecting.
2. Open the URL, check the code matches, and approve. Approval requires a workspace admin on a Premium workspace.
3. Tell Claude you've approved; it calls `guardstein_finish_connect` and you're connected.

## Tools

| Tool | What it does |
| --- | --- |
| `guardstein_connect` | Start the SSO device flow |
| `guardstein_finish_connect` | Collect the token after you approve |
| `guardstein_status` | Show connection state and workspace |
| `guardstein_list_notes` | List notes and folders (titles and ids, not content) |
| `guardstein_read_note` | Read one note's full markdown content and its version |
| `guardstein_read_asset` | Fetch an attachment by name: images display inline; `.docx`, spreadsheets and PDFs convert to text; text formats pass through |
| `guardstein_create_note` | Create a markdown note; `folder` is a folder *name*, created if new |
| `guardstein_update_note` | Replace a note's content or title; refused if someone edited it since you read it |
| `guardstein_upload_asset` | Upload a local file and get the markdown that links it (up to 4.5 MB) |
| `guardstein_add_diagram` | Upload a local `.drawio.svg` / `.drawio.png` and link it into a note: under a heading, in place of an older version, or in a new note |
| `guardstein_disconnect` | Delete the stored token from this machine |

## Diagrams

Diagrams are drawn by the **drawgen** MCP server ([drawio-tools](https://github.com/cintelis/drawio-tools)), which writes editable `NAME.drawio.svg` files: SVGs that GitHub shows as pictures, with the draw.io diagram embedded. Install both servers, then ask for a diagram in a note:

> *"Draw the order flow and add it to my Architecture note under 'Design'."*

Claude writes the diagram with drawgen, checks it, then calls `guardstein_add_diagram`, which uploads it and inserts `![Order flow](assets/3f9c21ab-order-flow.drawio.svg)`. The note shows it as an image you can click to edit in draw.io, and if the note is published to GitHub the same link renders there. To change it later, ask for the edit: Claude redraws it and swaps the link with `replace_link`.

Any `.drawio.svg` works, including ones exported from draw.io itself with *Include a copy of my diagram* ticked.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `GUARDSTEIN_URL` | `https://guardstein.com` | The GuardStein instance to talk to. `BRAINSTORM_URL` is still read if this is unset |
| `GUARDSTEIN_WORKDIR` | the server's working directory | Where relative file paths (uploads, diagrams) resolve. Claude Desktop starts servers in an arbitrary directory, so set this or use absolute paths there |

```json
"guardstein": {
  "command": "npx",
  "args": ["-y", "@cintelisai/guardstein-mcp@latest"],
  "env": { "GUARDSTEIN_URL": "https://your-instance.example.com" }
}
```

Updating notes and diagrams needs a deployment with `PATCH /api/v1/notes/{id}` (October 2026 or later); older ones answer 405 and the tools say so.

## Security notes

- The token is cached in one file per host in your home directory (`~/.guardstein-mcp-<host>.json`, mode 0600). It never appears in any config file or chat.
- Tokens are per-machine and individually revocable: each shows up under **Account → API tokens** in the app, and `guardstein_disconnect` deletes the local copy.
- Updates are refused when the note changed after it was read, so Claude cannot quietly replace text a person typed in the meantime; it re-reads and reapplies instead.
- Uploads read the file you name from your disk and send it to the workspace. Claude asks for files by path; check the path before approving the call.
- The API refuses plaintext writes into vault (end-to-end encrypted) workspaces by design; this server works with standard workspaces only.
- The API is a Premium feature; a lapsed subscription stops tokens working immediately.

## License

MIT © Cintelis Pty Limited
