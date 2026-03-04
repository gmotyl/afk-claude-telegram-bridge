#!/usr/bin/env node

import * as TE from 'fp-ts/TaskEither'
import * as E from 'fp-ts/Either'
import * as path from 'path'
import * as fs from 'fs/promises'
import { Config } from '../types/config'
import { State, Slot, PendingStop, initialState } from '../types/state'
import { IpcEvent } from '../types/events'
import { BridgeError, stateError } from '../types/errors'
import { loadConfig } from '../core/config'
import {
  addSlot,
  removeSlot,
  heartbeatSlot,
  cleanupStaleSlots,
  addPendingStop,
  removePendingStop,
  findPendingStopBySlot,
  updatePendingStopMessageId,
  StateError
} from '../core/state'
import { loadState } from '../services/state-persistence-sqlite'
import { readAllUnprocessedEvents, markEventDone, writeResponse } from '../services/ipc-sqlite'
import { openDatabase, closeDatabase, getDatabase } from '../services/db'
import { listActiveSessions, updateSessionThreadId, insertKnownTopic, insertPendingStop as dbInsertPendingStop, deletePendingStop as dbDeletePendingStop } from '../services/db-queries'
import {
  createForumTopic,
  deleteForumTopic,
  sendMessageToTopic,
  sendButtonsToTopic,
  sendMultiRowButtonsToTopic,
  editMessageText,
  answerCallbackQuery,
  sendChatAction,
  TelegramApiResponse,
} from '../services/telegram'
import { pollTelegram, TelegramUpdate } from '../services/telegram-poller'

/**
 * Daemon error type - all errors that can occur during daemon operation
 */
export type DaemonError = BridgeError | StateError

/**
 * Stop function type - async function that stops the daemon gracefully
 */
type StopFunction = () => TE.TaskEither<DaemonError, void>

/** A buffered permission request awaiting batch flush */
interface PermissionBatchEntry {
  readonly requestId: string
  readonly tool: string
  readonly command: string
  readonly slotNum: number
  readonly sessionId: string
  readonly bufferedAt: number // Date.now() when added
}

/** Tracks a flushed batch so callbacks can resolve all requests */
interface PendingBatchInfo {
  readonly requestIds: readonly string[]
  readonly slotNum: number
  readonly sessionId: string
}

/**
 * Non-persisted daemon runtime state
 */
interface DaemonRuntime {
  telegramOffset: number
  /** Track which pending stops have already had their Telegram side effects run */
  processedStopEvents: Set<string>
  /** Per-slot typing indicator: slotNum → true when Claude is processing */
  typingSlots: Map<number, boolean>
  /** Per-slot last typing action timestamp (Telegram expires after 5s) */
  typingLastSent: Map<number, number>
  /** Per-slot permission batch buffer (slotNum → entries) */
  permissionBatches: Map<number, PermissionBatchEntry[]>
  /** Flushed batch lookups (batchId → request info) */
  pendingBatches: Map<string, PendingBatchInfo>
  /** Per-session approval count for trust threshold */
  approvalCounts: Map<string, number>
  /** Sessions that have been trusted (auto-approve all future requests) */
  trustedSessions: Set<string>
  /** Per-slot queued instructions (message arrived before Stop event) */
  queuedInstructions: Map<number, string>
}

// ============================================================================
// Pure state processing
// ============================================================================

/**
 * Process a single IPC event and update state accordingly (pure)
 */
const processEvent = (
  _config: Config,
  state: State,
  event: IpcEvent
): E.Either<StateError, State> => {
  const now = new Date()

  switch (event._tag) {
    case 'SessionStart': {
      const newSlot: Slot = {
        sessionId: event.sessionId,
        projectName: event.projectName,
        topicName: event.topicName,
        ...(event.threadId !== undefined ? { threadId: event.threadId } : {}),
        activatedAt: now,
        lastHeartbeat: now
      }
      return addSlot(state, event.slotNum, newSlot)
    }

    case 'SessionEnd':
      return E.right(removeSlot(state, event.slotNum))

    case 'Heartbeat':
    case 'KeepAlive':
    case 'Message':
    case 'PermissionRequest':
      return heartbeatSlot(state, event.slotNum, now)

    case 'Stop': {
      const pendingStop: PendingStop = {
        eventId: event.eventId,
        slotNum: event.slotNum,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        lastMessage: event.lastMessage,
        timestamp: event.timestamp
      }
      return E.right(addPendingStop(state, pendingStop))
    }

    default:
      // Unknown event type (e.g. old Python-format events) — skip
      console.warn(`[daemon] Unknown event type: ${(event as Record<string, unknown>)._tag ?? (event as Record<string, unknown>).type}`)
      return E.right(state)
  }
}

