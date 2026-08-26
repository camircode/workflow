import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import './types.js'

/**
 * Applies every migration in db/migrations that has not run yet, in filename
 * order, each in its own transaction.
 *
 * The files are plain DDL: the transaction and the bookkeeping belong to the
 * runner, so a migration can also be read — or applied — on its own with psql.
 *
 * Serialised on an advisory lock, because the Deployment runs two replicas and
 * both start at once. Without it they race: one creates the tables, the other
 * fails on a relation that already exists, and the pod crash-loops until the
 * scheduler happens to sequence them. The second one blocks here instead, and
 * then finds there is nothing left to apply.
 */

/** Any constant works; it only has to be the same in every replica. */
const MIGRATION_LOCK = 'workflow:migrations'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', '..', 'db', 'migrations')

export async function migrate(client: PoolClient, dir = MIGRATIONS_DIR): Promise<string[]> {
  // Session-scoped and blocking, not pg_try_advisory_lock: the loser must wait
  // and then observe the result, not skip and start serving against a schema
  // that is not there yet.
  await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [MIGRATION_LOCK])
  try {
    return await applyPending(client, dir)
  } finally {
    await client
      .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [MIGRATION_LOCK])
      .catch(() => undefined)
  }
}

async function applyPending(client: PoolClient, dir: string): Promise<string[]> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    TEXT        PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  )

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const { rows } = await client.query('SELECT version FROM schema_migrations')
  const applied = new Set(rows.map((row: { version: string }) => row.version))

  const ran: string[] = []
  for (const file of files) {
    const version = file.replace(/\.sql$/, '')
    if (applied.has(version)) continue

    const sql = await readFile(join(dir, file), 'utf8')
    await client.query('BEGIN')
    try {
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw new Error(`Migration ${version} failed: ${(error as Error).message}`, { cause: error })
    }
    ran.push(version)
  }
  return ran
}

/** `pnpm db:migrate` */
async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL']
  if (!connectionString) throw new Error('DATABASE_URL is required')

  const pool = new Pool({ connectionString })
  const client = await pool.connect()
  try {
    const ran = await migrate(client)
    console.log(ran.length === 0 ? 'Nothing to apply.' : `Applied: ${ran.join(', ')}`)
  } finally {
    client.release()
    await pool.end()
  }
}

// Only when run directly, so importing migrate() from a test does not open a
// connection to whatever DATABASE_URL happens to hold.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
