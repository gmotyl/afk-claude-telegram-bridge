#!/bin/bash
# Task 5.1: Install TypeScript Version Script
# Builds TS version and installs to ~/.claude/hooks/telegram-bridge-ts/
# Ensures config.json and state.json are properly initialized

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="$HOME/.claude/hooks/telegram-bridge-ts"
CONFIG_FILE="$INSTALL_DIR/config.json"
STATE_FILE="$INSTALL_DIR/state.json"
CONFIG_TEMPLATE="$REPO_ROOT/config.json"

echo "Installing TypeScript version of telegram-bridge..."
echo ""

# Step 1: Build TypeScript
echo "Step 1: Building TypeScript..."
cd "$REPO_ROOT"
if ! npm run build > /dev/null 2>&1; then
  echo "ERROR: npm build failed" >&2
  exit 1
fi
echo "  ✓ TypeScript build complete"

# Step 2: Create installation directory
echo "Step 2: Creating installation directory..."
if ! mkdir -p "$INSTALL_DIR"; then
  echo "ERROR: Failed to create directory: $INSTALL_DIR" >&2
  exit 1
fi
echo "  ✓ Directory created: $INSTALL_DIR"

# Step 3: Copy compiled JavaScript files
echo "Step 3: Copying compiled files..."
if [ ! -f "$REPO_ROOT/dist/hook.js" ]; then
  echo "ERROR: dist/hook.js not found after build" >&2
  exit 1
fi
if [ ! -f "$REPO_ROOT/dist/bridge.js" ]; then
  echo "ERROR: dist/bridge.js not found after build" >&2
  exit 1
fi
cp "$REPO_ROOT/dist/hook.js" "$INSTALL_DIR/hook.js" || {
  echo "ERROR: Failed to copy hook.js" >&2
  exit 1
}
chmod +x "$INSTALL_DIR/hook.js" || {
  echo "ERROR: Failed to make hook.js executable" >&2
  exit 1
}
cp "$REPO_ROOT/dist/bridge.js" "$INSTALL_DIR/bridge.js" || {
  echo "ERROR: Failed to copy bridge.js" >&2
  exit 1
}
chmod +x "$INSTALL_DIR/bridge.js" || {
  echo "ERROR: Failed to make bridge.js executable" >&2
  exit 1
}
echo "  ✓ Copied and made hook.js and bridge.js executable"

# Step 4: Copy hook wrapper script
echo "Step 4: Installing wrapper script..."
if [ ! -f "$SCRIPT_DIR/hook-wrapper.sh" ]; then
  echo "ERROR: hook-wrapper.sh not found in scripts directory" >&2
  exit 1
fi
cp "$SCRIPT_DIR/hook-wrapper.sh" "$INSTALL_DIR/hook.sh" || {
  echo "ERROR: Failed to copy hook-wrapper.sh" >&2
  exit 1
}
chmod +x "$INSTALL_DIR/hook.sh" || {
  echo "ERROR: Failed to make hook.sh executable" >&2
  exit 1
}
echo "  ✓ Installed hook.sh wrapper"

# Step 5: Copy or create config.json
echo "Step 5: Setting up config.json..."
if [ ! -f "$CONFIG_FILE" ]; then
  if [ -f "$CONFIG_TEMPLATE" ]; then
    cp "$CONFIG_TEMPLATE" "$CONFIG_FILE" || {
      echo "ERROR: Failed to copy config.json template" >&2
      exit 1
    }
    echo "  ✓ Created config.json from template"
  else
    echo "WARNING: config.json template not found, using minimal config" >&2
    cat > "$CONFIG_FILE" <<'EOF'
{
  "bot_token": "",
  "chat_id": "",
  "permission_timeout": 300,
  "stop_timeout": 600,
  "auto_approve_tools": [
    "Read",
    "Glob",
    "Grep",
    "WebSearch",
    "WebFetch",
    "TaskList",
    "TaskGet",
    "TaskCreate",
    "TaskUpdate"
  ],
  "max_slots": 4,
  "keep_alive_poll_seconds": 60,
  "idle_ping_hours": 12,
  "context_warning_threshold": 150
}
EOF
    echo "  ✓ Created minimal config.json"
  fi
else
  echo "  ✓ Using existing config.json"
fi

# Step 6: Initialize state.json with empty slots
echo "Step 6: Initializing state.json..."
if [ ! -f "$STATE_FILE" ]; then
  cat > "$STATE_FILE" <<'EOF'
{
  "slots": {}
}
EOF
  echo "  ✓ Created state.json with empty slots"
else
  echo "  ✓ Using existing state.json"
fi

# Step 7: Verify installation
echo "Step 7: Verifying installation..."
for file in hook.js bridge.js hook.sh config.json state.json; do
  if [ ! -f "$INSTALL_DIR/$file" ]; then
    echo "ERROR: Verification failed - $file not found" >&2
    exit 1
  fi
done
echo "  ✓ All files present and verified"

echo ""
echo "=========================================="
echo "Installation successful!"
echo "=========================================="
echo ""
echo "Installed to: $INSTALL_DIR"
echo "Files:"
echo "  - hook.js           (compiled hook entry point)"
echo "  - bridge.js         (compiled daemon entry point)"
echo "  - hook.sh           (shell wrapper for Claude Code)"
echo "  - config.json       (configuration template)"
echo "  - state.json        (runtime state with slots)"
echo ""
echo "Next steps:"
echo "  1. Configure your Telegram bot:"
echo "     Edit: $CONFIG_FILE"
echo "     Set bot_token and chat_id"
echo ""
echo "  2. Switch Claude Code to use TypeScript version:"
echo "     ./scripts/switch-to-ts.sh"
echo ""
echo "  3. Monitor the daemon:"
echo "     ./scripts/hook-wrapper.sh --status"
echo ""
