export type DbError =
  | { readonly _tag: 'ConnectionError'; readonly message: string }
  | { readonly _tag: 'QueryError'; readonly message: string; readonly query: string }
  | { readonly _tag: 'ConstraintError'; readonly constraint: string }
  | { readonly _tag: 'BusyError'; readonly retryAfterMs: number }

export const connectionError = (message: string): DbError => ({ _tag: 'ConnectionError', message })
export const queryError = (message: string, query: string): DbError => ({ _tag: 'QueryError', message, query })
export const constraintError = (constraint: string): DbError => ({ _tag: 'ConstraintError', constraint })
export const busyError = (retryAfterMs: number): DbError => ({ _tag: 'BusyError', retryAfterMs })

export const dbErrorMessage = (error: DbError): string => {
  switch (error._tag) {
    case 'ConnectionError':
      return `DB connection error: ${error.message}`
    case 'QueryError':
      return `DB query error: ${error.message} (query: ${error.query})`
    case 'ConstraintError':
      return `DB constraint violation: ${error.constraint}`
    case 'BusyError':
      return `DB busy, retry after ${error.retryAfterMs}ms`
  }
}
