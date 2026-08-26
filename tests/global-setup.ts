import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Pool } from 'pg'
import type { TestProject } from 'vitest/node'
import { migrate } from '../src/infrastructure/db/migrate.js'

/**
 * Un PostgreSQL real, arrancado una sola vez para toda la ejecución.
 *
 * Ni un mock ni SQLite. Todo lo que este proyecto promete sobre comportarse
 * correctamente bajo peticiones concurrentes lo impone PostgreSQL — locks de
 * fila, advisory locks, un UPDATE condicional que solo una transacción puede
 * ganar. Un doble daría la razón a cada una de esas afirmaciones sin probar
 * ninguna de ellas.
 */
let container: StartedPostgreSqlContainer

export default async function setup(project: TestProject) {
  container = await new PostgreSqlContainer('postgres:17-alpine').start()
  const url = container.getConnectionUri()

  // Se migra aquí y no por archivo, para que las pruebas ejerciten el mismo
  // esquema que produce el ejecutor de migraciones — y no una segunda definición
  // mantenida junto a él.
  const pool = new Pool({ connectionString: url })
  const client = await pool.connect()
  try {
    await migrate(client)
  } finally {
    client.release()
    await pool.end()
  }

  project.provide('databaseUrl', url)

  return async () => {
    await container.stop()
  }
}
