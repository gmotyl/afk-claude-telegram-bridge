# TypeScript Rewrite: Testing & Switchover Checklist

**Status:** TypeScript rewrite complete (Feature Branch: `feature/ts-rewrite`)
**Tests:** 222/222 passing
**Date:** 2026-02-26

---

## Phase Overview

The TypeScript rewrite is organized in 5 phases:

| Phase | Status | Component |
|-------|--------|-----------|
| 1 | ✅ | Toolchain (TypeScript, Jest, esbuild) |
| 2 | ✅ | Types layer (Config, State, Events, Telegram, IPC types) |
| 3 | ✅ | Daemon implementation (config loader, Telegram API, IPC, state persistence, main loop) |
| 4 | ✅ | Hook implementation (arg parser, permission flow, entry point) |
| 5 | ✅ | Deployment scripts (install, wrapper, switch, rollback) |

---

## Pre-Switchover Testing (Python Still Active)

### Step 1: Install TypeScript Version

```bash
cd /Users/gmotyl/git/prv/afk-claude-telegram-bridge
./scripts/install-ts.sh
```

**Verify:**
- [ ] No errors during build
- [ ] Directory created: `~/.claude/hooks/telegram-bridge-ts/`
- [ ] Files exist: `hook.js`, `bridge.js`, `hook.sh`, `config.json`, `state.json`
- [ ] All files executable (ls -la)

### Step 2: Check Installation Status

```bash
~/.claude/hooks/telegram-bridge-ts/hook.sh --status
```

**Verify:**
- [ ] Shows daemon status (should show empty slots initially)
- [ ] No errors in output
- [ ] State file is readable

### Step 3: Start New Claude Code Session (Python Still Active)

Start a normal Claude Code session. The hook is still pointing to Python version:

```bash
cat ~/.claude/settings.json | grep telegram-bridge
# Should show: "~/.claude/hooks/telegram-bridge/hook.sh"
```

### Step 4: Test Python Version Works

Trigger a permission request while still on Python:
- Ask Claude Code to run a bash command (e.g., `npm install`)
- Should see Telegram permission request
- Approve or deny via Telegram

**Verify:**
- [ ] Permission request appeared in Telegram
- [ ] Claude Code received approval/denial
- [ ] No errors in daemon logs

---

## Switchover: Python → TypeScript

### Step 5: Switch to TypeScript Version

```bash
./scripts/switch-to-ts.sh
```

**Verify:**
- [ ] No errors during switch
- [ ] Backup created: `~/.claude/settings.json.bak`
- [ ] Settings.json updated (check with grep)
- [ ] Print shows success confirmation

Verify the switch:
```bash
cat ~/.claude/settings.json | grep telegram-bridge
# Should show: "~/.claude/hooks/telegram-bridge-ts/hook.sh"
```

### Step 6: Start New Claude Code Session (TypeScript Active)

Open a new Claude Code session. Hook will now use TypeScript version:

```bash
ps aux | grep "node.*bridge"
# Should show TypeScript daemon running
```

---

## Post-Switchover Validation (TypeScript Active - 1-2 Hours)

### Step 7: Test Permission Approvals

**Test Case 1: Approve Permission**
1. Ask Claude to run bash command
2. Telegram notification appears with Approve/Deny buttons
3. Click Approve
4. Claude proceeds with command

**Verify:**
- [ ] Permission request formatted correctly in Telegram
- [ ] Approval processed immediately
- [ ] Command executes without delay
- [ ] No errors in daemon logs: `tail -f ~/.claude/hooks/telegram-bridge-ts/daemon.log`

**Test Case 2: Deny Permission**
1. Ask Claude to run another bash command
2. Click Deny in Telegram
3. Claude should fail with "Permission denied" message

**Verify:**
- [ ] Denial processed correctly
- [ ] Claude shows permission denied error
- [ ] Daemon continues running

### Step 8: Test Multi-Session Support

If you have multiple Claude Code sessions active:

```bash
/afk   # In another session to get S2 slot
```

