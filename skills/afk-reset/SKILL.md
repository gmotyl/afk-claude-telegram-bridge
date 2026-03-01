---
name: afk-reset
description: "Nuclear reset of AFK Telegram Bridge. Kills all daemons, clears queued instructions, removes Telegram topics, resets state. Use when AFK is stuck or broken."
user_invocable: true
allowed-tools: Bash
---

# AFK Reset — Nuclear Reset of Telegram Bridge

Kill all daemons, clear all queued instructions, delete created Telegram topics, and reset state to allow a fresh start.

## Steps

1. Run the reset command:
   ```bash
   "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/hooks/telegram-bridge/hook.sh --reset
   ```

2. Confirm to user: "AFK bridge fully reset. All daemons killed, IPC cleared, state reset. Use /afk to start fresh."