// ============================================================================
// Telegram side effects
// ============================================================================

/**
 * Process Telegram side effects for an IPC event.
 * Called after pure processEvent() — handles topic creation, messages, buttons.
 */
const processEventSideEffects = async (
  config: Config,
  state: State,
  event: IpcEvent,
  runtime: DaemonRuntime
): Promise<State> => {
  const chatId = String(config.telegramGroupId)
  const token = config.telegramBotToken

  switch (event._tag) {
    case 'SessionStart': {
      const slot = state.slots[event.slotNum]
      if (!slot) return state

      // If slot already has a threadId (reattachment), send activation message to existing topic
      if (slot.threadId) {
        await sendMessageToTopic(
          token, chatId,
          `🟢 S${event.slotNum} reactivated — ${slot.projectName}`,
          slot.threadId
        )()
        return state
      }

      // Create new forum topic
      const topicResult = await createForumTopic(token, chatId, slot.topicName)()
      if (E.isRight(topicResult)) {
        const result = topicResult.right.result as { message_thread_id: number } | undefined
        if (result?.message_thread_id) {
          const threadId = result.message_thread_id
          // Update slot with threadId
          const updatedSlot: Slot = { ...slot, threadId }
          const updatedState: State = {
            ...state,
            slots: { ...state.slots, [event.slotNum]: updatedSlot }
          }

          // Persist threadId to SQLite so it survives daemon restarts
          const dbResult = getDatabase()
          if (E.isRight(dbResult)) {
            updateSessionThreadId(dbResult.right, slot.sessionId, threadId)
            insertKnownTopic(dbResult.right, threadId, slot.topicName)
          }

          // Send activation message
          await sendMessageToTopic(
            token, chatId,
            `🟢 ${slot.projectName}`,
            threadId
          )()

          return updatedState
        }
      } else {
        console.error('Failed to create forum topic:', topicResult.left)
      }
      return state
    }

    case 'SessionEnd': {
      stopTyping(runtime, event.slotNum)
      // Find slot before it was removed (it's already gone from state)
      // We need the threadId — check if we can find it from the slot that was just removed
      // The slot was removed in processEvent, so we need to look at the pre-removal state
      // Instead, we'll handle this in processAllEvents where we have both pre and post state
      return state
    }

    case 'PermissionRequest': {
      stopTyping(runtime, event.slotNum)
      const slot = state.slots[event.slotNum]
      if (!slot?.threadId) return state

      // Trusted session → auto-approve immediately
      if (slot.sessionId && runtime.trustedSessions.has(slot.sessionId)) {
        const sessionIpcDir = path.join(config.ipcBaseDir, slot.sessionId)
        const writeResult = await writeResponse(sessionIpcDir, event.requestId, { approved: true })()
        if (E.isLeft(writeResult)) {
          console.error(`[trust] Failed to write auto-approve response for ${event.tool}: ${String(writeResult.left)}`)
          // Fall through to normal batch flow so the request doesn't hang
        } else {
          startTyping(runtime, event.slotNum)
          console.log(`[trust] Auto-approved ${event.tool} for trusted session ${slot.sessionId.slice(0,8)}`)
          return state
        }
      }

      // Buffer into batch (flushed on next daemon tick after window expires)
      const batch = runtime.permissionBatches.get(event.slotNum) ?? []
      batch.push({
        requestId: event.requestId,
        tool: event.tool,
        command: event.command,
        slotNum: event.slotNum,
        sessionId: slot.sessionId,
        bufferedAt: Date.now()
      })
      runtime.permissionBatches.set(event.slotNum, batch)
      return state
    }

    case 'Stop': {
      stopTyping(runtime, event.slotNum)
      const slot = state.slots[event.slotNum]
      console.log(`[side-effect] Stop event ${event.eventId.slice(0,8)} for slot ${event.slotNum}, threadId=${slot?.threadId}`)

      // Persist pending_stop to SQLite
      if (event.sessionId) {
        const dbResult = getDatabase()
        if (E.isRight(dbResult)) {
          dbInsertPendingStop(dbResult.right, event.eventId, event.sessionId)
        }
      }

      if (!slot?.threadId) return state

      // Don't re-process stops we've already handled
      if (runtime.processedStopEvents.has(event.eventId)) return state
      runtime.processedStopEvents.add(event.eventId)

      // Send last message to topic
      const lastMsgPreview = event.lastMessage.length > 1000
        ? event.lastMessage.substring(0, 1000) + '...'
        : event.lastMessage
      const text = slot.verbose
        ? `${lastMsgPreview}\n\n📝 Reply with next instruction`
        : lastMsgPreview

      const sendResult = await sendMessageToTopic(token, chatId, text, slot.threadId)()
      if (E.isRight(sendResult)) {
        const result = sendResult.right.result as { message_id: number } | undefined
        if (result?.message_id) {
          return updatePendingStopMessageId(state, event.eventId, result.message_id)
        }
      }
      return state
    }

    default:
      return state
  }
}

