import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { inject } from 'vitest'
import { FakeNotifier, request, resetDatabase, startHarness, type Harness } from './harness.js'

/**
 * El contrato de fiabilidad, que es la parte de esta API que de verdad es
 * difícil.
 *
 * Todas las pruebas de aquí envían peticiones que se solapan a propósito. Una
 * batería que solo enviara una petición cada vez pasaría contra una
 * implementación que no tuviera ninguna de estas garantías.
 */
describe('fiabilidad', () => {
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

  describe('idempotencia', () => {
    it('realiza la operación una sola vez cuando la misma clave y el mismo cuerpo llegan dos veces en secuencia', async () => {
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

    it('realiza la operación una sola vez cuando la misma clave y el mismo cuerpo llegan en paralelo', async () => {
      // El caso que señala la especificación, y aquel en el que falla un
      // comprobar-y-luego-insertar ingenuo: ninguna de las dos peticiones puede
      // ver la fila de la otra, porque ninguna ha hecho commit.
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

    it('reproduce la misma respuesta para un usuario que completa, sin completar dos veces', async () => {
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
      // Un archivado significa una notificación, no dos.
      expect(h.notifier.received).toHaveLength(1)
    })

    it('rechaza una clave reutilizada con un cuerpo distinto', async () => {
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

    it('trata el mismo cuerpo con distinto orden de claves como la misma petición', async () => {
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

    it('no exige la cabecera', async () => {
      const a = await createTask('No key')
      const b = await createTask('No key')
      expect(a.status).toBe(201)
      expect(b.status).toBe(201)
      // Sin clave no hay nada contra lo que deduplicar, y fingir lo contrario
      // descartaría en silencio una segunda petición legítima.
      expect(b.body.id).not.toBe(a.body.id)
    })
  })

  describe('archivado sin duplicados', () => {
    it('archiva exactamente una vez cuando los dos últimos usuarios terminan a la vez', async () => {
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

      // A exactamente uno de los dos llamantes se le dice que archivó la tarea.
      const announced = [a, b].filter((r) => r.body.message.includes('archivada'))
      expect(announced).toHaveLength(1)

      const after = await request(h.app, { method: 'GET', url: `/tasks/${task.body.id}` })
      expect(after.body.status).toBe('archived')
      expect(after.body.archivedAt).not.toBeNull()

      expect(h.notifier.received).toHaveLength(1)
      expect(h.notifier.received[0]).toMatchObject({ taskId: task.body.id, title: 'Race' })
    })

    it('no archiva una tarea a la que no hay nadie asignado', async () => {
      // No tener partes pendientes no es lo mismo que estar terminada.
      const task = await createTask('Nobody')
      const listed = await request(h.app, { method: 'GET', url: '/tasks?status=open' })
      expect(listed.body.map((t: { id: number }) => t.id)).toContain(task.body.id)
    })

    it('archiva una sola vez cuando muchos usuarios terminan en el mismo momento', async () => {
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
      expect(results.filter((r) => r.body.message.includes('archivada'))).toHaveLength(1)
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

  describe('reintentos de notificación', () => {
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

    it('se detiene a los tres intentos cuando el destino sigue fallando', async () => {
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

    it('registra un timeout como un intento sin código de estado', async () => {
      const notifier = new FakeNotifier().always({ httpStatus: null, error: 'Sin respuesta en 5000ms.' })
      const harness = await startHarness(notifier)
      try {
        const taskId = await setUpArchivedTask(harness)
        const attempts = await request(harness.app, {
          method: 'GET',
          url: `/tasks/${taskId}/notifications`,
        })
        expect(attempts.body).toHaveLength(3)
        expect(attempts.body[0].httpStatus).toBeNull()
        expect(attempts.body[0].error).toContain('Sin respuesta')
      } finally {
        await harness.close()
      }
    })

    it('se detiene en cuanto el destino la acepta', async () => {
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

    it('no reintenta ante un 4xx, porque la respuesta no va a cambiar', async () => {
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
