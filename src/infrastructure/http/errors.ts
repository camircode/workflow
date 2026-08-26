import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod'
import { DomainError, type ErrorCode } from '../../domain/errors.js'
import type { ErrorBody } from './schemas.js'

/**
 * El único sitio que decide qué aspecto tiene un fallo sobre HTTP.
 *
 * El mapeo vive aquí y no en cada punto donde se lanza, para que el dominio
 * pueda decir qué salió mal sin decidir además qué código de estado es eso — y
 * para que todos los errores de esta API tengan la misma forma, que es lo que
 * exige la especificación y en lo que los consumidores confían mucho más de lo
 * que dicen.
 */
const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,

  // No es 404: la tarea y el usuario existen ambos. Lo que no existe es la
  // relación entre ellos, y responder 404 mandaría al llamante a buscar un
  // usuario ausente que nunca encontraría.
  USER_NOT_ASSIGNED: 409,

  TASK_ALREADY_ARCHIVED: 409,
  EMAIL_ALREADY_REGISTERED: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENCY_REQUEST_IN_PROGRESS: 409,
  INTERNAL_ERROR: 500,
}

export const errorBody = (code: ErrorCode, message: string): ErrorBody => ({
  error: { code, message },
})

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof DomainError) {
      const status = STATUS[error.code]
      if (status >= 500) request.log.error({ err: error }, 'domain error')
      return reply.status(status).send(errorBody(error.code, error.message))
    }

    // Zod rechazó el cuerpo, los parámetros o la query. Todos los problemas de
    // una vez, porque enviarlos de uno en uno convierte arreglar cuatro campos en
    // cuatro peticiones.
    if (hasZodFastifySchemaValidationErrors(error)) {
      const detail = error.validation
        .map((issue) => `${issue.instancePath || 'body'} ${issue.message ?? ''}`.trim())
        .join('; ')
      return reply
        .status(400)
        .send(errorBody('VALIDATION_ERROR', detail || 'La petición no es válida.'))
    }

    // JSON malformado y similares: Fastify lo rechazó antes de que se ejecutara
    // ningún esquema.
    const fastifyError = error as { statusCode?: number; message?: string }
    if (fastifyError.statusCode === 400) {
      return reply
        .status(400)
        .send(errorBody('VALIDATION_ERROR', fastifyError.message ?? 'La petición no es válida.'))
    }

    request.log.error({ err: error }, 'unhandled error')
    return reply
      .status(500)
      .send(errorBody('INTERNAL_ERROR', 'No se pudo completar la petición.'))
  })

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) =>
    reply
      .status(404)
      .send(
        errorBody(
          'NOT_FOUND',
          `Ninguna ruta coincide con ${request.method} ${request.url}. La API está descrita en /docs.`,
        ),
      ),
  )
}
