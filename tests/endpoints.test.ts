import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { request, resetDatabase, startHarness, type Harness } from './harness.js'

/** El comportamiento que promete cada endpoint, incluido lo que rechaza. */
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
    it('registra un usuario y devuelve el id junto con la información', async () => {
      const res = await user('ada@example.com')
      expect(res.status).toBe(201)
      expect(res.body).toMatchObject({ id: 1, name: 'A', lastName: 'B', email: 'ada@example.com' })
      expect(typeof res.body.createdAt).toBe('string')
    })

    it.each([
      ['name ausente', { lastName: 'B', email: 'a@example.com' }],
      ['lastName ausente', { name: 'A', email: 'a@example.com' }],
      ['email ausente', { name: 'A', lastName: 'B' }],
      ['name en blanco', { name: '   ', lastName: 'B', email: 'a@example.com' }],
      ['email malformado', { name: 'A', lastName: 'B', email: 'not-an-email' }],
    ])('rechaza una petición con %s', async (_label, payload) => {
      const res = await post('/users', payload)
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(typeof res.body.error.message).toBe('string')
    })

    it('rechaza una dirección ya registrada, sea cual sea su capitalización', async () => {
      await user('ada@example.com')
      const res = await user('ADA@EXAMPLE.COM')
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('EMAIL_ALREADY_REGISTERED')
    })
  })

  describe('POST /tasks', () => {
    it('crea una tarea que empieza abierta, con la descripción opcional', async () => {
      const res = await task('Ship it')
      expect(res.status).toBe(201)
      expect(res.body).toMatchObject({ id: 1, title: 'Ship it', description: null, status: 'open' })
    })

    it('conserva la descripción cuando se proporciona una', async () => {
      const res = await task('Ship it', 'by Friday')
      expect(res.body.description).toBe('by Friday')
    })

    it.each([
      ['title ausente', {}],
      ['title en blanco', { title: '  ' }],
    ])('rechaza una petición con %s', async (_label, payload) => {
      const res = await post('/tasks', payload)
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })
  })

  describe('POST /tasks/:idTask/assign', () => {
    it('asigna varios usuarios e informa del éxito', async () => {
      await user('a@example.com')
      await user('b@example.com')
      const t = await task()
      const res = await post(`/tasks/${t.body.id}/assign`, { userIds: [1, 2] })
      expect(res.status).toBe(200)
      expect(res.body.message).toEqual(expect.any(String))

      const full = await get(`/tasks/${t.body.id}`)
      expect(full.body.assignees).toHaveLength(2)
    })

    it('no duplica una relación que ya existe', async () => {
      await user('a@example.com')
      const t = await task()
      await post(`/tasks/${t.body.id}/assign`, { userIds: [1] })
      await post(`/tasks/${t.body.id}/assign`, { userIds: [1, 1] })

      const full = await get(`/tasks/${t.body.id}`)
      expect(full.body.assignees).toHaveLength(1)
    })

    it('rechaza una tarea desconocida', async () => {
      await user('a@example.com')
      const res = await post('/tasks/999/assign', { userIds: [1] })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('TASK_NOT_FOUND')
    })

    it('rechaza un usuario desconocido, nombrando todos los id ausentes de una vez', async () => {
      await user('a@example.com')
      const t = await task()
      const res = await post(`/tasks/${t.body.id}/assign`, { userIds: [1, 42, 43] })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('USER_NOT_FOUND')
      expect(res.body.error.message).toContain('42')
      expect(res.body.error.message).toContain('43')
    })

    it('rechaza una lista vacía', async () => {
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

    it('marca la parte de un usuario como hecha sin archivar la tarea', async () => {
      const id = await assigned()
      const res = await post(`/tasks/${id}/complete`, { userId: 1 })
      expect(res.status).toBe(200)

      const full = await get(`/tasks/${id}`)
      expect(full.body.status).toBe('open')
      expect(full.body.assignees.find((a: { userId: number }) => a.userId === 1).completed).toBe(true)
      expect(full.body.assignees.find((a: { userId: number }) => a.userId === 2).completed).toBe(false)
    })

    it('archiva y notifica en cuanto la última parte está hecha', async () => {
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

    it('rechaza una tarea desconocida', async () => {
      await user('a@example.com')
      const res = await post('/tasks/999/complete', { userId: 1 })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('TASK_NOT_FOUND')
    })

    it('rechaza un usuario desconocido', async () => {
      const t = await task()
      const res = await post(`/tasks/${t.body.id}/complete`, { userId: 999 })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('USER_NOT_FOUND')
    })

    it('rechaza a un usuario que no está asignado a la tarea', async () => {
      await user('a@example.com')
      const t = await task()
      const res = await post(`/tasks/${t.body.id}/complete`, { userId: 1 })
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('USER_NOT_ASSIGNED')
    })

    it('no hace nada la segunda vez que el mismo usuario completa', async () => {
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
    it('lista todas las tareas indicando quién ha completado su parte', async () => {
      await user('a@example.com')
      const t = await task('With people')
      await post(`/tasks/${t.body.id}/assign`, { userIds: [1] })

      const res = await get('/tasks')
      expect(res.status).toBe(200)
      expect(res.body).toHaveLength(1)
      expect(res.body[0].assignees[0]).toMatchObject({ userId: 1, completed: false })
    })

    it('filtra por estado', async () => {
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

    it('rechaza un estado que no es ninguno de los dos', async () => {
      const res = await get('/tasks?status=pending')
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })
  })

  describe('GET /users', () => {
    it('lista los usuarios con las tareas que todavía deben', async () => {
      await user('a@example.com')
      const t = await task('Owed')
      await post(`/tasks/${t.body.id}/assign`, { userIds: [1] })

      const res = await get('/users')
      expect(res.status).toBe(200)
      expect(res.body[0].pendingTasks).toEqual([{ id: t.body.id, title: 'Owed', status: 'open' }])
    })

    it('deja de listar una tarea como pendiente en cuanto el usuario la ha terminado', async () => {
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
    it('lista las tareas del usuario y si su parte está hecha', async () => {
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

    it('responde 404 para un usuario que no existe, en lugar de una lista vacía', async () => {
      const res = await get('/users/999/tasks')
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('USER_NOT_FOUND')
    })
  })

  describe('GET /tasks/:idTask', () => {
    it('devuelve la tarea completa con sus personas asignadas', async () => {
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

    it('responde 404 para una tarea que no existe', async () => {
      const res = await get('/tasks/999')
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('TASK_NOT_FOUND')
    })
  })

  describe('GET /tasks/:idTask/notifications', () => {
    it('está vacío para una tarea que no ha sido archivada', async () => {
      const t = await task()
      const res = await get(`/tasks/${t.body.id}/notifications`)
      expect(res.status).toBe(200)
      expect(res.body).toEqual([])
    })

    it('responde 404 para una tarea que no existe', async () => {
      const res = await get('/tasks/999/notifications')
      expect(res.status).toBe(404)
    })
  })

  describe('la forma del error', () => {
    it('es la misma para todos los fallos', async () => {
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

  describe('el documento OpenAPI generado', () => {
    it('describe todos los endpoints a partir de los mismos esquemas que los validan', async () => {
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

    it('documenta la cabecera Idempotency-Key en todos los POST', async () => {
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
