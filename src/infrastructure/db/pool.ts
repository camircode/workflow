import { Pool, type PoolClient } from 'pg'
import type { Database, UnitOfWork } from '../../application/ports.js'
import { migrate } from './migrate.js'
import { PostgresIdempotencyStore } from './idempotency-store.js'
import { PostgresTaskRepository } from './task-repository.js'
import { PostgresUserRepository } from './user-repository.js'

/**
 * Postgres returns bigint as a string, because a 64-bit integer does not fit in
 * a JavaScript number. Every id in this schema is a bigint and every one of them
 * is far below 2^53, so they are read as numbers — deliberately, and only
 * because the alternative is an API whose ids are strings for a reason no
 * consumer can see.
 */
const BIGINT_OID = 20

export function createDatabase(connectionString: string): Database {
  const pool = new Pool({ connectionString })

  return {
    async transaction<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
      const client: PoolClient = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await fn(unitOfWork(client))
        await client.query('COMMIT')
        return result
      } catch (error) {
        // Best effort: if the connection itself is what failed, the rollback
        // fails too, and the original error is the one worth reporting.
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },

    async withAdvisoryLock<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
      const client = await pool.connect()
      try {
        const { rows } = await client.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
          [name],
        )
        if (!rows[0]?.acquired) return null

        try {
          return await fn()
        } finally {
          await client
            .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [name])
            .catch(() => undefined)
        }
      } finally {
        // Releasing the connection would drop the lock with it, so this happens
        // only after the unlock above.
        client.release()
      }
    },

    close: () => pool.end(),
  }
}

const unitOfWork = (client: PoolClient): UnitOfWork => ({
  users: new PostgresUserRepository(client),
  tasks: new PostgresTaskRepository(client),
  idempotency: new PostgresIdempotencyStore(client),
})

/** Applies pending migrations on a connection of its own, then closes it. */
export async function runMigrations(connectionString: string): Promise<string[]> {
  const pool = new Pool({ connectionString })
  const client = await pool.connect()
  try {
    return await migrate(client)
  } finally {
    client.release()
    await pool.end()
  }
}

export { BIGINT_OID }
