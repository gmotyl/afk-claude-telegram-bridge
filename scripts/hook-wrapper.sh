#!/bin/bash
# Task 5.2: Hook Wrapper Script
# Executes JavaScript entry points from shell (Claude Code invokes this)
# Handles hook types, status, and setup operations

set -uo pipefail

# Determine config directory (same as where this script lives)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$SCRIPT_DIR"

# Validate that hook.js exists
if [ ! -f "$CONFIG_DIR/hook.js" ]; then
  echo "ERROR: hook.js not found in $CONFIG_DIR" >&2
  exit 127
fi

# Make sure hook.js is executable
chmod +x "$CONFIG_DIR/hook.js" 2>/dev/null || true

# Export config directory for Node.js to find config.json and state.json
export TELEGRAM_BRIDGE_CONFIG="$CONFIG_DIR"

# Handle special flags first (before stdin read)
case "${1:-}" in
  --status)
    # Show daemon status by reading state.json
    if [ -f "$CONFIG_DIR/state.json" ]; then
      echo "AFK Bridge Status:"
      echo "State file: $CONFIG_DIR/state.json"
      # Try to parse and display active slots
      if command -v jq &> /dev/null; then
        jq '.slots | length' "$CONFIG_DIR/state.json" 2>/dev/null | {
          read count
          echo "Active slots: ${count:-0}"
        }
      else
        # Fallback if jq not available
        grep -o '"slots"' "$CONFIG_DIR/state.json" > /dev/null 2>&1 && \
          echo "State file exists with slots" || echo "State file error"
      fi
    else
      echo "AFK Bridge not installed. Run: scripts/install-ts.sh"
      exit 1
    fi
    exit 0
    ;;
  --activate)
    # Activate AFK mode: claim slot, create IPC dir, start daemon
    shift
    exec node "$CONFIG_DIR/cli.js" activate "$@"
    ;;
  --deactivate)
    # Deactivate AFK mode: release slot, clean IPC, stop daemon if last
    shift
    exec node "$CONFIG_DIR/cli.js" deactivate "$@"
    ;;
  --setup)
    # Interactive bot token + chat_id configuration
    echo "Run 'bash install.sh' to reconfigure Telegram bot setup." >&2
    exit 1
    ;;
  --help|-h)
    cat <<'EOF'
Usage: hook.sh [--activate|--deactivate|--status|--setup|--help] [hook-type]

Wrapper for TypeScript telegram-bridge hook.

Commands:
  --activate <session_id> <project> [topic]  Activate AFK mode
  --deactivate <session_id>                  Deactivate AFK mode
  --status      Show daemon status
  --setup       Configure Telegram credentials
  --help        Show this help message

Hook Types (when called without --flags):
  Reads JSON from stdin (Claude Code hook event) and processes
  permission_request, stop, or notification events.

Environment:
  TELEGRAM_BRIDGE_CONFIG  Set to config directory
EOF
    exit 0
    ;;
esac

# Main hook mode: execute hook.js with all arguments
# Claude Code will call this with stdin containing the JSON event payload
"$CONFIG_DIR/hook.js" "$@"
exit $?
