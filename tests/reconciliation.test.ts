import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { inject } from 'vitest'
import { NotificationDispatcher } from '../src/application/notification-dispatcher.js'
import { reconcileMissedNotifications } from '../src/application/notification-reconciler.js'
import { createDatabase } from '../src/infrastructure/db/pool.js'
import { FakeNotifier, request, resetDatabase, startHarness, type Harness } from './harness.js'

const silent = { info: () => undefined, error: () => undefined }

/**
 * What happens to a notification the process never got to send.
 *
 * The state each test starts from — a task archived with no attempt recorded —
 * is exactly what a pod killed between the archiving commit and the first
 * delivery leaves behind. It is produced here by archiving through the API and
 * then removing the attempts, rather than by writing rows by hand, so the rest
 * of the task looks the way the application actually makes it look.
 */
describe('reconciling notifications the process never sent', () => {
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

  /** Archives a task, then erases the evidence that anyone tried to notify. */
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

  it('delivers a notification for a task archived with no attempt recorded', async () => {
    const taskId = await archivedButNeverNotified('Lost in the window')

    const delivered = await reconcileMissedNotifications(h.db, h.dispatcher, silent)

    expect(delivered).toBe(1)
    expect(h.notifier.received).toHaveLength(1)
    expect(h.notifier.received[0]).toMatchObject({ taskId, title: 'Lost in the window' })

    const attempts = await request(h.app, { method: 'GET', url: `/tasks/${taskId}/notifications` })
    expect(attempts.body).toHaveLength(1)
    expect(attempts.body[0].httpStatus).toBe(200)
  })

  it('leaves alone a task whose attempts were made and failed', async () => {
    // Three failures is a delivered verdict, not a lost obligation. Retrying it
    // at every restart would turn a dead endpoint into an infinite retry loop.
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

  it('does nothing when there is nothing to do', async () => {
    expect(await reconcileMissedNotifications(h.db, h.dispatcher, silent)).toBe(0)
    expect(h.notifier.received).toHaveLength(0)
  })

  it('notifies once when two replicas reconcile at the same moment', async () => {
    // The reason the lock exists. Both pods boot, both see the same archived
    // task, and without the lock both would announce it.
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

      // One did the work; the other found the lock taken and stood down.
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
