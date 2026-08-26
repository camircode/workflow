import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'
import { Pool } from 'pg'
import { inject } from 'vitest'
import { NotificationDispatcher } from '../src/application/notification-dispatcher.js'
import type {
  ArchivedTaskNotification,
  Database,
  Notifier,
  NotificationOutcome,
} from '../src/application/ports.js'
import { createDatabase } from '../src/infrastructure/db/pool.js'
import { buildServer } from '../src/infrastructure/http/server.js'
import '../src/infrastructure/db/types.js'

/**
 * Un destino que responde lo que una prueba le indique, y recuerda lo que se le
 * envió.
 *
 * Guionizado por intento en lugar de una única respuesta fija, porque los casos
 * interesantes son aquellos en los que la respuesta cambia: falla, falla,
 * funciona.
 */
export class FakeNotifier implements Notifier {
  readonly received: ArchivedTaskNotification[] = []
  private readonly scripted: NotificationOutcome[] = []
  private fallback: NotificationOutcome = { httpStatus: 200, error: null }

  /** Lo olvida todo. Un mismo harness sirve a un archivo entero, así que el
   * estado tiene que limpiarse entre pruebas o una prueba posterior contará las
   * entregas de una anterior. */
  reset(): this {
    this.received.length = 0
    this.scripted.length = 0
    return this
  }

  /** Respuestas para el intento 1, 2, 3 … en orden. */
  script(...outcomes: NotificationOutcome[]): this {
    this.scripted.push(...outcomes)
    return this
  }

  always(outcome: NotificationOutcome): this {
    this.fallback = outcome
    return this
  }

  async send(payload: ArchivedTaskNotification): Promise<NotificationOutcome> {
    this.received.push(payload)
    return this.scripted.shift() ?? this.fallback
  }
}

export interface Harness {
  app: FastifyInstance
  db: Database
  notifier: FakeNotifier
  dispatcher: NotificationDispatcher
  /** Espera a las notificaciones iniciadas por peticiones ya respondidas. */
  settle(): Promise<void>
  close(): Promise<void>
}

export async function startHarness(notifier = new FakeNotifier()): Promise<Harness> {
  const db = createDatabase(inject('databaseUrl'))
  const dispatcher = new NotificationDispatcher(db, notifier, {
    maxAttempts: 3,
    // Cero, para que demostrar que ocurren tres intentos no cueste tres segundos.
    // Lo que se está probando es que ocurren y quedan registrados, no que
    // setTimeout funcione.
    backoffMs: 0,
  })
  const app = await buildServer({ db, dispatcher, logLevel: 'silent' })
  await app.ready()

  return {
    app,
    db,
    notifier,
    dispatcher,
    settle: () => dispatcher.drain(),
    close: async () => {
      await app.close()
      await dispatcher.drain()
      await db.close()
    },
  }
}

/**
 * Vacía todas las tablas entre pruebas. También RESTART IDENTITY, para que los id
 * sean predecibles y una prueba pueda decir "usuario 1" en lugar de ir pasando
 * por cada aserción el id que acaba de crear.
 */
export async function resetDatabase(): Promise<void> {
  const pool = new Pool({ connectionString: inject('databaseUrl') })
  try {
    await pool.query(
      `TRUNCATE notification_attempts, task_assignments, idempotency_keys, tasks, users
       RESTART IDENTITY CASCADE`,
    )
  } finally {
    await pool.end()
  }
}

/** El inject de Fastify, con el JSON ya parseado. */
export async function request(
  app: FastifyInstance,
  options: InjectOptions,
): Promise<{ status: number; body: any }> {
  const response: LightMyRequestResponse = await app.inject(options)
  return {
    status: response.statusCode,
    body: response.body ? JSON.parse(response.body) : undefined,
  }
}
