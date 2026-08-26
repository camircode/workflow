import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Pool } from 'pg'
import type { TestProject } from 'vitest/node'
import { migrate } from '../src/infrastructure/db/migrate.js'

/**
 * A real PostgreSQL, started once for the whole run.
 *
 * Not a mock and not SQLite. Everything this project promises about behaving
 * correctly under concurrent requests is enforced by PostgreSQL — row locks,
 * advisory locks, a conditional UPDATE that only one transaction can win. A
 * fake would agree with every one of those claims without testing any of them.
 */
let container: StartedPostgreSqlContainer

export default async function setup(project: TestProject) {
  container = await new PostgreSqlContainer('postgres:17-alpine').start()
  const url = container.getConnectionUri()

  // Migrated here rather than per file, so the tests exercise the same schema
  // the migration runner produces — not a second definition kept beside it.
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