// ============================================================================
// IPC event processing
// ============================================================================

/**
 * Get the session IPC directory for a given slot number
 */
const getSessionIpcDir = (config: Config, state: State, slotNum: number): string => {
  const slot = state.slots[slotNum]
  if (slot) {
    return path.join(config.ipcBaseDir, slot.sessionId)
  }
  return config.ipcBaseDir
}

/**
 * Process all unprocessed events from SQLite events table.
 * Replaces directory scanning — reads events directly from the database.
 */
const processAllEvents = (
  config: Config,
  state: State,
  runtime: DaemonRuntime
): TE.TaskEither<DaemonError, State> => {
  return TE.tryCatch(
    async () => {
      let currentState = state

      // Read all unprocessed events from SQLite
      const eventsResult = await readAllUnprocessedEvents()()
      if (E.isLeft(eventsResult)) {
        console.error('Error reading events from SQLite:', eventsResult.left)
        return state
      }

      for (const { event, eventRowId } of eventsResult.right) {
        // Save pre-event state for SessionEnd side effects
        const preEventState = currentState

        // Pure state update
        const processResult = processEvent(config, currentState, event)
        if (E.isRight(processResult)) {
          currentState = processResult.right
        } else {
          // SlotAlreadyActive is benign (activate script pre-added slot)
          // — still run side effects below
          if (processResult.left._tag !== 'SlotAlreadyActive') {
            console.error('Error processing event:', processResult.left)
            // Mark as processed even on error to avoid infinite retry
            await markEventDone(eventRowId)()
            continue
          }
        }

        // Telegram side effects
        if (event._tag === 'SessionEnd') {
          // For SessionEnd, we need the slot from pre-removal state
          const slot = preEventState.slots[event.slotNum]
          if (slot?.threadId) {
            await sendMessageToTopic(
              config.telegramBotToken,
              String(config.telegramGroupId),
              `🔴 S${event.slotNum} deactivated — ${slot.projectName}`,
              slot.threadId
            )()

            // Delete forum topic
            await deleteForumTopic(
              config.telegramBotToken,
              String(config.telegramGroupId),
              slot.threadId
            )()
          }
        } else {
          currentState = await processEventSideEffects(
            config, currentState, event, runtime
          )
        }

        // Mark event as processed in SQLite
        await markEventDone(eventRowId)()
      }

      // Handle stop side effects (queued instruction auto-inject)
      currentState = await handleStopEventSideEffects(config, currentState, runtime)

      return currentState
    },
    (error) => {
      if (typeof error === 'object' && error !== null && '_tag' in error) {
        return error as DaemonError
      }
      return stateError(`Unexpected error processing events: ${String(error)}`, error)
    }
  )
}

// ============================================================================
// Stop event side effects
// ============================================================================

const handleStopEventSideEffects = async (
  config: Config,
  state: State,
  runtime: DaemonRuntime
): Promise<State> => {
  let currentState = state

  for (const ps of Object.values(currentState.pendingStops)) {
    const sessionIpcDir = getSessionIpcDir(config, currentState, ps.slotNum)

    // Check for queued instruction in runtime memory
    const queuedText = runtime.queuedInstructions.get(ps.slotNum)

    if (queuedText) {
      console.log(`[auto-inject] Found queued instruction for slot ${ps.slotNum}, eventId=${ps.eventId.slice(0,8)}: "${queuedText.slice(0,50)}"`)
      const writeResult = await writeResponse(sessionIpcDir, ps.eventId, {
        instruction: queuedText
      })()

      if (E.isRight(writeResult)) {
        runtime.queuedInstructions.delete(ps.slotNum)
        currentState = removePendingStop(currentState, ps.eventId)

        // Clean up SQLite pending_stop row
        const dbResult = getDatabase()
        if (E.isRight(dbResult)) {
          dbDeletePendingStop(dbResult.right, ps.eventId)
        }

        startTyping(runtime, ps.slotNum)

        // Verbose: confirm auto-injection
        const slot = currentState.slots[ps.slotNum]
        if (slot?.verbose && slot.threadId) {
          await sendMessageToTopic(
            config.telegramBotToken,
            String(config.telegramGroupId),
            `📨 Auto-injected queued instruction`,
            slot.threadId
          )()
        }
      }
    }
  }

  return currentState
}

