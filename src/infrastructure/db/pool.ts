import { Pool, type PoolClient } from 'pg'
import type { Database, UnitOfWork } from '../../application/ports.js'
import { migrate } from './migrate.js'
import { PostgresIdempotencyStore } from './idempotency-store.js'
import { PostgresTaskRepository } from './task-repository.js'
import { PostgresUserRepository } from './user-repository.js'

/**
 * Postgres devuelve bigint como cadena, porque un entero de 64 bits no cabe en
 * un número de JavaScript. Todos los id de este esquema son bigint y todos ellos
 * quedan muy por debajo de 2^53, así que se leen como números — deliberadamente,
 * y solo porque la alternativa es una API cuyos id son cadenas por un motivo que
 * ningún consumidor puede ver.
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
        // Se hace lo que se puede: si lo que falló es la conexión misma, el
        // rollback falla también, y el error original es el que merece
        // reportarse.
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
        // Liberar la conexión soltaría el lock con ella, así que esto ocurre
        // solo después del unlock de arriba.
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

/** Aplica las migraciones pendientes sobre una conexión propia y luego la cierra. */
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
