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
  --setup)
    # Placeholder for setup operations
    # Future: interactive config setup
    echo "Setup mode not yet implemented" >&2
    exit 1
    ;;
  --help|-h)
    cat <<'EOF'
Usage: hook.sh [--status|--setup|--help] [hook-type]

Wrapper for TypeScript telegram-bridge hook.

Options:
  --status      Show daemon status
  --setup       Configure Telegram credentials (placeholder)
  --help        Show this help message

Hook Types (when called without --flags):
  permission_request  Handle permission requests
  stop                Handle stop requests
  notification        Handle notifications

When called without arguments, reads JSON from stdin and processes
the hook event based on the hook type specified in the JSON.

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