// ============================================================================
// Typing indicator
// ============================================================================

/** Telegram typing indicator expires after 5s; resend every 4.5s */
const TYPING_INTERVAL_MS = 4500

/**
 * Send typing indicator for all slots where Claude is actively processing.
 * Idempotent — safe to call every daemon iteration.
 */
const updateTypingIndicators = async (
  config: Config,
  state: State,
  runtime: DaemonRuntime
): Promise<void> => {
  const now = Date.now()
  const token = config.telegramBotToken
  const chatId = String(config.telegramGroupId)

  for (const [slotNum, isTyping] of runtime.typingSlots) {
    if (!isTyping) continue

    const slot = state.slots[slotNum]
    if (!slot?.threadId) continue

    const lastSent = runtime.typingLastSent.get(slotNum) ?? 0
    if (now - lastSent >= TYPING_INTERVAL_MS) {
      await sendChatAction(token, chatId, 'typing', slot.threadId)()
      runtime.typingLastSent.set(slotNum, now)
    }
  }
}

/**
 * Enable typing indicator for a slot (Claude started processing)
 */
const startTyping = (runtime: DaemonRuntime, slotNum: number): void => {
  runtime.typingSlots.set(slotNum, true)
  // Force immediate send on next iteration by clearing last-sent
  runtime.typingLastSent.delete(slotNum)
}

/**
 * Disable typing indicator for a slot (Claude stopped / waiting)
 */
const stopTyping = (runtime: DaemonRuntime, slotNum: number): void => {
  runtime.typingSlots.set(slotNum, false)
}

// ============================================================================
// Permission batching + session trust
// ============================================================================

/** Default batch window in ms */
const DEFAULT_BATCH_WINDOW_MS = 2000
/** Default approval count before offering trust */
const DEFAULT_TRUST_THRESHOLD = 3

/**
 * Flush permission batches whose window has expired.
 * Single requests → standard [Approve] [Deny] buttons.
 * Multiple requests → combined [Approve All (N)] [Deny All] with per-item rows.
 */
const flushPermissionBatches = async (
  config: Config,
  state: State,
  runtime: DaemonRuntime
): Promise<void> => {
  const now = Date.now()
  const windowMs = config.permissionBatchWindowMs ?? DEFAULT_BATCH_WINDOW_MS
  const token = config.telegramBotToken
  const chatId = String(config.telegramGroupId)

  for (const [slotNum, entries] of runtime.permissionBatches) {
    if (entries.length === 0) continue

    // Check if the oldest entry has aged past the window
    const oldest = entries[0]!
    if (now - oldest.bufferedAt < windowMs) continue

    // Drain the batch
    runtime.permissionBatches.set(slotNum, [])

    const slot = state.slots[slotNum]
    if (!slot?.threadId) continue

    if (entries.length === 1) {
      // Single request — standard format
      const entry = entries[0]!
      const toolDisplay = entry.tool === 'Bash' ? `🖥️ ${entry.tool}` : `🔧 ${entry.tool}`
      const commandPreview = entry.command.length > 200
        ? entry.command.substring(0, 200) + '...'
        : entry.command
      const text = `${toolDisplay}\n\n\`\`\`\n${commandPreview}\n\`\`\``
      const buttons = [
        { text: '✅ Approve', callback_data: `approve:${entry.requestId}` },
        { text: '❌ Deny', callback_data: `deny:${entry.requestId}` }
      ]
      await sendButtonsToTopic(token, chatId, text, buttons, slot.threadId)()
    } else {
      // Multiple requests — batched format
      const batchId = `b_${Date.now()}_${slotNum}`
      const lines = entries.map(e => {
        const icon = e.tool === 'Bash' ? '🖥️' : '🔧'
        const preview = e.command.length > 80 ? e.command.substring(0, 80) + '...' : e.command
        return `${icon} ${e.tool}: ${preview}`
      })
      const text = `${entries.length} permission requests:\n\n${lines.join('\n')}`

      const buttonRows: { text: string; callback_data: string }[][] = [
        [
          { text: `✅ Approve All (${entries.length})`, callback_data: `batch_approve:${batchId}` },
          { text: '❌ Deny All', callback_data: `batch_deny:${batchId}` }
        ]
      ]

      // Store batch mapping for callback resolution
      runtime.pendingBatches.set(batchId, {
        requestIds: entries.map(e => e.requestId),
        slotNum,
        sessionId: entries[0]!.sessionId
      })

      await sendMultiRowButtonsToTopic(token, chatId, text, buttonRows, slot.threadId)()
    }
  }
}

/**
 * Track an approval and offer session trust at threshold.
 */
