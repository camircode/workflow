import type { Database } from './ports.js'
import type { NotificationDispatcher } from './notification-dispatcher.js'

/**
 * The name both replicas compete for. One wins and reconciles; the other is told
 * it lost and does nothing.
 */
const LOCK = 'workflow:notification-reconciliation'

export interface ReconcilerLog {
  info(details: Record<string, unknown>, message: string): void
  error(details: Record<string, unknown>, message: string): void
}

/**
 * Sends the notifications that were owed when the process last died.
 *
 * A task is archived and its notification is sent in that order, and they cannot
 * be one atomic act: the archive is a database transaction and the notification
 * is a call to somebody else's server, and holding the first open across the
 * second would tie a row lock to how slow a stranger is. So there is a window —
 * short, but real — in which the archive is committed and the obligation to
 * notify exists only in this process's memory. A pod killed there leaves a task
 * archived and nobody ever told.
 *
 * A task that is archived with no attempt recorded against it is exactly that
 * case, and it is unambiguous: the first thing delivery does is record an
 * attempt, so zero attempts means delivery never started. A task whose three
 * attempts all failed is a different situation with a different answer, and is
 * deliberately left alone.
 *
 * Guarded by a lock because two replicas starting together would otherwise both
 * find the same tasks and both notify — breaking the exactly-once guarantee this
 * exists to protect.
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
        // Awaited one at a time. This runs while the process is also serving
        // requests, and a hundred simultaneous outbound calls at startup is a
        // worse problem than the one being fixed.
        await dispatcher.deliver(task)
        sent++
      } catch (error) {
        // One task failing must not stop the rest. The attempts are recorded
        // either way, so nothing is lost by carrying on.
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
