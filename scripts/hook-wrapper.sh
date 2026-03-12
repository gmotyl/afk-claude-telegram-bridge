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
export AFK_CONFIG_PATH="$CONFIG_DIR/config.json"

# Fast gate: marker file check (no node needed — pure bash)
# hook.js resolves the exact session via session binding in the DB.
if [ -f "$CONFIG_DIR/active_count" ] && [ "$(cat "$CONFIG_DIR/active_count" 2>/dev/null)" -gt 0 ] 2>/dev/null; then
  if [ -f "$CONFIG_DIR/daemon.pid" ]; then
    _PID=$(cat "$CONFIG_DIR/daemon.pid" 2>/dev/null)
    if [ -n "$_PID" ] && kill -0 "$_PID" 2>/dev/null; then
      export AFK_ACTIVE=1
    elif [ -f "$CONFIG_DIR/daemon.heartbeat" ]; then
      _HB=$(cat "$CONFIG_DIR/daemon.heartbeat" 2>/dev/null)
      _NOW=$(date +%s)
      # Heartbeat is epoch milliseconds; convert to seconds and check staleness
      if [ -n "$_HB" ] && [ "$_HB" -gt 0 ] 2>/dev/null && [ $((_NOW - (_HB / 1000))) -lt 900 ]; then
        export AFK_ACTIVE=1
      else
        echo "0" > "$CONFIG_DIR/active_count"  # Reset stale marker
      fi
    fi
  else
    export AFK_ACTIVE=1  # No PID file but marker says active — let hook.js decide
  fi
fi

# Handle special flags first (before stdin read)
case "${1:-}" in
  --status)
    # Show daemon status using marker file and node:sqlite
    echo "AFK Bridge Status:"
    _COUNT=$(cat "$CONFIG_DIR/active_count" 2>/dev/null || echo "0")
    echo "Active sessions (marker): ${_COUNT}"
    if [ -f "$CONFIG_DIR/bridge.db" ] && command -v node &> /dev/null; then
      echo "Database: $CONFIG_DIR/bridge.db"
      _DB_COUNT=$(node -e 'try { const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); const r = db.prepare("SELECT COUNT(*) as c FROM sessions").get(); console.log(r.c); db.close(); } catch(e) { console.log("0"); }' "$CONFIG_DIR/bridge.db" 2>/dev/null)
      echo "Active sessions (db): ${_DB_COUNT:-0}"
    fi
    # Show daemon PID if alive
    if [ -f "$CONFIG_DIR/daemon.pid" ]; then
      _PID=$(cat "$CONFIG_DIR/daemon.pid" 2>/dev/null)
      if [ -n "$_PID" ] && kill -0 "$_PID" 2>/dev/null; then
        echo "Daemon PID: $_PID (alive)"
      else
        echo "Daemon PID: $_PID (dead)"
      fi
    else
      echo "Daemon: not running"
    fi
    exit 0
    ;;
  --activate)
    # Activate AFK mode: claim slot, create IPC dir, start daemon
    # Passes through all args including --verbose
    shift
    exec node "$CONFIG_DIR/cli.js" activate "$@"
    ;;
  --deactivate)
    # Deactivate AFK mode: release slot, clean IPC, stop daemon if last
    shift
    exec node "$CONFIG_DIR/cli.js" deactivate "$@"
    ;;
  --reset)
    # Nuclear reset: kill daemons, delete Telegram topics, delete bridge.db
    echo "Resetting AFK bridge..."

    # Delete Telegram topics from known_topics table in bridge.db
    if [ -f "$CONFIG_DIR/config.json" ] && [ -f "$CONFIG_DIR/bridge.db" ]; then
      BOT_TOKEN=$(node -e 'try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8")); console.log(c.telegramBotToken || c.bot_token || ""); } catch(e) {}' "$CONFIG_DIR/config.json" 2>/dev/null)
      CHAT_ID=$(node -e 'try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8")); console.log(c.telegramGroupId || c.chat_id || ""); } catch(e) {}' "$CONFIG_DIR/config.json" 2>/dev/null)
      if [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ]; then
        # Read thread IDs from both known_topics and sessions tables
        THREAD_IDS=$(node -e 'try { const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); const rows = db.prepare("SELECT DISTINCT thread_id FROM known_topics WHERE deleted_at IS NULL UNION SELECT DISTINCT thread_id FROM sessions WHERE thread_id IS NOT NULL").all(); rows.forEach(r => console.log(r.thread_id)); db.close(); } catch(e) {}' "$CONFIG_DIR/bridge.db" 2>/dev/null)
        _DELETED=0
        for tid in $THREAD_IDS; do
          [ -z "$tid" ] && continue
          curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/deleteForumTopic" \
            -H "Content-Type: application/json" \
            -d "{\"chat_id\":\"${CHAT_ID}\",\"message_thread_id\":${tid}}" > /dev/null 2>&1 \
            && echo "Deleted Telegram topic $tid" && _DELETED=$((_DELETED + 1)) || true
        done
        [ "$_DELETED" -gt 0 ] && echo "Deleted $_DELETED Telegram topic(s)" || echo "No Telegram topics to delete"
      fi
    else
      echo "No Telegram topics to delete"
    fi

    # Kill daemon: pkill as safety net for all bridge.js processes
    pkill -f "node.*bridge\.js" 2>/dev/null && echo "Killed bridge.js processes" || echo "No daemon running"

    # Delete bridge.db (the single source of truth)
    if [ -f "$CONFIG_DIR/bridge.db" ]; then
      rm -f "$CONFIG_DIR/bridge.db" "$CONFIG_DIR/bridge.db-wal" "$CONFIG_DIR/bridge.db-shm"
      echo "Deleted bridge.db"
    fi
    # Reset marker file
    echo "0" > "$CONFIG_DIR/active_count" 2>/dev/null
    # Clean up PID file and legacy files
    rm -f "$CONFIG_DIR/daemon.pid" "$CONFIG_DIR/daemon.heartbeat" "$CONFIG_DIR/state.json" "$CONFIG_DIR/known_topics.jsonl" 2>/dev/null
    rm -rf "$CONFIG_DIR/ipc" 2>/dev/null
    # Clear daemon log
    > "$CONFIG_DIR/daemon.log" 2>/dev/null
    echo "Cleared daemon.log"
    echo "AFK bridge reset complete. Use /afk to start fresh."
    exit 0
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

# ── Hook mode: read stdin, gate on session binding, then delegate to hook.js ──

# No active AFK slots → exit silently (fast path)
if [ "${AFK_ACTIVE:-}" != "1" ]; then
  exit 0
fi

# Read stdin (Claude Code sends JSON event payload)
INPUT=$(cat)

# Extract session_id from stdin JSON
SESSION_ID=$(echo "$INPUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).session_id||"")}catch(e){console.log("")}})' 2>/dev/null)

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

# Session gating: only proceed if bridge.db exists and has active sessions
# (hook.js handles detailed session binding via SQLite)
if [ ! -f "$CONFIG_DIR/bridge.db" ]; then
  exit 0
fi

# Pipe the saved stdin to hook.js
echo "$INPUT" | "$CONFIG_DIR/hook.js" "$@"
exit $?