const trackApproval = async (
  config: Config,
  state: State,
  runtime: DaemonRuntime,
  sessionId: string,
  slotNum: number
): Promise<void> => {
  const threshold = config.sessionTrustThreshold ?? DEFAULT_TRUST_THRESHOLD
  const count = (runtime.approvalCounts.get(sessionId) ?? 0) + 1
  runtime.approvalCounts.set(sessionId, count)

  if (count === threshold) {
    const slot = state.slots[slotNum]
    if (!slot?.threadId) return

    const token = config.telegramBotToken
    const chatId = String(config.telegramGroupId)
    const buttons = [
      { text: '🔓 Trust this session', callback_data: `trust:${sessionId}` },
      { text: '👀 Keep reviewing', callback_data: `no_trust:${sessionId}` }
    ]
    await sendButtonsToTopic(
      token, chatId,
      `You've approved ${count} requests. Trust this session to auto-approve future requests?`,
      buttons,
      slot.threadId
    )()
  }
}

// ============================================================================
// Telegram polling + message/callback routing
// ============================================================================

/**
 * Find slot number by matching message_thread_id to slot threadId
 */
const findSlotByThreadId = (state: State, threadId: number): number | undefined => {
  for (const [key, slot] of Object.entries(state.slots)) {
    if (slot && slot.threadId === threadId) {
      return parseInt(key, 10)
    }
  }
  return undefined
}

/**
 * Process an incoming Telegram message for a specific slot.
 */
/**
 * Strip @BotName suffix from Telegram bot commands.
 * e.g. "/clear@MyBot" → "/clear", "/compact@Bot_name" → "/compact"
 * Non-command messages pass through unchanged.
 */
export const stripBotMention = (text: string): string =>
  text.replace(/^(\/\w+)@\w+/, '$1')

const processIncomingMessage = async (
  config: Config,
  state: State,
  slotNum: number,
  rawText: string,
  runtime: DaemonRuntime
): Promise<State> => {
  const text = stripBotMention(rawText)
  const sessionIpcDir = getSessionIpcDir(config, state, slotNum)
  const pendingStop = findPendingStopBySlot(state, slotNum)

  const slot = state.slots[slotNum]
  const allPS = Object.values(state.pendingStops).map(ps => ({ eventId: ps.eventId.slice(0,8), slotNum: ps.slotNum, sessionId: ps.sessionId?.slice(0,8) }))
  console.log(`[telegram] processIncomingMessage slot=${slotNum}, pendingStops=${JSON.stringify(allPS)}, found=${!!pendingStop}`)

  // Validate pending stop belongs to this slot's session
  if (pendingStop && pendingStop.sessionId && slot?.sessionId && pendingStop.sessionId !== slot.sessionId) {
    console.error(`[telegram] PENDING STOP SESSION MISMATCH: pendingStop.sessionId=${pendingStop.sessionId.slice(0,8)} != slot.sessionId=${slot.sessionId.slice(0,8)}, skipping`)
    // Remove the mismatched pending stop
    return removePendingStop(state, pendingStop.eventId)
  }

  if (pendingStop) {
    console.log(`[telegram] Delivering instruction to slot ${slotNum}, eventId=${pendingStop.eventId.slice(0,8)}: "${text.slice(0,50)}"`)
    const writeResult = await writeResponse(sessionIpcDir, pendingStop.eventId, {
      instruction: text
    })()

    if (E.isRight(writeResult)) {
      startTyping(runtime, slotNum)

      // Clean up SQLite pending_stop row
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        dbDeletePendingStop(dbResult.right, pendingStop.eventId)
      }

      // Verbose: confirm delivery in topic
      if (slot?.verbose && slot.threadId) {
        await sendMessageToTopic(
          config.telegramBotToken,
          String(config.telegramGroupId),
          `📨 Instruction delivered to S${slotNum}`,
          slot.threadId
        )()
      }
      return removePendingStop(state, pendingStop.eventId)
    }
    return state
  }

  // No pending stop — buffer as queued instruction in runtime memory
  console.log(`[telegram] No pendingStop for slot ${slotNum}, queuing: "${text.slice(0,50)}"`)
  runtime.queuedInstructions.set(slotNum, text)

  // Verbose: confirm queuing in topic
  if (slot?.verbose && slot.threadId) {
    await sendMessageToTopic(
      config.telegramBotToken,
      String(config.telegramGroupId),
      `📋 Instruction queued (Claude is busy)`,
      slot.threadId
    )()
  }

  return state
}

/**
 * Handle a callback query (permission approve/deny button press)
 */