**Test Case 3: Concurrent Sessions**
1. Open 2 Claude Code sessions
2. Activate AFK in both: `/afk` in session 1, `/afk other-project` in session 2
3. Both should create permission requests in different Telegram topics
4. Approve/deny each independently

**Verify:**
- [ ] Both sessions show active slots in status
- [ ] Permissions isolated per session (S1, S2)
- [ ] No cross-session interference

### Step 9: Test Error Recovery

**Test Case 4: Network Interruption**
1. Ask Claude to run a command (permission request sent)
2. Manually kill daemon: `pkill -f "node.*bridge"`
3. Daemon should auto-restart on next hook invocation
4. Permission flow should recover

**Verify:**
- [ ] Daemon restarts automatically
- [ ] Permission request succeeds after restart
- [ ] No manual intervention needed

**Test Case 5: Malformed Response**
1. Ask Claude to run command
2. Manually create invalid response file:
   ```bash
   echo '{"invalid": true}' > ~/.claude/hooks/telegram-bridge-ts/ipc/response-*.json
   ```
3. Permission should timeout and return error

**Verify:**
- [ ] Error handled gracefully
- [ ] Claude Code receives error message
- [ ] Daemon continues running (no crash)

### Step 10: Monitor System

Monitor for 1-2 hours while using TypeScript version normally:

```bash
# Watch daemon logs
tail -f ~/.claude/hooks/telegram-bridge-ts/daemon.log

# Check process status
ps aux | grep "node.*bridge"

# Monitor state file
cat ~/.claude/hooks/telegram-bridge-ts/state.json
```

**Verify:**
- [ ] No errors in daemon logs
- [ ] Daemon process running continuously
- [ ] State file updates after each permission (lastUpdate timestamp)
- [ ] No CPU spikes or memory leaks

---

## Rollback (If Issues)

If any problems occur, rollback is instant:

```bash
./scripts/switch-to-python.sh
```

**Verify:**
- [ ] Switch succeeds without errors
- [ ] Settings.json reverted to Python path
- [ ] Backup preserved: `~/.claude/settings.json.bak`

Next Claude Code session will use Python version again (instant revert).

---

## Validation Success Criteria

All of these must pass before committing to TypeScript permanently:

### Functional Correctness
- [ ] All 3 hook types work (permission_request, stop, notification)
- [ ] Permission approval/denial flows correctly
- [ ] Multi-session support works (S1-S4 slots)
- [ ] Timeout handling works correctly
- [ ] Response cleanup (no orphaned files)

### Error Handling
- [ ] Network errors don't crash daemon
- [ ] Malformed responses handled gracefully
- [ ] Missing files don't cause hangs
- [ ] Permission timeout triggers properly
- [ ] Daemon continues after individual failures

### Performance
- [ ] Permission approval < 1 second
- [ ] No noticeable delay compared to Python version
- [ ] No memory leaks over 1-2 hours
- [ ] No CPU spikes during normal operation

### Stability
- [ ] Daemon runs continuously without crashes
- [ ] State file persists correctly
- [ ] Cleanup happens automatically (stale slots removed)
- [ ] Multi-session doesn't cause race conditions

---

## Merge to Main

Once all validation passes:

```bash
git checkout main
git pull origin main
git merge feature/ts-rewrite --no-ff -m "Merge TypeScript rewrite (complete daemon + hook + deployment)"
git push origin main
```

---

## Deployment to Production

After merging to main:

```bash
# Production installation
./scripts/install-ts.sh

# Switch production instance
./scripts/switch-to-ts.sh

# Monitor
tail -f ~/.claude/hooks/telegram-bridge-ts/daemon.log
```

---

## Rollback Procedure (If Production Issues)

```bash
# Instant revert to Python
./scripts/switch-to-python.sh

# Restart Claude Code session
```

---

## Success!

Once validated and merged:
- ✅ TypeScript rewrite deployed
- ✅ Full feature parity with Python
- ✅ Type-safe FP patterns throughout
- ✅ 222+ tests providing confidence
- ✅ Dual-deployment proven safe
- ✅ Instant rollback available

**Congratulations on completing the TypeScript rewrite!** 🎉
