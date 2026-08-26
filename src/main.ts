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

  // Se aplican en el arranque y no desde un Job ni un init container. La imagen
  // de runtime es distroless y no tiene shell, así que un segundo punto de
  // entrada significaría un segundo manifiesto que mantener sincronizado con
  // este; el advisory lock que hay dentro de migrate() es lo que hace seguro
  // ejecutarlas en todas las réplicas.
  //
  // El compromiso es honesto: una migración que falla se lleva por delante todas
  // las réplicas. Para un esquema de este tamaño es el lado correcto del
  // compromiso, y es el tipo de cosa que conviene revisar cuando deje de serlo.
  await runMigrations(config.DATABASE_URL)
  const dispatcher = new NotificationDispatcher(
    db,
    new HttpNotifier(config.NOTIFY_URL, config.NOTIFY_TIMEOUT_MS),
    { maxAttempts: MAX_NOTIFICATION_ATTEMPTS, backoffMs: config.NOTIFY_BACKOFF_MS },
  )

  const app = await buildServer({ db, dispatcher, logLevel: config.LOG_LEVEL })
  await app.listen({ host: config.HOST, port: config.PORT })

  // Después de escuchar, no antes. La reconciliación habla con un servidor
  // externo y uno lento retrasaría la readiness — o, peor, mantendría al proceso
  // sin escuchar el tiempo suficiente para que la sonda de liveness lo matara y
  // volviera a empezar todo de nuevo.
  void reconcileMissedNotifications(db, dispatcher, app.log).catch((error: unknown) => {
    app.log.error({ err: error }, 'reconciliation of missed notifications failed')
  })

  // Kubernetes envía SIGTERM y luego espera. Terminar las peticiones que ya
  // están en curso, y las notificaciones ya iniciadas, es la diferencia entre un
  // despliegue que nadie nota y uno que descarta lo que estuviera en marcha.
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
