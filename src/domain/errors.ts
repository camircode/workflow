/**
 * Every failure this API can report, as a type rather than a string thrown from
 * somewhere in the middle of a query.
 *
 * The HTTP layer maps these to status codes; nothing below it knows what a
 * status code is. That is the whole point of keeping them here: a use case can
 * say "that user is not assigned to that task" without deciding whether that is
 * a 404 or a 409, which is a question about HTTP and not about the domain.
 */

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'USER_NOT_FOUND',
  'TASK_NOT_FOUND',
  'USER_NOT_ASSIGNED',
  'TASK_ALREADY_ARCHIVED',
  'EMAIL_ALREADY_REGISTERED',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_REQUEST_IN_PROGRESS',
  'INTERNAL_ERROR',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

export const userNotFound = (id: number | number[]): DomainError =>
  Array.isArray(id)
    ? new DomainError('USER_NOT_FOUND', `No user is registered with id ${id.join(', ')}.`)
    : new DomainError('USER_NOT_FOUND', `No user is registered with id ${id}.`)

export const taskNotFound = (id: number): DomainError =>
  new DomainError('TASK_NOT_FOUND', `No task is registered with id ${id}.`)

export const userNotAssigned = (userId: number, taskId: number): DomainError =>
  new DomainError(
    'USER_NOT_ASSIGNED',
    `User ${userId} is not assigned to task ${taskId}, so there is no part for them to complete.`,
  )

export const taskAlreadyArchived = (id: number): DomainError =>
  new DomainError(
    'TASK_ALREADY_ARCHIVED',
    `Task ${id} is archived. Everyone assigned to it has finished, so it no longer takes changes.`,
  )

export const emailAlreadyRegistered = (email: string): DomainError =>
  new DomainError('EMAIL_ALREADY_REGISTERED', `${email} is already registered.`)

export const idempotencyKeyReused = (key: string): DomainError =>
  new DomainError(
    'IDEMPOTENCY_KEY_REUSED',
    `Idempotency-Key ${key} was already used on this endpoint with a different body. ` +
      'A key identifies one request, so reusing it for another is refused rather than ' +
      'answered with the earlier result.',
  )
