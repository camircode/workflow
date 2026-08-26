import type { Database } from './ports.js'
import type { NotificationDispatcher } from './notification-dispatcher.js'

/**
 * El nombre por el que compiten ambas réplicas. Una gana y reconcilia; a la otra
 * se le dice que perdió y no hace nada.
 */
const LOCK = 'workflow:notification-reconciliation'

export interface ReconcilerLog {
  info(details: Record<string, unknown>, message: string): void
  error(details: Record<string, unknown>, message: string): void
}

/**
 * Envía las notificaciones que se debían cuando el proceso murió la última vez.
 *
 * Una tarea se archiva y su notificación se envía en ese orden, y no pueden ser
 * un único acto atómico: el archivado es una transacción de base de datos y la
 * notificación es una llamada al servidor de otro, y mantener la primera abierta
 * durante la segunda ataría un lock de fila a lo lento que sea un extraño. Así
 * que hay una ventana — corta, pero real — en la que el archivado tiene commit y
 * la obligación de notificar existe únicamente en la memoria de este proceso. Un
 * pod eliminado ahí deja una tarea archivada y a nadie avisado nunca.
 *
 * Una tarea archivada sin ningún intento registrado contra ella es exactamente
 * ese caso, y no es ambiguo: lo primero que hace la entrega es registrar un
 * intento, así que cero intentos significa que la entrega nunca empezó. Una
 * tarea cuyos tres intentos fallaron es una situación distinta con una respuesta
 * distinta, y se deja en paz deliberadamente.
 *
 * Protegida por un lock porque, de lo contrario, dos réplicas que arrancan a la
 * vez encontrarían ambas las mismas tareas y notificarían ambas — rompiendo la
 * garantía de exactamente una vez que esto existe para proteger.
 */
export async function reconcileMissedNotifications(
  db: Database,
  dispatcher: NotificationDispatcher,
  log: ReconcilerLog,
): Promise<number> {
  const delivered = await db.withAdvisoryLock(LOCK, async () => {
    const pending = await db.transaction((uow) => uow.tasks.findArchivedWithoutNotification())
    if (pending.length === 0) return 0

    log.info({ count: pending.length }, 'archived tasks were never notified; delivering now')

    let sent = 0
    for (const task of pending) {
      try {
        // Se esperan de una en una. Esto se ejecuta mientras el proceso también
        // está atendiendo peticiones, y cien llamadas salientes simultáneas en el
        // arranque son un problema peor que el que se está arreglando.
        await dispatcher.deliver(task)
        sent++
      } catch (error) {
        // Que una tarea falle no debe detener a las demás. Los intentos quedan
        // registrados en cualquier caso, así que no se pierde nada por continuar.
        log.error({ taskId: task.id, err: error }, 'could not deliver a missed notification')
      }
    }
    return sent
  })

  if (delivered === null) {
    log.info({}, 'another replica is reconciling missed notifications')
    return 0
  }
  return delivered
}
