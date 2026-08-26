import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod'
import type { NotificationDispatcher } from '../../application/notification-dispatcher.js'
import type { Database } from '../../application/ports.js'
import { registerErrorHandler } from './errors.js'
import { usersRoutes } from './routes/users.js'
import { tasksRoutes } from './routes/tasks.js'

export interface ServerDeps {
  db: Database
  dispatcher: NotificationDispatcher
  logLevel?: string
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: deps.logLevel ?? 'info' },
    // Behind a Gateway that terminates TLS, so the client address and protocol
    // arrive in headers. Without this every log line records the proxy.
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>()

  // The same Zod schemas validate requests and describe the API. There is no
  // second document to keep in step, because there is no second document.
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  registerErrorHandler(app)

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Workflow API',
        version: '1.0.0',
        description:
          'Work management for teams: tasks are assigned to several people, each ' +
          'marks their own part done, and the task archives itself — exactly once — ' +
          'when the last one finishes.\n\n' +
          'Every POST accepts an `Idempotency-Key` header. Sending the same key with ' +
          'the same body twice performs the operation once and answers identically ' +
          'both times, including when the two requests arrive together.',
      },
      tags: [
        { name: 'users', description: 'People who can be assigned work' },
        { name: 'tasks', description: 'Work, who owes it, and what happened when it finished' },
        { name: 'health', description: 'Liveness and readiness' },
      ],
    },
    transform: jsonSchemaTransform,
    // Named models under components/schemas rather than the same object inlined
    // at a dozen call sites. It reads the ids the schemas registered through
    // .meta({ id }), so naming a model and publishing it are one act.
    transformObject: jsonSchemaTransformObject,
  })

  // The document itself, at a stable path. /docs is for a person; this is for
  // anything that generates a client.
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger())

  await app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  })

  // Liveness: is this process wedged. Deliberately touches nothing else — a
  // container killed because its database is slow does not help anybody, and
  // restarting it makes the database slower.
  app.get('/health', { schema: { tags: ['health'], summary: 'Liveness' } }, async () => ({
    status: 'ok',
  }))

  // Readiness: can this pod serve a request right now. It cannot without the
  // database, so this is the one that asks.
  app.get('/ready', { schema: { tags: ['health'], summary: 'Readiness' } }, async (_req, reply) => {
    try {
      await deps.db.transaction(async () => undefined)
      return { status: 'ready' }
    } catch {
      return reply.status(503).send({ status: 'not ready' })
    }
  })

  await app.register(usersRoutes(deps.db))
  await app.register(tasksRoutes(deps.db, deps.dispatcher))

  return app
}
