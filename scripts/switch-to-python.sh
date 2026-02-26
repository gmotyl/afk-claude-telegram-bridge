#!/bin/bash
# Task 5.4: Rollback to Python Script
# Reverts Claude Code to use Python version if TypeScript has issues
# Updates ~/.claude/settings.json hook configuration back to Python

set -e

SETTINGS_FILE="$HOME/.claude/settings.json"
PYTHON_HOOK_PATH="$HOME/.claude/hooks/telegram-bridge/hook.sh"
TS_HOOK_PATH="$HOME/.claude/hooks/telegram-bridge-ts/hook.sh"

echo "Rolling back to Python version..."
echo ""

# Step 1: Validate prerequisites
echo "Step 1: Validating prerequisites..."

if [ ! -f "$SETTINGS_FILE" ]; then
  echo "ERROR: Claude Code settings not found: $SETTINGS_FILE" >&2
  echo "Make sure Claude Code is installed and configured." >&2
  exit 1
fi

if [ ! -f "$PYTHON_HOOK_PATH" ]; then
  echo "ERROR: Python hook not found: $PYTHON_HOOK_PATH" >&2
  echo "The original Python version appears to be uninstalled." >&2
  exit 1
fi

echo "  ✓ Settings file found"
echo "  ✓ Python hook found"

# Step 2: Create backup
echo "Step 2: Creating backup..."
BACKUP_FILE="$SETTINGS_FILE.bak"
if ! cp "$SETTINGS_FILE" "$BACKUP_FILE"; then
  echo "ERROR: Failed to create backup: $BACKUP_FILE" >&2
  exit 1
fi
echo "  ✓ Backup created: $BACKUP_FILE"

# Step 3: Update all telegram-bridge hook references back to Python
echo "Step 3: Reverting hook configuration..."

# Count how many TypeScript hook references exist
TS_HOOK_COUNT=$(grep -c "$TS_HOOK_PATH" "$SETTINGS_FILE" || echo "0")

if [ "$TS_HOOK_COUNT" -gt 0 ]; then
  echo "  Found $TS_HOOK_COUNT TypeScript hook reference(s) to revert"

  if sed -i '' "s|$TS_HOOK_PATH|$PYTHON_HOOK_PATH|g" "$SETTINGS_FILE"; then
    echo "  ✓ Updated all hook paths back to Python"
  else
    echo "ERROR: Failed to update hook paths" >&2
    # Restore backup
    mv "$BACKUP_FILE" "$SETTINGS_FILE"
    exit 1
  fi
else
  echo "WARNING: No TypeScript hook references found" >&2
  echo "  This may already be using Python version"
fi

# Step 4: Verify the change was made
echo "Step 4: Verifying configuration..."
if grep -q "$PYTHON_HOOK_PATH" "$SETTINGS_FILE"; then
  echo "  ✓ Configuration verified (Python hook references found)"

  # Also verify no TypeScript hooks remain
  if grep -q "$TS_HOOK_PATH" "$SETTINGS_FILE"; then
    echo "WARNING: Some TypeScript hook references still exist" >&2
  fi
else
  if [ "$TS_HOOK_COUNT" -gt 0 ]; then
    echo "ERROR: Verification failed - hook path not found in settings" >&2
    # Restore backup
    mv "$BACKUP_FILE" "$SETTINGS_FILE"
    exit 1
  fi
fi

# Step 5: Validate configuration structure
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
echo "Rollback successful!"
echo "=========================================="
echo ""
echo "Claude Code is now configured to use:"
echo "  Python Hook: $PYTHON_HOOK_PATH"
echo ""
echo "Reverted $TS_HOOK_COUNT hook reference(s)"
echo ""
echo "Backup saved to: $BACKUP_FILE"
echo ""
echo "Next steps:"
echo "  1. Restart Claude Code for changes to take effect"
echo ""
echo "  2. Verify Python daemon is running:"
echo "     ~/.claude/hooks/telegram-bridge/hook.sh --status"
echo ""
echo "  3. To switch back to TypeScript:"
echo "     ./scripts/switch-to-ts.sh"
echo ""
