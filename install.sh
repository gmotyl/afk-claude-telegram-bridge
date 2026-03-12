#!/bin/bash
# afk-claude-telegram-bridge installer (TypeScript version)
# Works both via `npx` / `curl | bash` (downloads from GitHub) and local clone
set -euo pipefail

GLOBAL_BASE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
INSTALL_DIR="$GLOBAL_BASE/hooks/telegram-bridge"
SETTINGS="$GLOBAL_BASE/settings.json"
REPO_BASE="https://raw.githubusercontent.com/gmotyl/afk-claude-telegram-bridge/main"

# Check Node.js version (>= 22.5.0 required for node:sqlite)
NODE_VERSION=$(node -v 2>/dev/null | sed 's/^v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VERSION" | cut -d. -f2)
if [ -z "$NODE_VERSION" ]; then
  echo "ERROR: Node.js is required. Install Node.js >= 22.5.0" >&2
  exit 1
fi
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  echo "ERROR: Node.js >= 22.5.0 required (found v${NODE_VERSION}). node:sqlite is not available in older versions." >&2
  exit 1
fi
echo "Node.js v${NODE_VERSION} ✓"

# --- Detect source (local clone or remote) ---
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ "${BASH_SOURCE[0]}" != "bash" ]; then
  CANDIDATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
  # Local clone: check for dist/hook.js (built TS) or package.json
  if [ -f "$CANDIDATE/dist/hook.js" ]; then
    SCRIPT_DIR="$CANDIDATE"
  elif [ -f "$CANDIDATE/package.json" ]; then
    # Repo present but not built — build first
    echo "Building TypeScript..."
    (cd "$CANDIDATE" && npm run build > /dev/null 2>&1) || {
      echo "ERROR: npm run build failed. Run 'npm install && npm run build' first." >&2
      exit 1
    }
    SCRIPT_DIR="$CANDIDATE"
  fi
fi

# --- Detect update vs fresh install ---
UPDATING=false
if [ -f "$INSTALL_DIR/hook.js" ]; then
  UPDATING=true
fi

echo "=== afk-claude-telegram-bridge installer (TS) ==="
echo ""

if [ "$UPDATING" = true ]; then
  echo "Existing install found. Updating..."
else
  echo "Installing Telegram Bridge for Claude Code..."
fi

# --- Create install directory ---
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/ipc"

# --- Copy/download core files ---
if [ -n "$SCRIPT_DIR" ]; then
  echo "Installing from local clone: $SCRIPT_DIR"
  cp "$SCRIPT_DIR/dist/hook.js" "$INSTALL_DIR/hook.js"
  cp "$SCRIPT_DIR/dist/bridge.js" "$INSTALL_DIR/bridge.js"
  cp "$SCRIPT_DIR/dist/cli.js" "$INSTALL_DIR/cli.js"
  cp "$SCRIPT_DIR/scripts/hook-wrapper.sh" "$INSTALL_DIR/hook.sh"
else
  echo "Downloading from GitHub..."
  curl -fsSL "$REPO_BASE/dist/hook.js" -o "$INSTALL_DIR/hook.js"
  curl -fsSL "$REPO_BASE/dist/bridge.js" -o "$INSTALL_DIR/bridge.js"
  curl -fsSL "$REPO_BASE/dist/cli.js" -o "$INSTALL_DIR/cli.js"
  curl -fsSL "$REPO_BASE/scripts/hook-wrapper.sh" -o "$INSTALL_DIR/hook.sh"
fi

chmod +x "$INSTALL_DIR/hook.js" "$INSTALL_DIR/bridge.js" "$INSTALL_DIR/cli.js" "$INSTALL_DIR/hook.sh"

echo "Core files installed to $INSTALL_DIR"

# --- Install /afk and /back commands ---
COMMANDS_DIR="$GLOBAL_BASE/commands"
mkdir -p "$COMMANDS_DIR"

