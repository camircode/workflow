import './infrastructure/db/types.js'
import { loadConfig, MAX_NOTIFICATION_ATTEMPTS } from './config.js'
import { NotificationDispatcher } from './application/notification-dispatcher.js'
import { reconcileMissedNotifications } from './application/notification-reconciler.js'
import { createDatabase } from './infrastructure/db/pool.js'
import { runMigrations } from './infrastructure/db/pool.js'
import { HttpNotifier } from './infrastructure/notify/http-notifier.js'
import { buildServer } from './infrastructure/http/server.js'

async function main(): Promise<void> {
  const config = loadConfig()

  const db = createDatabase(config.DATABASE_URL)

  // Applied at startup rather than from a Job or an init container. The runtime
  // image is distroless and has no shell, so a second entry point would mean a
  // second manifest to keep in step with this one; the advisory lock inside
  // migrate() is what makes running it in every replica safe.
  //
  // The trade is honest: a migration that fails takes every replica with it.
  // For a schema this size that is the right side of the trade, and it is the
  // kind of thing worth revisiting when it stops being.
  await runMigrations(config.DATABASE_URL)
  const dispatcher = new NotificationDispatcher(
    db,
    new HttpNotifier(config.NOTIFY_URL, config.NOTIFY_TIMEOUT_MS),
    { maxAttempts: MAX_NOTIFICATION_ATTEMPTS, backoffMs: config.NOTIFY_BACKOFF_MS },
  )

  const app = await buildServer({ db, dispatcher, logLevel: config.LOG_LEVEL })
  await app.listen({ host: config.HOST, port: config.PORT })

  // After listening, not before. Reconciliation talks to an external server and
  // a slow one would delay readiness — or, worse, hold the process short of
  // listening long enough for the liveness probe to kill it and start the whole
  // thing again.
  void reconcileMissedNotifications(db, dispatcher, app.log).catch((error: unknown) => {
    app.log.error({ err: error }, 'reconciliation of missed notifications failed')
  })

  // Kubernetes sends SIGTERM and then waits. Finishing the requests already in
  // flight, and the notifications already started, is the difference between a
  // deploy nobody notices and one that drops whatever was in progress.
  const shutdown = (signal: string) => {
    app.log.info({ signal }, 'shutting down')
    void (async () => {
      try {
        await app.close()
        await dispatcher.drain()
        await db.close()
      } finally {
        process.exit(0)
      }
    })()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
