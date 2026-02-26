#!/bin/bash
# Task 5.3: Switch to TypeScript Script
# Atomically switches Claude Code to use TypeScript version
# Updates ~/.claude/settings.json hook configuration

set -e

SETTINGS_FILE="$HOME/.claude/settings.json"
TS_HOOK_PATH="$HOME/.claude/hooks/telegram-bridge-ts/hook.sh"
PYTHON_HOOK_PATH="$HOME/.claude/hooks/telegram-bridge/hook.sh"

echo "Switching Claude Code to TypeScript version..."
echo ""

# Step 1: Validate prerequisites
echo "Step 1: Validating prerequisites..."

if [ ! -f "$SETTINGS_FILE" ]; then
  echo "ERROR: Claude Code settings not found: $SETTINGS_FILE" >&2
  echo "Make sure Claude Code is installed and configured." >&2
  exit 1
fi

if [ ! -f "$TS_HOOK_PATH" ]; then
  echo "ERROR: TypeScript hook not found: $TS_HOOK_PATH" >&2
  echo "Run 'scripts/install-ts.sh' first to install TypeScript version." >&2
  exit 1
fi

echo "  ✓ Settings file found"
echo "  ✓ TypeScript hook found"

# Step 2: Create backup
echo "Step 2: Creating backup..."
BACKUP_FILE="$SETTINGS_FILE.bak"
if ! cp "$SETTINGS_FILE" "$BACKUP_FILE"; then
  echo "ERROR: Failed to create backup: $BACKUP_FILE" >&2
  exit 1
fi
echo "  ✓ Backup created: $BACKUP_FILE"

# Step 3: Update all telegram-bridge hook references
echo "Step 3: Updating hook configuration..."
# Use sed to replace all references from Python hook to TypeScript hook
# This is a multi-step approach since the hook is referenced in multiple places

# Count how many hooks we're replacing
HOOK_COUNT=$(grep -c "$PYTHON_HOOK_PATH" "$SETTINGS_FILE" || echo "0")

if [ "$HOOK_COUNT" -gt 0 ]; then
  echo "  Found $HOOK_COUNT hook references to update"

  if sed -i '' "s|$PYTHON_HOOK_PATH|$TS_HOOK_PATH|g" "$SETTINGS_FILE"; then
    echo "  ✓ Updated all hook paths"
  else
    echo "ERROR: Failed to update hook paths" >&2
    # Restore backup
    mv "$BACKUP_FILE" "$SETTINGS_FILE"
    exit 1
  fi
else
  echo "WARNING: No existing Python hook configuration found" >&2
  echo "  This is OK if this is the first switch to TS"
fi

# Step 4: Verify the change was made
echo "Step 4: Verifying configuration..."
if grep -q "$TS_HOOK_PATH" "$SETTINGS_FILE"; then
  echo "  ✓ Configuration verified (TypeScript hook references found)"

  # Also verify no Python hooks remain
  if grep -q "$PYTHON_HOOK_PATH" "$SETTINGS_FILE"; then
    echo "WARNING: Some Python hook references still exist" >&2
  fi
else
  if [ "$HOOK_COUNT" -gt 0 ]; then
    echo "ERROR: Verification failed - hook path not found in settings" >&2
    # Restore backup
    mv "$BACKUP_FILE" "$SETTINGS_FILE"
    exit 1
  fi
fi

# Step 5: Validate JSON syntax (basic check with grep)
echo "Step 5: Validating configuration..."
if grep -q '"command"' "$SETTINGS_FILE" && grep -q '"hooks"' "$SETTINGS_FILE"; then
  echo "  ✓ Configuration structure valid"
else
  echo "ERROR: Configuration structure appears invalid" >&2
  # Restore backup
  mv "$BACKUP_FILE" "$SETTINGS_FILE"
  exit 1
fi

echo ""
echo "=========================================="
echo "Switch successful!"
echo "=========================================="
echo ""
echo "Claude Code is now configured to use:"
echo "  TypeScript Hook: $TS_HOOK_PATH"
echo ""
echo "Updated $HOOK_COUNT hook reference(s)"
echo ""
echo "Backup saved to: $BACKUP_FILE"
echo ""
echo "Next steps:"
echo "  1. Restart Claude Code for changes to take effect"
echo ""
echo "  2. Monitor the daemon status:"
echo "     ~/.claude/hooks/telegram-bridge-ts/hook.sh --status"
echo ""
echo "  3. If issues occur, rollback to Python:"
echo "     ./scripts/switch-to-python.sh"
echo ""
