import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod'
import { DomainError, type ErrorCode } from '../../domain/errors.js'
import type { ErrorBody } from './schemas.js'

/**
 * The one place that decides what a failure looks like over HTTP.
 *
 * The mapping lives here rather than at each throw site so the domain can say
 * what went wrong without also deciding what status code that is — and so every
 * error in this API has the same shape, which the specification requires and
 * consumers rely on far more than they say.
 */
const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,

  // Not 404: the task and the user both exist. What does not exist is the
  // relationship between them, and answering 404 would send the caller looking
  // for a missing user they would never find.
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

    // Zod rejected the body, the params or the query. Every problem at once,
    // because sending them one at a time makes fixing four fields four requests.
    if (hasZodFastifySchemaValidationErrors(error)) {
      const detail = error.validation
        .map((issue) => `${issue.instancePath || 'body'} ${issue.message ?? ''}`.trim())
        .join('; ')
      return reply
        .status(400)
        .send(errorBody('VALIDATION_ERROR', detail || 'The request is not valid.'))
    }

    // Malformed JSON and the like: Fastify rejected it before any schema ran.
    const fastifyError = error as { statusCode?: number; message?: string }
    if (fastifyError.statusCode === 400) {
      return reply
        .status(400)
        .send(errorBody('VALIDATION_ERROR', fastifyError.message ?? 'The request is not valid.'))
    }

    request.log.error({ err: error }, 'unhandled error')
    return reply
      .status(500)
      .send(errorBody('INTERNAL_ERROR', 'The request could not be completed.'))
  })

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) =>
    reply
      .status(404)
      .send(
        errorBody(
          'NOT_FOUND',
          `No route matches ${request.method} ${request.url}. The API is described at /docs.`,
        ),
      ),
  )
}
