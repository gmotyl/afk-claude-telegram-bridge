// src/hook/__tests__/args.test.ts
import * as E from 'fp-ts/Either'
import * as args from '../args'

describe('Hook Argument Parser', () => {
  describe('parseHookArgs', () => {
    describe('valid permission_request', () => {
      it('parses permission_request with tool and command', () => {
        const result = args.parseHookArgs(['permission_request', 'Bash', 'npm install'])
        expect(E.isRight(result)).toBe(true)

        if (E.isRight(result)) {
          expect((result as any).right).toEqual({
            type: 'permission_request',
            tool: 'Bash',
            command: 'npm install',
          })
        }
      })

      it('parses permission_request with multi-word command', () => {
        const result = args.parseHookArgs(['permission_request', 'Node', 'node --version && npm list'])
        expect(E.isRight(result)).toBe(true)

        if (E.isRight(result)) {
          const hookArgs = (result as any).right
          expect(hookArgs.type).toBe('permission_request')
          expect(hookArgs.tool).toBe('Node')
          expect(hookArgs.command).toBe('node --version && npm list')
        }
      })
    })

    describe('valid stop', () => {
      it('parses stop with no additional arguments', () => {
        const result = args.parseHookArgs(['stop'])
        expect(E.isRight(result)).toBe(true)

        if (E.isRight(result)) {
          expect((result as any).right).toEqual({
            type: 'stop',
          })
        }
      })

      it('ignores extra arguments after stop', () => {
        const result = args.parseHookArgs(['stop', 'extra', 'args'])
        expect(E.isRight(result)).toBe(true)

        if (E.isRight(result)) {
          const hookArgs = (result as any).right
          expect(hookArgs.type).toBe('stop')
          expect(hookArgs.tool).toBeUndefined()
          expect(hookArgs.command).toBeUndefined()
          expect(hookArgs.message).toBeUndefined()
        }
      })
    })

    describe('valid notification', () => {
      it('parses notification with message', () => {
        const result = args.parseHookArgs(['notification', 'Task completed'])
        expect(E.isRight(result)).toBe(true)

        if (E.isRight(result)) {
          expect((result as any).right).toEqual({
            type: 'notification',
            message: 'Task completed',
          })
        }
      })

      it('parses notification with multi-word message', () => {
        const result = args.parseHookArgs(['notification', 'Build failed with error: timeout'])
        expect(E.isRight(result)).toBe(true)

        if (E.isRight(result)) {
          const hookArgs = (result as any).right
          expect(hookArgs.type).toBe('notification')
          expect(hookArgs.message).toBe('Build failed with error: timeout')
        }
      })
    })

    describe('error cases', () => {
      it('returns Left for no arguments', () => {
        const result = args.parseHookArgs([])
        expect(E.isLeft(result)).toBe(true)

        if (E.isLeft(result)) {
          expect((result as any).left._tag).toBe('HookParseError')
        }
      })

      it('returns Left for invalid hook type', () => {
        const result = args.parseHookArgs(['invalid_type'])
        expect(E.isLeft(result)).toBe(true)

        if (E.isLeft(result)) {
          expect((result as any).left._tag).toBe('HookParseError')
        }
      })

      it('returns Left for permission_request without tool', () => {
        const result = args.parseHookArgs(['permission_request'])
        expect(E.isLeft(result)).toBe(true)

        if (E.isLeft(result)) {
          expect((result as any).left._tag).toBe('HookParseError')
        }
      })

      it('returns Left for permission_request without command', () => {
        const result = args.parseHookArgs(['permission_request', 'Bash'])
        expect(E.isLeft(result)).toBe(true)

        if (E.isLeft(result)) {
          expect((result as any).left._tag).toBe('HookParseError')
        }
      })

      it('returns Left for notification without message', () => {
        const result = args.parseHookArgs(['notification'])
        expect(E.isLeft(result)).toBe(true)

        if (E.isLeft(result)) {
          expect((result as any).left._tag).toBe('HookParseError')
        }
      })

      it('returns Left for empty string as hook type', () => {
        const result = args.parseHookArgs([''])
        expect(E.isLeft(result)).toBe(true)
      })

      it('returns Left for empty string as tool in permission_request', () => {
        const result = args.parseHookArgs(['permission_request', '', 'npm install'])
        expect(E.isLeft(result)).toBe(true)
      })

      it('returns Left for empty string as command in permission_request', () => {
        const result = args.parseHookArgs(['permission_request', 'Bash', ''])
        expect(E.isLeft(result)).toBe(true)
      })

      it('returns Left for empty string as message in notification', () => {
        const result = args.parseHookArgs(['notification', ''])
        expect(E.isLeft(result)).toBe(true)
      })
    })

    describe('error messages', () => {
      it('includes helpful error message for missing arguments', () => {
        const result = args.parseHookArgs(['permission_request'])

        if (E.isLeft(result)) {
          const error = (result as any).left
          expect(error.message).toContain('permission_request')
          expect(error.message.toLowerCase()).toContain('argument')
        }
      })

      it('includes helpful error message for invalid hook type', () => {
        const result = args.parseHookArgs(['unknown'])

        if (E.isLeft(result)) {
          const error = (result as any).left
          expect(error.message).toContain('unknown')
          expect(error.message.toLowerCase()).toContain('hook')
        }
      })
    })

    describe('integration with Either', () => {
      it('works with fold for success case', () => {
        const result = args.parseHookArgs(['stop'])
        const message = E.fold(
          (err: any) => `Parse error: ${err.message}`,
          (ok: any) => `Hook type: ${ok.type}`
        )(result)

        expect(message).toBe('Hook type: stop')
      })

      it('works with fold for error case', () => {
        const result = args.parseHookArgs(['invalid'])
        const message = E.fold(
          (err: any) => `Parse error: ${err.message}`,
          (ok: any) => `Hook type: ${ok.type}`
        )(result)

        expect(message).toContain('Parse error')
      })
    })
  })

  describe('HookArgs type', () => {
    it('has required type field', () => {
      const hookArgs: args.HookArgs = {
        type: 'stop',
      }
      expect(hookArgs.type).toBe('stop')
    })

    it('can have optional tool field', () => {
      const hookArgs: args.HookArgs = {
        type: 'permission_request',
        tool: 'Bash',
        command: 'ls',
      }
      expect(hookArgs.tool).toBe('Bash')
    })

    it('can have optional message field', () => {
      const hookArgs: args.HookArgs = {
        type: 'notification',
        message: 'Done',
      }
      expect(hookArgs.message).toBe('Done')
    })
  })

  describe('HookType', () => {
    it('accepts permission_request', () => {
      const t: args.HookType = 'permission_request'
      expect(t).toBe('permission_request')
    })

    it('accepts stop', () => {
      const t: args.HookType = 'stop'
      expect(t).toBe('stop')
    })

    it('accepts notification', () => {
      const t: args.HookType = 'notification'
      expect(t).toBe('notification')
    })
  })
})