const handleCallbackQuery = async (
  config: Config,
  state: State,
  update: TelegramUpdate,
  runtime: DaemonRuntime
): Promise<State> => {
  const cq = update.callback_query
  if (!cq?.data || !cq.message) return state

  const token = config.telegramBotToken
  const chatId = String(config.telegramGroupId)

  // Parse callback data: "action:id"
  const colonIdx = cq.data.indexOf(':')
  if (colonIdx === -1) {
    await answerCallbackQuery(token, cq.id, 'Unknown action')()
    return state
  }
  const action = cq.data.substring(0, colonIdx)
  const actionId = cq.data.substring(colonIdx + 1)

  // --- Batch approve/deny ---
  if (action === 'batch_approve' || action === 'batch_deny') {
    const batchInfo = runtime.pendingBatches.get(actionId)
    if (!batchInfo) {
      await answerCallbackQuery(token, cq.id, 'Batch expired')()
      return state
    }
    runtime.pendingBatches.delete(actionId)

    const approved = action === 'batch_approve'
    const sessionIpcDir = getSessionIpcDir(config, state, batchInfo.slotNum)

    for (const reqId of batchInfo.requestIds) {
      await writeResponse(sessionIpcDir, reqId, { approved })()
    }

    if (approved) {
      startTyping(runtime, batchInfo.slotNum)
      await trackApproval(config, state, runtime, batchInfo.sessionId, batchInfo.slotNum)
    }

    const statusText = approved
      ? `✅ Approved all (${batchInfo.requestIds.length})`
      : `❌ Denied all (${batchInfo.requestIds.length})`
    await answerCallbackQuery(token, cq.id, statusText)()
    await editMessageText(token, chatId, cq.message.message_id, statusText)()
    return state
  }

  // --- Trust session ---
  if (action === 'trust') {
    runtime.trustedSessions.add(actionId)
    console.log(`[trust] Session ${actionId.slice(0,8)} is now trusted`)
    await answerCallbackQuery(token, cq.id, '🔓 Session trusted')()
    await editMessageText(token, chatId, cq.message.message_id, '🔓 Session trusted — auto-approving future requests')()
    return state
  }

  // --- Decline trust ---
  if (action === 'no_trust') {
    await answerCallbackQuery(token, cq.id, '👀 Will keep asking')()
    await editMessageText(token, chatId, cq.message.message_id, '👀 Continuing manual review')()
    return state
  }

  // --- Single approve/deny ---
  if (action !== 'approve' && action !== 'deny') {
    await answerCallbackQuery(token, cq.id, 'Unknown action')()
    return state
  }

  const approved = action === 'approve'
  const requestId = actionId

  // Find the slot by thread ID to get session IPC dir
  const threadId = cq.message.message_thread_id
  let slotNum: number | undefined
  if (threadId) {
    slotNum = findSlotByThreadId(state, threadId)
  }

  if (slotNum !== undefined) {
    const sessionIpcDir = getSessionIpcDir(config, state, slotNum)
    console.log(`[callback] Writing permission response: slot=${slotNum}, requestId=${requestId.slice(0,8)}, approved=${approved}, dir=${sessionIpcDir}`)

    // Write permission response file
    const writeResult = await writeResponse(sessionIpcDir, requestId, {
      approved
    })()

    if (E.isLeft(writeResult)) {
      console.error(`[callback] Failed to write response: ${String(writeResult.left)}`)
    }

    if (approved) {
      startTyping(runtime, slotNum)
      // Track approval for trust threshold
      const slot = state.slots[slotNum]
      if (slot?.sessionId) {
        await trackApproval(config, state, runtime, slot.sessionId, slotNum)
      }
    }
  } else {
    console.warn(`[callback] Could not find slot for threadId=${threadId}, requestId=${requestId.slice(0,8)} — response NOT written`)
  }

  // Answer callback query (dismiss spinner)
  await answerCallbackQuery(
    token, cq.id,
    approved ? '✅ Approved' : '❌ Denied'
  )()

  // Edit original message to show decision
  const statusText = approved ? '✅ Approved' : '❌ Denied'
  await editMessageText(
    token, chatId,
    cq.message.message_id,
    `${statusText}`
  )()

  return state
}

/**
 * Poll Telegram and route updates to appropriate handlers
 */
