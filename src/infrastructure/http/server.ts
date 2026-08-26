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
import type { NotificationDispatcher } from '#application/notification-dispatcher.js'
import type { Database } from '#application/ports.js'
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
    // Detrás de un Gateway que termina TLS, así que la dirección del cliente y el
    // protocolo llegan en cabeceras. Sin esto cada línea de log registra al proxy.
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>()

  // Los mismos esquemas de Zod validan las peticiones y describen la API. No hay
  // un segundo documento que mantener sincronizado, porque no hay un segundo
  // documento.
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  registerErrorHandler(app)

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'API de Workflow',
        version: '1.0.0',
        description:
          'Gestión de trabajo para equipos: las tareas se asignan a varias personas, ' +
          'cada una marca su propia parte como hecha, y la tarea se archiva sola ' +
          '— exactamente una vez — cuando termina la última.\n\n' +
          'Todo POST acepta una cabecera `Idempotency-Key`. Enviar la misma clave con ' +
          'el mismo cuerpo dos veces realiza la operación una vez y responde de forma ' +
          'idéntica ambas veces, incluso cuando las dos peticiones llegan a la vez.',
      },
      tags: [
        { name: 'users', description: 'Personas a las que se puede asignar trabajo' },
        { name: 'tasks', description: 'El trabajo, quién lo debe y qué ocurrió cuando terminó' },
        { name: 'health', description: 'Liveness y readiness' },
      ],
    },
    transform: jsonSchemaTransform,
    // Modelos con nombre bajo components/schemas en lugar del mismo objeto en
    // línea en una docena de sitios. Lee los id que los esquemas registraron a
    // través de .meta({ id }), de modo que nombrar un modelo y publicarlo son un
    // único acto.
    transformObject: jsonSchemaTransformObject,
  })

  // El documento en sí, en una ruta estable. /docs es para una persona; esto es
  // para cualquier cosa que genere un cliente.
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger())

  await app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  })

  // Liveness: si este proceso está atascado. Deliberadamente no toca nada más —
  // un contenedor eliminado porque su base de datos va lenta no ayuda a nadie, y
  // reiniciarlo hace que la base de datos vaya aún más lenta.
  app.get('/health', { schema: { tags: ['health'], summary: 'Liveness' } }, async () => ({
    status: 'ok',
  }))

  // Readiness: si este pod puede atender una petición ahora mismo. No puede sin la
  // base de datos, así que este es el que pregunta.
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
