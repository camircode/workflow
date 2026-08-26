import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { inject } from 'vitest'
import { FakeNotifier, request, resetDatabase, startHarness, type Harness } from './harness.js'

/**
 * The reliability contract, which is the part of this API that is actually hard.
 *
 * Every test here sends requests that overlap on purpose. A suite that only ever
 * sends one request at a time would pass against an implementation with none of
 * these guarantees.
 */
describe('reliability', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  })
  afterAll(() => h.close())
  beforeEach(async () => {
    await resetDatabase()
    h.notifier.reset()
  })

  const createUser = (email: string) =>
    request(h.app, {
      method: 'POST',
      url: '/users',
      payload: { name: 'A', lastName: 'B', email },
    })

  const createTask = (title = 'A task') =>
    request(h.app, { method: 'POST', url: '/tasks', payload: { title } })

  describe('idempotency', () => {
    it('performs the operation once when the same key and body arrive twice in sequence', async () => {
      const key = 'seq-1'
      const first = await request(h.app, {
        method: 'POST',
        url: '/tasks',
        headers: { 'idempotency-key': key },
        payload: { title: 'Only once' },
      })
      const second = await request(h.app, {
        method: 'POST',
        url: '/tasks',
        headers: { 'idempotency-key': key },
        payload: { title: 'Only once' },
      })

      expect(first.status).toBe(201)
      expect(second.status).toBe(first.status)
      expect(second.body).toEqual(first.body)

      const all = await request(h.app, { method: 'GET', url: '/tasks' })
      expect(all.body).toHaveLength(1)
    })

    it('performs the operation once when the same key and body arrive in parallel', async () => {
      // The case the specification calls out, and the one a naive
      // check-then-insert fails: neither request can see the other's row,
      // because neither has committed.
      const key = 'parallel-1'
      const send = () =>
        request(h.app, {
          method: 'POST',
          url: '/tasks',
          headers: { 'idempotency-key': key },
          payload: { title: 'Double clicked' },
        })

      const [a, b] = await Promise.all([send(), send()])

      expect(a.status).toBe(201)
      expect(b.status).toBe(201)
      expect(a.body).toEqual(b.body)

      const all = await request(h.app, { method: 'GET', url: '/tasks' })
      expect(all.body).toHaveLength(1)
    })

    it('replays the same answer for a completing user, without completing twice', async () => {
      await createUser('one@example.com')
      const task = await createTask()
      await request(h.app, {
        method: 'POST',
        url: `/tasks/${task.body.id}/assign`,
        payload: { userIds: [1] },
      })

      const key = 'complete-1'
      const send = () =>
        request(h.app, {
          method: 'POST',
          url: `/tasks/${task.body.id}/complete`,
          headers: { 'idempotency-key': key },
          payload: { userId: 1 },
        })

      const [a, b] = await Promise.all([send(), send()])
      await h.settle()

      expect(a.body).toEqual(b.body)
      // One archive means one notification, not two.
      expect(h.notifier.received).toHaveLength(1)
    })

    it('refuses a key reused with a different body', async () => {
      const key = 'reused-1'
      await request(h.app, {
        method: 'POST',
        url: '/tasks',
        headers: { 'idempotency-key': key },
        payload: { title: 'First' },
      })
      const second = await request(h.app, {
        method: 'POST',
        url: '/tasks',
        headers: { 'idempotency-key': key },
        payload: { title: 'Second' },
      })

      expect(second.status).toBe(409)
      expect(second.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    })

    it('treats the same body with different key order as the same request', async () => {
      await createUser('a@example.com')
      const key = 'order-1'
      const a = await request(h.app, {
        method: 'POST',
        url: '/tasks',
        headers: { 'idempotency-key': key },
        payload: { title: 'T', description: 'D' },
      })
      const b = await request(h.app, {
        method: 'POST',
        url: '/tasks',
        headers: { 'idempotency-key': key },
        payload: { description: 'D', title: 'T' },
      })
      expect(b.status).toBe(201)
      expect(b.body).toEqual(a.body)
    })

    it('does not require the header', async () => {
      const a = await createTask('No key')
      const b = await createTask('No key')
      expect(a.status).toBe(201)
      expect(b.status).toBe(201)
      // Without a key there is nothing to deduplicate against, and pretending
      // otherwise would silently drop a genuine second request.
      expect(b.body.id).not.toBe(a.body.id)
    })
  })

  describe('archiving without duplicates', () => {
    it('archives exactly once when the last two users finish simultaneously', async () => {
      await createUser('one@example.com')
      await createUser('two@example.com')
      const task = await createTask('Race')
      await request(h.app, {
        method: 'POST',
        url: `/tasks/${task.body.id}/assign`,
        payload: { userIds: [1, 2] },
      })

      const complete = (userId: number) =>
        request(h.app, {
          method: 'POST',
          url: `/tasks/${task.body.id}/complete`,
          payload: { userId },
        })

      const [a, b] = await Promise.all([complete(1), complete(2)])
      await h.settle()

      expect(a.status).toBe(200)
      expect(b.status).toBe(200)

      // Exactly one of the two callers is told it archived the task.
      const announced = [a, b].filter((r) => r.body.message.includes('archived'))
      expect(announced).toHaveLength(1)

      const after = await request(h.app, { method: 'GET', url: `/tasks/${task.body.id}` })
      expect(after.body.status).toBe('archived')
      expect(after.body.archivedAt).not.toBeNull()

      expect(h.notifier.received).toHaveLength(1)
      expect(h.notifier.received[0]).toMatchObject({ taskId: task.body.id, title: 'Race' })
    })

    it('does not archive a task nobody is assigned to', async () => {
      // No outstanding parts is not the same as finished.
      const task = await createTask('Nobody')
      const listed = await request(h.app, { method: 'GET', url: '/tasks?status=open' })
      expect(listed.body.map((t: { id: number }) => t.id)).toContain(task.body.id)
    })

    it('archives once when many users finish at the same moment', async () => {
      const count = 8
      for (let i = 1; i <= count; i++) await createUser(`u${i}@example.com`)
      const task = await createTask('Everyone at once')
      await request(h.app, {
        method: 'POST',
        url: `/tasks/${task.body.id}/assign`,
        payload: { userIds: Array.from({ length: count }, (_, i) => i + 1) },
      })

      const results = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          request(h.app, {
            method: 'POST',
            url: `/tasks/${task.body.id}/complete`,
            payload: { userId: i + 1 },
          }),
        ),
      )
      await h.settle()

      expect(results.every((r) => r.status === 200)).toBe(true)
      expect(results.filter((r) => r.body.message.includes('archived'))).toHaveLength(1)
      expect(h.notifier.received).toHaveLength(1)

      const pool = new Pool({ connectionString: inject('databaseUrl') })
      try {
        const { rows } = await pool.query(
          'SELECT count(*)::int AS n FROM notification_attempts WHERE task_id = $1',
          [task.body.id],
        )
        expect(rows[0].n).toBe(1)
      } finally {
        await pool.end()
      }
    })
  })

  describe('notification retries', () => {
    const setUpArchivedTask = async (harness: Harness) => {
      await request(harness.app, {
        method: 'POST',
        url: '/users',
        payload: { name: 'A', lastName: 'B', email: 'solo@example.com' },
      })
      const task = await request(harness.app, {
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Notify me' },
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
      return task.body.id as number
    }

    it('stops at three attempts when the destination keeps failing', async () => {
      const notifier = new FakeNotifier().always({ httpStatus: 503, error: 'unavailable' })
      const harness = await startHarness(notifier)
      try {
        const taskId = await setUpArchivedTask(harness)
        const attempts = await request(harness.app, {
          method: 'GET',
          url: `/tasks/${taskId}/notifications`,
        })

        expect(attempts.body).toHaveLength(3)
        expect(attempts.body.map((a: { attemptNumber: number }) => a.attemptNumber)).toEqual([1, 2, 3])
        expect(attempts.body.every((a: { httpStatus: number }) => a.httpStatus === 503)).toBe(true)
      } finally {
        await harness.close()
      }
    })

    it('records a timeout as an attempt with no status code', async () => {
      const notifier = new FakeNotifier().always({ httpStatus: null, error: 'No answer within 5000ms.' })
      const harness = await startHarness(notifier)
      try {
        const taskId = await setUpArchivedTask(harness)
        const attempts = await request(harness.app, {
          method: 'GET',
          url: `/tasks/${taskId}/notifications`,
        })
        expect(attempts.body).toHaveLength(3)
        expect(attempts.body[0].httpStatus).toBeNull()
        expect(attempts.body[0].error).toContain('No answer')
      } finally {
        await harness.close()
      }
    })

    it('stops as soon as the destination accepts it', async () => {
      const notifier = new FakeNotifier().script(
        { httpStatus: 500, error: 'boom' },
        { httpStatus: 204, error: null },
      )
      const harness = await startHarness(notifier)
      try {
        const taskId = await setUpArchivedTask(harness)
        const attempts = await request(harness.app, {
          method: 'GET',
          url: `/tasks/${taskId}/notifications`,
        })
        expect(attempts.body).toHaveLength(2)
        expect(attempts.body[1].httpStatus).toBe(204)
      } finally {
        await harness.close()
      }
    })

    it('does not retry a 4xx, because the answer will not change', async () => {
      const notifier = new FakeNotifier().always({ httpStatus: 400, error: 'bad payload' })
      const harness = await startHarness(notifier)
      try {
        const taskId = await setUpArchivedTask(harness)
        const attempts = await request(harness.app, {
          method: 'GET',
          url: `/tasks/${taskId}/notifications`,
        })
        expect(attempts.body).toHaveLength(1)
        expect(attempts.body[0].httpStatus).toBe(400)
      } finally {
        await harness.close()
      }
    })
  })
})