const pollAndRouteUpdates = async (
  config: Config,
  state: State,
  runtime: DaemonRuntime
): Promise<State> => {
  // Non-blocking poll (timeout=0)
  const pollResult = await pollTelegram(config, runtime.telegramOffset, 0)()

  if (E.isLeft(pollResult)) {
    // Poll errors are transient — just skip this iteration
    return state
  }

  const { updates, nextOffset } = pollResult.right
  runtime.telegramOffset = nextOffset

  let currentState = state

  if (updates.length > 0) {
    console.log(`[poll] Got ${updates.length} Telegram updates, state.pendingStops=${JSON.stringify(Object.keys(currentState.pendingStops))}`)
  }

  for (const update of updates) {
    // Handle callback queries (button presses)
    if (update.callback_query) {
      currentState = await handleCallbackQuery(config, currentState, update, runtime)
      continue
    }

    // Handle text messages
    const msg = update.message
    if (!msg?.text || msg.chat.id !== config.telegramGroupId) continue

    const threadId = msg.message_thread_id
    if (!threadId) continue

    // Find slot by thread ID
    const slotNum = findSlotByThreadId(currentState, threadId)
    if (slotNum === undefined) continue

    currentState = await processIncomingMessage(
      config, currentState, slotNum, msg.text, runtime
    )
  }

  return currentState
}

// ============================================================================
// Orphaned slot cleanup
// ============================================================================

/**
 * Remove slots whose session no longer exists in the SQLite database.
 * This handles the case where deactivate deletes the session row but the
 * daemon's in-memory state still has the slot.
 *
 * Exported for testing.
 */
export const cleanupOrphanedSlots = async (_config: Config, state: State): Promise<State> => {
  const dbResult = getDatabase()
  if (E.isLeft(dbResult)) return state

  const sessionsResult = listActiveSessions(dbResult.right)
  if (E.isLeft(sessionsResult)) return state

  const activeSessionIds = new Set(sessionsResult.right.map(s => s.id))
  let currentState = state

  for (const [key, slot] of Object.entries(currentState.slots)) {
    if (!slot) continue
    if (!activeSessionIds.has(slot.sessionId)) {
      const slotNum = parseInt(key, 10)
      console.log(`Cleaning orphaned slot ${slotNum} (session ${slot.sessionId})`)
      currentState = removeSlot(currentState, slotNum)
    }
  }

  return currentState
}

// ============================================================================
// Daemon loop
// ============================================================================

/**
 * Run one iteration of the daemon loop
 */
const runDaemonIteration = (
  config: Config,
  state: State,
  runtime: DaemonRuntime,
  lastCleanupTime: Date,
  cleanupIntervalMs: number
): TE.TaskEither<DaemonError, { state: State; lastCleanupTime: Date }> => {
  return TE.tryCatch(
    async () => {
      // 1. Process IPC events + side effects
      const eventsResult = await processAllEvents(config, state, runtime)()
      let currentState = E.isRight(eventsResult) ? eventsResult.right : state

      // 1b. Flush expired permission batches
      await flushPermissionBatches(config, currentState, runtime)

      // Debug: log pending stops count
      const pendingCount = Object.keys(currentState.pendingStops).length
      if (pendingCount > 0) {
        console.log(`[iter] pendingStops: ${pendingCount}, slots: ${Object.keys(currentState.slots).filter(k => currentState.slots[parseInt(k,10)]).length}`)
      }

      // 2. Poll Telegram and route updates
      currentState = await pollAndRouteUpdates(config, currentState, runtime)

      // 3. Send typing indicators for active processing slots
      await updateTypingIndicators(config, currentState, runtime)

      // 4. Cleanup stale/orphaned slots periodically
      const now = new Date()
      const timeSinceCleanup = now.getTime() - lastCleanupTime.getTime()

      if (timeSinceCleanup >= cleanupIntervalMs) {
        const preCleanupSlots = new Set(
          Object.keys(currentState.slots).filter(k => currentState.slots[parseInt(k, 10)])
        )
        currentState = cleanupStaleSlots(currentState, config.sessionTimeout, now)
        currentState = await cleanupOrphanedSlots(config, currentState)

        // Stop typing for any slots removed during cleanup
        for (const key of preCleanupSlots) {
          const slotNum = parseInt(key, 10)
          if (!currentState.slots[slotNum]) {
            stopTyping(runtime, slotNum)
          }
        }
      }

      // State is persisted through individual SQLite operations;
      // no need to write state.json (saveState is a no-op in SQLite mode)

      return {
        state: currentState,
        lastCleanupTime: timeSinceCleanup >= cleanupIntervalMs ? now : lastCleanupTime
      }
    },
    (error) => {
      if (typeof error === 'object' && error !== null && '_tag' in error) {
        return error as DaemonError
      }
      return stateError(`Error in daemon iteration: ${String(error)}`, error)
    }
  )
}

// ============================================================================
// Daemon start/stop
// ============================================================================

/**
 * Start the daemon and return a stop function
 */
