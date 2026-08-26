import { createHash } from 'node:crypto'
import type { Database, UnitOfWork } from '../../application/ports.js'

export const IDEMPOTENCY_HEADER = 'idempotency-key'

export interface Executed<T> {
  body: T
  /**
   * Runs once, after the transaction commits, and only for the caller that
   * actually performed the operation. A replay never triggers it.
   *
   * This is where the notification goes. Sending it inside the transaction would
   * tie a row lock to how long somebody else's server takes to answer; sending it
   * before the commit would mean announcing something that might still roll back.
   */
  afterCommit?: () => void
}

export interface HttpResult<T, S extends number> {
  status: S
  body: T
}

/**
 * Canonical JSON, so that two requests differing only in key order hash the same.
 *
 * The body hashed here is the one Zod has already parsed, so it is also
 * normalised — a title sent with surrounding spaces and the same title without
 * them are one request, which is what a caller retrying after a double click
 * means by "the same request".
 */
function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`)
  return `{${entries.join(',')}}`
}

const hashOf = (body: unknown): string =>
  createHash('sha256').update(canonicalise(body)).digest('hex')

/**
 * Runs a write once per Idempotency-Key, even when the same key arrives twice at
 * the same moment.
 *
 * Without a key the operation simply runs — the header is offered, not demanded,
 * because requiring it would break every caller that has no retry problem.
 */
export async function runIdempotent<T, S extends number>(
  db: Database,
  key: string | undefined,
  endpoint: string,
  body: unknown,
  status: S,
  operation: (uow: UnitOfWork) => Promise<Executed<T>>,
): Promise<HttpResult<T, S>> {
  if (key === undefined || key === '') {
    const executed = await db.transaction(operation)
    executed.afterCommit?.()
    return { status, body: executed.body }
  }

  const requestHash = hashOf(body)

  const outcome = await db.transaction(async (uow) => {
    const claim = await uow.idempotency.claim(key, endpoint, requestHash)
    if (!claim.owned) return { replay: claim.replay } as const

    const executed = await operation(uow)
    // Stored inside the same transaction as the work itself: if the work rolls
    // back there is no answer to replay, and the key is free again.
    await uow.idempotency.complete(key, endpoint, { status, body: executed.body })
    return { executed } as const
  })

  if ('replay' in outcome && outcome.replay) {
    // The stored response is the one this same handler wrote, with this same
    // status, and JSONB round-trips it unchanged. The cast asserts exactly that
    // and nothing wider — it is the only place the type system cannot follow the
    // value through the database and back.
    return {
      status: outcome.replay.status as S,
      body: outcome.replay.body as T,
    }
  }
  if ('executed' in outcome) {
    outcome.executed.afterCommit?.()
    return { status, body: outcome.executed.body }
  }
  // claim() only returns owned:false with a replay, or throws.
  throw new Error('Idempotent operation produced neither a result nor a replay.')
}
