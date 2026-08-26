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
 * A destination that answers whatever a test tells it to, and remembers what it
 * was sent.
 *
 * Scripted per attempt rather than one fixed answer, because the interesting
 * cases are the ones where the answer changes: fails, fails, succeeds.
 */
export class FakeNotifier implements Notifier {
  readonly received: ArchivedTaskNotification[] = []
  private readonly scripted: NotificationOutcome[] = []
  private fallback: NotificationOutcome = { httpStatus: 200, error: null }

  /** Forgets everything. One harness serves a whole file, so state has to be
   * cleared between tests or a later test counts an earlier test's deliveries. */
  reset(): this {
    this.received.length = 0
    this.scripted.length = 0
    return this
  }

  /** Answers for attempt 1, 2, 3 … in order. */
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
  /** Waits for notifications started by requests already answered. */
  settle(): Promise<void>
  close(): Promise<void>
}

export async function startHarness(notifier = new FakeNotifier()): Promise<Harness> {
  const db = createDatabase(inject('databaseUrl'))
  const dispatcher = new NotificationDispatcher(db, notifier, {
    maxAttempts: 3,
    // Zero, so proving that three attempts happen does not cost three seconds.
    // What is under test is that they happen and are recorded, not that
    // setTimeout works.
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
 * Empties every table between tests. RESTART IDENTITY as well, so ids are
 * predictable and a test can say "user 1" instead of threading the id it just
 * created through every assertion.
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

/** Fastify's inject, with the JSON already parsed. */
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
