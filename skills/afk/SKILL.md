---
name: afk
description: "Activate Telegram Bridge for remote Claude Code control. Use when user wants to go AFK, enable remote approval of permissions from phone, or forward Claude output to Telegram."
user_invocable: true
allowed-tools: Bash
---

# AFK Mode — Activate Telegram Bridge

Enable remote control of this Claude Code session via Telegram.
When AFK mode is active, permission requests will appear in Telegram for approval, and you can send instructions from your phone.

## Usage

```bash
/afk                        # Default: uses current directory name as topic
/afk custom-topic-name      # Custom: uses "custom-topic-name" as topic name
/afk --verbose              # Show status messages (instruction delivered, queued, etc.)
/afk --verbose custom-name  # Both verbose and custom topic
```

## Steps

1. Generate a session ID:
   ```bash
   SESSION_ID=$(node -e "console.log(require('crypto').randomUUID().slice(0, 12))")
   echo "Session: $SESSION_ID"
   ```

2. Parse arguments — extract `--verbose` flag and topic name from arguments:
   ```bash
   VERBOSE_FLAG=""
   TOPIC_NAME="$(basename "$PWD")"
   for arg in "$@"; do
     if [ "$arg" = "--verbose" ]; then
       VERBOSE_FLAG="--verbose"
     else
       TOPIC_NAME="$arg"
     fi
   done
   ```

3. Activate AFK mode:
   ```bash
   "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/hooks/telegram-bridge/hook.sh --activate "$SESSION_ID" "$(basename "$PWD")" "$TOPIC_NAME" $VERBOSE_FLAG
   ```

4. Confirm to user: "AFK mode active! Permission requests will appear on Telegram. Topic: TOPIC_NAME. Use /back to deactivate."
