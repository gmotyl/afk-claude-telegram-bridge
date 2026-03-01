/**
 * @module services/session-binding
 * Maps Claude Code's internal session_id to AFK IPC directories.
 *
 * When multiple Claude Code sessions run concurrently, each sends a unique
 * session_id in stdin JSON. This module creates a binding between Claude's
 * session_id and the AFK session's IPC directory so events are routed correctly.
 *
 * Binding lifecycle:
 * 1. /afk activation creates IPC dir: ipc/{uuid}/
 * 2. First hook call from Claude session reads session_id from stdin
 * 3. findBoundSession() scans IPC dirs for matching bound_session file
 * 4. If no match, findUnboundSession() finds an IPC dir without bound_session
 * 5. bindSession() writes Claude's session_id to bound_session file
 * 6. All subsequent hook calls find the existing binding
 */

import * as fs from 'fs/promises'
import * as path from 'path'

export interface BoundSession {
  readonly sessionId: string   // AFK session UUID (IPC directory name)
  readonly slotNum: number     // Slot number from state.json
}

/**
 * Find an IPC directory already bound to a Claude Code session_id.
 *
 * Scans all subdirectories under ipcBaseDir for a `bound_session` file
 * whose content matches the given claudeSessionId.
 *
 * @param ipcBaseDir - Base IPC directory (e.g. ~/.claude/hooks/telegram-bridge/ipc/)
 * @param claudeSessionId - Claude Code's internal session_id from stdin JSON
 * @param state - Current state with slots to look up slot numbers
 * @returns BoundSession if found, null otherwise
 */
export const findBoundSession = async (
  ipcBaseDir: string,
  claudeSessionId: string,
  slots: Record<string, { sessionId: string } | undefined>
): Promise<BoundSession | null> => {
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(ipcBaseDir, { withFileTypes: true })
  } catch {
    return null
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const boundFile = path.join(ipcBaseDir, entry.name, 'bound_session')
    try {
      const content = await fs.readFile(boundFile, 'utf-8')
      if (content.trim() === claudeSessionId) {
        // Found matching binding — look up slot number
        const slotNum = findSlotNumBySessionId(slots, entry.name)
        if (slotNum !== null) {
          return { sessionId: entry.name, slotNum }
        }
      }
    } catch {
      // No bound_session file or read error — skip
      continue
    }
  }

  return null
}

/**
 * Find an IPC directory that hasn't been bound to any Claude session yet.
 *
 * Returns the first directory (by slot number order) that:
 * 1. Has a matching slot in state.json
 * 2. Does NOT have a `bound_session` file
 *
 * @param ipcBaseDir - Base IPC directory
 * @param slots - Current state slots
 * @returns BoundSession for the unbound slot, or null if all are bound
 */
export const findUnboundSession = async (
  ipcBaseDir: string,
  slots: Record<string, { sessionId: string } | undefined>
): Promise<BoundSession | null> => {
  // Sort by slot number to ensure deterministic binding order
  const sortedSlots = Object.entries(slots)
    .filter(([, slot]) => slot !== undefined)
    .sort(([a], [b]) => parseInt(a, 10) - parseInt(b, 10))

  for (const [slotKey, slot] of sortedSlots) {
    if (!slot) continue

    const boundFile = path.join(ipcBaseDir, slot.sessionId, 'bound_session')
    try {
      await fs.access(boundFile)
      // File exists — this slot is already bound
    } catch {
      // No bound_session file — this slot is unbound
      return {
        sessionId: slot.sessionId,
        slotNum: parseInt(slotKey, 10)
      }
    }
  }

  return null
}

/**
 * Bind a Claude Code session_id to an AFK IPC directory.
 *
 * Writes the claudeSessionId to `{ipcBaseDir}/{afkSessionId}/bound_session`.
 *
 * @param ipcBaseDir - Base IPC directory
 * @param afkSessionId - AFK session UUID (IPC directory name)
 * @param claudeSessionId - Claude Code's internal session_id
 */
export const bindSession = async (
  ipcBaseDir: string,
  afkSessionId: string,
  claudeSessionId: string
): Promise<void> => {
  const boundFile = path.join(ipcBaseDir, afkSessionId, 'bound_session')
  await fs.writeFile(boundFile, claudeSessionId, 'utf-8')
}

/**
 * Look up slot number by AFK session ID from state slots.
 */
const findSlotNumBySessionId = (
  slots: Record<string, { sessionId: string } | undefined>,
  sessionId: string
): number | null => {
  for (const [key, slot] of Object.entries(slots)) {
    if (slot && slot.sessionId === sessionId) {
      return parseInt(key, 10)
    }
  }
  return null
}
