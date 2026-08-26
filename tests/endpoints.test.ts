import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { request, resetDatabase, startHarness, type Harness } from './harness.js'

/** The behaviour each endpoint promises, including what it refuses. */
describe('endpoints', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  })
  afterAll(() => h.close())
  beforeEach(async () => {
    await resetDatabase()
    h.notifier.reset()
  })

  const post = (url: string, payload: unknown) =>
    request(h.app, { method: 'POST', url, payload: payload as object })
  const get = (url: string) => request(h.app, { method: 'GET', url })

  const user = (email: string) => post('/users', { name: 'A', lastName: 'B', email })
  const task = (title = 'T', description?: string) =>
    post('/tasks', description === undefined ? { title } : { title, description })

  describe('POST /users', () => {
    it('registers a user and returns the id with the information', async () => {
      const res = await user('ada@example.com')
      expect(res.status).toBe(201)
      expect(res.body).toMatchObject({ id: 1, name: 'A', lastName: 'B', email: 'ada@example.com' })
      expect(typeof res.body.createdAt).toBe('string')
    })

    it.each([
      ['name missing', { lastName: 'B', email: 'a@example.com' }],
      ['lastName missing', { name: 'A', email: 'a@example.com' }],
      ['email missing', { name: 'A', lastName: 'B' }],
      ['name blank', { name: '   ', lastName: 'B', email: 'a@example.com' }],
      ['email malformed', { name: 'A', lastName: 'B', email: 'not-an-email' }],
    ])('rejects a request with %s', async (_label, payload) => {
      const res = await post('/users', payload)
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(typeof res.body.error.message).toBe('string')
    })

    it('refuses an address already registered, whatever its case', async () => {
      await user('ada@example.com')
      const res = await user('ADA@EXAMPLE.COM')
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('EMAIL_ALREADY_REGISTERED')
    })
  })

  describe('POST /tasks', () => {
    it('creates a task that starts open, with the description optional', async () => {
      const res = await task('Ship it')
      expect(res.status).toBe(201)
      expect(res.body).toMatchObject({ id: 1, title: 'Ship it', description: null, status: 'open' })
    })

    it('keeps the description when one is given', async () => {
      const res = await task('Ship it', 'by Friday')
      expect(res.body.description).toBe('by Friday')
    })

    it.each([
      ['title missing', {}],
      ['title blank', { title: '  ' }],
    ])('rejects a request with %s', async (_label, payload) => {
      const res = await post('/tasks', payload)
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })
  })

  describe('POST /tasks/:idTask/assign', () => {
    it('assigns several users and reports success', async () => {
      await user('a@example.com')
      await user('b@example.com')
      const t = await task()
      const res = await post(`/tasks/${t.body.id}/assign`, { userIds: [1, 2] })
      expect(res.status).toBe(200)
      expect(res.body.message).toEqual(expect.any(String))

      const full = await get(`/tasks/${t.body.id}`)
      expect(full.body.assignees).toHaveLength(2)
    })

    it('does not duplicate a relationship that already exists', async () => {
      await user('a@example.com')
      const t = await task()
      await post(`/tasks/${t.body.id}/assign`, { userIds: [1] })
      await post(`/tasks/${t.body.id}/assign`, { userIds: [1, 1] })

      const full = await get(`/tasks/${t.body.id}`)
      expect(full.body.assignees).toHaveLength(1)
    })

    it('refuses an unknown task', async () => {
      await user('a@example.com')
      const res = await post('/tasks/999/assign', { userIds: [1] })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('TASK_NOT_FOUND')
    })

    it('refuses an unknown user, naming every missing id at once', async () => {
      await user('a@example.com')
      const t = await task()
      const res = await post(`/tasks/${t.body.id}/assign`, { userIds: [1, 42, 43] })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('USER_NOT_FOUND')
      expect(res.body.error.message).toContain('42')
      expect(res.body.error.message).toContain('43')
    })

    it('refuses an empty list', async () => {
      const t = await task()
      const res = await post(`/tasks/${t.body.id}/assign`, { userIds: [] })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /tasks/:idTask/complete', () => {
    const assigned = async () => {
      await user('a@example.com')
      await user('b@example.com')
      const t = await task('Two people')
      await post(`/tasks/${t.body.id}/assign`, { userIds: [1, 2] })
      return t.body.id as number
    }

    it("marks one user's part done without archiving the task", async () => {
      const id = await assigned()
      const res = await post(`/tasks/${id}/complete`, { userId: 1 })
      expect(res.status).toBe(200)

      const full = await get(`/tasks/${id}`)
      expect(full.body.status).toBe('open')
      expect(full.body.assignees.find((a: { userId: number }) => a.userId === 1).completed).toBe(true)
      expect(full.body.assignees.find((a: { userId: number }) => a.userId === 2).completed).toBe(false)
    })

    it('archives and notifies once the last part is done', async () => {
      const id = await assigned()
      await post(`/tasks/${id}/complete`, { userId: 1 })
      await post(`/tasks/${id}/complete`, { userId: 2 })
      await h.settle()

      const full = await get(`/tasks/${id}`)
      expect(full.body.status).toBe('archived')
      expect(full.body.archivedAt).not.toBeNull()
      expect(h.notifier.received).toHaveLength(1)
      expect(h.notifier.received[0]).toMatchObject({ taskId: id, title: 'Two people' })
      expect(typeof h.notifier.received[0]!.archivedAt).toBe('string')
    })

    it('refuses an unknown task', async () => {
      await user('a@example.com')
      const res = await post('/tasks/999/complete', { userId: 1 })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('TASK_NOT_FOUND')
    })

    it('refuses an unknown user', async () => {
      const t = await task()
      const res = await post(`/tasks/${t.body.id}/complete`, { userId: 999 })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('USER_NOT_FOUND')
    })

    it('refuses a user who is not assigned to the task', async () => {
      await user('a@example.com')
      const t = await task()
      const res = await post(`/tasks/${t.body.id}/complete`, { userId: 1 })
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('USER_NOT_ASSIGNED')
    })

    it('is a no-op the second time the same user completes', async () => {
      const id = await assigned()
      await post(`/tasks/${id}/complete`, { userId: 1 })
      const again = await post(`/tasks/${id}/complete`, { userId: 1 })
      await h.settle()

      expect(again.status).toBe(200)
      const full = await get(`/tasks/${id}`)
      expect(full.body.status).toBe('open')
      expect(h.notifier.received).toHaveLength(0)
    })
  })

  describe('GET /tasks', () => {
    it('lists every task with who has completed their part', async () => {
      await user('a@example.com')
      const t = await task('With people')
      await post(`/tasks/${t.body.id}/assign`, { userIds: [1] })

      const res = await get('/tasks')
      expect(res.status).toBe(200)
      expect(res.body).toHaveLength(1)
      expect(res.body[0].assignees[0]).toMatchObject({ userId: 1, completed: false })
    })

    it('filters by status', async () => {
      await user('a@example.com')
      const open = await task('Still open')
      const done = await task('Will archive')
      await post(`/tasks/${done.body.id}/assign`, { userIds: [1] })
      await post(`/tasks/${done.body.id}/complete`, { userId: 1 })
      await h.settle()

      const archived = await get('/tasks?status=archived')
      expect(archived.body.map((t: { id: number }) => t.id)).toEqual([done.body.id])

      const stillOpen = await get('/tasks?status=open')
      expect(stillOpen.body.map((t: { id: number }) => t.id)).toEqual([open.body.id])
    })

    it('rejects a status that is not one of the two', async () => {
      const res = await get('/tasks?status=pending')
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })
  })

  describe('GET /users', () => {
    it('lists users with the tasks they still owe', async () => {
      await user('a@example.com')
      const t = await task('Owed')
      await post(`/tasks/${t.body.id}/assign`, { userIds: [1] })

      const res = await get('/users')
      expect(res.status).toBe(200)
      expect(res.body[0].pendingTasks).toEqual([{ id: t.body.id, title: 'Owed', status: 'open' }])
    })

    it('stops listing a task as pending once the user has finished it', async () => {
      await user('a@example.com')
      const t = await task('Owed')
      await post(`/tasks/${t.body.id}/assign`, { userIds: [1] })
      await post(`/tasks/${t.body.id}/complete`, { userId: 1 })
      await h.settle()

      const res = await get('/users')
      expect(res.body[0].pendingTasks).toEqual([])
    })
  })

  describe('GET /users/:idUser/tasks', () => {
    it("lists the user's tasks and whether their part is done", async () => {
      await user('a@example.com')
      const one = await task('Done')
      const two = await task('Not done')
      await post(`/tasks/${one.body.id}/assign`, { userIds: [1] })
      await post(`/tasks/${two.body.id}/assign`, { userIds: [1] })
      await post(`/tasks/${one.body.id}/complete`, { userId: 1 })
      await h.settle()

      const res = await get('/users/1/tasks')
      expect(res.status).toBe(200)
      expect(res.body).toHaveLength(2)
      expect(res.body.find((t: { id: number }) => t.id === one.body.id).completed).toBe(true)
      expect(res.body.find((t: { id: number }) => t.id === two.body.id).completed).toBe(false)
    })

    it('answers 404 for a user who does not exist, rather than an empty list', async () => {
      const res = await get('/users/999/tasks')
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('USER_NOT_FOUND')
    })
  })

  describe('GET /tasks/:idTask', () => {
    it('returns the whole task with its assignees', async () => {
      await user('a@example.com')
      const t = await task('Detailed', 'with a description')
      await post(`/tasks/${t.body.id}/assign`, { userIds: [1] })

      const res = await get(`/tasks/${t.body.id}`)
      expect(res.body).toMatchObject({
        id: t.body.id,
        title: 'Detailed',
        description: 'with a description',
        status: 'open',
      })
      expect(res.body.assignees[0]).toMatchObject({ userId: 1, email: 'a@example.com', completed: false })
    })

    it('answers 404 for a task that does not exist', async () => {
      const res = await get('/tasks/999')
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('TASK_NOT_FOUND')
    })
  })

  describe('GET /tasks/:idTask/notifications', () => {
    it('is empty for a task that has not been archived', async () => {
      const t = await task()
      const res = await get(`/tasks/${t.body.id}/notifications`)
      expect(res.status).toBe(200)
      expect(res.body).toEqual([])
    })

    it('answers 404 for a task that does not exist', async () => {
      const res = await get('/tasks/999/notifications')
      expect(res.status).toBe(404)
    })
  })

  describe('the error shape', () => {
    it('is the same for every failure', async () => {
      const responses = [
        await get('/tasks/999'),
        await get('/users/999/tasks'),
        await post('/tasks', {}),
        await get('/nothing-here'),
      ]
      for (const res of responses) {
        expect(res.body).toHaveProperty('error.code')
        expect(res.body).toHaveProperty('error.message')
        expect(Object.keys(res.body)).toEqual(['error'])
      }
    })
  })

  describe('the generated OpenAPI document', () => {
    it('describes every endpoint from the same schemas that validate them', async () => {
      const res = await get('/openapi.json')
      expect(res.status).toBe(200)
      expect(res.body.openapi).toBe('3.1.0')
      for (const path of [
        '/users',
        '/users/{idUser}/tasks',
        '/tasks',
        '/tasks/{idTask}',
        '/tasks/{idTask}/assign',
        '/tasks/{idTask}/complete',
        '/tasks/{idTask}/notifications',
      ]) {
        expect(Object.keys(res.body.paths)).toContain(path)
      }
    })

    it('documents the Idempotency-Key header on every POST', async () => {
      const res = await get('/openapi.json')
      const posts = Object.values(res.body.paths as Record<string, Record<string, any>>)
        .flatMap((ops) => (ops['post'] ? [ops['post']] : []))
      expect(posts.length).toBeGreaterThan(0)
      for (const op of posts) {
        const names = (op.parameters ?? []).map((p: { name: string }) => p.name)
        expect(names).toContain('idempotency-key')
      }
    })
  })
})
