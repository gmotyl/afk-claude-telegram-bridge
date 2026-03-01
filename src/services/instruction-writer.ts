import * as TE from 'fp-ts/TaskEither'
import * as fs from 'fs/promises'
import * as path from 'path'
import { randomBytes } from 'crypto'

export interface InstructionWriterError {
  readonly _tag: 'InstructionWriterError'
  readonly message: string
}

export const instructionWriterError = (msg: string): InstructionWriterError => ({
  _tag: 'InstructionWriterError',
  message: msg
})

/**
 * Write an instruction to the IPC directory
 * Creates a file: ipc/instruction.{slot}.{uuid}.txt
 */
export const writeInstruction = (
  ipcBaseDir: string,
  slotNum: number,
  instructionText: string
): TE.TaskEither<InstructionWriterError, string> => {
  return TE.tryCatch(
    async () => {
      const randomId = randomBytes(8).toString('hex')
      const filename = `instruction.S${slotNum}.${randomId}.txt`
      const filePath = path.join(ipcBaseDir, filename)

      // Ensure directory exists
      await fs.mkdir(ipcBaseDir, { recursive: true })

      // Write instruction file
      await fs.writeFile(filePath, instructionText, 'utf8')

      return filePath
    },
    (error) =>
      instructionWriterError(
        `Failed to write instruction: ${error instanceof Error ? error.message : String(error)}`
      )
  )
}
