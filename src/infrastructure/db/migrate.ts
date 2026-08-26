import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import './types.js'

/**
 * Aplica todas las migraciones de db/migrations que todavía no se han ejecutado,
 * en orden de nombre de archivo, cada una en su propia transacción.
 *
 * Los archivos son DDL a secas: la transacción y la contabilidad pertenecen al
 * ejecutor, de modo que una migración también se puede leer — o aplicar — por su
 * cuenta con psql.
 *
 * Serializadas sobre un advisory lock, porque el Deployment ejecuta dos réplicas
 * y ambas arrancan a la vez. Sin él compiten: una crea las tablas, la otra falla
 * sobre una relación que ya existe, y el pod entra en crash-loop hasta que el
 * planificador las secuencia por casualidad. La segunda se bloquea aquí en su
 * lugar, y luego descubre que no queda nada por aplicar.
 */

/** Cualquier constante sirve; solo tiene que ser la misma en todas las réplicas. */
const MIGRATION_LOCK = 'workflow:migrations'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', '..', 'db', 'migrations')

export async function migrate(client: PoolClient, dir = MIGRATIONS_DIR): Promise<string[]> {
  // Con alcance de sesión y bloqueante, no pg_try_advisory_lock: quien pierde
  // debe esperar y después observar el resultado, no saltárselo y empezar a
  // atender peticiones contra un esquema que todavía no está.
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
      throw new Error(`La migración ${version} falló: ${(error as Error).message}`, { cause: error })
    }
    ran.push(version)
  }
  return ran
}

/** `pnpm db:migrate` */
async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL']
  if (!connectionString) throw new Error('DATABASE_URL es obligatoria')

  const pool = new Pool({ connectionString })
  const client = await pool.connect()
  try {
    const ran = await migrate(client)
    console.log(ran.length === 0 ? 'No hay nada que aplicar.' : `Aplicadas: ${ran.join(', ')}`)
  } finally {
    client.release()
    await pool.end()
  }
}

// Solo cuando se ejecuta directamente, para que importar migrate() desde una
// prueba no abra una conexión a lo que sea que contenga DATABASE_URL.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
