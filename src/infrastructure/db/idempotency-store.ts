import type { PoolClient } from 'pg'
import { DomainError, idempotencyKeyReused } from '../../domain/errors.js'
import type { IdempotencyClaim, IdempotencyStore, StoredResponse } from '../../application/ports.js'

/**
 * Makes a POST safe to send twice.
 *
 * The hard part is not the second request arriving later — it is the second
 * request arriving *at the same time*, which is exactly what a double click and
 * an automatic retry produce.
 *
 * Three things could be tried and only the third works:
 *
 *   INSERT ... ON CONFLICT DO NOTHING alone tells the loser nothing. It returns
 *   no row, and the winner's row is not committed yet, so a following SELECT
 *   does not see it either. The loser learns that it did not win and cannot find
 *   out what happened.
 *
 *   Adding SELECT ... FOR UPDATE does not rescue it, for the same reason: under
 *   READ COMMITTED an uncommitted row is not visible, so there is nothing to lock.
 *
 *   A transaction-scoped advisory lock on the key does. The second caller blocks
 *   until the first one's transaction ends, and only then looks. If the first
 *   committed, its answer is there to replay. If it rolled back, its row is gone
 *   and the second caller becomes the owner. There is no window in between and
 *   nothing spins.
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly client: PoolClient) {}

  async claim(key: string, endpoint: string, requestHash: string): Promise<IdempotencyClaim> {
    // Held until this transaction ends, so one key is processed once at a time.
    //
    // Two different keys can hash to the same value and would then queue behind
    // each other. That costs a little concurrency and no correctness, which is
    // the right side of that trade.
    await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${endpoint}:${key}`,
    ])

    const claimed = await this.client.query(
      `INSERT INTO idempotency_keys (key, endpoint, request_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (key, endpoint) DO NOTHING
       RETURNING key`,
      [key, endpoint, requestHash],
    )
    if (claimed.rowCount === 1) return { owned: true }

    const { rows } = await this.client.query(
      `SELECT request_hash, state, response_status, response_body
         FROM idempotency_keys
        WHERE key = $1 AND endpoint = $2`,
      [key, endpoint],
    )
    const row = rows[0]

    // The advisory lock was held by whoever inserted it, and their transaction
    // has ended: either the row is committed or it never existed. A missing row
    // here would mean the lock did not do its job.
    if (!row) {
      throw new DomainError(
        'INTERNAL_ERROR',
        'The idempotency key was neither claimed nor found. This should be impossible.',
      )
    }

    // A key names one request. Answering a different body with the first body's
    // response would be worse than refusing: the caller would believe something
    // happened that never did.
    if (row.request_hash !== requestHash) throw idempotencyKeyReused(key)

    if (row.state !== 'completed') {
      throw new DomainError(
        'IDEMPOTENCY_REQUEST_IN_PROGRESS',
        `An earlier request with Idempotency-Key ${key} is still being processed.`,
      )
    }

    return {
      owned: false,
      replay: { status: row.response_status, body: row.response_body },
    }
  }

  async complete(key: string, endpoint: string, response: StoredResponse): Promise<void> {
    await this.client.query(
      `UPDATE idempotency_keys
          SET state = 'completed', response_status = $3, response_body = $4
        WHERE key = $1 AND endpoint = $2`,
      [key, endpoint, response.status, JSON.stringify(response.body)],
    )
  }
}