describe('parseStdinInput', () => {
  describe('valid Stop JSON', () => {
    it('parses Stop event with all fields', () => {
      const json = JSON.stringify({
        hook_event_name: 'Stop',
        stop_hook_active: true,
        last_assistant_message: 'Task completed successfully',
        session_id: 'sess-123',
      })
      const result = args.parseStdinInput(json)
      expect(E.isRight(result)).toBe(true)

      if (E.isRight(result)) {
        const hookArgs = (result as any).right
        expect(hookArgs.type).toBe('stop')
        expect(hookArgs.lastMessage).toBe('Task completed successfully')
        expect(hookArgs.stopHookActive).toBe(true)
        expect(hookArgs.sessionId).toBe('sess-123')
      }
    })

    it('parses Stop event with minimal fields', () => {
      const json = JSON.stringify({ hook_event_name: 'Stop' })
      const result = args.parseStdinInput(json)
      expect(E.isRight(result)).toBe(true)

      if (E.isRight(result)) {
        const hookArgs = (result as any).right
        expect(hookArgs.type).toBe('stop')
        expect(hookArgs.lastMessage).toBeUndefined()
        expect(hookArgs.stopHookActive).toBeUndefined()
      }
    })
  })

  describe('valid PreToolUse JSON', () => {
    it('parses PreToolUse with tool_name and tool_input.command', () => {
      const json = JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
      })
      const result = args.parseStdinInput(json)
      expect(E.isRight(result)).toBe(true)

      if (E.isRight(result)) {
        const hookArgs = (result as any).right
        expect(hookArgs.type).toBe('permission_request')
        expect(hookArgs.tool).toBe('Bash')
        expect(hookArgs.command).toBe('npm test')
        expect(hookArgs.toolInput).toEqual({ command: 'npm test' })
      }
    })

    it('parses PreToolUse without tool_input', () => {
      const json = JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
      })
      const result = args.parseStdinInput(json)
      expect(E.isRight(result)).toBe(true)

      if (E.isRight(result)) {
        const hookArgs = (result as any).right
        expect(hookArgs.type).toBe('permission_request')
        expect(hookArgs.tool).toBe('Read')
        expect(hookArgs.command).toBeUndefined()
        expect(hookArgs.toolInput).toBeUndefined()
      }
    })

    it('parses PreToolUse for Edit tool with file_path and old/new strings', () => {
      const json = JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: '/src/index.ts',
          old_string: 'const x = 1',
          new_string: 'const x = 2',
        },
        session_id: 'sess-edit',
      })
      const result = args.parseStdinInput(json)
      expect(E.isRight(result)).toBe(true)

      if (E.isRight(result)) {
        const hookArgs = (result as any).right
        expect(hookArgs.type).toBe('permission_request')
        expect(hookArgs.tool).toBe('Edit')
        expect(hookArgs.command).toContain('/src/index.ts')
        expect(hookArgs.command).toContain('const x = 1')
        expect(hookArgs.command).toContain('const x = 2')
      }
    })

    it('parses PreToolUse for Write tool with file_path', () => {
      const json = JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: {
          file_path: '/src/new-file.ts',
          content: 'export const foo = 42',
        },
        session_id: 'sess-write',
      })
      const result = args.parseStdinInput(json)
      expect(E.isRight(result)).toBe(true)

      if (E.isRight(result)) {
        const hookArgs = (result as any).right
        expect(hookArgs.type).toBe('permission_request')
        expect(hookArgs.tool).toBe('Write')
        expect(hookArgs.command).toContain('/src/new-file.ts')
      }
    })

    it('formats unknown tool with key-value fallback', () => {
      const json = JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'CustomTool',
        tool_input: { query: 'search term', path: '/some/dir' },
      })
      const result = args.parseStdinInput(json)
      expect(E.isRight(result)).toBe(true)

      if (E.isRight(result)) {
        const hookArgs = (result as any).right
        expect(hookArgs.command).toContain('query: search term')
        expect(hookArgs.command).toContain('path: /some/dir')
      }
    })

    it('extracts session_id from PreToolUse', () => {
      const json = JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        session_id: 'claude-sess-123',
      })
      const result = args.parseStdinInput(json)
      expect(E.isRight(result)).toBe(true)

      if (E.isRight(result)) {
        const hookArgs = (result as any).right
        expect(hookArgs.sessionId).toBe('claude-sess-123')
      }
    })
  })

  describe('valid Notification JSON', () => {
    it('parses Notification with message', () => {
      const json = JSON.stringify({
        hook_event_name: 'Notification',
        message: 'Build complete',
      })
      const result = args.parseStdinInput(json)
      expect(E.isRight(result)).toBe(true)

      if (E.isRight(result)) {
        const hookArgs = (result as any).right
        expect(hookArgs.type).toBe('notification')
        expect(hookArgs.message).toBe('Build complete')
      }
    })

    it('parses Notification without message', () => {
      const json = JSON.stringify({ hook_event_name: 'Notification' })
      const result = args.parseStdinInput(json)
      expect(E.isRight(result)).toBe(true)

      if (E.isRight(result)) {
        const hookArgs = (result as any).right
        expect(hookArgs.type).toBe('notification')
        expect(hookArgs.message).toBeUndefined()
      }
    })

    it('extracts session_id from Notification', () => {
      const json = JSON.stringify({
        hook_event_name: 'Notification',
        message: 'Done',
        session_id: 'claude-sess-456',
      })
      const result = args.parseStdinInput(json)
      expect(E.isRight(result)).toBe(true)

      if (E.isRight(result)) {
        const hookArgs = (result as any).right
        expect(hookArgs.sessionId).toBe('claude-sess-456')
      }
    })
  })

  describe('error cases', () => {
    it('returns Left for invalid JSON', () => {
      const result = args.parseStdinInput('not json at all')
      expect(E.isLeft(result)).toBe(true)

      if (E.isLeft(result)) {
        expect((result as any).left._tag).toBe('HookParseError')
        expect((result as any).left.message).toContain('Invalid JSON')
      }
    })

    it('returns Left for missing hook_event_name', () => {
      const json = JSON.stringify({ tool_name: 'Bash' })
      const result = args.parseStdinInput(json)
      expect(E.isLeft(result)).toBe(true)

      if (E.isLeft(result)) {
        expect((result as any).left._tag).toBe('HookParseError')
        expect((result as any).left.message).toContain('hook_event_name')
      }
    })

    it('returns Left for unknown hook_event_name', () => {
      const json = JSON.stringify({ hook_event_name: 'Unknown' })
      const result = args.parseStdinInput(json)
      expect(E.isLeft(result)).toBe(true)

      if (E.isLeft(result)) {
        expect((result as any).left._tag).toBe('HookParseError')
        expect((result as any).left.message).toContain('Unknown')
      }
    })

    it('returns Left for non-object JSON', () => {
      const result = args.parseStdinInput('"just a string"')
      expect(E.isLeft(result)).toBe(true)
    })

    it('returns Left for null JSON', () => {
      const result = args.parseStdinInput('null')
      expect(E.isLeft(result)).toBe(true)
    })
  })
})
