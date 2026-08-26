/**
 * Todos los fallos que esta API puede reportar, como un tipo y no como una
 * cadena lanzada desde algún punto en medio de una consulta.
 *
 * La capa HTTP los mapea a códigos de estado; nada por debajo de ella sabe qué
 * es un código de estado. Ese es justamente el motivo de mantenerlos aquí: un
 * caso de uso puede decir "ese usuario no está asignado a esa tarea" sin decidir
 * si eso es un 404 o un 409, que es una pregunta sobre HTTP y no sobre el
 * dominio.
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
    ? new DomainError('USER_NOT_FOUND', `No hay ningún usuario registrado con el id ${id.join(', ')}.`)
    : new DomainError('USER_NOT_FOUND', `No hay ningún usuario registrado con el id ${id}.`)

export const taskNotFound = (id: number): DomainError =>
  new DomainError('TASK_NOT_FOUND', `No hay ninguna tarea registrada con el id ${id}.`)

export const userNotAssigned = (userId: number, taskId: number): DomainError =>
  new DomainError(
    'USER_NOT_ASSIGNED',
    `El usuario ${userId} no está asignado a la tarea ${taskId}, así que no tiene ninguna parte que completar.`,
  )

export const taskAlreadyArchived = (id: number): DomainError =>
  new DomainError(
    'TASK_ALREADY_ARCHIVED',
    `La tarea ${id} está archivada. Todas las personas asignadas a ella han terminado, así que ya no admite cambios.`,
  )

export const emailAlreadyRegistered = (email: string): DomainError =>
  new DomainError('EMAIL_ALREADY_REGISTERED', `${email} ya está registrado.`)

export const idempotencyKeyReused = (key: string): DomainError =>
  new DomainError(
    'IDEMPOTENCY_KEY_REUSED',
    `La Idempotency-Key ${key} ya se usó en este endpoint con un cuerpo distinto. ` +
      'Una clave identifica una petición, así que reutilizarla para otra se rechaza en lugar de ' +
      'responderse con el resultado anterior.',
  )