if [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR/skills" ]; then
  [ -f "$SCRIPT_DIR/skills/afk/SKILL.md" ] && cp "$SCRIPT_DIR/skills/afk/SKILL.md" "$COMMANDS_DIR/afk.md"
  [ -f "$SCRIPT_DIR/skills/back/SKILL.md" ] && cp "$SCRIPT_DIR/skills/back/SKILL.md" "$COMMANDS_DIR/back.md"
  [ -f "$SCRIPT_DIR/skills/afk-reset/SKILL.md" ] && cp "$SCRIPT_DIR/skills/afk-reset/SKILL.md" "$COMMANDS_DIR/afk-reset.md"
else
  curl -fsSL "$REPO_BASE/skills/afk/SKILL.md" -o "$COMMANDS_DIR/afk.md" 2>/dev/null || true
  curl -fsSL "$REPO_BASE/skills/back/SKILL.md" -o "$COMMANDS_DIR/back.md" 2>/dev/null || true
  curl -fsSL "$REPO_BASE/skills/afk-reset/SKILL.md" -o "$COMMANDS_DIR/afk-reset.md" 2>/dev/null || true
fi

echo "Commands installed: /afk, /back, /afk-reset"

# --- Clean up legacy state.json (replaced by bridge.db) ---
if [ -f "$INSTALL_DIR/state.json" ]; then
  rm -f "$INSTALL_DIR/state.json"
  echo "Removed legacy state.json (replaced by SQLite bridge.db)"
fi

# --- Register hooks in settings.json ---
echo ""
echo "Registering hooks in settings.json..."

node -e "
const fs = require('fs');
const settingsPath = '$SETTINGS';
const hookCmd = '$INSTALL_DIR/hook.sh';

const settings = fs.existsSync(settingsPath)
  ? JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  : {};

const hooks = settings.hooks || {};

const hookConfigs = {
  Stop: { timeout: 660 },
  Notification: { timeout: 10 },
  PreToolUse: { timeout: 360 },
};

for (const [event, cfg] of Object.entries(hookConfigs)) {
  let eventHooks = hooks[event] || [];

  // Remove any existing telegram-bridge entries
  eventHooks = eventHooks.filter(h =>
    !(h.hooks || []).some(hk => (hk.command || '').includes('telegram-bridge'))
  );

  eventHooks.push({
    matcher: '',
    hooks: [{ type: 'command', command: hookCmd, timeout: cfg.timeout }],
  });
  hooks[event] = eventHooks;
}

settings.hooks = hooks;
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log('Hooks registered for: ' + Object.keys(hookConfigs).join(', '));
"

# --- Config setup ---
CONFIG_FILE="$INSTALL_DIR/config.json"

if [ -f "$CONFIG_FILE" ]; then
  echo ""
  echo "Existing bot configuration found."
  if [ -t 0 ]; then
    read -p "Re-run Telegram bot setup? [y/N]: " RERUN
    RERUN_LOWER=$(echo "$RERUN" | tr '[:upper:]' '[:lower:]')
    if [ "$RERUN_LOWER" != "y" ]; then
      SKIP_SETUP=true
    else
      SKIP_SETUP=false
    fi
  else
    # Non-interactive mode (e.g. npm run deploy) — skip setup
    SKIP_SETUP=true
  fi
else
  SKIP_SETUP=false
fi

if [ "${SKIP_SETUP:-false}" = false ]; then
  echo ""
  echo "Bot Configuration"
  echo "-----------------"
  echo ""
  echo "Step 1: Bot Token"
  echo "  1. Open Telegram -> search @BotFather"
  echo "  2. Send /newbot and follow instructions"
  echo "  3. Copy the bot token"
  echo ""
  read -p "Enter bot token: " BOT_TOKEN

  if [ -z "$BOT_TOKEN" ]; then
    echo "ERROR: Bot token is required. Run install again." >&2
    exit 1
  fi

  echo ""
  echo "Step 2: Add Bot to Telegram Group"
  echo "  1. Create a Telegram group with Topics enabled"
  echo "  2. Add your bot as Administrator"
  echo "  3. Send any message in the group"
  echo ""
  read -p "Press Enter after you've done the above..."

  echo ""
  echo "Step 3: Detecting your group..."

  RESPONSE=$(curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?timeout=5")

  if echo "$RESPONSE" | grep -q '"ok":false'; then
    echo "ERROR: Failed to fetch updates. Check your bot token." >&2
    exit 1
  fi

  CHATS=$(echo "$RESPONSE" | node -e "
const data = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
const chats = {};
for (const result of data.result || []) {
  const chat = (result.message || {}).chat || {};
  if (chat.id) chats[chat.id] = { type: chat.type, title: chat.title || 'Private Chat' };
}
Object.keys(chats).sort((a, b) => Number(a) - Number(b)).forEach(cid => {
  console.log(cid + '|' + chats[cid].type + '|' + chats[cid].title);
});
" 2>/dev/null)

  if [ -z "$CHATS" ]; then
    echo "ERROR: No messages found. Ensure bot is admin in a group with a message." >&2
    exit 1
  fi

  echo ""
  echo "Available groups:"
  echo ""
  COUNT=0
  while IFS='|' read -r cid ctype ctitle; do
    COUNT=$((COUNT + 1))
    echo "  [$COUNT] $ctitle (ID: $cid)"
  done <<< "$CHATS"

  echo ""
  read -p "Select group number: " CHAT_NUM

  SELECTED=$(echo "$CHATS" | sed -n "${CHAT_NUM}p")
  if [ -z "$SELECTED" ]; then
    echo "ERROR: Invalid selection" >&2
    exit 1
  fi

  CHAT_ID=$(echo "$SELECTED" | cut -d'|' -f1)
  CHAT_TITLE=$(echo "$SELECTED" | cut -d'|' -f3)

  echo ""
  echo "Selected: $CHAT_TITLE (ID: $CHAT_ID)"

  # Write TS-format config
  cat > "$CONFIG_FILE" << EOF
{
  "telegramBotToken": "$BOT_TOKEN",
  "telegramGroupId": $CHAT_ID,
  "ipcBaseDir": "$INSTALL_DIR/ipc",
  "sessionTimeout": 900000
}
EOF

  echo "Config saved to $CONFIG_FILE"
fi

# --- Remove legacy Python files (no longer needed) ---
for old_file in hook.py bridge.py poll.py; do
  if [ -f "$INSTALL_DIR/$old_file" ]; then
    rm -f "$INSTALL_DIR/$old_file"
    echo "Removed legacy $old_file"
  fi
done
# Clean up old -ts directory if it exists and we're installing to main dir
OLD_TS_DIR="$GLOBAL_BASE/hooks/telegram-bridge-ts"
if [ -d "$OLD_TS_DIR" ] && [ "$INSTALL_DIR" != "$OLD_TS_DIR" ]; then
  echo "Note: Old telegram-bridge-ts directory found at $OLD_TS_DIR"
  echo "  You can remove it manually if no longer needed."
fi

# --- Done ---
echo ""
echo "============================================"
echo "  Installation complete!"
echo "============================================"
echo ""
echo "Files installed:"
echo "  $INSTALL_DIR/hook.js"
echo "  $INSTALL_DIR/bridge.js"
echo "  $INSTALL_DIR/cli.js"
echo "  $INSTALL_DIR/hook.sh"
echo "  $INSTALL_DIR/config.json"
echo "  $COMMANDS_DIR/afk.md"
echo "  $COMMANDS_DIR/back.md"
echo "  $COMMANDS_DIR/afk-reset.md"
echo ""
echo "Hooks registered in:"
echo "  $SETTINGS"
echo ""
echo "Restart Claude Code to load the new /afk and /back commands."
echo ""
echo "Usage (after restart):"
echo "  /afk              Activate AFK mode"
echo "  /afk my-project   Activate with custom topic name"
echo "  /back             Deactivate AFK mode"
echo "  /afk-reset        Nuclear reset (kill daemons, clear state)"
echo ""
