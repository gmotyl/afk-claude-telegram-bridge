# AFK Claude Telegram Bridge

Remote-control Claude Code from your phone via Telegram when you're away from your keyboard.

## Use Case

You're working on code with Claude Code, but you need to leave your desk. With this bridge, you can:

- **Approve tool calls** from your phone (Write, Bash, Edit, etc.)
- **Send instructions** and see Claude's responses directly in Telegram
- **Continue conversations** — multiple back-and-forth exchanges without touching your laptop
- **Monitor progress** via Telegram notifications
- **Run multiple sessions** concurrently with automatic topic routing

Perfect for: working on the go, meetings, or just stepping away while keeping Claude running.

## Features

- **Session Isolation** — Only the terminal that called `/afk` publishes to Telegram. Other concurrent Claude sessions are completely isolated.
- **Telegram Topics** — Each session gets its own topic/thread in a Telegram group
- **Response Forwarding** — Claude's responses appear in Telegram as chat messages
- **Conversation Chain** — Send instructions, see responses, send more — stays alive until you stop
- **Message Buffer** — Queue instructions while Claude is working, auto-delivered when idle
- **Smart Routing** — Just type in the topic, no prefixes needed
- **Auto-approve** read-only tools (Read, Glob, Grep, WebSearch, WebFetch)
- **Multi-session** support (up to 4 concurrent sessions)
- **Zero runtime dependencies** — single-file JS bundles (fp-ts bundled in), SQLite via Node.js built-in `node:sqlite`

## Quick Install

```bash
# From clone (build + install):
git clone https://github.com/gmotyl/afk-claude-telegram-bridge.git
cd afk-claude-telegram-bridge
npm install && npm run deploy

# Or install pre-built via curl:
curl -fsSL https://raw.githubusercontent.com/gmotyl/afk-claude-telegram-bridge/main/install.sh | bash

# Or via skills.sh:
npx skills add gmotyl/afk-claude-telegram-bridge --skill afk-claude-telegram-bridge -y && bash ~/.claude/skills/afk-claude-telegram-bridge/install.sh
```

The installer builds (if local), copies files, registers hooks, installs `/afk` and `/back` commands, and walks you through Telegram bot setup.

**Restart Claude Code after installation** to load the new commands.

## Requirements

- Node.js 22.5+ (uses built-in `node:sqlite` for session state and IPC)
- bash
- Telegram Group (not private chat) with **Topics enabled**
- Bot added to the group as **Administrator**

## Manual Installation

### 1. Create Telegram Bot

1. Open Telegram, search **@BotFather**, send `/newbot`
2. Name it "Claude Bridge" (or your preference)
3. Copy the bot token

### 2. Create a Telegram Group

1. Create a new group in Telegram
2. Add your bot to the group
3. **Make bot an Administrator**
4. **Enable Topics** in group settings
5. Send a message in the group (so the bot can detect it)

### 3. Build and Install

```bash
git clone https://github.com/gmotyl/afk-claude-telegram-bridge.git
cd afk-claude-telegram-bridge
npm install
npm run deploy
```

This will build the TypeScript, copy files to `~/.claude/hooks/telegram-bridge/`, register hooks, and run interactive bot setup.

### 4. Add Hooks Manually (if not using installer)

Edit `~/.claude/settings.json` and add the hooks:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/telegram-bridge/hook.sh",
            "timeout": 660
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/telegram-bridge/hook.sh",
            "timeout": 10
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/telegram-bridge/hook.sh",
            "timeout": 360
          }
        ]
      }
    ]
  }
}
```

## Usage

### Activate

```
/afk              # Topic: current directory name
/afk my-project   # Topic: "my-project"
```

A new Telegram topic is created (e.g., "S1 - my-project").

### While Away

**Permission requests** appear with inline buttons:
```
🔐 Permission Request
Tool: Bash
`npm install express`
[Approve] [Deny]
```

**Task completion** shows Claude's response and waits for instructions:
```
🤖 I've implemented the login form with validation...

Reply to give next instruction...
[Let it stop]
```

**Just reply with your next instruction** — Claude processes it and sends the response back to Telegram. The conversation continues until you press "Let it stop" or the timeout expires.

### Message Buffer

If you send instructions while Claude is still working, they're queued and automatically delivered when the current task completes.

### Multiple Sessions

Open multiple terminals, each with its own `/afk`:
- Terminal 1: `/afk frontend` → Topic "S1 - frontend"
- Terminal 2: `/afk backend` → Topic "S2 - backend"

Each session is fully isolated — messages in one topic only affect that terminal.

### Deactivate

```
/back
```

Topic is automatically cleaned up from the Telegram group.

## Architecture

```
Claude Code ←→ hook.sh ←→ hook.js ←→ IPC (filesystem) ←→ bridge.js daemon ←→ Telegram API
```

- **hook.js**: Processes Claude Code hook events (reads stdin JSON or CLI args), manages session binding
- **bridge.js**: Long-polling Telegram daemon, routes messages between sessions
- **hook.sh**: Bash wrapper that Claude Code invokes (forwards to hook.js)
- **IPC**: File-based communication via `~/.claude/hooks/telegram-bridge/ipc/`
- **Session binding**: First hook event from a Claude session binds it to its AFK slot

## Auto-Approved Tools

These tools are approved automatically without Telegram notification:

Read, Glob, Grep, WebSearch, WebFetch, TaskList, TaskGet, TaskCreate, TaskUpdate

Configure in `config.json`:
```json
{
  "auto_approve_tools": ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]
}
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| No messages in Telegram | Check `daemon.log`: `cat ~/.claude/hooks/telegram-bridge/daemon.log` |
| Hook not firing | Check `hook-debug.log`: `cat ~/.claude/hooks/telegram-bridge/hook-debug.log` |
| Topic not created | Ensure bot is admin with Topics permission |
| Permission timeout | Increase timeout in `settings.json` (default: 360s) |
| Daemon crashed | Restart: `node ~/.claude/hooks/telegram-bridge/bridge.js` |
| Check status | `~/.claude/hooks/telegram-bridge/hook.sh --status` |
| Kill daemon | `kill $(jq -r '.daemon_pid' ~/.claude/hooks/telegram-bridge/state.json)` |

## CLI Commands

| Command | Description |
|---------|-------------|
| `hook.sh --activate <session> [project] [topic]` | Enable AFK mode |
| `hook.sh --deactivate <session>` | Disable AFK mode |
| `hook.sh --status` | Show active sessions |
| `hook.sh --setup` | Configure bot token and group |
| `hook.sh --help` | Show help |

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history and breaking changes.

## Credits

Built by [Greg Motyl](https://github.com/gmotyl)

## Support

If you find this useful, you can [buy me a coffee](https://buymeacoffee.com/motyl.dev)!
