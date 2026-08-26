import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { inject } from 'vitest'
import { NotificationDispatcher } from '../src/application/notification-dispatcher.js'
import { reconcileMissedNotifications } from '../src/application/notification-reconciler.js'
import { createDatabase } from '../src/infrastructure/db/pool.js'
import { FakeNotifier, request, resetDatabase, startHarness, type Harness } from './harness.js'

const silent = { info: () => undefined, error: () => undefined }

/**
 * Qué ocurre con una notificación que el proceso nunca llegó a enviar.
 *
 * El estado del que parte cada prueba — una tarea archivada sin ningún intento
 * registrado — es exactamente lo que deja atrás un pod eliminado entre el commit
 * del archivado y la primera entrega. Aquí se produce archivando a través de la
 * API y eliminando después los intentos, en lugar de escribiendo filas a mano,
 * para que el resto de la tarea tenga el aspecto que la aplicación realmente le
 * da.
 */
describe('reconciliar notificaciones que el proceso nunca envió', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  })
  afterAll(() => h.close())
  beforeEach(async () => {
    await resetDatabase()
    h.notifier.reset()
  })

  const query = async (sql: string, params: unknown[] = []) => {
    const pool = new Pool({ connectionString: inject('databaseUrl') })
    try {
      return await pool.query(sql, params)
    } finally {
      await pool.end()
    }
  }

  /** Archiva una tarea y luego borra la evidencia de que alguien intentó notificar. */
  const archivedButNeverNotified = async (title = 'Lost') => {
    await request(h.app, {
      method: 'POST',
      url: '/users',
      payload: { name: 'A', lastName: 'B', email: 'a@example.com' },
    })
    const task = await request(h.app, { method: 'POST', url: '/tasks', payload: { title } })
    await request(h.app, {
      method: 'POST',
      url: `/tasks/${task.body.id}/assign`,
      payload: { userIds: [1] },
    })
    await request(h.app, {
      method: 'POST',
      url: `/tasks/${task.body.id}/complete`,
      payload: { userId: 1 },
    })
    await h.settle()

    await query('DELETE FROM notification_attempts WHERE task_id = $1', [task.body.id])
    h.notifier.reset()
    return task.body.id as number
  }

  it('entrega una notificación para una tarea archivada sin ningún intento registrado', async () => {
    const taskId = await archivedButNeverNotified('Lost in the window')

    const delivered = await reconcileMissedNotifications(h.db, h.dispatcher, silent)

    expect(delivered).toBe(1)
    expect(h.notifier.received).toHaveLength(1)
    expect(h.notifier.received[0]).toMatchObject({ taskId, title: 'Lost in the window' })

    const attempts = await request(h.app, { method: 'GET', url: `/tasks/${taskId}/notifications` })
    expect(attempts.body).toHaveLength(1)
    expect(attempts.body[0].httpStatus).toBe(200)
  })

  it('deja en paz una tarea cuyos intentos se hicieron y fallaron', async () => {
    // Tres fallos son un veredicto emitido, no una obligación perdida.
    // Reintentarlo en cada reinicio convertiría un endpoint muerto en un bucle de
    // reintentos infinito.
    const notifier = new FakeNotifier().always({ httpStatus: 503, error: 'unavailable' })
    const harness = await startHarness(notifier)
    try {
      await request(harness.app, {
        method: 'POST',
        url: '/users',
        payload: { name: 'A', lastName: 'B', email: 'failed@example.com' },
      })
      const task = await request(harness.app, {
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Tried and failed' },
      })
      await request(harness.app, {
        method: 'POST',
        url: `/tasks/${task.body.id}/assign`,
        payload: { userIds: [1] },
      })
      await request(harness.app, {
        method: 'POST',
        url: `/tasks/${task.body.id}/complete`,
        payload: { userId: 1 },
      })
      await harness.settle()
      expect(notifier.received).toHaveLength(3)

      notifier.reset()
      const delivered = await reconcileMissedNotifications(harness.db, harness.dispatcher, silent)

      expect(delivered).toBe(0)
      expect(notifier.received).toHaveLength(0)
    } finally {
      await harness.close()
    }
  })

  it('no hace nada cuando no hay nada que hacer', async () => {
    expect(await reconcileMissedNotifications(h.db, h.dispatcher, silent)).toBe(0)
    expect(h.notifier.received).toHaveLength(0)
  })

  it('notifica una sola vez cuando dos réplicas reconcilian en el mismo momento', async () => {
    // La razón por la que existe el lock. Ambos pods arrancan, ambos ven la misma
    // tarea archivada, y sin el lock ambos la anunciarían.
    const taskId = await archivedButNeverNotified('Two replicas')

    const replica = () => {
      const db = createDatabase(inject('databaseUrl'))
      const notifier = new FakeNotifier()
      const dispatcher = new NotificationDispatcher(db, notifier, { maxAttempts: 3, backoffMs: 0 })
      return { db, notifier, dispatcher }
    }

    const a = replica()
    const b = replica()
    try {
      const [sentByA, sentByB] = await Promise.all([
        reconcileMissedNotifications(a.db, a.dispatcher, silent),
        reconcileMissedNotifications(b.db, b.dispatcher, silent),
      ])

      // Una hizo el trabajo; la otra encontró el lock tomado y se retiró.
      expect(sentByA + sentByB).toBe(1)
      expect(a.notifier.received.length + b.notifier.received.length).toBe(1)

      const { rows } = await query(
        'SELECT count(*)::int AS n FROM notification_attempts WHERE task_id = $1',
        [taskId],
      )
      expect(rows[0].n).toBe(1)
    } finally {
      await a.db.close()
      await b.db.close()
    }
  })
})