export const startDaemon = (configPath: string): TE.TaskEither<DaemonError, StopFunction> => {
  return TE.tryCatch(
    async () => {
      // Load config
      const configResult = loadConfig(configPath)
      if (E.isLeft(configResult)) {
        throw stateError(`Failed to load config: ${configResult.left.message}`)
      }
      const config = configResult.right

      // Open SQLite database for IPC
      const configDir = path.dirname(configPath)
      const dbPath = path.join(configDir, 'bridge.db')
      const dbResult = openDatabase(dbPath)
      if (E.isLeft(dbResult)) {
        throw stateError(`Failed to open SQLite database: ${String(dbResult.left)}`)
      }
      console.log(`SQLite database opened at ${dbPath}`)

      // Load state from SQLite (reconstructs from sessions + pending_stops tables)
      const stateResult = await loadState('')()

      let state: State = initialState
      if (E.isRight(stateResult)) {
        state = stateResult.right
      } else {
        console.warn('Failed to load state, using default:', stateResult.left)
      }

      console.log('Bridge Daemon started with config:', {
        sessionTimeout: config.sessionTimeout,
        ipcBaseDir: config.ipcBaseDir,
        configDir,
      })
      console.log('Initial slots:', Object.values(state.slots).filter(Boolean).length)

      let running = true
      let currentState = state
      let lastCleanupTime = new Date()

      const runtime: DaemonRuntime = {
        telegramOffset: 0,
        processedStopEvents: new Set(),
        typingSlots: new Map(),
        typingLastSent: new Map(),
        permissionBatches: new Map(),
        pendingBatches: new Map(),
        approvalCounts: new Map(),
        trustedSessions: new Set(),
        queuedInstructions: new Map()
      }

      // Write initial heartbeat immediately so hooks can verify startup
      const heartbeatPath = path.join(configDir, 'daemon.heartbeat')
      await fs.writeFile(heartbeatPath, String(Date.now()), 'utf-8')

      // Main loop — sequential async iterations (no overlapping)
      let iterating = false
      const loopInterval = setInterval(async () => {
        if (!running) {
          clearInterval(loopInterval)
          return
        }

        // Prevent overlapping iterations
        if (iterating) return
        iterating = true

        try {
          const result = await runDaemonIteration(
            config,
            currentState,
            runtime,
            lastCleanupTime,
            30 * 1000
          )()

          if (E.isRight(result)) {
            currentState = result.right.state
            lastCleanupTime = result.right.lastCleanupTime
          } else {
            console.error('Error in daemon iteration:', result.left)
          }

          // Write heartbeat file so hooks can verify daemon is alive
          const heartbeatPath = path.join(configDir, 'daemon.heartbeat')
          await fs.writeFile(heartbeatPath, String(Date.now()), 'utf-8').catch(() => {})
        } catch (error) {
          console.error('Unexpected error in daemon loop:', error)
        } finally {
          iterating = false
        }
      }, 1000)

      // Return stop function
      const stopFunction: StopFunction = (): TE.TaskEither<DaemonError, void> => {
        return TE.tryCatch(
          async () => {
            running = false
            clearInterval(loopInterval)

            // Close SQLite database
            closeDatabase()

            console.log('Bridge Daemon stopped gracefully')
          },
          (error) => {
            if (typeof error === 'object' && error !== null && '_tag' in error) {
              return error as DaemonError
            }
            return stateError(`Error stopping daemon: ${String(error)}`)
          }
        )
      }

      return stopFunction
    },
    (error) => {
      if (typeof error === 'object' && error !== null && '_tag' in error) {
        return error as DaemonError
      }
      return stateError(`Failed to start daemon: ${String(error)}`, error)
    }
  )
}

// ============================================================================
// CLI entry point
// ============================================================================

const main = async (): Promise<void> => {
  // Config path: CLI arg > TELEGRAM_BRIDGE_CONFIG env (directory) > ./config.json
  const configDir = process.env.TELEGRAM_BRIDGE_CONFIG
  const configPath = process.argv[2] || (configDir ? path.join(configDir, 'config.json') : './config.json')

  try {
    const result = await startDaemon(configPath)()

    if (E.isLeft(result)) {
      console.error('Failed to start daemon:', result.left)
      process.exit(1)
    }

    const stopFunction = result.right

    const handleShutdown = async (signal: string) => {
      console.log(`Received ${signal}, shutting down...`)
      const stopResult = await stopFunction()()

      if (E.isLeft(stopResult)) {
        console.error('Error during shutdown:', stopResult.left)
        process.exit(1)
      }

      process.exit(0)
    }

    process.on('SIGTERM', () => handleShutdown('SIGTERM'))
    process.on('SIGINT', () => handleShutdown('SIGINT'))

    console.log('Daemon is running. Press Ctrl+C to stop.')

    // Keep process alive
    await new Promise(() => {})
  } catch (error) {
    console.error('Fatal error:', error)
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}
